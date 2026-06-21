import { useRef, useState } from 'react';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { buildPlacePick } from '../lib/ptb';
import { findOpenQuestion, fetchDusdcCoins } from '../lib/reads';
import type { Market } from '../lib/reads';
import { DUSDC, DIR_UP } from '../config';
import { toMessage } from '../lib/errors';

// Oracle prices and question strikes carry 9 implied decimals; DUSDC carries 6. Quantity is fixed
// to the e2e value (1_000_000) — a single position; sizing UX is out of P1 scope.
const PRICE_SCALE = 1_000_000_000n;
const DUSDC_DECIMALS = 6;
const QUANTITY = 1_000_000n;

function fmtUsd(v: bigint): string {
  return `$${Number(v / PRICE_SCALE).toLocaleString('en-US')}`;
}

// Parse a human DUSDC amount ("50", "12.5") to base units (6 decimals), rejecting anything that
// isn't a clean positive number with ≤6 fractional digits. Returns null on invalid input.
function parseDusdc(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > DUSDC_DECIMALS) return null;
  const units = BigInt(whole) * 10n ** BigInt(DUSDC_DECIMALS) + BigInt((frac + '000000').slice(0, DUSDC_DECIMALS));
  return units > 0n ? units : null;
}

export default function Pick({
  market,
  profileId,
  managerId,
  onDone,
  onBack,
}: {
  market: Market;
  profileId: string;
  managerId: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [stake, setStake] = useState('50');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // In-flight mutex: a disabled button can't stop a double-click that fires before React
  // re-renders, which would submit two picks (the 2nd aborts EAlreadyPicked, but wastes a signature).
  const inFlight = useRef(false);
  // Live account ref: the `account` captured in submit()'s closure is a snapshot, so comparing it
  // to itself can never detect a mid-flow wallet switch. This ref is refreshed every render.
  const accountRef = useRef(account);
  accountRef.current = account;

  // Load the published question for THIS market so the UI shows the side/strike place_pick will
  // actually bind to on-chain — never a guessed or hardcoded direction. No question → can't pick.
  const question = useQuery({
    queryKey: ['open-question', market.oracleId],
    queryFn: () => findOpenQuestion(client, market.oracleId, market.expiry),
  });
  const q = question.data;
  const dirLabel = q ? (q.direction === DIR_UP ? 'UP' : 'DOWN') : '—';

  async function submit() {
    if (!account || inFlight.current || !q) return;
    inFlight.current = true;
    setBusy(true);
    setErr(undefined);
    const addr = account.address;
    try {
      const amount = parseDusdc(stake);
      if (amount == null) throw new Error('Enter a valid amount (max 6 decimals).');

      // Re-read the question right before signing — it may have expired or been resolved since the
      // page loaded; the cached `q` could be stale. Refuse to sign if the live question differs from
      // the one the user saw (different id/side/strike) — otherwise they'd authorise a pick on terms
      // they never reviewed. Refresh the display and ask them to confirm again.
      const fresh = await findOpenQuestion(client, market.oracleId, market.expiry);
      if (!fresh) throw new Error('No open question for this market yet — ask the operator to publish one.');
      if (fresh.questionId !== q.questionId || fresh.direction !== q.direction || fresh.strike !== q.strike) {
        question.refetch();
        throw new Error('This market just changed — review the updated question and try again.');
      }

      // Gather every DUSDC coin (paginated) so buildPlacePick can merge-then-split; guard
      // insufficient funds BEFORE building so the user sees a clear message, not a split abort.
      const coins = await fetchDusdcCoins(client, addr, DUSDC);
      const total = coins.reduce((s, c) => s + c.balance, 0n);
      if (!coins.length || total < amount) throw new Error('Not enough DUSDC for this stake.');

      // Account-switch guard: the reads above are async; if the wallet changed underneath us the
      // tx would be signed by — and the profile/coins would belong to — a different address. Compare
      // the LIVE account (ref), not the closure snapshot, which can never differ from `addr`.
      if (accountRef.current?.address !== addr) throw new Error('Account changed — try again.');

      const tx = buildPlacePick({
        oracleId: market.oracleId,
        profileId,
        managerId,
        questionId: fresh.questionId,
        quantity: QUANTITY,
        maxCost: amount,
        amount,
        coinIds: coins.map((c) => c.objectId),
      });

      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(JSON.stringify(res.FailedTransaction.status?.error ?? 'transaction failed'));
      await client.waitForTransaction({ digest: res.Transaction.digest });
      onDone();
    } catch (e) {
      setErr(toMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-xl mx-auto grid gap-4">
      <button onClick={onBack} className="text-sm text-gray-500 text-left hover:underline" disabled={busy}>
        ← Back to markets
      </button>

      <div className="border rounded p-4">
        <div className="font-medium text-lg">
          BTC · {dirLabel}
          {q && <> · strike {fmtUsd(q.strike)}</>}
        </div>
        <div className="text-sm text-gray-500">
          spot {fmtUsd(market.spot)} · expires {new Date(Number(market.expiry)).toLocaleTimeString()}
        </div>
      </div>

      {question.isLoading && <div className="text-sm text-gray-500">Checking for an open question…</div>}
      {question.error && (
        <div className="text-sm text-red-600">Failed to load question: {String(question.error)}</div>
      )}
      {!question.isLoading && !question.error && !q && (
        <div className="text-sm text-amber-700">
          No open question for this market yet — ask the operator to publish one.
        </div>
      )}

      {q && (
        <>
          <label className="grid gap-1">
            <span className="text-sm text-gray-600">Stake (DUSDC)</span>
            <input
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              disabled={busy}
              className="border rounded p-2 font-mono disabled:opacity-50"
            />
            <span className="text-xs text-gray-400">
              The full amount is deposited; only the live premium is consumed — the rest stays
              withdrawable.
            </span>
          </label>

          <button
            onClick={submit}
            disabled={busy}
            className="border rounded p-3 font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? 'Placing pick…' : `Place ${dirLabel} pick`}
          </button>
        </>
      )}

      {err && <div className="text-sm text-red-600">{err}</div>}
    </div>
  );
}
