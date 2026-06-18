# M1-REVISIT — Re-target league CPI to the deployed OracleSVI predict architecture

_Date: 2026-06-17 · Scope: re-target + 順手精簡 · Track: plan_

## Problem

M1 (2026-06-15) built the `league` predict CPI against deepbookv3 **source HEAD** (`rev=main`,
commit `9f69985`), which had been restructured into `expiry_market` / `market_oracle` /
`protocol_config` / `pyth_source` modules. But the predict package **deployed and live on testnet**
(`0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`, the one the predict indexer
serves — 4232 oracles, all `oracle::OracleSVI`) is the **older monolithic architecture**.

Consequences:
- `Move.lock` has no `published-at` for `deepbook_predict` → the restructured version is not deployed
  on testnet → `league` cannot be published and its object types don't match any live market.
- All live markets are `oracle::OracleSVI` + `market_key::MarketKey` + `predict::Predict`, not the
  `MarketOracle`/`ExpiryMarket` types the M1 code imports.

This is a repeat of an earlier lesson: "real type is `MarketOracle`" was verified against *source*,
not against the *deployed* package. The 2026-05-31 spec (F1–F5, OracleSVI/MarketKey) was actually
correct for the live chain.

## Decision

**Option A — rewrite the league CPI to target the deployed OracleSVI architecture.** The three M1
security properties all still hold; the deployed API is in fact simpler (no proof / config / pyth /
leverage objects). Option B (self-deploy the restructured protocol) is unrealistic for a hackathon;
Option C (skip the e2e) loses on-chain proof.

## Deployed ABI (on-chain verified, package `0xf5ea2b…`)

```
predict::create_manager(ctx) -> ID                         // create + share a PredictManager
predict::mint<DUSDC>(&mut Predict, &mut PredictManager, &OracleSVI, MarketKey, qty: u64, &Clock, ctx)
predict::redeem_permissionless<DUSDC>(&mut Predict, &mut PredictManager, &OracleSVI, MarketKey, u64, &Clock, ctx)
predict_manager::deposit<DUSDC>(&mut PredictManager, Coin<DUSDC>, &TxContext)
predict_manager::balance<DUSDC>(&PredictManager) -> u64
predict_manager::withdraw<DUSDC>(&mut PredictManager, u64, &mut TxContext) -> Coin<DUSDC>
predict_manager::position(&PredictManager, MarketKey) -> u64
oracle::is_settled(&OracleSVI) -> bool
oracle::settlement_price(&OracleSVI) -> Option<u64>
oracle::id(&OracleSVI) -> ID
market_key::new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool) -> MarketKey   // Copy+Drop+Store
```

`mint` internals (commit `19f86eb`): asserts `ctx.sender() == manager.owner()`, `quantity > 0`,
`assert_key_matches(oracle, key)` (oracle_id + expiry + on-grid strike), `assert_live_oracle` (not
expired/settled); computes `cost = ask_price * quantity`, withdraws `cost` from the manager balance.
→ measured DUSDC balance delta == `cost` == real at-risk cash. `mint` returns nothing (no order_id);
position is keyed by `MarketKey` and tracked in `manager` (`increase_position(key, quantity)`).

## Security properties → deployed mapping

| M1 property | deployed mechanism | change |
|---|---|---|
| Real stake = at-risk cash (#1) | `deposit` → `balance()` delta around `mint` (= `cost`) | unchanged |
| On-chain settlement price (#2/F8) | `oracle.is_settled()` + `oracle.settlement_price()` Option unwrap | unwrap replaces getter |
| Hold-to-settle anti early-close | `predict_manager::position(manager, MarketKey) > 0` | replaces order_id check |

## Build / Move.toml

- Pin `deepbook_predict` and its transitive `deepbook` to `rev = "19f86ebad9c6371c4f5c07229faabb2020dc691c"`
  (last predict-touching commit before the 2026-04-16 testnet deploy; module set matches deployed).
- `[dep-replacements.testnet]`:
  - `deepbook_predict` → `published-at` / `original-id` = `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
  - `deepbook` → `published-at` = deployed testnet deepbook package id (resolve during plan)
- **Remove** the `pyth_lazer` and `wormhole` dep-replacements — the old predict only depends on
  `deepbook`; it does not use pyth/wormhole.
- `dusdc` dep → resolve to the deployed DUSDC package (type `0xe95040…::dusdc::DUSDC`); confirm
  published-at source during plan.
- Publish with `--skip-dependency-verification` (layout matches deployed; runtime links via published-at).

## league.move changes

### Imports
Drop `expiry_market`, `market_oracle`, `protocol_config`, `pyth_source`. Add `predict::Predict`,
`oracle::OracleSVI`, `market_key::{Self, MarketKey}`. Keep `predict_manager::PredictManager`,
`dusdc::dusdc::DUSDC`.

### Data model
- `Question`: unchanged. (Confirm `expiry_ms` and `OracleSVI.expiry()` share the same unit — ms —
  so `MarketKey.expiry` matches `assert_key_matches`.)
- `Pick`: replace `order_id: u256` with `market_key: MarketKey`. Keep `predict_manager: ID`.

### `place_pick`
```
place_pick(league, profile, predict: &mut Predict, manager: &mut PredictManager,
           oracle: &OracleSVI, question_id, quantity, stake_coin: Coin<DUSDC>, clock, ctx)
```
Removed params: `config`, `pyth`, `leverage`, `lower_strike`, `higher_strike`, and the
`generate_proof_as_owner` call. Flow:
1. guards: `!paused`, `questions.contains(question_id)`, `object::id(manager) == profile.predict_manager` (EManagerMismatch)
2. read `(direction, strike, oracle_id, expiry_ms)` from question; `now < expiry_ms` (EQuestionClosed)
3. `assert oracle.id() == oracle_id` (EOracleMismatch)
4. `key = market_key::new(oracle_id, expiry_ms, strike, direction == DIR_UP)`
5. `stat.open_picks` not already containing question_id (EAlreadyPicked); stat exists (ENoProfileStat)
6. `manager.deposit(stake_coin, ctx)`; `bal_before = manager.balance()`
7. `predict::mint<DUSDC>(predict, manager, oracle, key, quantity, clock, ctx)`
8. `bal_after = manager.balance()`; `assert bal_before > bal_after` (EZeroStake); `cost = bal_before - bal_after`
9. `book_pick(stat, player, question_id, direction, cost, key, predict_manager, now)`

### `settle_pick`
```
settle_pick(league, manager: &PredictManager, oracle: &OracleSVI,
            profile_addr, question_id, clock)
```
Removed param: `market: &ExpiryMarket`. Flow:
1. `questions.contains` (EQuestionNotFound); `now >= expiry_ms` (ENotExpired)
2. `assert oracle.id() == q.oracle_id` (EOracleMismatch)
3. `assert oracle.is_settled()` (EOracleNotSettled)
4. `price = oracle.settlement_price()`; if `none` → abort EOracleNotSettled; else unwrap
5. stat exists (ENoProfileStat); `open_picks.contains(question_id)` (EAlreadySettled)
6. `key = market_key::new(...)` from question; `assert manager == pick.predict_manager` (EManagerMismatch)
7. **`assert manager.position(key) > 0` (EPositionClosed)** — hold-to-settle guard
8. `book_settle(league, profile_addr, question_id, strike, direction, price)`

PTB ordering contract: `league::settle_pick` (reads `position > 0`) must run **before** the sibling
`predict::redeem_permissionless` (which removes the position) in the same PTB.

### Errors
Remove `EMarketMismatch` (15) — there is no `ExpiryMarket` object to bind. Leave the remaining codes
unchanged for stability.

## Tests

Keep the `book_pick` / `book_settle` accounting seam and the `place_pick_for_testing` /
`settle_pick_for_testing` logic-layer wrappers — `OracleSVI`/`Predict` still cannot be constructed in
unit tests, so the predict-coupled parts (real cost delta, `position` hold) are covered by the Task 6
testnet e2e. Adapt test fixtures: `order_id: 0` → a dummy `MarketKey`. **Maintain 22/22 passing.**
Re-run the Move review chain (move-code-quality → sui-security-guard → sui-red-team) on the diff.

## Task 6 — testnet e2e (after the rewrite)

`scripts/m1_e2e.ts` using `@mysten/sui` (gRPC client). Resources are ready: active address
`0x1509b5fdf09296b2cf749a710e36da06f5693ccd5b2144ad643b3a895abcbc4c` (≈22 SUI, ≈490 DUSDC); live BTC
`OracleSVI` markets cadence every 15 min via the predict indexer
(`https://predict-server.testnet.mystenlabs.com/oracles`).

Flow: `predict::create_manager` → pick a near-expiry active BTC OracleSVI (read oracle_id / expiry /
min_strike / tick from indexer) → `publish_question` → `place_pick` (real DUSDC) and assert
`PickPlaced.stake > 0` → wait past expiry until the oracle settles (a few minutes) → `settle_pick`
and assert win/points → negative paths: settle after early redeem aborts `EPositionClosed`, settle
against an unsettled oracle aborts `EOracleNotSettled`.

## Open items for the plan

- Resolve deployed `deepbook` testnet package id (for `deepbook.published-at`) and the DUSDC package
  published-at source.
- Confirm `MarketKey.expiry` unit (ms) vs `OracleSVI.expiry()`; align `Question.expiry_ms`.
- Confirm a viable on-grid `strike` (oracle `min_strike` + `tick_size` grid) and a minimum `quantity`
  that yields `cost > 0` (avoid `EZeroStake`) for the e2e.
- Confirm the oracle must be `status active` at place-pick time (`assert_live_oracle`).
