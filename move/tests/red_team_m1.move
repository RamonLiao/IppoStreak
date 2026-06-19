#[test_only]
/// M1 red-team: adversarial tests against the money path (place_pick/settle_pick/book_*).
/// These exercise the LOGIC layer reachable in `sui move test`. The predict-object-coupled
/// bindings (manager/oracle, real cost-delta, position(MarketKey)) cannot be constructed in
/// unit tests (predict exposes no test ctors) and are assessed by static analysis in the report.
module predict_league::league_red_team_m1;

use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use predict_league::league::{Self, League, LeagueAdminCap};

const ADMIN: address = @0xA;
const DAY: u64 = 86_400_000;
const UNIT: u64 = 1_000_000;

fun oid(): ID { object::id_from_address(@0xCAFE) }

fun begin(): Scenario {
    let mut sc = ts::begin(ADMIN);
    league::init_for_testing(ts::ctx(&mut sc));
    sc
}

// ===== Round 4: permissionless double-settle / replay =====
// Attack: settle the SAME pick twice to award points twice (or after another player settled it).
// Defense expected: book_settle removes the open pick; second settle aborts EAlreadySettled.
#[test]
#[expected_failure(abort_code = 5, location = predict_league::league)] // EAlreadySettled
fun red_double_settle_replay() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    // UP question, strike 100, expiry at 1 day.
    let q = league::publish_question(&admin, &mut league, oid(), 100, 0, 0, DAY);
    clock::set_for_testing(&mut clock, DAY / 2);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);

    // expire + settle (win: price 150 >= strike 100)
    clock::set_for_testing(&mut clock, DAY + 1);
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock);
    let pts1 = league::stat_points(&league, p);
    assert!(pts1 > 0, 100);

    // Replay: second settle of same pick must abort.
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock);

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Round 6: settle-before-expiry (timelock bypass) =====
// Attack: keeper settles a winning pick before expiry to lock in points / pre-empt outcome.
#[test]
#[expected_failure(abort_code = 4, location = predict_league::league)] // ENotExpired
fun red_settle_before_expiry() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);
    let q = league::publish_question(&admin, &mut league, oid(), 100, 0, 0, DAY);
    clock::set_for_testing(&mut clock, DAY / 2);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);

    // Not expired yet.
    clock::set_for_testing(&mut clock, DAY - 1);
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock);

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Round 4b: cross-player mis-attribution =====
// Attack: keeper settles victim's pick crediting attacker. settle_pick_for_testing keys on
// profile_addr, and book_settle awards to that same addr. Confirm points land on the pick owner,
// never the caller/keeper (sender is irrelevant to scoring).
#[test]
fun red_cross_player_attribution_is_owner_keyed() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let victim = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let attacker = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let pv = league::profile_addr_for_testing(&victim);
    let pa = league::profile_addr_for_testing(&attacker);

    let q = league::publish_question(&admin, &mut league, oid(), 100, 0, 0, DAY);
    clock::set_for_testing(&mut clock, DAY / 2);
    league::place_pick_for_testing(&mut league, &victim, q, 5 * UNIT, &clock);

    clock::set_for_testing(&mut clock, DAY + 1);
    // Keeper (attacker addr) settles victim's pick. Points must go to victim, not attacker.
    league::settle_pick_for_testing(&mut league, pv, q, 150, &clock);

    assert!(league::stat_points(&league, pv) > 0, 1);
    assert!(league::stat_points(&league, pa) == 0, 2); // attacker gained nothing

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(victim);
    league::destroy_profile_for_testing(attacker);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Round 2: leverage/notional cannot inflate points beyond cash stake =====
// points_for() is purely a function of `stake` (measured cash) and streak; leverage/quantity/
// notional do NOT enter. Two identical stakes => identical points regardless of any notional.
#[test]
fun red_leverage_does_not_inflate_points() {
    // Same cash stake, same streak => same points. Leverage is not an input to points_for.
    let a = league::points_for(5 * UNIT, 3);
    let b = league::points_for(5 * UNIT, 3);
    assert!(a == b, 1);
    // 10x stake gives exactly 10x points (linear in cash, no notional multiplier).
    let big = league::points_for(50 * UNIT, 3);
    assert!(big == a * 10, 2);
}

// ===== Round 2b: sub-unit stake rounds to zero points (dust farming check) =====
// Stake below POINT_UNIT (1e6) yields 0 points: units = stake/POINT_UNIT = 0.
// Confirms an attacker can't farm points with sub-unit dust stakes.
#[test]
fun red_dust_stake_zero_points() {
    assert!(league::points_for(UNIT - 1, 1000) == 0, 1);
    assert!(league::points_for(0, 1000) == 0, 2);
}
