# PredictLeague Frontend — Enoki zkLogin dApp (Design)

_Date: 2026-06-20 · Status: Approved (awaiting spec review) · Scope: C (full P1→P2→P3)_

## Goal

Browser dApp shell for PredictLeague, deployed `predict_league` pkg
`0xc76cfc044354aab402cfd007c866a6ba95546bd35783dc251bc28b4cd467e250` (testnet).
Players log in with Google via Enoki zkLogin (no wallet extension, gas sponsored by
Enoki), get auto-onboarded, place daily picks on live DeepBook-Predict BTC markets,
and see scoring / streaks / leaderboard / badges / teams. Admin publishes questions.

The frontend wraps the exact PTBs already proven in `scripts/m1_e2e.ts`.

## Stack

Vite + React + TypeScript + `@mysten/dapp-kit` + `@mysten/enoki` +
`@tanstack/react-query` + Tailwind. Zero custom backend (Enoki client-side testnet
flow). Brand name TBD from `BRAND_NAMES.md` before implementation.

```
app/
  src/
    main.tsx            # EnokiFlow + SuiClientProvider + WalletProvider + QueryClient
    config.ts           # PKG/LEAGUE/PREDICT/DUSDC ids, network, Enoki API key, Google client id (env)
    lib/
      enoki.ts          # registerEnokiWallets + zkLogin connect
      ptb.ts            # one builder per Move entry (onboarding / placePick / settlePick / badge / team / admin)
      reads.ts          # on-chain reads (markets / stats / leaderboard / badges / teams)
      errors.ts         # Move abort-code → human message map
    hooks/              # useMarkets, useMyStats, useLeaderboard, useOnboard, useBadges, useTeams
    pages/              # Login, Markets, Pick, MyPicks, Leaderboard, Teams, Admin
    components/
```

## Prerequisite Move change

Add `create_profile_open` to `league.move`: identical to `create_profile` but WITHOUT
the `&VerifierCap` parameter, transferring the new `PlayerProfile` to `ctx.sender()`
(like `create_profile_and_keep`). Rationale: an owned `VerifierCap` can only be
referenced by a tx its owner signs, so a pure client-side zkLogin user cannot use the
gated path. `create_profile`/`create_profile_and_keep` stay (D5 upgrade path).

Sybil resistance: `SubRegistry.used` dedups `sub_commit` (frontend sets
`sub_commit = zkLogin address bytes` → one profile per Google-derived address). Note
this per-address dedup does NOT stop multi-account sybil (Google accounts are free →
N addresses → N profiles). That is acceptable because the **core anti-sybil is
economic**: the leaderboard is stake-weighted (points bind to real at-risk DUSDC, design
#1), so a fake account earns nothing without staking real money. VerifierCap was a
belt-and-suspenders gate against non-linear rewards; dropping it on testnet demo is
acceptable. `create_profile`/`create_profile_and_keep` stay for the D5 verified path.
(If Enoki exposes the raw JWT, prefer `sub_commit = hash(iss|sub|aud)`; decided at
implementation.)

Must pass the full Move review chain (move-code-quality → sui-security-guard →
sui-red-team) and `sui move test`. Then republish/upgrade the package; record new ids.

## Onboarding flow (Enoki, zero backend)

1. `registerEnokiWallets({ apiKey, providers: { google: { clientId } }, network: 'testnet' })`
   → `ConnectButton` → Google → connected as zkLogin wallet (sender = zkLogin addr).
2. New-user detection: no `PlayerProfile` owned → auto-onboard (Enoki sponsored, gasless):
   - tx1 `predict::create_manager` → read created `PredictManager` id from objectChanges.
   - tx2 `league::create_profile_open(reg, league, sub_commit=addr, manager_id, clock)`.
   - (Combine into one PTB only if `create_manager` returns a usable id in-PTB; else two
     sequential sponsored txs. Verified at implementation.)
3. DUSDC funding: admin transfers DUSDC manually to the user's zkLogin addr (demo). UI
   shows a "waiting for funds" state; picking unlocks only when DUSDC balance > 0.

## Read strategy

- **Markets**: indexer `/oracles` (BTC, `status==='active'`, unsettled, near-expiry) +
  on-chain oracle object for `prices.spot` and on-grid strike (reuse e2e `pickOracle`).
  Which markets have a published question → `QuestionPublished` events.
- **My stats / picks**: `devInspect` on `stat_points`/`stat_streak`/`stat_best_streak`/
  `stat_total_staked` (gasless) + `PickPlaced`/`PickSettled` events.
- **Leaderboard**: paginate `getDynamicFields(League.stats table id)` → each `PlayerStat`
  (on-chain authoritative).
- **Badges**: `getOwnedObjects(owner, type=Badge)`.
- **Teams**: `TeamCreated` events + `getObject`.
- Transport: dapp-kit JSON-RPC. **RISK (A2):** SUI roadmap marks JSON-RPC removal
  ~April 2026; e2e proved testnet reads still served as of 2026-06, but this is a
  load-bearing, demo-killer assumption (dapp-kit's default `SuiClient` is JSON-RPC). P1
  task #1 is to re-verify testnet JSON-RPC reads still work; if not, route all reads
  through GraphQL beta immediately. (Echoes the 06-19 lesson: verify deployed runtime
  behavior, not just ABI.)

## Screens by phase

- **P1 (core loop)**: Login (Enoki) · Markets list · Pick page (quantity + max_cost
  slippage) · MyPicks (post-settle points / won).
- **P2 (GTM)**: Leaderboard · Badge display (mint/sync) · streak visualization.
- **P3 (social/admin)**: Teams (create / join / leader_pick / follow) · Admin
  (standard wallet holding `LeagueAdminCap` → `publish_question_for_market`).

## Contract interaction layer

`lib/ptb.ts`: one function per entry, all executed via Enoki sponsored execution.
`settle_pick` is permissionless → frontend exposes a "settle" trigger (anyone can call).
Admin page uses a separate standard wallet-connect path (AdminCap must not live on a
social-login address). **Operational prereq (A6):** the publisher key `0x1509…bc4c`
(holds `LeagueAdminCap`) must be imported into a browser wallet to drive the admin page.

Implementation-time verifications (from architecture review): (A3) measure real gas on
the first testnet `place_pick` — it touches 4 shared objects + deposit/mint CPI — and
confirm it fits the Enoki sponsor policy/budget (adjust move-call allowlist + budget in
the Enoki portal if it exceeds). (A4) confirm `create_manager` output (shared vs owned,
owner field = sender) to decide 1 vs 2 onboarding PTBs. (A5) leaderboard read =
`getObject(League)` → `stats.fields.id.id` (Table UID) → paginated `getDynamicFields`,
cached via react-query. (A7, optional P2) register Display V2 (registry `0xd`) for Badge
so it renders in wallets.

PTB shapes mirror `scripts/m1_e2e.ts` argument order exactly.

## Error handling & testing

- Move abort codes → human messages (`errors.ts`): e.g. `EMaxCostExceeded`→"slippage
  exceeded", `EAlreadyPicked`→"already picked this question today", `EZeroStake`,
  `EQuestionClosed`, `EOracleNotActive`, `ESubAlreadyRegistered`.
- Tests: existing Move suite (22/22) plus the new `create_profile_open` unit + negative
  tests. Frontend onboarding + place_pick happy path via manual testnet e2e (Google
  login → fund → pick → settle). Per `test.md`, add monkey tests: extreme quantity,
  duplicate pick, pick before funding, max_cost = 0, re-onboard same Google account.

## Decisions / open assumptions

- `sub_commit = zkLogin addr` is the default; switch to JWT-derived hash if Enoki exposes
  the id token.
- Admin uses standard wallet, not zkLogin (AdminCap custody).
- Brand name picked from `BRAND_NAMES.md` before P1 build.

## Out of scope

- Production backend / gas station (Enoki covers sponsorship on testnet).
- In-app DUSDC faucet (manual admin transfer for demo).
- GraphQL read migration.
- Off-chain team copy-trade orchestrator (separate milestone).
