# M1-REVISIT — Re-target league CPI to deployed OracleSVI predict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the `league` predict CPI to link against the **deployed** monolithic OracleSVI predict package (`0xf5ea2b…`) instead of the never-deployed restructured `MarketOracle`/`ExpiryMarket` source HEAD, so `predict_league` can publish on testnet and its object types match live markets.

**Architecture:** `place_pick` composes `predict_manager::deposit` + `predict::mint` (no proof/config/pyth/leverage objects in the deployed API) and books the measured DUSDC balance delta as stake (#1 anti-farming, unchanged). `settle_pick` reads `oracle.settlement_price(): Option<u64>` on-chain (#2/F8) and gates on `predict_manager::position(MarketKey) > 0` for hold-to-settle. The market is a `MarketKey` value over a shared `OracleSVI`; there is no per-market object.

**Tech Stack:** Sui Move 2024.beta (sui CLI 1.73.1), DeepBook Predict (deepbookv3 @ commit `19f86eb`), `@mysten/sui` (gRPC) for the testnet e2e.

## Global Constraints

- **deepbookv3 dep rev (pin exactly):** `19f86ebad9c6371c4f5c07229faabb2020dc691c` — last predict-touching commit before the 2026-04-16 testnet deploy; module set matches deployed `0xf5ea2b`.
- **Deployed package ids are the source of truth, NOT git HEAD.** Verify any CPI type/signature against the deployed ABI before relying on it.
- **Deployed testnet published-at values (verified 2026-06-18 via `sui_getObject` BCS linkage table):**
  - `deepbook_predict` published-at = original-id = `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
  - `deepbook` published-at = `0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8`, original-id = `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` (on-chain version 19)
  - `dusdc` published-at = original-id = `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a`
  - `token`/DEEP = `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8` (auto-resolved from its own `[env.testnet]` Move.lock; no dep-replacement needed)
  - `predict_math` — **no separate published-at**; compiled into `0xf5ea2b`. Do not add a dep-replacement for it. If the build asks for one, that is a signal the rev is wrong — stop and re-verify the rev.
- **predict singleton (Shared):** `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`
- **DUSDC type:** `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC`
- **Maintain the Move test suite at 22/22 passing.** `OracleSVI`/`Predict` cannot be constructed in unit tests; predict-coupled behaviour (real cost delta, `position` hold) is proven only by the Task 6 testnet e2e.
- **Move review chain is mandatory after the rewrite:** move-code-quality → sui-security-guard → sui-red-team (CLAUDE.md forbids the generic reviewer on `.move`).
- **Time unit:** `OracleSVI.expiry()` and `MarketKey.expiry` are **milliseconds** (verified: live oracle `expiry = 1781801100000`, 13-digit ms; source comment "Expiration timestamp in milliseconds"). `Question.expiry_ms` is already ms — aligned.

---

## Deployed ABI reference (verified against source @ `19f86eb`, matches deployed `0xf5ea2b`)

```
predict::create_manager(ctx: &mut TxContext): ID                       // creates + shares a PredictManager; owner = ctx.sender()
predict::mint<Quote>(&mut Predict, &mut PredictManager, &OracleSVI, key: MarketKey, quantity: u64, &Clock, &mut TxContext)
                                                                       // asserts sender==manager.owner(), quantity>0, assert_quote_asset<Quote>,
                                                                       // assert_key_matches(oracle,key), assert_live_oracle; cost = mul(ask, quantity); returns nothing
predict::redeem_permissionless<Quote>(&mut Predict, &mut PredictManager, &OracleSVI, MarketKey, u64, &Clock, &mut TxContext)  // no owner check
predict_manager::deposit<T>(&mut PredictManager, Coin<T>, &TxContext)
predict_manager::balance<T>(&PredictManager): u64
predict_manager::withdraw<T>(&mut PredictManager, amount: u64, &mut TxContext): Coin<T>
predict_manager::position(&PredictManager, key: MarketKey): u64
predict_manager::owner(&PredictManager): address
oracle::id(&OracleSVI): ID
oracle::expiry(&OracleSVI): u64                                         // ms — PUBLIC
oracle::is_settled(&OracleSVI): bool
oracle::is_active(&OracleSVI): bool                                     // PUBLIC; on-chain field is `active: bool`
oracle::settlement_price(&OracleSVI): Option<u64>
market_key::new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool): MarketKey   // is_up==true -> direction 0 (UP); abilities copy,drop,store
```

**Spec correction (from recon):** the deployed `MarketKey` field is `direction: u8` (0=UP, 1=DOWN), NOT `bool`. We construct it only via the public `market_key::new(..., is_up: bool)` helper, which maps `true → direction 0`. League's `DIR_UP = 0` is consistent, so `market_key::new(oracle_id, expiry_ms, strike, direction == DIR_UP)` is correct.

**Strike grid is `public(package)`** (`oracle_config::assert_key_matches`, `vault::oracle_strike_range`): `league` cannot read `min_strike`/`tick_size` on-chain. V5 strike-on-grid validation is therefore **off-chain admin tooling** (the indexer `/oracles` exposes `min_strike`/`tick_size`). The ultimate backstop is `mint`'s `assert_key_matches` (an off-grid strike makes every `place_pick` abort — a demo-killer, not a security hole). V6 expiry alignment IS closed on-chain by **deriving** `expiry_ms` from `oracle.expiry()` at publish time.

---

## File Structure

- `move/Move.toml` — re-point deps to rev `19f86eb`; set deployed published-at; remove `pyth_lazer`/`wormhole`.
- `move/sources/league.move` — imports, `Pick` struct, `place_pick`, `settle_pick`, `publish_question` (+ new `publish_question_for_market` seam), errors, test wrappers.
- `move/tests/*.move` — fixture adaptation (`order_id: 0` → dummy `MarketKey`); no behavioural change to accounting tests.
- `scripts/m1_e2e.ts` (new) — testnet end-to-end against live BTC OracleSVI markets.
- `docs/security/threat-model.md` (new) — A2 third-party-redeem-grief operational boundary + keeper ordering contract.
- `move-notes.md`, `tasks/progress.md` — update on completion.

---

## Task 1: Re-point Move.toml to the deployed predict architecture (dependency gate)

**Files:**
- Modify: `move/Move.toml`

**Interfaces:**
- Produces: a dependency graph where `deepbook_predict`/`deepbook`/`dusdc` resolve to the deployed testnet packages at rev `19f86eb`. Consumed by every later task (they compile against these).

- [ ] **Step 1: Replace the `[dependencies]` and `[dep-replacements.testnet]` sections**

Replace lines 6–22 of `move/Move.toml` with:

```toml
[dependencies]
# System deps (Sui, MoveStdlib) are auto-added in the new package management format.

# DeepBook Predict — DEPLOYED testnet architecture (monolithic OracleSVI), NOT source HEAD.
# rev pinned to the last predict-touching commit before the 2026-04-16 testnet deploy; the module
# set at this commit matches deployed package 0xf5ea2b (verified: oracle/predict/market_key/
# predict_manager + predict_math compiled in). Do NOT bump to main — main is the unreleased
# MarketOracle/ExpiryMarket rewrite that is not on testnet.
deepbook_predict = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/predict", rev = "19f86ebad9c6371c4f5c07229faabb2020dc691c" }

# DUSDC coin type used as the stake currency; its named address must be in scope for
# `dusdc::dusdc::DUSDC`, so declare it directly (it is a generic type param, not linked into predict).
dusdc = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/dusdc", rev = "19f86ebad9c6371c4f5c07229faabb2020dc691c" }

# Link against the on-chain deployed packages instead of re-publishing. published-at values verified
# 2026-06-18 from predict (0xf5ea2b) BCS linkage table + each package's testnet object.
# token/DEEP resolves automatically from its own [env.testnet] Move.lock — no entry needed here.
# predict_math has NO separate published-at (compiled into 0xf5ea2b) — do NOT add it.
[dep-replacements.testnet]
deepbook_predict = { published-at = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138", original-id = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138" }
deepbook = { published-at = "0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8", original-id = "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982" }
dusdc = { published-at = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a", original-id = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a" }
```

- [ ] **Step 2: Delete the stale `move/Move.lock` dep pins so the new rev re-resolves**

Run: `rm -f move/Move.lock`
Expected: file removed (it will be regenerated by the next build with the new rev).

- [ ] **Step 3: Resolve dependencies (this build is EXPECTED to fail in `league.move`)**

Run: `cd move && sui move build 2>&1 | tee /tmp/m1r_build1.log; cd ..`
Expected: dependency **resolution succeeds** (deepbookv3 fetched at `19f86eb`, all published-at accepted). The ONLY errors are in `sources/league.move` — unresolved modules `expiry_market`/`market_oracle`/`protocol_config`/`pyth_source` (these don't exist at this rev). That is the gate: **no** `"no published-at"`, `"unresolved dependency"`, or `"Unable to resolve"` errors for any predict/deepbook/dusdc/predict_math package.

- [ ] **Step 4: Confirm the gate**

Run: `grep -iE 'no published-at|unresolved dependency|unable to resolve|predict_math' /tmp/m1r_build1.log || echo "DEPS_CLEAN"`
Expected: prints `DEPS_CLEAN` (only `league.move` symbol errors remain, which Task 2 fixes).

- [ ] **Step 5: Commit**

```bash
git add move/Move.toml move/Move.lock
git commit -m "build: re-point predict deps to deployed OracleSVI arch (rev 19f86eb)"
```

---

## Task 2: Rewrite league.move CPI for the deployed OracleSVI API

This is a single atomic task: the `Pick` type change and the signature changes ripple through `place_pick`/`settle_pick`/`book_pick`/test wrappers, and a half-migration does not compile. Internal steps are ordered so the final `sui move build` + `sui move test` is the deliverable.

**Files:**
- Modify: `move/sources/league.move`
- Test: `move/tests/league_tests.move`, `move/tests/red_team*.move` (fixture adaptation)

**Interfaces:**
- Consumes (from deployed predict): the ABI reference block above.
- Produces:
  - `Pick { question_id: u64, direction: u8, stake: u64, market_key: MarketKey, predict_manager: ID, placed_ms: u64 }`
  - `place_pick(league: &mut League, profile: &PlayerProfile, predict: &mut Predict, manager: &mut PredictManager, oracle: &OracleSVI, question_id: u64, quantity: u64, max_cost: u64, stake_coin: Coin<DUSDC>, clock: &Clock, ctx: &mut TxContext)`
  - `settle_pick(league: &mut League, manager: &PredictManager, oracle: &OracleSVI, profile_addr: address, question_id: u64, clock: &Clock)`
  - `publish_question(_: &LeagueAdminCap, league: &mut League, oracle_id: ID, strike: u64, direction: u8, open_ms: u64, expiry_ms: u64): u64` (core, unit-testable — unchanged signature)
  - `publish_question_for_market(_: &LeagueAdminCap, league: &mut League, oracle: &OracleSVI, strike: u64, direction: u8, open_ms: u64): u64` (production entry — derives oracle_id+expiry from the oracle, closing V6 by construction)

- [ ] **Step 1: Swap the imports**

In `move/sources/league.move`, replace lines 22–27:

```move
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::expiry_market::ExpiryMarket;
use deepbook_predict::market_oracle::MarketOracle;
use deepbook_predict::protocol_config::ProtocolConfig;
use deepbook_predict::pyth_source::PythSource;
use dusdc::dusdc::DUSDC;
```

with:

```move
use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::market_key::{Self, MarketKey};
use dusdc::dusdc::DUSDC;
```

- [ ] **Step 2: Retire `EMarketMismatch` and add the two new error codes**

In the errors block (lines 29–50), replace line 44:

```move
const EMarketMismatch: u64 = 15; // market/oracle not the one the question binds
```

with:

```move
// 15 retired: was EMarketMismatch — no ExpiryMarket object exists in the deployed API to bind.
const EMaxCostExceeded: u64 = 22; // place_pick: live mint cost exceeded the caller's max_cost (V11 slippage guard)
const EOracleNotActive: u64 = 23; // publish_question_for_market: oracle not active (expired/settled/inactive)
```

(Leave `EBadgeAlreadyMinted = 20` and `EInvalidDirection = 21` where they are; add 22/23 alongside, or move 22/23 to the end of the const block — placement is cosmetic, the values matter.)

- [ ] **Step 3: Change the `Pick` struct**

Replace lines 135–142:

```move
public struct Pick has store {
    question_id: u64,
    direction: u8,
    stake: u64,
    order_id: u256,
    predict_manager: ID,
    placed_ms: u64,
}
```

with:

```move
public struct Pick has store {
    question_id: u64,
    direction: u8,
    stake: u64,
    market_key: MarketKey, // the deployed market identity; position is keyed by this in PredictManager
    predict_manager: ID,
    placed_ms: u64,
}
```

- [ ] **Step 4: Add the production publish entry (V6 closed by construction)**

Immediately after `publish_question` (after line 214), add:

```move
/// Production entry: publish a question bound to a LIVE OracleSVI. Derives `oracle_id` and
/// `expiry_ms` from the oracle itself so they can never drift from the market `mint` will check
/// (`assert_key_matches`) — this closes the V6 expiry-misalignment footgun by construction.
/// `strike` MUST be on the oracle's `min_strike + k*tick_size` grid; that grid is `public(package)`
/// in predict and not readable on-chain, so strike-on-grid (V5) is validated by off-chain admin
/// tooling reading the indexer `/oracles`. An off-grid strike is not unsafe — it makes every
/// `place_pick` abort in `mint::assert_key_matches` (a demo-killer caught by tooling).
public fun publish_question_for_market(
    cap: &LeagueAdminCap,
    league: &mut League,
    oracle: &OracleSVI,
    strike: u64,
    direction: u8,
    open_ms: u64,
): u64 {
    assert!(oracle.is_active(), EOracleNotActive);
    publish_question(cap, league, oracle.id(), strike, direction, open_ms, oracle.expiry())
}
```

- [ ] **Step 5: Rewrite `place_pick`**

Replace the whole `place_pick` function (lines 276–332) with:

```move
public fun place_pick(
    league: &mut League,
    profile: &PlayerProfile,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    question_id: u64,
    quantity: u64,
    max_cost: u64,
    stake_coin: Coin<DUSDC>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!league.paused, EPaused);
    assert!(league.questions.contains(question_id), EQuestionNotFound);
    // The manager must be the one registered to this profile (settle binds to pick.predict_manager).
    assert!(object::id(manager) == profile.predict_manager, EManagerMismatch);

    let now = clock::timestamp_ms(clock);
    let (direction, strike, oracle_id, expiry_ms) = {
        let q = league.questions.borrow(question_id);
        assert!(now < q.expiry_ms, EQuestionClosed);
        (q.direction, q.strike, q.oracle_id, q.expiry_ms)
    };
    // Bind the passed oracle to the question's oracle: stake can only come from a position on THIS market.
    assert!(oracle.id() == oracle_id, EOracleMismatch);

    let player = object::uid_to_address(&profile.id);
    assert!(league.stats.contains(player), ENoProfileStat);
    {
        let stat = league.stats.borrow(player);
        assert!(!stat.open_picks.contains(question_id), EAlreadyPicked);
    };

    // The deployed market identity. `mint` re-derives + re-checks this (assert_key_matches); we store
    // it so settle can read `position(key)` without reconstructing.
    let key = market_key::new(oracle_id, expiry_ms, strike, direction == DIR_UP);

    // Compose the real predict trade and measure the actual DUSDC cash spent.
    manager.deposit(stake_coin, ctx);
    let bal_before = manager.balance<DUSDC>();
    // No proof/config/pyth/leverage in the deployed API; mint asserts sender==manager.owner().
    predict::mint<DUSDC>(predict, manager, oracle, key, quantity, clock, ctx);
    // Stake = the DUSDC the mint actually CONSUMED (premium + fees), measured as the balance drop.
    // NOT stake_coin.value(): that books deposited-but-unspent cash the player can withdraw back = the
    // #1 farming vector. Guard the subtraction so a no-op/crediting mint aborts cleanly.
    let bal_after = manager.balance<DUSDC>();
    assert!(bal_before > bal_after, EZeroStake);
    let cost = bal_before - bal_after;
    // V11 slippage guard: ask is quoted live inside mint; abort (reverting the withdrawal) if the
    // player paid more premium than they authorised. Risks only the caller's own funds.
    assert!(cost <= max_cost, EMaxCostExceeded);

    let predict_manager = profile.predict_manager;
    let stat = league.stats.borrow_mut(player);
    book_pick(stat, player, question_id, direction, cost, key, predict_manager, now);
}
```

- [ ] **Step 6: Update `book_pick` to carry `market_key`**

Replace `book_pick` (lines 337–354):

```move
fun book_pick(
    stat: &mut PlayerStat,
    player: address,
    question_id: u64,
    direction: u8,
    stake: u64,
    market_key: MarketKey,
    predict_manager: ID,
    now: u64,
) {
    roll_streak(stat, now / MS_PER_DAY);
    stat.total_staked = stat.total_staked + stake;
    stat.open_picks.add(question_id, Pick {
        question_id, direction, stake, market_key, predict_manager, placed_ms: now,
    });
    event::emit(PickPlaced { player, question_id, direction, stake });
    event::emit(StreakUpdated { player, streak: stat.streak, best_streak: stat.best_streak });
}
```

- [ ] **Step 7: Rewrite `settle_pick`**

Replace the whole `settle_pick` function (lines 383–417) with:

```move
public fun settle_pick(
    league: &mut League,
    manager: &PredictManager,
    oracle: &OracleSVI,
    profile_addr: address,
    question_id: u64,
    clock: &Clock,
) {
    assert!(league.questions.contains(question_id), EQuestionNotFound);
    let now = clock::timestamp_ms(clock);

    let (strike, direction, oracle_id) = {
        let q = league.questions.borrow(question_id);
        assert!(now >= q.expiry_ms, ENotExpired);
        (q.strike, q.direction, q.oracle_id)
    };
    // Bind the oracle to the question, then read the price ONLY from the bound, settled oracle.
    assert!(oracle.id() == oracle_id, EOracleMismatch);
    assert!(oracle.is_settled(), EOracleNotSettled);
    let price_opt = oracle.settlement_price();
    assert!(price_opt.is_some(), EOracleNotSettled);
    let settlement_price = price_opt.destroy_some();

    assert!(league.stats.contains(profile_addr), ENoProfileStat);
    // Peek before scoring: bind manager + require position still held (anti early-close farming).
    {
        let stat = league.stats.borrow(profile_addr);
        assert!(stat.open_picks.contains(question_id), EAlreadySettled);
        let pick = stat.open_picks.borrow(question_id);
        assert!(object::id(manager) == pick.predict_manager, EManagerMismatch);
        // position(key) > 0 is the on-chain "held to settlement" truth. See threat-model.md for the
        // A2 third-party-redeem-grief operational boundary and the keeper ordering contract.
        assert!(manager.position(pick.market_key) > 0, EPositionClosed);
    };

    book_settle(league, profile_addr, question_id, strike, direction, settlement_price);
}
```

- [ ] **Step 8: Update the doc-comment headers of `place_pick`/`settle_pick`**

Update the `///` comment above `place_pick` (lines 267–275): drop the "F8 MarketOracle" wording; the `Aborts:` line becomes `EPaused, EQuestionNotFound, EManagerMismatch, EQuestionClosed, EOracleMismatch, ENoProfileStat, EAlreadyPicked, EZeroStake, EMaxCostExceeded`.
Update the `///` above `settle_pick` (lines 373–382): `Aborts:` becomes `EQuestionNotFound, ENotExpired, EOracleMismatch, EOracleNotSettled, ENoProfileStat, EAlreadySettled, EManagerMismatch, EPositionClosed`. Also fix the module-level header (lines 8–13) to say `OracleSVI` not `MarketOracle`, and `position(MarketKey)` not `has_position(market, order_id)`.

- [ ] **Step 9: Update the test wrapper `place_pick_for_testing`**

In `place_pick_for_testing` (lines 593–620), replace the final two lines:

```move
    let predict_manager = profile.predict_manager;
    let stat = league.stats.borrow_mut(player);
    book_pick(stat, player, question_id, direction, stake, 0, predict_manager, now);
```

with:

```move
    let predict_manager = profile.predict_manager;
    // Dummy market_key: the accounting/streak path under test never reads it (real binding +
    // position hold are covered by the Task 6 testnet e2e). MarketKey is constructible in tests.
    let key = market_key::new(object::id_from_address(@0x0), 0, 0, direction == DIR_UP);
    let stat = league.stats.borrow_mut(player);
    book_pick(stat, player, question_id, direction, stake, key, predict_manager, now);
```

Also update the wrapper's `///` comment "obtains `order_id` from `market.mint`; here … `order_id` is 0" → "obtains `market_key` from the question; here a dummy `MarketKey` is used".

- [ ] **Step 10: Build**

Run: `cd move && sui move build 2>&1 | tee /tmp/m1r_build2.log; cd ..`
Expected: `Success` / exit 0. If errors reference `market.mint`, `has_position`, `ExpiryMarket`, or `order_id`, a call site was missed — grep and fix:
Run: `grep -nE 'order_id|has_position|ExpiryMarket|MarketOracle|market\.mint|\.mint\(' move/sources/league.move`
Expected after fixes: no matches.

- [ ] **Step 11: Fix test fixtures and run the suite**

Search the tests for any remaining `order_id` usage or `Pick { … }` literals:
Run: `grep -rnE 'order_id|ExpiryMarket|MarketOracle' move/tests/`
For each match, replace the `order_id: <x>` field with `market_key: deepbook_predict::market_key::new(object::id_from_address(@0x0), 0, 0, true)` (add the `use` if a test destructures/builds a `Pick`). Most tests go through `place_pick_for_testing`/`settle_pick_for_testing` and need no change.

Run: `cd move && sui move test 2>&1 | tail -20; cd ..`
Expected: `Test result: OK. Total tests: 22; passed: 22; failed: 0`.

- [ ] **Step 12: Commit**

```bash
git add move/sources/league.move move/tests/
git commit -m "feat: re-target league CPI to deployed OracleSVI predict (MarketKey, mint, position hold, V6/V11 guards)"
```

---

## Task 3: Re-run the Move review chain on the diff

**Files:** none modified unless findings are accepted (then `move/sources/league.move`).

- [ ] **Step 1: Generate the diff**

Run: `git diff HEAD~2 -- move/sources/league.move move/Move.toml > /tmp/m1r.diff && wc -l /tmp/m1r.diff`
Expected: a non-empty diff.

- [ ] **Step 2: Run move-code-quality**

Invoke the `sui-dev-agents:move-code-quality` skill on `move/sources/league.move`. Record findings.

- [ ] **Step 3: Run sui-security-guard**

Invoke the `sui-dev-agents:sui-security-guard` skill on the diff. Record findings.

- [ ] **Step 4: Run sui-red-team**

Invoke the `sui-dev-agents:sui-red-team` skill on `place_pick`/`settle_pick`/`publish_question_for_market`. Verify the three carried-over properties survive: (1) stake = balance delta is over-, never under-counted; (2) `position(key) > 0` cannot be forged by redeem-and-re-mint (`assert_live_oracle` blocks post-settlement mint — V10); (3) permissionless settle triple-binding (question↔oracle↔manager). Record findings.

- [ ] **Step 5: Triage + apply**

For each finding, verify it against the spec's threat model before acting (a "HIGH" that says "use `stake_coin.value()`" must be REJECTED — it reopens #1 farming; see `tasks/lessons.md` 2026-06-15). Apply only findings that do not regress a documented defense. If any change is applied, re-run `sui move test` (expect 22/22) and commit with `fix: <finding>`.

- [ ] **Step 6: Commit (if changes applied)**

```bash
git add move/sources/league.move && git commit -m "fix: address Move review chain findings (M1-REVISIT)"
```

---

## Task 4: Document the A2 grief boundary + keeper ordering contract

**Files:**
- Create: `docs/security/threat-model.md`

**Interfaces:** none (documentation deliverable).

- [ ] **Step 1: Write the threat model doc**

Create `docs/security/threat-model.md` with these sections (content, not placeholders):

```markdown
# PredictLeague Threat Model (M1-REVISIT)

## Core defenses (on-chain, hard guarantees)
- **#1 Real stake = at-risk cash.** `place_pick` books `manager.balance` delta around `predict::mint`
  (= `cost = mul(ask, quantity)`), never the deposited coin value. Over-counts (player paid fees),
  never under-counts. Depositing-then-withdrawing cannot inflate points.
- **#2/F8 On-chain settlement price.** `settle_pick` reads `oracle.settlement_price(): Option<u64>`
  from the question-bound, settled `OracleSVI`. A keeper cannot feed a fake price.
- **Triple binding.** settle binds question ↔ oracle (`oracle.id() == q.oracle_id`) ↔ manager
  (`object::id(manager) == pick.predict_manager`).
- **V11 slippage.** `place_pick(max_cost)` aborts if the live mint cost exceeds the caller's bound.

## Hold-to-settle (`position(key) > 0`) — secondary product rule, best-effort
`predict::redeem_permissionless` has NO owner check, takes the SHARED `PredictManager`, and is enabled
once `oracle.is_settled()`. Any third party can construct the `MarketKey` and redeem any manager's
position post-settlement. The payout still deposits to the manager owner (NO theft), but it zeroes
`position(key)`. A griefer doing this in the window `[oracle settled, settle_pick called]` makes the
honest `settle_pick` abort `EPositionClosed`, permanently denying that pick's league points. Griefer
gains nothing and pays gas (spite only).

**No clean on-chain fix exists** under the deployed immutable predict API. Rejected (each defeated):
1. wrapping settle+redeem in one league function — only stops same-PTB reordering, not an independent
   bare-redeem tx;
2. a league-owned `forfeited` flag — player bypasses the wrapper via owner-only `predict::redeem`
   pre-settle, reopening early-close farming;
3. an admin re-award path — cannot distinguish a legit owner early-close from a third-party grief.

### Mitigation (operational, layered)
1. **Primary:** a first-party keeper subscribes to oracle settlement and batch-calls `settle_pick`
   for all open picks the instant the oracle settles, BEFORE redeeming — shrinking the window toward
   zero. A griefer must win a sub-second race for no gain.
2. **Structural:** within the keeper PTB, `settle_pick` (reads `position > 0`) is ordered BEFORE
   `predict::redeem_permissionless` (removes the position). The keeper never self-griefs.
3. **Kept rule:** `position > 0` stays correct for the common case — a player who owner-redeems
   before settlement legitimately forfeits points.
4. **Residual (accepted boundary):** a griefer who beats the keeper can deny specific picks' points.
   No fund risk. This is an operational boundary of the deployed predict API, not a core-defense gap.

## V5/V6 publish-time liveness
- **V6 (expiry):** closed by construction — `publish_question_for_market` derives `expiry_ms` from
  `oracle.expiry()`, so it cannot drift from `mint`'s `assert_key_matches`.
- **V5 (strike grid):** the grid (`min_strike`/`tick_size`) is `public(package)` in predict and not
  readable on-chain. Off-chain admin tooling validates strike-on-grid from the indexer `/oracles`
  before publishing. Backstop: an off-grid strike makes `place_pick` abort in `mint` (demo-killer,
  not unsafe).
```

- [ ] **Step 2: Commit**

```bash
git add docs/security/threat-model.md
git commit -m "docs: threat model — A2 redeem-grief operational boundary + keeper ordering"
```

---

## Task 5: Testnet end-to-end (`scripts/m1_e2e.ts`)

**Files:**
- Create: `scripts/m1_e2e.ts`
- Possibly: `scripts/package.json` / deps if not present (`@mysten/sui`).

**Interfaces:**
- Consumes: published `predict_league` package id (from a `sui client publish` done as Step 2), the deployed predict constants (Global Constraints), live oracle data from the indexer.

> **Resources (ready):** active address `0x1509b5fdf09296b2cf749a710e36da06f5693ccd5b2144ad643b3a895abcbc4c`
> (~22 SUI, ~490 DUSDC). Live BTC `OracleSVI` markets every 15 min at
> `https://predict-server.testnet.mystenlabs.com/oracles`.

- [ ] **Step 1: Publish `predict_league` to testnet**

Run: `cd move && sui client publish --skip-dependency-verification --json 2>&1 | tee /tmp/m1r_publish.json; cd ..`
Expected: success; record the new package id and the shared `League`/`SubRegistry` object ids + `LeagueAdminCap`/`VerifierCap` ids from the output. (`--skip-dependency-verification` is required: local source layout matches deployed bytecode; runtime links via the published-at values from Task 1.)

- [ ] **Step 2: Spot-check the on-chain MarketKey layout vs the linked package (A3)**

Run: `curl -s https://fullnode.testnet.sui.io -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",{"showBcs":true}]}' | grep -o 'market_key' | head -1`
Expected: prints `market_key` (the module is present in the linked deployed package). The struct layout (`oracle_id: ID, expiry: u64, strike: u64, direction: u8`, abilities `copy,drop,store`) was already verified at rev `19f86eb` == deployed; this confirms the link target is the right package.

- [ ] **Step 3: Write the e2e script**

Create `scripts/m1_e2e.ts` (using `@mysten/sui`, gRPC/`SuiClient`):

```ts
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
  const qid = tx.moveCall({
    target: `${PKG}::league::publish_question_for_market`,
    arguments: [tx.object(ADMIN), tx.object(LEAGUE), tx.object(o.id),
      tx.pure.u64(o.strike), tx.pure.u8(0), tx.pure.u64(Date.now())],
  });
  // qid is a return value; emit it via a follow-up read of QuestionPublished event.
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
```

- [ ] **Step 4: Run the positive path**

Run: `cd scripts && SUI_KEY=… PKG=… LEAGUE=… ADMIN_CAP=… VERIFIER_CAP=… SUB_REGISTRY=… pnpm tsx m1_e2e.ts; cd ..`
Expected: `✓ create_manager` … `✓ place_pick` with `stake > 0` … `✓ settle_pick` with `won`/`points` … `E2E POSITIVE PATH PASS ✅`.

- [ ] **Step 5: Negative paths (manual, append assertions or run as variants)**

Add two negative checks (separate runs or a `--neg` flag) and assert the abort codes:
- **Early redeem → settle aborts `EPositionClosed` (19):** mint, then send a standalone `redeem_permissionless` BEFORE `settle_pick`, then call `settle_pick` alone → expect failure containing abort code `19`.
- **Unsettled oracle → settle aborts `EOracleNotSettled` (11):** call `settle_pick` after expiry but before the oracle posts `settlement_price` → expect abort code `11`.

Run each and confirm the expected abort code appears in `effects.status.error`.

- [ ] **Step 6: Commit**

```bash
git add scripts/m1_e2e.ts scripts/package.json
git commit -m "test: M1-REVISIT testnet e2e (place_pick/settle_pick against live OracleSVI)"
```

---

## Task 6: Update notes + progress

**Files:**
- Modify: `move-notes.md`, `tasks/progress.md`

- [ ] **Step 1:** Append a `§M1-REVISIT IMPLEMENTED (2026-06-19)` block to `move-notes.md`: deployed published-at table, the V5-off-chain / V6-by-construction split, the `position(MarketKey)` hold-to-settle, V11 `max_cost`, e2e digests, and the A2 residual boundary (link `docs/security/threat-model.md`).
- [ ] **Step 2:** Move the M1-REVISIT TODO items to `## Recently Completed` in `tasks/progress.md`; mark Task 6 (e2e) done with the run digests.
- [ ] **Step 3: Commit**

```bash
git add move-notes.md tasks/progress.md
git commit -m "docs: record M1-REVISIT implementation + e2e results"
```

---

## Self-Review (run against the spec)

**Spec coverage:**
- Build/Move.toml (spec §"Build / Move.toml") → Task 1 ✓ (rev pin, published-at, remove pyth/wormhole, skip-dep-verification at publish).
- Imports/data model/`place_pick`/`settle_pick`/errors (spec §"league.move changes") → Task 2 ✓.
- V11 max_cost decision → **decided: add `max_cost` param** (Task 2 Step 5), EMaxCostExceeded=22. Documented rationale (defensive-first; risks only caller funds).
- V5/V6 publish validation (spec §V5/V6) → Task 2 Step 4 (`publish_question_for_market`): V6 by construction; V5 off-chain (grid is `public(package)`, not on-chain readable) + documented in Task 4.
- A1/A2 anti-grief operational mitigation → Task 4 threat-model + Task 5 keeper ordering in the e2e PTB ✓.
- A3 MarketKey layout spot-check → Task 5 Step 2 ✓ (layout already verified rev==deployed in recon).
- A4 quote whitelist (DUSDC) → covered implicitly by `mint`'s `assert_quote_asset`; e2e proves it (place_pick succeeds).
- Test seam + 22/22 → Task 2 Steps 9/11 ✓.
- Review chain → Task 3 ✓.
- Task 6 testnet e2e → Task 5 ✓.

**Open-items resolution (spec §"Open items for the plan"):** all 5 resolved in Global Constraints / ABI reference (deepbook+dusdc published-at; expiry=ms; on-grid strike via indexer + min quantity by dev-inspect; oracle `active: bool` / `is_active()`; V11 decided = add `max_cost`).

**Placeholder scan:** no TBD/"handle errors"/"similar to" — every code step shows full code. The only deferred numeric is the live `ask_price` (computed inside `mint`, not knowable offline); the e2e uses `max_cost = 50 DUSDC` headroom and asserts `stake > 0`, which is correct without pinning the exact ask.

**Type consistency:** `MarketKey` (not `order_id`) used uniformly in `Pick`/`book_pick`/`place_pick`/`settle_pick`/test wrappers; `predict::mint<DUSDC>` and `manager.balance<DUSDC>()` carry the type arg consistently; `market_key::new(oracle_id, expiry_ms, strike, direction == DIR_UP)` identical at both construction sites.
