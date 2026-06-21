// Onboarding PTB builders.
//
// ABI NOTE (verified against deployed source, not the P1 plan): `create_profile_open` takes
// NO `sub_commit` arg — the Task 1 security fix derives the dedup key on-chain from the tx
// sender (`to_bytes(sender) + 0x01`). Passing caller bytes (as the plan drafted) would be an
// arity mismatch. Args are exactly: (SubRegistry, League, predict_manager: ID, Clock).
//
// `predict::create_manager` shares a `PredictManager` with `owner = ctx.sender()` baked in,
// so when the Enoki zkLogin wallet signs, the manager is owned by the user's derived address
// (satisfies V4: onboarding must bind to the user address, never a shared backend key).
import { Transaction } from '@mysten/sui/transactions';
import { PKG, PREDICT, PREDICT_SINGLETON, LEAGUE, SUB_REGISTRY, CLOCK } from '../config';

export function buildCreateManager(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PREDICT}::predict::create_manager` });
  return tx;
}

export function buildCreateProfileOpen(managerId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::league::create_profile_open`,
    arguments: [
      tx.object(SUB_REGISTRY),
      tx.object(LEAGUE),
      tx.pure.id(managerId),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

// place_pick PTB (verified against the deployed source signature, league.move):
//   (&mut League, &PlayerProfile, &mut Predict, &mut PredictManager, &OracleSVI,
//    question_id: u64, quantity: u64, max_cost: u64, stake_coin: Coin<DUSDC>, &Clock)
// The contract DEPOSITS the full stake_coin into the manager, mints the position, then books
// stake = the DUSDC the mint actually consumed (premium+fees) — the unspent remainder stays
// withdrawable in the manager. `max_cost` is the V11 slippage ceiling (abort EMaxCostExceeded
// if the live premium exceeds it).
//
// Coin handling: we merge ALL of the caller's DUSDC coins into the first, then split exactly
// `amount` for the stake_coin. Merging guards the foot-gun where the wallet's gas-selected
// primary coin is smaller than `amount` (split would abort) when the balance is spread across
// several coins.
export function buildPlacePick(p: {
  oracleId: string;
  profileId: string;
  managerId: string;
  questionId: bigint | string;
  quantity: bigint;
  maxCost: bigint;
  amount: bigint; // DUSDC (6 decimals) deposited as the stake_coin; also the slippage ceiling source
  coinIds: string[]; // all of the caller's DUSDC coin object ids (non-empty; total >= amount)
}): Transaction {
  const tx = new Transaction();
  const [primary, ...rest] = p.coinIds;
  const primaryObj = tx.object(primary);
  if (rest.length) tx.mergeCoins(primaryObj, rest.map((c) => tx.object(c)));
  const [stakeCoin] = tx.splitCoins(primaryObj, [tx.pure.u64(p.amount)]);
  tx.moveCall({
    target: `${PKG}::league::place_pick`,
    arguments: [
      tx.object(LEAGUE),
      tx.object(p.profileId),
      tx.object(PREDICT_SINGLETON),
      tx.object(p.managerId),
      tx.object(p.oracleId),
      tx.pure.u64(p.questionId),
      tx.pure.u64(p.quantity),
      tx.pure.u64(p.maxCost),
      stakeCoin,
      tx.object(CLOCK),
    ],
  });
  return tx;
}
