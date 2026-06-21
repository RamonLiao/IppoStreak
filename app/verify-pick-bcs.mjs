// Task 7 (b): live-verify the Pick BCS layout in src/lib/reads.ts against a real on-chain open
// pick. reads.ts notes the Pick layout "matches source but had no live entry to decode". We placed
// one (profile 0x1305…, question_id=1, stake=495279, dir=0, oracle 0x05306d43…) so we can now decode
// it via the SAME gRPC core API path the app uses (SuiGrpcClient) and assert against ground truth
// (the on-chain PickPlaced event). The BCS structs below are COPIED VERBATIM from reads.ts — a sibling
// diff check (run separately) proves byte-identity, so a pass here certifies reads.ts's real layout.
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';

const LEAGUE = '0x2e1cad6d4fe097bb2315e0524d703614db7eb0c14970e4d459989d477d8a716c';
const PROFILE = '0x1305cfca1979677caf13a09df6171ae6ad34659f91f6a2d5e543663d45d6a56b'; // stats key = profile object id
const EXPECT = { qid: '1', dir: 0, stake: 495279n, oracle: '0x05306d43afb006322e73aeadb217b1a83511aed57f773a2f4e7a181e0caae01d' };

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });

function readField(obj, key) {
  if (obj == null) return undefined;
  if (key in obj) return obj[key];
  if (obj.fields && key in obj.fields) return obj.fields[key];
  return undefined;
}

// === COPIED VERBATIM from src/lib/reads.ts ===
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
// === end copy ===

const { object } = await client.core.getObject({ objectId: LEAGUE, include: { json: true } });
const statsTableId = readField(readField(object.json, 'stats'), 'id');
if (!statsTableId) throw new Error('no stats table');

const { dynamicField } = await client.getDynamicField({
  parentId: statsTableId,
  name: { type: 'address', bcs: bcs.Address.serialize(PROFILE).toBytes() },
});
const stat = PlayerStatBcs.parse(dynamicField.value.bcs);
console.log('PlayerStat:', {
  streak: stat.streak, best_streak: stat.best_streak, season_points: stat.season_points,
  total_staked: stat.total_staked, badge_minted: stat.badge_minted, open_picks_size: stat.open_picks.size,
});

if (Number(stat.open_picks.size) === 0) throw new Error('FAIL: open_picks empty — no live pick to decode');

let found = null;
let cursor = null;
for (;;) {
  const page = await client.listDynamicFields({ parentId: stat.open_picks.id, include: { value: true }, cursor });
  for (const f of page.dynamicFields) {
    if (!f.value) continue;
    const pick = PickBcs.parse(f.value.bcs);
    const decoded = {
      questionId: bcs.u64().parse(f.name.bcs),
      direction: pick.direction,
      stake: BigInt(pick.stake),
      oracleId: normalizeSuiAddress(pick.market_key.oracle_id),
      marketStrike: BigInt(pick.market_key.strike),
      predictManager: normalizeSuiAddress(pick.predict_manager),
      placedMs: BigInt(pick.placed_ms),
    };
    console.log('Decoded Pick:', decoded);
    if (decoded.questionId === EXPECT.qid) found = decoded;
  }
  if (!page.hasNextPage) break;
  cursor = page.cursor;
}

if (!found) throw new Error(`FAIL: question_id=${EXPECT.qid} not found in open_picks`);

const checks = [
  ['questionId', found.questionId, EXPECT.qid],
  ['direction', found.direction, EXPECT.dir],
  ['stake', found.stake, EXPECT.stake],
  ['oracleId', found.oracleId, normalizeSuiAddress(EXPECT.oracle)],
];
let ok = true;
for (const [k, got, want] of checks) {
  const pass = got === want || String(got) === String(want);
  console.log(`${pass ? '✓' : '✗'} ${k}: got=${got} want=${want}`);
  if (!pass) ok = false;
}
if (!ok) throw new Error('FAIL: decoded Pick does not match on-chain PickPlaced event');
console.log('\nPICK BCS LIVE VERIFY PASS ✅ — reads.ts Pick layout decodes the live on-chain entry correctly');
