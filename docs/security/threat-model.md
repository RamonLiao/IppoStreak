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
