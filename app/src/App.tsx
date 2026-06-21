import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Login from './pages/Login';
import Markets from './pages/Markets';
import Pick from './pages/Pick';
import type { Market } from './lib/reads';
import type { Profile } from './hooks/useProfile';
import { useProfile } from './hooks/useProfile';
import { useOnboard } from './hooks/useOnboard';
import { useDusdcBalance } from './hooks/useDusdcBalance';

export default function App() {
  const account = useCurrentAccount();
  if (!account) return <Login />;
  return (
    <div className="min-h-screen">
      <div className="p-4 font-mono text-xs text-gray-500 border-b">
        Connected: {account.address}
      </div>
      <Gate />
    </div>
  );
}

// Onboarding gate: no profile → create one; profile but unfunded → wait for DUSDC; else Markets.
function Gate() {
  const profile = useProfile();
  const dusdc = useDusdcBalance();

  if (profile.isLoading) return <div className="p-6 text-gray-500">Checking account…</div>;
  if (profile.error)
    return <div className="p-6 text-red-600">Failed to load profile: {String(profile.error)}</div>;

  if (!profile.data) return <CreateAccount />;

  return <Home profile={profile.data} unfunded={dusdc.data === 0n} />;
}

// Markets ⇄ Pick router for an onboarded player. Kept here (not a route lib) — P1 has exactly two
// screens and a single selected-market handoff.
function Home({ profile, unfunded }: { profile: Profile; unfunded: boolean }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState<Market | null>(null);

  if (picking) {
    return (
      <Pick
        market={picking}
        profileId={profile.profileId}
        managerId={profile.managerId}
        onBack={() => setPicking(null)}
        onDone={() => {
          // Pick spent DUSDC — refresh the balance banner and (Task 6) any picks view.
          qc.invalidateQueries({ queryKey: ['dusdc'] });
          setPicking(null);
        }}
      />
    );
  }

  // Funding is shown as a non-blocking banner, NOT a full-screen gate: an onboarded user must
  // always reach Markets (and, in Task 6, MyPicks/settle) even at 0 balance — otherwise spending
  // all DUSDC on a pick would lock them out of their open positions. The "needs funds" hard stop
  // belongs to the pick action (Pick.tsx), not the whole app. Banner shows only on a CONFIRMED zero.
  return (
    <>
      {unfunded && (
        <div className="p-3 bg-amber-50 text-amber-800 text-sm text-center border-b">
          Your account has no DUSDC yet — an admin needs to fund your address before you can place
          a pick. Refreshes automatically.
        </div>
      )}
      <Markets onPick={setPicking} />
    </>
  );
}

function CreateAccount() {
  const { onboard, status } = useOnboard();
  const [err, setErr] = useState<string | null>(null);
  const busy = status === 'manager' || status === 'profile';

  const label =
    status === 'manager'
      ? 'Creating trading account…'
      : status === 'profile'
        ? 'Creating profile…'
        : 'Create account';

  return (
    <div className="p-6 max-w-xl mx-auto grid gap-3">
      <h2 className="text-xl font-semibold">Welcome to PredictLeague</h2>
      <p className="text-sm text-gray-600">
        Set up your on-chain trading account and player profile. This signs two transactions
        (gas sponsored).
      </p>
      <button
        onClick={async () => {
          setErr(null);
          try {
            await onboard();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          }
        }}
        disabled={busy}
        className="border rounded p-3 font-medium hover:bg-gray-50 disabled:opacity-50"
      >
        {label}
      </button>
      {err && <div className="text-sm text-red-600">Onboarding failed: {err}</div>}
    </div>
  );
}
