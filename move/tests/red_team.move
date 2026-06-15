#[test_only]
/// Red-team adversarial tests. These ASSERT the exploit succeeds (attack passes) to prove the
/// vulnerability is real and reachable from public entry points. If a future fix closes the hole,
/// the corresponding test will start failing — that's the signal to convert it into a regression.
module predict_league::league_red_team;

use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use predict_league::league::{Self, League, LeagueAdminCap};
use predict_league::badge::{Self, Badge};

const ADMIN: address = @0xA;
const DAY: u64 = 86_400_000;
const FAR: u64 = 1_000_000_000_000;
const UNIT: u64 = 1_000_000;

fun dummy_oracle(): ID { object::id_from_address(@0xCAFE) }

fun begin(): Scenario {
    let mut sc = ts::begin(ADMIN);
    league::init_for_testing(ts::ctx(&mut sc));
    sc
}

// ===== Round 4 (Economic): stake-inflation farming — NOW CLOSED (#1) =====
// WAS EXPLOITED: the old `place_pick(stake: u64)` recorded an attacker-supplied number with no coin
// moved (predict::mint was a separate PTB command), so a gigantic fake stake minted points from $0.
// FIX: production `place_pick` now composes `deposit + mint` itself and records the MEASURED DUSDC
// cash delta as stake, aborting `EZeroStake` if the measured cost is 0. There is no caller-supplied
// stake argument anymore — the exploit's entry point is gone. The pure scoring layer guarantees the
// invariant this guards: zero cash at risk can never book points, regardless of streak.
// (The full deposit+mint+cost-delta path is proven on the predict-CPI testnet e2e — Task 6.)
#[test]
fun stake_inflation_zero_cost_yields_zero_points() {
    assert!(league::points_for(0, 100) == 0, 0); // zero stake -> zero points, any streak
}

// ===== Round 1 (Access Control): keeper fake-price — NOW STRUCTURALLY IMPOSSIBLE (#2/F8) =====
// WAS EXPLOITED: the old `settle_pick(settlement_price: u64)` let any permissionless keeper pick the
// number; the only gate was `price > 0`. A keeper could force a win for a confederate or grief a
// rival. FIX: production `settle_pick` takes NO price argument — it reads `settlement_price` ONLY
// from the question's bound, settled `MarketOracle` (`is_settled()` + `settlement_price()`), with the
// market/oracle double-bound to the question id. A keeper cannot fabricate the price.
// This exploit test is intentionally REMOVED: with no caller price arg there is nothing to fake at
// the Move type level. The positive proof that an unsettled oracle is rejected (EOracleNotSettled)
// and that a held position is required lives in the predict-CPI testnet e2e (Task 6).

// ===== Round 3 (Object/Idempotency): unlimited badge minting — DEFENDED (#3) =====
// Was EXPLOITED: mint_badge took `&League` with no "already minted" check, so a qualifying player
// replayed it for N soulbound badges (dilutes achievements, bloats storage, games badge-counting
// leaderboards). Fixed with a per-PlayerStat `badge_minted` once-guard: the first mint flips it,
// every later mint aborts EBadgeAlreadyMinted (20). Later tier changes go through `sync_badge`
// (upgrade-only). This is now the negative proof of that guard.
#[test]
#[expected_failure(abort_code = 20, location = predict_league::league)]
fun red_team_unlimited_badge_mint_defended() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let mut day = 1;
    while (day <= 3) { // reach bronze
        let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
        clock::set_for_testing(&mut clock, day * DAY + 5);
        league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
        day = day + 1;
    };

    // First mint succeeds; the second aborts EBadgeAlreadyMinted before any cleanup runs.
    league::mint_badge(&mut league, &profile, &clock, ts::ctx(&mut sc));
    league::mint_badge(&mut league, &profile, &clock, ts::ctx(&mut sc)); // <-- aborts here

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}
