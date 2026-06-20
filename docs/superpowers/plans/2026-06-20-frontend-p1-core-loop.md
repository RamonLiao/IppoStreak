# PredictLeague Frontend P1 (Core Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the demoable core loop — Google/Enoki zkLogin → auto-onboard → see live BTC markets → place a pick → see settlement/points — as a Vite+React dApp wrapping the proven `scripts/m1_e2e.ts` PTBs.

**Architecture:** New `app/` Vite+React+TS project beside `move/`. Enoki wallets registered via the wallet standard; dapp-kit's `useSignAndExecuteTransaction` handles gas sponsorship automatically (no manual `createSponsoredTransaction`). One prerequisite Move change (`create_profile_open`) lets a pure client-side zkLogin user self-onboard. Reads via dapp-kit JSON-RPC `SuiClient` + the predict indexer.

**Tech Stack:** Vite, React 18, TypeScript, `@mysten/dapp-kit`, `@mysten/enoki`, `@mysten/sui`, `@tanstack/react-query`, Tailwind.

## Global Constraints

- Deployed `predict_league` pkg (pre-upgrade): `0xc76cfc044354aab402cfd007c866a6ba95546bd35783dc251bc28b4cd467e250`. **Task 1 upgrades it → record the NEW package id into `app/src/config.ts`; all PTB targets use the new id, but shared objects (League/SubRegistry/caps) keep their existing ids (upgrade does not re-run `init`).**
- Predict pkg: `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
- Predict singleton (Shared): `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`
- DUSDC type: `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC`
- Clock: `0x6`. Indexer: `https://predict-server.testnet.mystenlabs.com/oracles`
- Network: testnet only. SDK: `@mysten/sui` (`Transaction`, not `TransactionBlock`).
- `DIR_UP = 0` (win if settlement_price >= strike), `DIR_DOWN = 1`. expiry unit = ms.
- Move review: Move changes MUST pass move-code-quality → sui-security-guard → sui-red-team and `sui move test` before upgrade (CLAUDE.md: no generic reviewer on .move).
- Existing League/SubRegistry/AdminCap/VerifierCap ids come from the original publish output — locate them (publish tx objectChanges or `move-notes.md`) and put them in `config.ts`.
- PTB argument order MUST mirror `scripts/m1_e2e.ts` exactly.

---

### Task 1: Move `create_profile_open` (ungated onboarding entry)

**Files:**
- Modify: `move/sources/league.move` (add fn after `create_profile_and_keep`, ~line 297)
- Test: `move/tests/league_tests.move` (add two tests)

**Interfaces:**
- Produces: `public entry fun create_profile_open(reg: &mut SubRegistry, league: &mut League, sub_commit: vector<u8>, predict_manager: ID, clock: &Clock, ctx: &mut TxContext)` — creates a `PlayerProfile`, registers `sub_commit` in `SubRegistry` (dedup → `ESubAlreadyRegistered`), transfers profile to `ctx.sender()`. No `VerifierCap`.

- [ ] **Step 1: Write the failing tests**

In `move/tests/league_tests.move`, add:

```move
// ===== Open onboarding (frontend self-serve, no VerifierCap) =====

#[test]
fun test_create_profile_open_registers_and_transfers() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));

    league::create_profile_open(&mut reg, &mut league, b"openSub", dummy_oracle(), &clock, ts::ctx(&mut sc));

    clock::destroy_for_testing(clock);
    ts::return_shared(reg);
    ts::return_shared(league);
    // Profile was transferred to sender; confirm it is now owned by ADMIN.
    ts::next_tx(&mut sc, ADMIN);
    let profile = ts::take_from_sender<league::PlayerProfile>(&sc);
    ts::return_to_sender(&sc, profile);
    ts::end(sc);
}

#[test]
#[expected_failure(abort_code = ::predict_league::league::ESubAlreadyRegistered)]
fun test_create_profile_open_dedup_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));

    league::create_profile_open(&mut reg, &mut league, b"dupSub", dummy_oracle(), &clock, ts::ctx(&mut sc));
    league::create_profile_open(&mut reg, &mut league, b"dupSub", dummy_oracle(), &clock, ts::ctx(&mut sc)); // aborts

    clock::destroy_for_testing(clock);
    ts::return_shared(reg);
    ts::return_shared(league);
    ts::end(sc);
}
```

> If `ESubAlreadyRegistered` / `PlayerProfile` are not visible to the test module, make them test-visible the same way existing tests reference them (the existing `test_sub_uniqueness_aborts` uses `#[expected_failure]` with no code — if the named-code form fails to compile, fall back to bare `#[expected_failure]` to match the existing convention).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd move && sui move test create_profile_open`
Expected: FAIL — `create_profile_open` not defined.

- [ ] **Step 3: Add the implementation**

In `move/sources/league.move`, immediately after `create_profile_and_keep` (after line 297):

```move
/// Open onboarding entry (frontend self-serve): create a profile WITHOUT a `VerifierCap` and
/// deliver it to the caller. Used by the zkLogin dApp where the user cannot reference the
/// admin-owned `VerifierCap`. Sybil resistance still holds via (a) `SubRegistry` dedup on
/// `sub_commit` (the frontend passes the caller's zkLogin address bytes → one profile per
/// derived address) and (b) stake-weighted scoring (points require real at-risk DUSDC).
/// The gated `create_profile`/`create_profile_and_keep` remain for the D5 verified path.
public entry fun create_profile_open(
    reg: &mut SubRegistry,
    league: &mut League,
    sub_commit: vector<u8>,
    predict_manager: ID,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!reg.used.contains(sub_commit), ESubAlreadyRegistered);
    let uid = object::new(ctx);
    let profile_addr = object::uid_to_address(&uid);
    reg.used.add(sub_commit, profile_addr);

    if (!league.stats.contains(profile_addr)) {
        league.stats.add(profile_addr, new_stat(ctx));
    };

    event::emit(ProfileCreated { profile: profile_addr, predict_manager });
    transfer::transfer(
        PlayerProfile {
            id: uid,
            owner_sub_commit: sub_commit,
            predict_manager,
            created_ms: clock::timestamp_ms(clock),
        },
        ctx.sender(),
    );
}
```

- [ ] **Step 4: Run tests + full suite**

Run: `cd move && sui move test`
Expected: PASS — previous 22 tests + 2 new (24 total).

- [ ] **Step 5: Move review chain**

Run the three skills on the diff (per CLAUDE.md): `move-code-quality` → `sui-security-guard` → `sui-red-team`. The red-team focus: does the ungated path open any abuse beyond documented sybil? Fix any HIGH; record verdict in `move-notes.md`.

- [ ] **Step 6: Build + upgrade + record ids**

```bash
cd move && sui move build
# Upgrade (preserves League/SubRegistry/caps). Needs the UpgradeCap id from the original publish.
sui client upgrade --upgrade-capability <UPGRADE_CAP_ID> --gas-budget 500000000
```
Expected: success. Copy the new package id from objectChanges. If no UpgradeCap exists, fresh-publish instead (new package + new League/SubRegistry/caps via re-run `init`) and record ALL new ids.

- [ ] **Step 7: Commit**

```bash
git add move/sources/league.move move/tests/league_tests.move move-notes.md
git commit -m "feat(move): add create_profile_open ungated onboarding entry + tests"
```

---

### Task 2: App scaffold + Enoki providers + Login page

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json`, `app/index.html`, `app/tailwind.config.js`, `app/postcss.config.js`, `app/.env.example`
- Create: `app/src/main.tsx`, `app/src/App.tsx`, `app/src/index.css`
- Create: `app/src/config.ts`
- Create: `app/src/lib/enoki.tsx`
- Create: `app/src/pages/Login.tsx`

**Interfaces:**
- Produces: `config` object (all on-chain ids + env), `RegisterEnokiWallets` component, app shell rendering `ConnectButton` and routing to Login when disconnected.

- [ ] **Step 1: Scaffold Vite React-TS + deps**

```bash
cd app 2>/dev/null || (cd .. && npm create vite@latest app -- --template react-ts && cd app)
npm install @mysten/dapp-kit @mysten/enoki @mysten/sui @tanstack/react-query
npm install -D tailwindcss postcss autoprefixer && npx tailwindcss init -p
```

- [ ] **Step 2: Write `app/src/config.ts`**

```typescript
export const NETWORK = 'testnet' as const;
export const PKG = import.meta.env.VITE_PKG as string;          // new pkg id from Task 1 upgrade
export const LEAGUE = import.meta.env.VITE_LEAGUE as string;
export const SUB_REGISTRY = import.meta.env.VITE_SUB_REGISTRY as string;
export const PREDICT = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
export const PREDICT_SINGLETON = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
export const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
export const CLOCK = '0x6';
export const INDEXER = 'https://predict-server.testnet.mystenlabs.com/oracles';
export const ENOKI_API_KEY = import.meta.env.VITE_ENOKI_API_KEY as string;
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
```

Write `app/.env.example` with the `VITE_*` keys (empty values) and a note to copy to `.env.local`.

- [ ] **Step 3: Tailwind wiring**

In `app/tailwind.config.js` set `content: ['./index.html', './src/**/*.{ts,tsx}']`. In `app/src/index.css` put the three `@tailwind base; @tailwind components; @tailwind utilities;` lines.

- [ ] **Step 4: Write `app/src/lib/enoki.tsx`**

```tsx
import { SuiClientProvider, WalletProvider, createNetworkConfig, useSuiClientContext } from '@mysten/dapp-kit';
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki';
import { getFullnodeUrl } from '@mysten/sui/client';
import { useEffect } from 'react';
import { ENOKI_API_KEY, GOOGLE_CLIENT_ID } from '../config';

const { networkConfig } = createNetworkConfig({ testnet: { url: getFullnodeUrl('testnet') } });

function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();
  useEffect(() => {
    if (!isEnokiNetwork(network)) return;
    const { unregister } = registerEnokiWallets({
      apiKey: ENOKI_API_KEY,
      providers: { google: { clientId: GOOGLE_CLIENT_ID } },
      client, network,
    });
    return unregister;
  }, [client, network]);
  return null;
}

export function SuiProviders({ children }: { children: React.ReactNode }) {
  return (
    <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
      <RegisterEnokiWallets />
      <WalletProvider autoConnect>{children}</WalletProvider>
    </SuiClientProvider>
  );
}
```

- [ ] **Step 5: Write `app/src/main.tsx` + `App.tsx` + `Login.tsx`**

`main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mysten/dapp-kit/dist/index.css';
import './index.css';
import { SuiProviders } from './lib/enoki';
import App from './App';

const qc = new QueryClient();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <SuiProviders><App /></SuiProviders>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

`App.tsx`:
```tsx
import { useCurrentAccount } from '@mysten/dapp-kit';
import Login from './pages/Login';

export default function App() {
  const account = useCurrentAccount();
  if (!account) return <Login />;
  return <div className="p-6">Connected: {account.address}</div>; // replaced in later tasks
}
```

`pages/Login.tsx`:
```tsx
import { ConnectButton } from '@mysten/dapp-kit';

export default function Login() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">PredictLeague</h1>
      <p className="text-gray-500">Sign in with Google to play.</p>
      <ConnectButton />
    </div>
  );
}
```

- [ ] **Step 6: Verify build + dev server**

Run: `cd app && npm run build`
Expected: type-checks and builds with no errors.
Run: `npm run dev` and load the page — Login renders with a ConnectButton (manual check; full Google login verified in Task 7).

- [ ] **Step 7: Commit**

```bash
git add app && git commit -m "feat(app): scaffold Vite+React+dapp-kit+Enoki + Login"
```

---

### Task 3: Reads — JSON-RPC verify + markets

**Files:**
- Create: `app/src/lib/reads.ts`
- Create: `app/src/hooks/useMarkets.ts`
- Modify: `app/src/App.tsx` (render a Markets list when connected)
- Create: `app/src/pages/Markets.tsx`

**Interfaces:**
- Consumes: `config` from Task 2.
- Produces: `type Market = { oracleId: string; expiry: bigint; strike: bigint; asset: string; minStrike: bigint; tick: bigint }`, `async function fetchMarkets(client: SuiClient): Promise<Market[]>`, `useMarkets()` react-query hook.

- [ ] **Step 1: A2 — verify testnet JSON-RPC reads still serve**

Run: `curl -s -X POST https://fullnode.testnet.sui.io:443 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'`
Expected: a JSON result with a chain id (not an error/404). If it errors, STOP and switch `reads.ts` to the GraphQL beta endpoint before continuing (spec A2).

- [ ] **Step 2: Write `reads.ts` market fetcher (port `pickOracle` from e2e)**

```typescript
import type { SuiClient } from '@mysten/sui/client';
import { INDEXER } from '../config';

export type Market = {
  oracleId: string; expiry: bigint; strike: bigint; asset: string;
  minStrike: bigint; tick: bigint; spot: bigint;
};

export async function fetchMarkets(client: SuiClient): Promise<Market[]> {
  const all = await (await fetch(INDEXER)).json();
  const now = Date.now();
  const live = all.filter((o: any) =>
    o.underlying_asset === 'BTC' && o.status === 'active' &&
    o.settlement_price == null && Number(o.expiry) > now + 120_000);
  live.sort((a: any, b: any) => Number(a.expiry) - Number(b.expiry));
  const out: Market[] = [];
  for (const o of live.slice(0, 10)) {
    const obj = await client.getObject({ id: o.oracle_id, options: { showContent: true } });
    const spot = BigInt((obj.data?.content as any).fields.prices.fields.spot);
    const minStrike = BigInt(o.min_strike), tick = BigInt(o.tick_size);
    const strike = minStrike + ((spot - minStrike) / tick) * tick; // on-grid ATM
    out.push({ oracleId: o.oracle_id, expiry: BigInt(o.expiry), strike, asset: o.underlying_asset, minStrike, tick, spot });
  }
  return out;
}
```

- [ ] **Step 3: Write `useMarkets` hook**

```typescript
import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { fetchMarkets } from '../lib/reads';

export function useMarkets() {
  const client = useSuiClient();
  return useQuery({ queryKey: ['markets'], queryFn: () => fetchMarkets(client), refetchInterval: 30_000 });
}
```

- [ ] **Step 4: Write `pages/Markets.tsx` + wire into App**

```tsx
import { useMarkets } from '../hooks/useMarkets';

export default function Markets({ onPick }: { onPick: (oracleId: string) => void }) {
  const { data, isLoading } = useMarkets();
  if (isLoading) return <div className="p-6">Loading markets…</div>;
  return (
    <div className="p-6 grid gap-3">
      <h2 className="text-xl font-semibold">Live BTC Markets</h2>
      {data?.map((m) => (
        <button key={m.oracleId} onClick={() => onPick(m.oracleId)}
          className="border rounded p-3 text-left hover:bg-gray-50">
          BTC · strike {m.strike.toString()} · spot {m.spot.toString()} ·
          expires {new Date(Number(m.expiry)).toLocaleTimeString()}
        </button>
      ))}
    </div>
  );
}
```
In `App.tsx`, when connected render `<Markets onPick={...} />` (route to Pick page in Task 5; for now `console.log`).

- [ ] **Step 5: Verify build + live data**

Run: `cd app && npm run build` (PASS). Then `npm run dev`, log in flow not required for reads — confirm the markets list renders real BTC oracles (manual check against the indexer).

- [ ] **Step 6: Commit**

```bash
git add app && git commit -m "feat(app): market reads (indexer + oracle) + Markets page + JSON-RPC verify"
```

---

### Task 4: Onboarding (create_manager + create_profile_open)

**Files:**
- Create: `app/src/lib/ptb.ts`
- Create: `app/src/hooks/useOnboard.ts`
- Create: `app/src/hooks/useProfile.ts`
- Modify: `app/src/App.tsx` (gate: onboard before showing Markets; show DUSDC funding state)

**Interfaces:**
- Consumes: `config`, `useSignAndExecuteTransaction`, `useSuiClient`, `useCurrentAccount`.
- Produces: `buildCreateManager(): Transaction`, `buildCreateProfileOpen(managerId, subCommit): Transaction`, `useProfile()` → `{ profileId, managerId } | null`, `useOnboard()` → `{ onboard(): Promise<void>, status }`, `useDusdcBalance()`.

- [ ] **Step 1: Write onboarding PTB builders in `ptb.ts`**

```typescript
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import { PKG, PREDICT, LEAGUE, SUB_REGISTRY, CLOCK } from './config';

export function buildCreateManager(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PREDICT}::predict::create_manager` });
  return tx;
}

// sub_commit = the caller's zkLogin address bytes (one profile per derived address).
export function buildCreateProfileOpen(managerId: string, address: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::league::create_profile_open`,
    arguments: [
      tx.object(SUB_REGISTRY), tx.object(LEAGUE),
      tx.pure.vector('u8', Array.from(fromHex(address))),
      tx.pure.id(managerId), tx.object(CLOCK),
    ],
  });
  return tx;
}
```

- [ ] **Step 2: Write `useProfile` (detect existing onboarding)**

```typescript
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { PKG } from '../config';

export function useProfile() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  return useQuery({
    enabled: !!account,
    queryKey: ['profile', account?.address],
    queryFn: async () => {
      const owned = await client.getOwnedObjects({
        owner: account!.address,
        filter: { StructType: `${PKG}::league::PlayerProfile` },
        options: { showContent: true },
      });
      const obj = owned.data[0];
      if (!obj) return null;
      const fields = (obj.data?.content as any).fields;
      return { profileId: obj.data!.objectId as string, managerId: fields.predict_manager as string };
    },
  });
}
```

- [ ] **Step 3: Write `useOnboard`**

```typescript
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { buildCreateManager, buildCreateProfileOpen } from '../lib/ptb';

export function useOnboard() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'manager' | 'profile' | 'done' | 'error'>('idle');

  async function onboard() {
    try {
      setStatus('manager');
      const mr = await signAndExecute({ transaction: buildCreateManager() });
      await client.waitForTransaction({ digest: mr.digest });
      const full = await client.getTransactionBlock({ digest: mr.digest, options: { showObjectChanges: true } });
      const manager = (full.objectChanges ?? []).find(
        (c: any) => c.type === 'created' && c.objectType.endsWith('::predict_manager::PredictManager')) as any;
      const managerId = manager.objectId as string;

      setStatus('profile');
      const pr = await signAndExecute({ transaction: buildCreateProfileOpen(managerId, account!.address) });
      await client.waitForTransaction({ digest: pr.digest });
      setStatus('done');
      qc.invalidateQueries({ queryKey: ['profile', account!.address] });
    } catch (e) { setStatus('error'); throw e; }
  }
  return { onboard, status };
}
```

- [ ] **Step 4: DUSDC balance hook**

```typescript
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { DUSDC } from '../config';

export function useDusdcBalance() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  return useQuery({
    enabled: !!account,
    queryKey: ['dusdc', account?.address],
    queryFn: async () => BigInt((await client.getBalance({ owner: account!.address, coinType: DUSDC })).totalBalance),
    refetchInterval: 10_000,
  });
}
```

- [ ] **Step 5: Gate in App.tsx**

```tsx
// when account exists: if !profile → show "Create account" button calling onboard();
// else if dusdc === 0n → show "Waiting for DUSDC funding…" (admin transfers manually);
// else → render Markets.
```
Implement that branching in `App.tsx` using `useProfile`, `useOnboard`, `useDusdcBalance`.

- [ ] **Step 6: Verify build**

Run: `cd app && npm run build`
Expected: PASS. (Live onboarding verified in Task 7.)

- [ ] **Step 7: Commit**

```bash
git add app && git commit -m "feat(app): Enoki onboarding (create_manager + create_profile_open) + funding gate"
```

---

### Task 5: place_pick PTB + Pick page

**Files:**
- Modify: `app/src/lib/ptb.ts` (add `buildPlacePick`)
- Create: `app/src/pages/Pick.tsx`
- Create: `app/src/hooks/usePublishQuestion.ts` (demo helper: ensure a question exists for the chosen market — see note)
- Modify: `app/src/App.tsx` (route Markets → Pick)

**Interfaces:**
- Consumes: `Market` (Task 3), `{ profileId, managerId }` (Task 4), `useSignAndExecuteTransaction`.
- Produces: `buildPlacePick({ profileId, managerId, oracleId, questionId, quantity, maxCost, stakeCoinId, splitAmount }): Transaction`.

> **Question availability (demo):** `place_pick` requires a published `question_id` bound to the market. Publishing is `LeagueAdminCap`-gated (Admin page is P3). For P1, expose a small admin-key path: read `QuestionPublished` events to find an open question for the chosen oracle; if none, the demo operator publishes one via the existing `scripts/m1_e2e.ts` flow or a one-off script. Document this in the Pick page as "no open question yet". Do NOT put AdminCap in the zkLogin app.

- [ ] **Step 1: Add `buildPlacePick` to `ptb.ts`**

```typescript
import { PREDICT_SINGLETON } from './config';

export function buildPlacePick(p: {
  oracleId: string; profileId: string; managerId: string;
  questionId: string; quantity: bigint; maxCost: bigint;
  primaryCoinId: string; splitAmount: bigint;
}): Transaction {
  const tx = new Transaction();
  const [stakeCoin] = tx.splitCoins(tx.object(p.primaryCoinId), [tx.pure.u64(p.splitAmount)]);
  tx.moveCall({
    target: `${PKG}::league::place_pick`,
    typeArguments: [],
    arguments: [
      tx.object(LEAGUE), tx.object(p.profileId), tx.object(PREDICT_SINGLETON), tx.object(p.managerId),
      tx.object(p.oracleId), tx.pure.u64(p.questionId), tx.pure.u64(p.quantity),
      tx.pure.u64(p.maxCost), stakeCoin, tx.object(CLOCK),
    ],
  });
  return tx;
}
```
(Import `LEAGUE`, `CLOCK`, `PKG`, `PREDICT_SINGLETON` at top of `ptb.ts`.)

- [ ] **Step 2: Find an open question for the market**

Add to `reads.ts`:
```typescript
import { PKG } from '../config';
export async function findOpenQuestion(client: SuiClient, oracleId: string): Promise<string | null> {
  const ev = await client.queryEvents({
    query: { MoveEventType: `${PKG}::league::QuestionPublished` }, order: 'descending', limit: 50,
  });
  const hit = ev.data.find((e: any) => e.parsedJson.oracle_id === oracleId);
  return hit ? (hit.parsedJson as any).question_id as string : null;
}
```

- [ ] **Step 3: Write `pages/Pick.tsx`**

```tsx
import { useState } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { buildPlacePick } from '../lib/ptb';
import { findOpenQuestion, type Market } from '../lib/reads';
import { DUSDC } from '../config';
import { toMessage } from '../lib/errors';

export default function Pick({ market, profileId, managerId, onDone }: {
  market: Market; profileId: string; managerId: string; onDone: () => void;
}) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [stake, setStake] = useState('50');      // DUSDC (6 decimals)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  async function submit() {
    setBusy(true); setErr(undefined);
    try {
      const qid = await findOpenQuestion(client, market.oracleId);
      if (!qid) throw new Error('No open question for this market yet — ask the operator to publish one.');
      const coins = await client.getCoins({ owner: account!.address, coinType: DUSDC });
      if (!coins.data.length) throw new Error('No DUSDC.');
      const amount = BigInt(Math.round(Number(stake) * 1_000_000));
      const tx = buildPlacePick({
        oracleId: market.oracleId, profileId, managerId, questionId: qid,
        quantity: 1_000_000n, maxCost: amount, primaryCoinId: coins.data[0].coinObjectId, splitAmount: amount,
      });
      const r = await signAndExecute({ transaction: tx });
      await client.waitForTransaction({ digest: r.digest });
      onDone();
    } catch (e: any) { setErr(toMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="p-6 max-w-md">
      <h2 className="text-xl font-semibold mb-2">Pick UP on BTC</h2>
      <p className="text-sm text-gray-500 mb-4">strike {market.strike.toString()} · max cost = stake</p>
      <label className="block mb-2">Stake (DUSDC)
        <input className="border rounded p-2 w-full" value={stake} onChange={(e) => setStake(e.target.value)} />
      </label>
      {err && <p className="text-red-600 text-sm mb-2">{err}</p>}
      <button disabled={busy} onClick={submit} className="bg-black text-white rounded px-4 py-2">
        {busy ? 'Placing…' : 'Place pick'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Route + verify build**

Wire `App.tsx`: Markets `onPick(oracleId)` → look up the `Market` → render `<Pick … />`. Run `cd app && npm run build` (PASS).

- [ ] **Step 5: Commit**

```bash
git add app && git commit -m "feat(app): place_pick PTB + Pick page + open-question lookup"
```

---

### Task 6: settle_pick + MyPicks + stats

**Files:**
- Modify: `app/src/lib/ptb.ts` (add `buildSettlePick`)
- Modify: `app/src/lib/reads.ts` (add `fetchMyStats`)
- Create: `app/src/lib/errors.ts`
- Create: `app/src/hooks/useMyStats.ts`
- Create: `app/src/pages/MyPicks.tsx`

**Interfaces:**
- Consumes: `{ profileId }`, events.
- Produces: `buildSettlePick({ oracleId, profileAddr, questionId }): Transaction`, `fetchMyStats(client, profileAddr)`, `toMessage(e): string`.

- [ ] **Step 1: Error map `errors.ts`**

```typescript
const CODES: Record<number, string> = {
  2: 'Market already closed', 3: 'Already picked this question', 4: 'Not expired yet',
  5: 'Already settled', 11: 'Oracle not settled yet', 13: 'Question not found',
  18: 'Stake was zero — pick rejected', 22: 'Slippage exceeded (cost > max)', 23: 'Oracle not active',
  1: 'This account already has a profile',
};
export function toMessage(e: any): string {
  const s = String(e?.message ?? e);
  const m = s.match(/MoveAbort.*?,\s*(\d+)\)/);
  if (m) return CODES[Number(m[1])] ?? `On-chain error ${m[1]}`;
  return s;
}
```

- [ ] **Step 2: Add `buildSettlePick`**

```typescript
export function buildSettlePick(p: { oracleId: string; profileAddr: string; questionId: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::league::settle_pick`,
    arguments: [tx.object(LEAGUE), tx.object(p.oracleId), tx.pure.address(p.profileAddr),
      tx.pure.u64(p.questionId), tx.object(CLOCK)],
  });
  return tx;
}
```

- [ ] **Step 3: `fetchMyStats` via devInspect**

```typescript
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
export async function fetchMyStats(client: SuiClient, profileAddr: string) {
  const tx = new Transaction();
  for (const fn of ['stat_points', 'stat_streak', 'stat_best_streak', 'stat_total_staked'])
    tx.moveCall({ target: `${PKG}::league::${fn}`, arguments: [tx.object(LEAGUE), tx.pure.address(profileAddr)] });
  const r = await client.devInspectTransactionBlock({ sender: profileAddr, transactionBlock: tx });
  const read = (i: number) => bcs.U64.parse(Uint8Array.from(r.results![i].returnValues![0][0])).toString();
  return { points: read(0), streak: read(1), bestStreak: read(2), totalStaked: read(3) };
}
```
(Import `LEAGUE`, `PKG`, `CLOCK` in `reads.ts`.)

- [ ] **Step 4: `useMyStats` hook + `MyPicks.tsx`**

`useMyStats`:
```typescript
import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { fetchMyStats } from '../lib/reads';
export function useMyStats(profileAddr?: string) {
  const client = useSuiClient();
  return useQuery({ enabled: !!profileAddr, queryKey: ['stats', profileAddr],
    queryFn: () => fetchMyStats(client, profileAddr!), refetchInterval: 15_000 });
}
```
`MyPicks.tsx`: show `useMyStats(profileId)` (points/streak/best/total) and a "Settle now" button per open question that calls `buildSettlePick` via `useSignAndExecuteTransaction`, surfacing `toMessage` on error (handles "oracle not settled yet" gracefully).

- [ ] **Step 5: Verify build**

Run: `cd app && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app && git commit -m "feat(app): settle_pick + MyPicks + stats (devInspect) + error map"
```

---

### Task 7: Manual testnet E2E + monkey tests

**Files:**
- Create: `app/E2E_CHECKLIST.md`
- Modify: `tasks/progress.md`, `move-notes.md` (record P1 result + new ids)

**Interfaces:** none (verification task).

- [ ] **Step 1: Configure env**

Fill `app/.env.local` with `VITE_PKG` (new), `VITE_LEAGUE`, `VITE_SUB_REGISTRY`, `VITE_ENOKI_API_KEY`, `VITE_GOOGLE_CLIENT_ID` (Enoki portal allowlists the move-call targets used by onboarding + place_pick + settle_pick).

- [ ] **Step 2: Happy path (record digests in E2E_CHECKLIST.md)**

`npm run dev`, then in the browser: (1) Google login → connected as a zkLogin address; (2) "Create account" → create_manager + create_profile_open succeed gasless; (3) admin transfers DUSDC to that address → funding gate clears; (4) ensure an open question exists for a live market (publish via script if needed); (5) place a pick → `PickPlaced.stake > 0`; (6) after expiry+settlement, "Settle now" → `PickSettled` with points; (7) MyPicks shows updated points/streak.

- [ ] **Step 3: A3 — capture place_pick gas**

From the place_pick tx effects, record `gasUsed`. Confirm it was sponsored (Enoki) and within policy. If it failed for budget/allowlist, fix in the Enoki portal and note the final budget in E2E_CHECKLIST.md.

- [ ] **Step 4: Monkey tests (per test.md)**

Exercise and record behavior: (a) place_pick before funding → blocked by gate; (b) duplicate pick same question → `EAlreadyPicked` shown as "Already picked this question"; (c) stake `0` → `EZeroStake` message; (d) settle before oracle settled → "Oracle not settled yet", no crash; (e) re-onboard same Google account (clear local state, log in again) → second `create_profile_open` aborts `ESubAlreadyRegistered`, surfaced as "This account already has a profile". Each must fail gracefully (no white screen, no unhandled rejection).

- [ ] **Step 5: Record + commit**

Update `tasks/progress.md` (P1 done, new ids, gas figure) and `move-notes.md` (create_profile_open shipped + upgrade digest). Commit:
```bash
git add app/E2E_CHECKLIST.md tasks/progress.md move-notes.md
git commit -m "test(app): P1 testnet e2e + monkey tests; record ids/gas"
```

---

## Self-Review

- **Spec coverage:** Move change (Task 1) ✓; stack/scaffold/Enoki (Task 2) ✓; reads incl. A2 (Task 3) ✓; onboarding incl. A4 (Task 4) ✓; place_pick/Pick (Task 5) ✓; settle/MyPicks/stats/error-map (Task 6) ✓; A3 gas + monkey tests (Task 7) ✓. P1 screens (Login, Markets, Pick, MyPicks) all covered. **P2 (leaderboard/badge/A5/A7) and P3 (teams/admin/A6) are intentionally separate plans.**
- **Placeholder scan:** No TBD/TODO; the only operator-dependent values (new pkg id, League/SubRegistry/UpgradeCap ids, Enoki/Google keys) are explicitly env-driven and located in Task 1/7. Question-availability for place_pick is documented, not hand-waved.
- **Type consistency:** `Market`, `{ profileId, managerId }`, `buildPlacePick`/`buildSettlePick`/`buildCreateProfileOpen` signatures, `toMessage`, `fetchMyStats` names match across tasks. PTB arg orders mirror `scripts/m1_e2e.ts`.
