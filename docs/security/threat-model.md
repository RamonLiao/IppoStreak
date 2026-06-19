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

## Hold-to-settle (`position(key) > 0`) — REMOVED after live testnet evidence
The earlier design gated `settle_pick` on `manager.position(pick.market_key) > 0` ("held to
settlement", anti early-close farming). **This was removed in M1-REVISIT.**

**Why (verified on-chain, 2026-06-19):** `predict::redeem_permissionless` has NO owner check, takes
the SHARED `PredictManager`, and is enabled the moment `oracle.is_settled()`. The deployed testnet
predict runs a permissionless **auto-redeem keeper bot** (`0x49c56cac…`, observed doing only
`market_key::new` + `redeem_permissionless`, 34 calls across 15 batched txs) that redeems every
position within seconds of settlement. In our e2e the bot redeemed our position **14 seconds after
settlement** (tx `8VdgBb…`, `PositionRedeemed`), zeroing `position(key)` BEFORE `settle_pick` could
run, so `settle_pick` aborted `EPositionClosed`. The held-position requirement is therefore
**unsatisfiable in the normal case**, not merely under adversarial griefing — the "first-party keeper
settles before redeem" mitigation would have to win a <14s race against a protocol bot.

**Why removing it is safe:** points reward a CORRECTLY-DIRECTIONED, real (`cost > 0`) pick. Anti-farming
does not depend on holding a position to settlement:
- **#1** stake = the real mint-cost delta, paid (and sunk) at `place_pick` — measured live as `377631`
  for a 200-DUSDC deposit, proving deposited-but-unspent cash is never booked.
- **V10** `mint`'s `assert_live_oracle` forbids re-establishing a position after settlement, so a
  redeem-then-re-mint cannot fabricate a settled-time position either.
A redeem (by the bot, the owner, or anyone) does not change whether the pick's direction was right at
the on-chain settlement price. `settle_pick` now scores purely on `direction` vs `settlement_price`,
and remains idempotent (`book_settle` removes the open pick; re-settle aborts `EAlreadySettled`).

Rejected alternatives (each defeated) for keeping a hold requirement: (1) wrapping settle+redeem in one
league PTB — only stops same-PTB reordering, not the bot's independent tx; (2) a league `forfeited`
flag — bypassable via owner-only `predict::redeem`; (3) admin re-award — cannot tell a legit early
close from a grief. None survive the auto-redeem reality, hence removal.

## V5/V6 publish-time liveness
- **V6 (expiry):** closed by construction — `publish_question_for_market` derives `expiry_ms` from
  `oracle.expiry()`, so it cannot drift from `mint`'s `assert_key_matches`.
- **V5 (strike grid):** the grid (`min_strike`/`tick_size`) is `public(package)` in predict and not
  readable on-chain. Off-chain admin tooling validates strike-on-grid from the indexer `/oracles`
  before publishing. Backstop: an off-grid strike makes `place_pick` abort in `mint` (demo-killer,
  not unsafe).
