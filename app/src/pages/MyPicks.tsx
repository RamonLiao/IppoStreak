import { useRef, useState } from 'react';
import { useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMyStats } from '../hooks/useMyStats';
import { buildSettlePick } from '../lib/ptb';
import { toMessage } from '../lib/errors';
import { DIR_UP } from '../config';
import type { MyPick } from '../lib/reads';

const DUSDC_DECIMALS = 6;
function fmtDusdc(v: bigint): string {
  return `${(Number(v) / 10 ** DUSDC_DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 2 })} DUSDC`;
}

export default function MyPicks({ profileId, onBack }: { profileId: string; onBack: () => void }) {
  const state = useMyStats(profileId);
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const qc = useQueryClient();

  // Per-pick in-flight question id (settle is permissionless and idempotent, but a double-submit
  // wastes a signature and the 2nd aborts EAlreadySettled). One settle at a time.
  const inFlight = useRef<string | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const [err, setErr] = useState<string>();

  async function settle(pick: MyPick) {
    if (inFlight.current) return;
    inFlight.current = pick.questionId;
    setSettling(pick.questionId);
    setErr(undefined);
    try {
      // settle_pick is keyed by the PlayerProfile object id (== profileId), and is permissionless —
      // any signer can settle this profile's pick, so a mid-flow wallet switch doesn't corrupt it.
      const tx = buildSettlePick({
        oracleId: pick.oracleId,
        profileAddr: profileId,
        questionId: pick.questionId,
      });
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction)
        throw new Error(JSON.stringify(res.FailedTransaction.status?.error ?? 'transaction failed'));
      await client.waitForTransaction({ digest: res.Transaction.digest });
      // Points/streak changed and the pick is now removed — refresh.
      qc.invalidateQueries({ queryKey: ['my-state'] });
    } catch (e) {
      setErr(toMessage(e));
    } finally {
      inFlight.current = null;
      setSettling(null);
    }
  }

  const s = state.data;

  return (
    <div className="p-6 max-w-xl mx-auto grid gap-4">
      <button onClick={onBack} className="text-sm text-gray-500 text-left hover:underline">
        ← Back to markets
      </button>

      <h2 className="text-xl font-semibold">My stats</h2>
      {state.isLoading && <div className="text-sm text-gray-500">Loading…</div>}
      {state.error && (
        <div className="text-sm text-red-600">Failed to load: {String(state.error)}</div>
      )}
      {!state.isLoading && !state.error && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Points" value={(s?.points ?? 0n).toString()} />
          <Stat label="Streak" value={(s?.streak ?? 0n).toString()} />
          <Stat label="Best streak" value={(s?.bestStreak ?? 0n).toString()} />
          <Stat label="Total staked" value={fmtDusdc(s?.totalStaked ?? 0n)} />
        </div>
      )}

      <h2 className="text-xl font-semibold mt-2">Open picks</h2>
      {s && s.picks.length === 0 && (
        <div className="text-sm text-gray-500">No open picks. Place one from Markets.</div>
      )}
      <div className="grid gap-2">
        {s?.picks.map((p) => (
          <div key={p.questionId} className="border rounded p-3 flex items-center justify-between">
            <div>
              <div className="font-medium">
                Q#{p.questionId} · {p.direction === DIR_UP ? 'UP' : 'DOWN'}
              </div>
              <div className="text-sm text-gray-500">staked {fmtDusdc(p.stake)}</div>
            </div>
            <button
              onClick={() => settle(p)}
              disabled={settling !== null}
              className="border rounded px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {settling === p.questionId ? 'Settling…' : 'Settle now'}
            </button>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-400">
        Settling is open to anyone and only works once the oracle has resolved the market. If it
        says “not expired” or “oracle hasn’t settled”, check back after the market’s expiry.
      </p>

      {err && <div className="text-sm text-red-600">{err}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-mono">{value}</div>
    </div>
  );
}
