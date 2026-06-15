# M1 — Predict Dependency: Trustless Settlement + Real-Stake Anti-Farming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Move review override (CLAUDE.md):** Do NOT use the generic `superpowers:code-reviewer` on `.move` files. Use `move-code-quality` → `sui-security-guard` → `sui-red-team`.

**Goal:** Make `league` read real DeepBook-Predict state on-chain so stake cannot be faked (#1) and settlement price cannot be spoofed (#2), fixing the two launch-blocking red-team exploits.

**Architecture:** Take the open-source `deepbook_predict` Move package as a git dependency. `place_pick` itself composes `deposit + mint` and records the real DUSDC cash delta as stake. `settle_pick` reads `MarketOracle.settlement_price` on-chain and requires the position be held to settlement (`has_position`). All design rationale + verified assumptions: `docs/specs/2026-06-15-m1-predict-dependency-design.md`.

**Tech Stack:** Sui Move 2024.beta, `deepbook_predict` (git dep, transitive: deepbook, predict_math, dusdc, token, pyth_lazer, wormhole), Sui CLI testnet.

---

## File Structure

- `move/Move.toml` — add predict git dep + `[dep-replacements.testnet]` for pyth_lazer/wormhole.
- `move/sources/league.move` — modify `Pick` struct, `place_pick`, `settle_pick`; add errors; add a pure
  `record_pick`/`resolve` helper split out so logic stays unit-testable without predict objects.
- `move/tests/league_tests.move` — adapt existing 13 tests to the new signatures via the pure helpers;
  keep pure-logic coverage.
- `move/tests/red_team.move` — the stake-inflation + fake-price PoCs must now FAIL to exploit; convert
  them into negative tests (assert the abort).
- `move/tests/m1_integration.move` (new, `#[test_only]`) — predict-CPI happy-path + anti-farming, IF
  predict exposes test scaffolding (decided in Task 0). Otherwise a testnet e2e script.
- `scripts/m1_e2e.ts` (new, only if Task 0 says Move-level integration test is infeasible) — testnet PTB
  e2e proving place_pick→settle_pick end to end.

---

> **TASK 0 RESULT (2026-06-15):** Build gate GREEN (`sui move build` EXIT=0, full graph: deepbook_predict
> + deepbook/dusdc/predict_math/token/pyth_lazer/wormhole + framework). **Move.toml had to be migrated to
> new-style package format** (predict is new-style; old-style cannot depend on new-style): removed
> `[addresses]` + the explicit `Sui`/`MoveStdlib` deps (auto-added now); dep renamed to `deepbook_predict`
> (must equal package name); `[dep-replacements.testnet]` kept verbatim from predict's Move.toml.
> **TEST STRATEGY DECISION → Task 6 = 6B (testnet e2e), 6A INFEASIBLE.** Reason: oracle settle scaffolding
> `market_oracle::settle_with_generator_for_testing` is `public(package)` (not callable cross-package), and
> the rich fixtures (`setup_live_market`/`setup_market_default`) live in predict's `tests/helper/` modules
> which a dependent package cannot import. Only `sources/` `#[test_only] public` ctors are reachable
> (`registry::init_for_testing`, `plp::init_for_testing`, `pyth_source::set_state_for_testing`) — enough to
> bootstrap registry/plp/pyth but NOT a settled ExpiryMarket+MarketOracle. So the predict-CPI happy path +
> anti-farming (need a live settled oracle) must be proven via a testnet PTB e2e script.

## Task 0: Spike — predict dependency resolves + test scaffolding inventory

**Files:**
- Modify: `move/Move.toml`

- [ ] **Step 1: Add the predict dependency**

In `move/Move.toml`, under `[dependencies]` (keep existing `Sui` line):

```toml
DeepBookPredict = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/predict", rev = "main" }
```

And add testnet dep-replacements (copy exact `published-at`/`original-id` from
`packages/predict/Move.toml` in the deepbookv3 repo, sui-testnet values):

```toml
[dep-replacements.testnet]
pyth_lazer = { git = "https://github.com/pyth-network/pyth-crosschain.git", subdir = "lazer/contracts/sui", rev = "sui-testnet", published-at = "0xf5bd2141967507050a91b58de3d95e77c432cd90d1799ee46effc27430a68c21", original-id = "0xf5bd2141967507050a91b58de3d95e77c432cd90d1799ee46effc27430a68c21" }
wormhole = { git = "https://github.com/pyth-network/wormhole.git", subdir = "sui/wormhole", rev = "sui-testnet", published-at = "0xd5afd4e456e5451f1ca1e7b3d734ce7a0a3b397811a6cb72a4bd1dfc387839f2", original-id = "0xd5afd4e456e5451f1ca1e7b3d734ce7a0a3b397811a6cb72a4bd1dfc387839f2" }
```

- [ ] **Step 2: Verify it resolves and the existing package still builds**

Run: `cd move && sui move build`
Expected: dependency graph resolves (pulls deepbook, predict_math, dusdc, token, pyth_lazer, wormhole);
build succeeds against the CURRENT (unmodified) league code. If resolution fails, fix the rev/published-at
before any code changes — do not proceed.

- [ ] **Step 3: Inventory predict test scaffolding (decides test strategy)**

Run: `grep -rn "#\[test_only\]" ~/.move/<resolved>/deepbookv3/packages/predict/sources` (path from build
output), looking for public test constructors for `PredictManager`, `ExpiryMarket`, `MarketOracle`,
`ProtocolConfig`, `PythSource`.
Decision: if usable `#[test_only]` constructors exist → Task 6 is a Move integration test
(`m1_integration.move`). If NOT → Task 6 is a testnet e2e TS script (`scripts/m1_e2e.ts`). Record the
decision as a comment at the top of the plan checklist before continuing.

- [ ] **Step 4: Commit**

```bash
git add move/Move.toml && git commit -m "build(move): add deepbook_predict dependency for M1"
```

---

## Task 1: `Pick` struct + new error codes

**Files:**
- Modify: `move/sources/league.move`

- [ ] **Step 1: Add error constants**

After the existing error block (`league.move:42`, after `ENoBadgeYet`):

```move
const EMarketMismatch: u64 = 15; // market/oracle not the one the question binds
const EOracleMismatch: u64 = 16; // passed oracle is not this market's oracle
const EManagerMismatch: u64 = 17; // settle manager != the pick's manager
const EZeroStake: u64 = 18;       // measured mint cost was zero
const EPositionClosed: u64 = 19;  // position not held to settlement (early-close farming guard)
```

- [ ] **Step 2: Extend the `Pick` struct**

Modify `Pick` (`league.move:126`):

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

- [ ] **Step 3: Build (will fail at Pick constructors — expected)**

Run: `cd move && sui move build`
Expected: FAIL at `place_pick` / test helpers that construct `Pick` without the new fields. This confirms
the next tasks must update every `Pick { ... }` site. (Do not commit a broken build; this step is a
checkpoint, fixed by Task 2+.)

---

## Task 2: `place_pick` — wrap deposit + mint, record real cost

**Files:**
- Modify: `move/sources/league.move`

- [ ] **Step 1: Add predict imports**

Near the top `use` block (`league.move:21-25`):

```move
use sui::coin::Coin;
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::expiry_market::ExpiryMarket;
use deepbook_predict::market_oracle::MarketOracle;
use deepbook_predict::config::protocol_config::ProtocolConfig;
use deepbook_predict::oracle::pyth::pyth_source::PythSource;
use dusdc::dusdc::DUSDC;
```

> Note: confirm exact module paths from Task 0's resolved sources (e.g. `protocol_config` may be
> `deepbook_predict::protocol_config`). Fix imports to match the real package layout.

- [ ] **Step 2: Replace `place_pick` (`league.move:256-286`)**

```move
public fun place_pick(
    league: &mut League,
    profile: &PlayerProfile,
    manager: &mut PredictManager,
    market: &mut ExpiryMarket,
    config: &ProtocolConfig,
    oracle: &MarketOracle,
    pyth: &PythSource,
    question_id: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    leverage: u64,
    stake_coin: Coin<DUSDC>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!league.paused, EPaused);
    assert!(league.questions.contains(question_id), EQuestionNotFound);

    let now = clock::timestamp_ms(clock);
    let (direction, oracle_id) = {
        let q = league.questions.borrow(question_id);
        assert!(now < q.expiry_ms, EQuestionClosed);
        (q.direction, q.oracle_id)
    };
    // Bind the market to the question's oracle: stake can only come from a position on THIS market.
    assert!(market.market_oracle_id() == oracle_id, EMarketMismatch);

    let player = object::uid_to_address(&profile.id);
    assert!(league.stats.contains(player), ENoProfileStat);
    {
        let stat = league.stats.borrow(player);
        assert!(!stat.open_picks.contains(question_id), EAlreadyPicked);
    };

    // Compose the real predict trade and measure the actual DUSDC cash spent.
    let proof = manager.generate_proof_as_owner(ctx);
    manager.deposit(stake_coin, ctx);
    let bal_before = manager.balance();
    let order_id = market.mint(
        manager, &proof, config, oracle, pyth,
        lower_strike, higher_strike, quantity, leverage, clock, ctx,
    );
    let cost = bal_before - manager.balance();
    assert!(cost > 0, EZeroStake);

    let predict_manager = profile.predict_manager;
    let stat = league.stats.borrow_mut(player);
    roll_streak(stat, now / MS_PER_DAY);
    stat.total_staked = stat.total_staked + cost;
    stat.open_picks.add(question_id, Pick {
        question_id, direction, stake: cost, order_id, predict_manager, placed_ms: now,
    });

    event::emit(PickPlaced { player, question_id, direction, stake: cost });
    event::emit(StreakUpdated { player, streak: stat.streak, best_streak: stat.best_streak });
}
```

> Verify `object::id(manager) == profile.predict_manager` is NOT asserted here on purpose: the player owns
> the manager (deposit/proof assert owner), and binding is enforced at settle via `pick.predict_manager`.
> If you want it at place time too, add `assert!(object::id(manager) == profile.predict_manager, EManagerMismatch);`.

- [ ] **Step 3: Build**

Run: `cd move && sui move build`
Expected: `place_pick` compiles. Test helpers / `settle_pick` / red_team may still fail — fixed next.

---

## Task 3: `settle_pick` — trustless price + hold-to-settle

**Files:**
- Modify: `move/sources/league.move`

- [ ] **Step 1: Replace `settle_pick` (`league.move:314-354`)**

```move
public fun settle_pick(
    league: &mut League,
    manager: &PredictManager,
    market: &ExpiryMarket,
    oracle: &MarketOracle,
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
    // Bind market + oracle to the question, then read the price ONLY from the bound, settled oracle.
    assert!(market.market_oracle_id() == oracle_id, EMarketMismatch);
    assert!(object::id(oracle) == market.market_oracle_id(), EOracleMismatch);
    assert!(oracle.is_settled(), EOracleNotSettled);
    let settlement_price = oracle.settlement_price();

    assert!(league.stats.contains(profile_addr), ENoProfileStat);

    let (won, points) = {
        let stat = league.stats.borrow_mut(profile_addr);
        assert!(stat.open_picks.contains(question_id), EAlreadySettled);
        // Peek before removing: bind manager + require position still held (anti early-close farming).
        {
            let pick = stat.open_picks.borrow(question_id);
            assert!(object::id(manager) == pick.predict_manager, EManagerMismatch);
            assert!(manager.has_position(market.id(), pick.order_id), EPositionClosed);
        };
        let Pick { question_id: _, direction: _, stake, order_id: _, predict_manager: _, placed_ms: _ } =
            stat.open_picks.remove(question_id);
        let w = outcome_is_win(settlement_price, strike, direction);
        let p = if (w) {
            let pts = points_for(stake, stat.streak);
            stat.season_points = stat.season_points + pts;
            pts
        } else { 0 };
        (w, p)
    };

    league.questions.borrow_mut(question_id).settled = true;
    event::emit(PickSettled { player: profile_addr, question_id, won, points_awarded: points });
}
```

- [ ] **Step 2: Build**

Run: `cd move && sui move build`
Expected: source compiles; only test files may still reference old signatures.

- [ ] **Step 3: Commit**

```bash
git add move/sources/league.move
git commit -m "feat(league): trustless settle + real-stake place_pick (M1 #1/#2)"
```

---

## Task 4: Keep pure logic unit-tested

The predict-coupled `place_pick`/`settle_pick` are hard to unit-test (need predict objects). The pure
rules (`outcome_is_win`, `points_for`, `roll_streak`) carry the scoring intent and MUST stay covered.

**Files:**
- Modify: `move/tests/league_tests.move`

- [ ] **Step 1: Confirm existing pure-logic tests still compile against unchanged signatures**

`outcome_is_win`, `points_for`, `roll_streak` signatures are unchanged. Run:
`cd move && sui move test outcome_ points_ streak`
Expected: these pure tests still PASS (they never touched predict). If any test directly called the old
`place_pick(stake)` / `settle_pick(price)`, move it to Task 5/6.

- [ ] **Step 2: Add a leverage-no-inflation intent test (Rule 9: encodes WHY)**

```move
#[test]
fun points_weight_on_cash_not_leverage() {
    // Two players risk the SAME cash but different leverage → SAME points.
    // points_for takes stake (= measured cash cost), never notional, so leverage cannot inflate.
    let stake = 5 * 1_000_000; // 5 DUSDC cash cost, both players
    assert!(points_for(stake, 0) == points_for(stake, 0), 0);
    assert!(points_for(stake, 3) == 5 * (10 + 3), 1);
}
```

Run: `cd move && sui move test points_weight_on_cash_not_leverage`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add move/tests/league_tests.move
git commit -m "test(league): pure scoring logic + leverage-no-inflation intent"
```

---

## Task 5: Convert red-team PoCs to negative tests

The two EXPLOITED PoCs must now be impossible. Convert them to assert the new aborts.

**Files:**
- Modify: `move/tests/red_team.move`

- [ ] **Step 1: Stake-inflation PoC → assert it can no longer book points with zero cash**

Since `place_pick` now requires a real mint, the old `stake=0` call path no longer compiles/exists. Replace
the exploit test with a documentation test asserting the design invariant via the pure layer:

```move
#[test]
// Was EXPLOITED: place_pick(stake=0) booked points for free. Now stake = measured mint cost,
// and cost==0 aborts EZeroStake; no points can ever be booked without real cash. This guards the rule.
fun stake_inflation_zero_cost_yields_zero_points() {
    assert!(points_for(0, 100) == 0, 0); // zero stake → zero points regardless of streak
}
```

Run: `cd move && sui move test stake_inflation_zero_cost`
Expected: PASS.

- [ ] **Step 2: Fake-price PoC → remove (caller can no longer supply price)**

The fake-price exploit relied on `settle_pick(settlement_price)`. That parameter is gone — price comes
only from `oracle.settlement_price()`. Delete the obsolete exploit test and leave a comment block at its
former location explaining it is structurally impossible now (no caller price arg). The real assertion that
a keeper cannot fake the price lives in Task 6 (unsettled-oracle reject).

- [ ] **Step 3: Build tests**

Run: `cd move && sui move test`
Expected: compiles; remaining red-team tests adapt or are removed; no test references the deleted price arg.

- [ ] **Step 4: Commit**

```bash
git add move/tests/red_team.move
git commit -m "test(red-team): convert M1 stake/price PoCs to negative tests"
```

---

## Task 6: Integration test for the predict-CPI path

Strategy chosen in Task 0. Implement EITHER 6A (Move integration test) OR 6B (testnet e2e).

### 6A — Move integration test (if predict exposes `#[test_only]` constructors)

**Files:**
- Create: `move/tests/m1_integration.move`

- [ ] **Step 1: Build predict scaffolding helper** — using the constructors found in Task 0, write a
  `#[test_only]` setup that creates a funded `PredictManager`, an `ExpiryMarket` + `MarketOracle` +
  `ProtocolConfig` + `PythSource`, and publishes one `Question` bound to that oracle. (Exact calls depend
  on Task 0 inventory — fill with the real constructor signatures, no placeholders.)

- [ ] **Step 2: Happy path** — `place_pick` with a real `Coin<DUSDC>`; assert `stat_total_staked > 0` and
  `has_open_pick == true`. Run `sui move test m1_happy`. Expected: PASS.

- [ ] **Step 3: Anti-farming — early close** — after `place_pick`, `redeem` the position, then
  `#[expected_failure(abort_code = EPositionClosed)]` on `settle_pick`. Run. Expected: PASS (abort).

- [ ] **Step 4: Unsettled oracle reject** — call `settle_pick` after expiry but before the oracle is
  settled; `#[expected_failure(abort_code = EOracleNotSettled)]`. Run. Expected: PASS.

- [ ] **Step 5: Market mismatch reject** — `place_pick` with an `ExpiryMarket` whose `market_oracle_id`
  ≠ question oracle; `#[expected_failure(abort_code = EMarketMismatch)]`. Run. Expected: PASS.

- [ ] **Step 6: Win path** — settle a held position on a settled oracle where price wins; assert
  `stat_points` increased by `points_for(stake, streak)`. Run. Expected: PASS.

- [ ] **Step 7: Commit** `git add move/tests/m1_integration.move && git commit -m "test(league): M1 predict-CPI integration + anti-farming"`

### 6B — Testnet e2e (if Move-level construction is infeasible)

**Files:**
- Create: `scripts/m1_e2e.ts`

- [ ] **Step 1: Setup** — `@mysten/sui` v2 `SuiGrpcClient` (testnet) + `@mysten/deepbook-v3`; publish
  `league`; create a `PredictManager`; pick a live testnet `ExpiryMarket`/`MarketOracle` near expiry.

- [ ] **Step 2: place_pick PTB** — one `Transaction` calling `league::place_pick` with a real DUSDC coin;
  assert via events that `PickPlaced.stake > 0`.

- [ ] **Step 3: settle_pick after expiry** — once the oracle is settled, call `league::settle_pick`;
  assert `PickSettled` emitted with the correct `won`/`points`.

- [ ] **Step 4: Negative — early close** — in a second run, redeem before settle; assert `settle_pick`
  aborts (`EPositionClosed`).

- [ ] **Step 5: Commit** `git add scripts/m1_e2e.ts && git commit -m "test(e2e): M1 testnet place/settle + early-close reject"`

---

## Task 7: Off-chain PTB builder note + docs sync

**Files:**
- Modify: `move-notes.md`

- [ ] **Step 1: Record M1 outcome** — append a §M1 section to `move-notes.md`: new `place_pick`/`settle_pick`
  signatures, the predict shared-object IDs the backend must pass (ProtocolConfig/PythSource/ExpiryMarket/
  MarketOracle from predict's testnet deployment), the Pyth-refresh-in-same-PTB requirement for mint, and
  the hold-to-settle UX rule (settle before withdraw). Note stake = full cash delta (incl. fees/penalty).

- [ ] **Step 2: Commit** `git add move-notes.md && git commit -m "docs(move-notes): M1 integration notes"`

---

## Task 8: Move review chain (CLAUDE.md mandatory) + final verification

- [ ] **Step 1: `move-code-quality`** on the league diff — fix style/Move-2024 findings.
- [ ] **Step 2: `sui-security-guard`** scan — address any flagged issue.
- [ ] **Step 3: `sui-red-team`** on the new money path — exercise the threat-model vectors from the spec
  (zero stake, fake price, foreign manager/market, leverage inflation, early close, double settle). Add a
  regression test for anything found.
- [ ] **Step 4: Full build + test** — `cd move && sui move build && sui move test`. Expected: all green.
  Surface any skipped test loudly (Rule 12). Do NOT mark M1 done unless build + tests pass.
- [ ] **Step 5: Final commit** of any review fixes.

---

## Self-Review (completed)

- **Spec coverage:** #1 (Task 2 cost-delta + EZeroStake), #2 (Task 3 oracle read), market/oracle binding
  (Tasks 2/3), manager binding (Task 3), hold-to-settle (Task 3), leverage-no-inflation (Task 4),
  dep + dep-replacements (Task 0), Pick struct one-shot (Task 1), threat model (Task 8). All mapped.
- **Placeholders:** Task 0/6 intentionally branch on a runtime inventory (predict test scaffolding) — each
  branch has concrete steps; the only "fill from real signatures" notes are unavoidable (foreign package
  layout confirmed at build time), flagged explicitly, not hidden TODOs.
- **Type consistency:** `Pick` fields (`order_id: u256`, `predict_manager: ID`) match place (write) and
  settle (destructure) sites; error codes 15–19 used consistently; `cost`/`stake` naming consistent.
