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

// True only for an absent dynamic field / object (gRPC NotFound). Used to distinguish "no stat
// entry yet" from real transport/decode failures, which must propagate.
function isNotFound(e: unknown): boolean {
  const s = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    s.includes('not found') ||
    s.includes('notfound') ||
    s.includes('does not exist') ||
    s.includes('no field')
  );
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

// === MyPicks / stats (Task 6) ===
// A player's season state lives in `League.stats: Table<address, PlayerStat>`; their open picks in
// `PlayerStat.open_picks: Table<u64, Pick>`. There is no event-query API on Path B (gRPC core), so
// we read both directly from chain. ONE getDynamicField gives the PlayerStat (stat fields + the
// open_picks table handle) — a single consistent snapshot — so we derive stats AND the picks list
// from it, instead of the plan's 4-getter devInspect (simpler, fewer round-trips, one snapshot).
// (simulateTransaction stat getters were verified to work too, kept as a fallback option.)
//
// BCS layouts are positional and MUST match league.move / predict market_key.move exactly. A Sui
// `Table<K,V>` serialises as { id: ObjectID(32B), size: u64 } — `id` is the inner table's object id.
// PlayerStat + the stat values were live-verified against the deployed chain; the Pick layout
// matches source but had no live entry to decode (the one on-chain player had already settled).
const TableBcs = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });
const MarketKeyBcs = bcs.struct('MarketKey', {
  oracle_id: bcs.Address,
  expiry: bcs.u64(),
  strike: bcs.u64(),
  direction: bcs.u8(),
});
const PickBcs = bcs.struct('Pick', {
  question_id: bcs.u64(),
  direction: bcs.u8(),
  stake: bcs.u64(),
  market_key: MarketKeyBcs,
  predict_manager: bcs.Address,
  placed_ms: bcs.u64(),
});
const PlayerStatBcs = bcs.struct('PlayerStat', {
  streak: bcs.u64(),
  best_streak: bcs.u64(),
  last_active_day: bcs.u64(),
  season_points: bcs.u64(),
  total_staked: bcs.u64(),
  badge_minted: bcs.bool(),
  open_picks: TableBcs,
});

export type MyPick = {
  questionId: string; // u64
  direction: number; // 0 = UP, 1 = DOWN
  stake: bigint; // DUSDC base units actually consumed at pick time
  oracleId: string; // from market_key — exactly what settle_pick needs
};

export type MyState = {
  points: bigint;
  streak: bigint;
  bestStreak: bigint;
  totalStaked: bigint;
  picks: MyPick[];
};

// Read a player's stats + open picks. `player` is the PlayerProfile OBJECT id (the contract keys
// `League.stats` by `object::uid_to_address(&profile.id)`, NOT the wallet address). Returns null
// when there is no stat entry — create_profile_open seeds one at onboarding, so for a real profile
// id this won't happen; null means "not a known profile".
export async function fetchMyState(client: SuiGrpcClient, player: string): Promise<MyState | null> {
  const { object } = await client.core.getObject({ objectId: LEAGUE, include: { json: true } });
  const statsTableId = readField(readField(object.json, 'stats'), 'id') as string | undefined;
  if (!statsTableId) return null;

  let stat;
  try {
    const { dynamicField } = await client.getDynamicField({
      parentId: statsTableId,
      name: { type: 'address', bcs: bcs.Address.serialize(player).toBytes() },
    });
    stat = PlayerStatBcs.parse(dynamicField.value.bcs);
  } catch (e) {
    // Swallow ONLY a genuine "no such dynamic field" (this profile has no stat entry). Any other
    // error — RPC/network failure, BCS layout mismatch, corrupt data — must surface, not be
    // misreported as a zeroed-out player (Rule 12: fail loud).
    if (isNotFound(e)) return null;
    throw e;
  }

  const base: MyState = {
    points: BigInt(stat.season_points),
    streak: BigInt(stat.streak),
    bestStreak: BigInt(stat.best_streak),
    totalStaked: BigInt(stat.total_staked),
    picks: [],
  };
  if (Number(stat.open_picks.size) === 0) return base;

  let cursor: string | null = null;
  for (;;) {
    const page: DynFieldPage = await client.listDynamicFields({
      parentId: stat.open_picks.id,
      include: { value: true },
      cursor,
    });
    for (const f of page.dynamicFields) {
      if (!f.value) continue;
      const pick = PickBcs.parse(f.value.bcs);
      base.picks.push({
        questionId: bcs.u64().parse(f.name.bcs),
        direction: pick.direction,
        stake: BigInt(pick.stake),
        oracleId: normalizeSuiAddress(pick.market_key.oracle_id),
      });
    }
    if (!page.hasNextPage) break;
    cursor = page.cursor;
  }
  return base;
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
