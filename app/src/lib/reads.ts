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
import { INDEXER } from '../config';

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
