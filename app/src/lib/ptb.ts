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
import { PKG, PREDICT, LEAGUE, SUB_REGISTRY, CLOCK } from '../config';

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
