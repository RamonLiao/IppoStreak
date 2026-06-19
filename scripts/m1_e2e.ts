// M1-REVISIT testnet e2e. Run: pnpm tsx scripts/m1_e2e.ts
// Env: SUI_KEY (bech32 suiprivkey of 0x1509…bc4c), PKG (published predict_league pkg id),
//      LEAGUE, ADMIN_CAP, VERIFIER_CAP, SUB_REGISTRY (from publish output).
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const PREDICT = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const PREDICT_SINGLETON = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const DUSDC = `${'0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a'}::dusdc::DUSDC`;
const CLOCK = '0x6';
const IDX = 'https://predict-server.testnet.mystenlabs.com/oracles';

const client = new SuiClient({ url: getFullnodeUrl('testnet') });
const kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.SUI_KEY!).secretKey);
const me = kp.toSuiAddress();
const PKG = process.env.PKG!, LEAGUE = process.env.LEAGUE!, ADMIN = process.env.ADMIN_CAP!;
const VERIFIER = process.env.VERIFIER_CAP!, SUB_REGISTRY = process.env.SUB_REGISTRY!;

async function exec(tx: Transaction, label: string) {
  const r = await client.signAndExecuteTransaction({
    signer: kp, transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  if (r.effects?.status.status !== 'success')
    throw new Error(`${label} FAILED: ${r.effects?.status.error}`);
  console.log(`✓ ${label}: ${r.digest}`);
  return r;
}

// Pick a near-expiry ACTIVE BTC oracle from the indexer.
async function pickOracle() {
  const all = await (await fetch(IDX)).json();
  const now = Date.now();
  const live = all.filter((o: any) =>
    o.underlying_asset?.includes('BTC') && o.active === true &&
    o.settlement_price == null && Number(o.expiry) > now + 90_000);
  live.sort((a: any, b: any) => Number(a.expiry) - Number(b.expiry));
  if (!live.length) throw new Error('no near-expiry active BTC oracle');
  const o = live[0];
  // on-grid at-the-money strike
  const minStrike = BigInt(o.min_strike), tick = BigInt(o.tick_size), spot = BigInt(o.prices.spot);
  const k = (spot - minStrike) / tick;
  const strike = minStrike + k * tick;
  return { id: o.oracle_id, expiry: BigInt(o.expiry), strike, asset: o.underlying_asset };
}

async function main() {
  const o = await pickOracle();
  console.log('oracle', o.id, 'expiry', o.expiry.toString(), 'strike', o.strike.toString());

  // 1) create + share a PredictManager (owner = me, satisfies mint's sender==owner).
  let tx = new Transaction();
  tx.moveCall({ target: `${PREDICT}::predict::create_manager` });
  const mr = await exec(tx, 'create_manager');
  const manager = mr.objectChanges!.find(
    (c: any) => c.type === 'created' && c.objectType.endsWith('::predict_manager::PredictManager'),
  ) as any;
  const MANAGER = manager.objectId;

  // 2) create_profile (VerifierCap-gated, binds predict_manager).
  tx = new Transaction();
  const profile = tx.moveCall({
    target: `${PKG}::league::create_profile`,
    arguments: [tx.object(VERIFIER), tx.object(SUB_REGISTRY), tx.object(LEAGUE),
      tx.pure.vector('u8', [...Buffer.from('e2e-sub')]), tx.pure.id(MANAGER), tx.object(CLOCK)],
  });
  tx.transferObjects([profile], me);
  const pr = await exec(tx, 'create_profile');
  const PROFILE = (pr.objectChanges!.find(
    (c: any) => c.type === 'created' && c.objectType.endsWith('::league::PlayerProfile')) as any).objectId;
  const PROFILE_ADDR = PROFILE; // stats keyed by profile object id

  // 3) publish_question_for_market (DIR_UP=0; derives oracle_id+expiry from the oracle).
  tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::league::publish_question_for_market`,
    arguments: [tx.object(ADMIN), tx.object(LEAGUE), tx.object(o.id),
      tx.pure.u64(o.strike), tx.pure.u8(0), tx.pure.u64(Date.now())],
  });
  const qr = await exec(tx, 'publish_question_for_market');
  const QID = (qr.events!.find((e: any) => e.type.endsWith('::QuestionPublished')) as any).parsedJson.question_id;

  // 4) place_pick with real DUSDC; assert PickPlaced.stake > 0.
  const dusdc = await client.getCoins({ owner: me, coinType: DUSDC });
  if (!dusdc.data.length) throw new Error('no DUSDC');
  tx = new Transaction();
  const [stakeCoin] = tx.splitCoins(tx.object(dusdc.data[0].coinObjectId), [tx.pure.u64(50_000_000)]); // 50 DUSDC
  tx.moveCall({
    target: `${PKG}::league::place_pick`,
    typeArguments: [],
    arguments: [tx.object(LEAGUE), tx.object(PROFILE), tx.object(PREDICT_SINGLETON), tx.object(MANAGER),
      tx.object(o.id), tx.pure.u64(QID), tx.pure.u64(1_000_000) /*quantity*/,
      tx.pure.u64(50_000_000) /*max_cost*/, stakeCoin, tx.object(CLOCK)],
  });
  const ppr = await exec(tx, 'place_pick');
  const placed = (ppr.events!.find((e: any) => e.type.endsWith('::PickPlaced')) as any).parsedJson;
  if (Number(placed.stake) <= 0) throw new Error('stake not > 0');
  console.log('  stake =', placed.stake);

  // 5) wait until past expiry AND oracle settled.
  const waitMs = Number(o.expiry) - Date.now() + 5_000;
  if (waitMs > 0) { console.log(`waiting ${Math.ceil(waitMs/1000)}s for expiry…`); await new Promise(r => setTimeout(r, waitMs)); }
  let settled = false;
  for (let i = 0; i < 40 && !settled; i++) {
    const obj = await client.getObject({ id: o.id, options: { showContent: true } });
    settled = (obj.data?.content as any)?.fields?.settlement_price != null;
    if (!settled) await new Promise(r => setTimeout(r, 15_000));
  }
  if (!settled) throw new Error('oracle did not settle in time');

  // 6) KEEPER path: settle_pick BEFORE redeem_permissionless, in one PTB.
  tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::league::settle_pick`,
    arguments: [tx.object(LEAGUE), tx.object(MANAGER), tx.object(o.id),
      tx.pure.address(PROFILE_ADDR), tx.pure.u64(QID), tx.object(CLOCK)],
  });
  // sibling redeem (key reconstructed: is_up = direction 0). market_key::new(oracle_id, expiry, strike, true)
  const key = tx.moveCall({
    target: `${PREDICT}::market_key::new`,
    arguments: [tx.pure.id(o.id), tx.pure.u64(o.expiry), tx.pure.u64(o.strike), tx.pure.bool(true)],
  });
  tx.moveCall({
    target: `${PREDICT}::predict::redeem_permissionless`, typeArguments: [DUSDC],
    arguments: [tx.object(PREDICT_SINGLETON), tx.object(MANAGER), tx.object(o.id), key,
      tx.pure.u64(0) /*min payout*/, tx.object(CLOCK)],
  });
  const sr = await exec(tx, 'settle_pick (keeper, before redeem)');
  const settledEv = (sr.events!.find((e: any) => e.type.endsWith('::PickSettled')) as any).parsedJson;
  console.log('  won =', settledEv.won, 'points =', settledEv.points_awarded);

  console.log('\nE2E POSITIVE PATH PASS ✅');
}
main().catch((e) => { console.error('E2E FAIL:', e.message); process.exit(1); });
