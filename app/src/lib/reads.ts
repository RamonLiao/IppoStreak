// Market reads. Source of truth for the live-market list is the Predict indexer
// (`/oracles`); per-oracle spot price is read on-chain via the dApp Kit client.
//
// PATH B NOTE: we read with the unified *core* API (`client.core.getObject`) so this works
// against the SuiGrpcClient configured in `lib/dapp-kit.ts`. The core API returns a flat
// `json` representation (`json.prices.spot`) — unlike the deprecated JSON-RPC SuiClient,
// which nested every Move struct under `.fields` (`content.fields.prices.fields.spot`).
// The SDK warns the `json` shape can differ across API impls, so `readField` tolerates both
// the flat and the `.fields`-wrapped layouts.
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { INDEXER, LEAGUE } from '../config';

export type Market = {
  oracleId: string;
  expiry: bigint;
  strike: bigint;
  asset: string;
  minStrike: bigint;
  tick: bigint;
  spot: bigint;
};

// Indexer row shape (only the fields we consume).
type OracleRow = {
  oracle_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
  settlement_price: number | null;
};

// Drill `obj[key]`, transparently unwrapping a `{ fields: {...} }` wrapper if present.
function readField(obj: any, key: string): any {
  if (obj == null) return undefined;
  if (key in obj) return obj[key];
  if (obj.fields && key in obj.fields) return obj.fields[key];
  return undefined;
}

export async function fetchMarkets(client: SuiGrpcClient): Promise<Market[]> {
  const res = await fetch(INDEXER);
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const all: OracleRow[] = await res.json();

  const now = Date.now();
  const live = all
    .filter(
      (o) =>
        o.underlying_asset === 'BTC' &&
        o.status === 'active' &&
        o.settlement_price == null &&
        Number(o.expiry) > now + 120_000, // skip near-expiry (no time to place + settle)
    )
    .sort((a, b) => Number(a.expiry) - Number(b.expiry))
    .slice(0, 10);

  const out: Market[] = [];
  for (const o of live) {
    const { object } = await client.core.getObject({
      objectId: o.oracle_id,
      include: { json: true },
    });
    const prices = readField(object.json, 'prices');
    const spot = BigInt(readField(prices, 'spot'));

    const minStrike = BigInt(o.min_strike);
    const tick = BigInt(o.tick_size);
    // Nearest on-grid strike at-or-below spot (ATM). strike grid is package-private on
    // chain, so min_strike/tick_size come from the indexer (spec V5).
    const strike = minStrike + ((spot - minStrike) / tick) * tick;

    out.push({
      oracleId: o.oracle_id,
      expiry: BigInt(o.expiry),
      strike,
      asset: o.underlying_asset,
      minStrike,
      tick,
      spot,
    });
  }
  return out;
}

// `Question` as stored in `League.questions: Table<u64, Question>`. Field order MUST match the
// Move struct in league.move exactly (BCS is positional). `oracle_id: ID` serialises as a bare
// 32-byte address. Verified by decoding the live table entry against the deployed chain.
// Minimal projection of listDynamicFields(value:true) — only the fields findOpenQuestion reads.
type DynFieldPage = {
  dynamicFields: { name: { bcs: Uint8Array }; value?: { bcs: Uint8Array } }[];
  hasNextPage: boolean;
  cursor: string | null;
};

const QuestionBcs = bcs.struct('Question', {
  id: bcs.u64(),
  oracle_id: bcs.Address,
  strike: bcs.u64(),
  direction: bcs.u8(),
  open_ms: bcs.u64(),
  expiry_ms: bcs.u64(),
  settled: bcs.bool(),
});

export type OpenQuestion = {
  questionId: string; // u64
  direction: number; // 0 = UP, 1 = DOWN (mirrors DIR_UP/DIR_DOWN)
  strike: bigint; // 9-implied-decimals, same scale as oracle spot
};

// Find a published, still-open question bound to `oracleId`. There is NO event-query API on the
// gRPC core client (the JSON-RPC `queryEvents` the P1 plan assumed does not exist on Path B), so
// we read the source of truth directly: enumerate `League.questions` dynamic fields and BCS-decode
// each `Question` value. Returns the question's id + the ON-CHAIN direction/strike (so the UI
// shows what `place_pick` will actually bind to — never a guessed/hardcoded side), or null.
//
// `place_pick` is AdminCap-gated to publish; the demo operator publishes a fresh question per
// market (Pick page shows "no open question yet" when this returns null). We skip settled and
// already-expired questions so a stale resolved question never gets offered as pickable.
//
// `expiryMs` (the market's oracle expiry) is matched as defense-in-depth — an OracleSVI is unique
// per expiry window, so oracle-match already implies it, but the assertion guards against a reused
// id. P1 LIMITATION: the contract allows multiple unsettled questions per oracle (e.g. UP + DOWN);
// we return the FIRST match. The demo operator publishes exactly one question per market, so this
// is unambiguous in P1; a market that offers both sides needs a selection UI (P2).
export async function findOpenQuestion(
  client: SuiGrpcClient,
  oracleId: string,
  expiryMs?: bigint,
): Promise<OpenQuestion | null> {
  const { object } = await client.core.getObject({ objectId: LEAGUE, include: { json: true } });
  const tableId = readField(readField(object.json, 'questions'), 'id') as string | undefined;
  if (!tableId) return null;

  const now = Date.now();
  const want = normalizeSuiAddress(oracleId);
  let cursor: string | null = null;
  for (;;) {
    // Explicit shape: threading `cursor` (read back from the result) into the call confuses
    // TS's generic inference into a self-reference, so we pin the result type to the fields used.
    const page: DynFieldPage = await client.listDynamicFields({
      parentId: tableId,
      include: { value: true },
      cursor,
    });
    for (const f of page.dynamicFields) {
      if (!f.value) continue;
      const q = QuestionBcs.parse(f.value.bcs);
      if (q.settled) continue;
      if (Number(q.expiry_ms) <= now) continue;
      if (normalizeSuiAddress(q.oracle_id) !== want) continue;
      if (expiryMs != null && BigInt(q.expiry_ms) !== expiryMs) continue;
      return { questionId: bcs.u64().parse(f.name.bcs), direction: q.direction, strike: BigInt(q.strike) };
    }
    if (!page.hasNextPage) return null;
    cursor = page.cursor;
  }
}

// All of an owner's DUSDC coins, following pagination. listCoins returns one page (~50); a player
// whose balance is fragmented across more coins would otherwise look underfunded or have funds the
// pick can't reach. Returns { objectId, balance } for every non-empty coin.
export async function fetchDusdcCoins(
  client: SuiGrpcClient,
  owner: string,
  coinType: string,
): Promise<{ objectId: string; balance: bigint }[]> {
  const out: { objectId: string; balance: bigint }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await client.core.listCoins({ owner, coinType, cursor });
    for (const c of page.objects) {
      const balance = BigInt(c.balance);
      if (balance > 0n) out.push({ objectId: c.objectId, balance });
    }
    if (!page.hasNextPage) return out;
    cursor = page.cursor;
  }
}
