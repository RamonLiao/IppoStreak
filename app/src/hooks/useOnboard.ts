import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { buildCreateManager, buildCreateProfileOpen } from '../lib/ptb';

export type OnboardStatus = 'idle' | 'manager' | 'profile' | 'done' | 'error';

// Two sequential signatures: (1) create_manager → shared PredictManager, (2) create_profile_open
// referencing that manager id. dapp-kit's signAndExecuteTransaction returns a discriminated
// union ({ Transaction } | { FailedTransaction }) with effects already included.
export function useOnboard() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const qc = useQueryClient();
  const [status, setStatus] = useState<OnboardStatus>('idle');
  // Remember a manager created in a prior attempt so a retry resumes at step 2 instead of
  // creating (and orphaning) a second shared PredictManager when step 2 failed. Bound to the
  // address: PredictManager bakes in `owner = creator`, so reusing it under a switched account
  // would mint a profile pointing at a manager that account can never use.
  const [created, setCreated] = useState<{ address: string; id: string } | null>(null);
  // Live account ref so the async flow can detect a mid-flow wallet switch — the `account`
  // captured in the closure is stale, but this ref is refreshed every render.
  const accountRef = useRef(account);
  accountRef.current = account;
  // In-flight mutex: a render-state `disabled` button can't prevent a double-click that fires
  // two flows before React re-renders, which would create two managers.
  const inFlight = useRef(false);

  async function onboard() {
    if (!account || inFlight.current) return;
    inFlight.current = true;
    const addr = account.address;
    // Each transaction is signed by the LIVE current account; bail if the user switched wallets
    // mid-flow, else step 2 would mint a profile against step 1's now-foreign manager.
    const assertSameAccount = () => {
      if (accountRef.current?.address !== addr) throw new Error('Account changed during onboarding');
    };
    try {
      let mid = created?.address === addr ? created.id : null;
      if (!mid) {
        setStatus('manager');
        const mgr = await dAppKit.signAndExecuteTransaction({ transaction: buildCreateManager() });
        assertSameAccount();
        if (mgr.FailedTransaction) throw new Error(txError(mgr.FailedTransaction));
        // waitForTransaction can carry effects+objectTypes in one round-trip — used to locate the
        // created shared PredictManager (effects give ids, objectTypes give the type per id).
        const waited = await client.waitForTransaction({
          digest: mgr.Transaction.digest,
          include: { effects: true, objectTypes: true },
        });
        mid = pickCreatedManager(waited);
        setCreated({ address: addr, id: mid });
      }

      assertSameAccount();
      setStatus('profile');
      const prof = await dAppKit.signAndExecuteTransaction({
        transaction: buildCreateProfileOpen(mid),
      });
      assertSameAccount();
      if (prof.FailedTransaction) throw new Error(txError(prof.FailedTransaction));
      await client.waitForTransaction({ digest: prof.Transaction.digest });

      setStatus('done');
      qc.invalidateQueries({ queryKey: ['profile', addr] });
    } catch (e) {
      setStatus('error');
      // Self-heal: the failure may have hit AFTER create_profile_open committed (e.g.
      // waitForTransaction timed out). Re-checking profile lets the gate advance instead of
      // retrying into an on-chain dedup abort that would wedge onboarding permanently.
      qc.invalidateQueries({ queryKey: ['profile', addr] });
      throw e;
    } finally {
      inFlight.current = false;
    }
  }

  return { onboard, status };
}

// Loose structural types: gRPC `TransactionResult<Include>` is invariant in `Include`, so a
// richer (effects+objectTypes) result isn't assignable to the default-generic shape. We only
// touch a handful of fields, so accept them structurally rather than fight the variance.
type TxLike = {
  digest: string;
  status?: { success: boolean; error?: unknown };
  objectTypes?: Record<string, string>;
  effects?: { changedObjects?: { objectId: string; idOperation: string }[] };
};

function pickCreatedManager(res: { Transaction?: TxLike }): string {
  const tx = res.Transaction;
  if (!tx) throw new Error('create_manager did not commit');
  const types = tx.objectTypes ?? {};
  const created = (tx.effects?.changedObjects ?? []).filter((c) => c.idOperation === 'Created');
  const mgr = created.find((c) => (types[c.objectId] ?? '').endsWith('::predict_manager::PredictManager'));
  if (!mgr) throw new Error('PredictManager not found in create_manager effects');
  return mgr.objectId;
}

function txError(failed: TxLike): string {
  const err = failed.status?.success === false ? failed.status.error : null;
  return err ? JSON.stringify(err) : 'transaction failed';
}
