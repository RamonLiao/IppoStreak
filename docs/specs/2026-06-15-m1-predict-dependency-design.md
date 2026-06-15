# M1 — Predict Dependency: Trustless Settlement + Real-Stake Anti-Farming

_Design doc · 2026-06-15 · Approach C (full Predict dep + Coin escrow magnitude)_

## Problem

Two red-team EXPLOITED findings block launch (PoCs in `move/tests/red_team.move`):

- **#1 STAKE INFLATION** — `place_pick(stake: u64)` takes a caller-supplied stake. A farmer
  passes `stake = 0` (or any number) without committing real capital. D5 anti-farming is fake until
  stake is sourced from real on-chain capital at risk.
- **#2 / F8 FAKE PRICE** — `settle_pick(settlement_price: u64)` takes a caller-supplied price. A
  permissionless keeper can feed any price to force wins/losses.

Both were "deferred" on a false premise: the progress notes claim the DeepBook Predict Move source is
unavailable so `league` was decoupled. **That premise is wrong** — `packages/predict` and
`packages/predict_math` are open-source in `github.com/MystenLabs/deepbookv3` and can be pinned as a
git dependency. M1 takes that dependency and fixes both findings on-chain.

## Decision: Approach C

Take the full `deepbook_predict` Move dependency. Fix #2 by reading the oracle on-chain. Fix #1 by
having `league` itself compose the Predict `deposit + mint` so it measures the **real cash spent** and
records that as stake (preserves stake-magnitude-weighted points). `league` now touches custody at the
mint step — accepted tradeoff for honest magnitude.

### Why not the alternatives
- **A (flat points, no magnitude):** simplest, but the user wants magnitude-weighted scoring.
- **B (dusdc-only dep):** can't fix #2 — `MarketOracle` lives in the predict package, so reading
  `settlement_price` on-chain forces the full dep anyway. Inconsistent. Rejected.

## On-chain facts (verified against repo `main`, 2026-06-15)

Real Predict interfaces `league` will consume:

```
// oracle/market_oracle.move
public struct MarketOracle has key { ... }                 // shared, per-expiry
public fun settlement_price(market: &MarketOracle): u64    // aborts if unsettled
public fun is_settled(market: &MarketOracle): bool
public fun market_oracle_id(market: &ExpiryMarket): ID     // expiry_market.move

// expiry_market.move
public struct ExpiryMarket has key { ... }                 // shared
public fun id(market: &ExpiryMarket): ID
public fun mint(market, manager, proof, config, market_oracle, pyth,
                lower_strike, higher_strike, quantity, leverage, clock, ctx): u256  // returns order_id

// predict_manager.move
public struct PredictManager has key { ... }               // shared (has share())
public fun deposit(self: &mut PredictManager, coin: Coin<DUSDC>, ctx)   // asserts owner
public fun generate_proof_as_owner(self, ctx): PredictTradeProof        // asserts owner
public fun balance(self: &PredictManager): u64
public fun has_position(self, expiry_market_id: ID, order_id: u256): bool
```

Key facts that shape the design:
- `MarketOracle` is the real type (spec's `OracleSVI` name was wrong). `settlement_price` is a clean
  public read. **#2 is fully trustless.**
- Predict exposes **no** per-position notional getter (`order.move` has zero public fns;
  `gross_paid_to_expiry` is internal). The only way to know real stake is to **measure the manager
  balance delta around a mint we call ourselves**.
- `deposit` + `generate_proof_as_owner` both `assert_owner(ctx)` ⇒ `place_pick` must be **player-signed**
  (the player owns their manager). Unchanged from today (place_pick was already player-signed).
- `PredictManager` is shared ⇒ permissionless `settle_pick` can take `&PredictManager` and re-check
  `has_position`.

## Design

### `place_pick` — wraps deposit + mint, records real cost

```
public fun place_pick(
    league: &mut League,
    profile: &PlayerProfile,
    manager: &mut PredictManager,        // player's, shared
    market: &mut ExpiryMarket,           // shared
    config: &ProtocolConfig,             // shared
    oracle: &MarketOracle,               // shared
    pyth: &PythSource,                   // shared
    question_id: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    leverage: u64,
    stake_coin: Coin<DUSDC>,             // player's capital
    clock: &Clock,
    ctx: &mut TxContext,
)
```

Logic:
1. Existing gates: `!paused`, `question` exists, `now < expiry`, `!already_picked`, `stat` exists.
2. **Bind market to question:** `assert!(market.market_oracle_id() == question.oracle_id, EMarketMismatch)`.
   This is what makes the stake un-spoofable — the position must be on the exact market the question names.
3. `let proof = manager.generate_proof_as_owner(ctx);`
4. `manager.deposit(stake_coin, ctx);`  // credits full coin value
5. `let bal_before = manager.balance();`
6. `let order_id = market.mint(manager, &proof, config, oracle, pyth, lower_strike, higher_strike, quantity, leverage, clock, ctx);`
7. `let cost = bal_before - manager.balance();`  // **real cash at risk = recorded stake**
8. `assert!(cost > 0, EZeroStake);`  // dust/0 guard on top of predict's min-size
9. Book `Pick { question_id, direction, stake: cost, order_id, placed_ms }`, roll streak, `total_staked += cost`.

Points weight on `cost` (cash at risk), **not** notional/exposure — so leverage can't inflate points
beyond capital genuinely risked. Any unspent deposit stays as the player's withdrawable manager balance
(their own money, not farmable points).

`Pick` gains `order_id: u256` and `predict_manager: ID` (the latter copied from
`profile.predict_manager`). `league` is unpublished (`predict_league = "0x0"`), so changing the `Pick`
struct now is free — define it fully in M1 to avoid the `extra: Bag` workaround after launch (F4).
`predict_manager` lets `settle_pick` bind the keeper-supplied manager explicitly (defense-in-depth on
top of `order_id` uniqueness).

### `settle_pick` — trustless price + hold-to-settle requirement

```
public fun settle_pick(
    league: &mut League,
    manager: &PredictManager,            // shared; to re-check position held
    market: &ExpiryMarket,               // shared; market_oracle_id binding
    oracle: &MarketOracle,               // shared; price source
    profile_addr: address,
    question_id: u64,
    clock: &Clock,
)
```

Logic:
1. `question` exists, `now >= expiry` (`ENotExpired`).
2. **Bind oracle to question:** `assert!(market.market_oracle_id() == question.oracle_id, EMarketMismatch)`
   and `assert!(object::id(oracle) == market.market_oracle_id(), EOracleMismatch)` — the passed
   `oracle` must be exactly the market's oracle. Read price only from it.
3. `assert!(oracle.is_settled(), EOracleNotSettled); let price = oracle.settlement_price();`
   — replaces caller-supplied price entirely.
3b. **Bind manager:** `assert!(object::id(manager) == pick.predict_manager, EManagerMismatch);`
4. **Hold-to-settle:** `assert!(manager.has_position(market.id(), pick.order_id), EPositionClosed);`
   Closes early-close farming (mint big → redeem immediately → still score). You only score if you
   held the position to settlement.
5. Existing idempotency: pick removed from `open_picks` ⇒ second call aborts `EAlreadySettled`.
6. `won = outcome_is_win(price, strike, direction)`; award `points_for(stake, streak)` on win.

Still permissionless: every arg is shared or value. The keeper supplies the right `manager`/`market`/
`oracle` (derivable from the question's `oracle_id` + the pick's manager, both on-chain / event-indexed).

### Threat model (core money path — red team)

| Vector | Defense |
|---|---|
| Zero / fake stake (#1) | Stake = measured cash delta of a mint `league` itself calls; `cost > 0` guard + predict min-size |
| Fake settlement price (#2) | Price read from oracle bound to `question.oracle_id`; caller price removed |
| Wrong/foreign market or oracle | `market.market_oracle_id() == question.oracle_id` on both place + settle |
| Foreign manager | `generate_proof_as_owner` asserts owner; proof validated by predict mint |
| Leverage inflation | Points weight on cash `cost`, not levered notional |
| Early-close farming | `settle_pick` re-checks `has_position`; no position held → no points |
| Double settle | Existing `open_picks.remove` idempotency (`EAlreadySettled`) |

### Move.toml

```toml
[dependencies]
Sui = { ... }  # unchanged
DeepBookPredict = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/predict", rev = "main" }
# transitive (resolver pulls): deepbook, predict_math, dusdc, token, pyth_lazer, wormhole

[dep-replacements.testnet]
# pyth_lazer + wormhole are published on testnet; link on-chain, don't republish.
# Copy published-at/original-id from predict/Move.toml (sui-testnet rev).
```

Cost surfaced honestly: build/audit surface grows (6 transitive packages incl. pyth/wormhole). This
contradicts the original "minimal scope" rationale — accepted because it's the only on-chain-trustless
path and the user chose magnitude fidelity (C).

### Off-chain (PTB builder) impact

`place_pick` is now a single PTB command that internally does deposit+mint — the backend no longer
composes a separate `predict::mint` sibling command. The backend must pass the shared
`ProtocolConfig` / `PythSource` / `ExpiryMarket` / `MarketOracle` object IDs (from predict's
testnet deployment) plus refresh Pyth in the same PTB if the oracle requires fresh data for mint.

## Verified assumptions (repo `main`, 2026-06-15)

All three load-bearing assumptions checked against Predict source before committing to this design:

- **Oracle settle does NOT remove the position** — `remove_position` is called only in
  `expiry_market`'s redeem/liquidate paths (lines 650/758/823); the oracle `settle` path never touches
  manager positions. ⇒ `has_position` stays `true` between expiry and redeem, so the hold-to-settle
  check in `settle_pick` is valid.
- **Mint cost flows entirely through the DUSDC manager balance, no credit-back** —
  `balance() = balance_manager.balance<DUSDC>()`; `settle_mint_payment` does a single
  `withdraw_with_proof(net_premium + fee + builder_fee + penalty)`. ⇒ `bal_before - bal_after` equals
  the exact total cash cost. DEEP only affects the fee discount (`active_stake`), never debits DUSDC.
- **Stake = balance delta (incl. fees/penalty)** — `net_premium` alone (the purer at-risk figure) is
  only emitted in the `OrderMinted` event, not returned by `mint` (which returns `order_id: u256`). The
  delta is a safe over-approximation: paying fees/penalty to farm points is net-negative, so not
  exploitable. Use the delta.

## Out of scope (stays as-is)
- #3 badge once-guard (M2), M3 style cleanup, docs/threat-model split.
- D5 identity uniqueness via backend `VerifierCap` (unchanged semi-trust, already disclosed).

## Success criteria
- `sui move build` green with the predict dep.
- `place_pick` with `stake_coin` value 0 / no real position → aborts (no points booked).
- `settle_pick` ignores any caller intent; price comes only from the bound settled oracle.
- Early-close (redeem before settle) → `settle_pick` aborts `EPositionClosed`, no points.
- Existing 13 unit + 3 red-team tests adapted; the two stake/price PoCs now FAIL to exploit.
- New tests: market-mismatch reject, leverage-no-inflation, early-close reject, unsettled-oracle reject.
```