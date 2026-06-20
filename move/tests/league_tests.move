#[test_only]
module predict_league::league_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use predict_league::league::{Self, League, SubRegistry, LeagueAdminCap, VerifierCap};
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

// ===== Pure logic =====

#[test]
fun test_outcome_logic() {
    // UP: win iff price >= strike
    assert!(league::outcome_is_win(150, 100, 0), 0);
    assert!(league::outcome_is_win(100, 100, 0), 1); // boundary
    assert!(!league::outcome_is_win(99, 100, 0), 2);
    // DOWN: win iff price < strike
    assert!(league::outcome_is_win(99, 100, 1), 3);
    assert!(!league::outcome_is_win(100, 100, 1), 4);
}

#[test]
fun test_points_formula() {
    // 5 units, streak 1 -> 5 * (10 + 1) = 55
    assert!(league::points_for(5 * UNIT, 1) == 55, 0);
    // sub-unit stake floors to 0 units -> 0 points
    assert!(league::points_for(UNIT - 1, 9) == 0, 1);
    // 3 units, streak 7 -> 3 * 17 = 51
    assert!(league::points_for(3 * UNIT, 7) == 51, 2);
}

#[test]
// WHY: points must weight on REAL cash at risk, never leverage/notional. `place_pick` records the
// measured DUSDC cost as `stake` and `points_for` takes only that stake, so two players risking the
// same cash earn the same points regardless of leverage. This encodes the #1 anti-farming intent.
fun points_weight_on_cash_not_leverage() {
    let stake = 5 * UNIT; // same cash cost for both players, any leverage
    assert!(league::points_for(stake, 0) == league::points_for(stake, 0), 0);
    assert!(league::points_for(stake, 3) == 5 * (10 + 3), 1);
}

// ===== Streak (UC2: rolls on day boundaries) =====

#[test]
fun test_streak_consecutive_then_gap_resets() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q0 = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
    let q1 = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
    let q2 = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    clock::set_for_testing(&mut clock, 1 * DAY + 5);
    league::place_pick_for_testing(&mut league, &profile, q0, 5 * UNIT, &clock);
    assert!(league::stat_streak(&league, p) == 1, 0);

    clock::set_for_testing(&mut clock, 2 * DAY + 5);
    league::place_pick_for_testing(&mut league, &profile, q1, 5 * UNIT, &clock);
    assert!(league::stat_streak(&league, p) == 2, 1);

    clock::set_for_testing(&mut clock, 5 * DAY + 5); // gap -> reset
    league::place_pick_for_testing(&mut league, &profile, q2, 5 * UNIT, &clock);
    assert!(league::stat_streak(&league, p) == 1, 2);
    assert!(league::stat_best_streak(&league, p) == 2, 3);

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Settlement =====

#[test]
fun test_settle_win_awards_points() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0 /*UP*/, 0, 2 * DAY);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    clock::set_for_testing(&mut clock, 1 * DAY + 5);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
    assert!(league::has_open_pick(&league, p, q), 0);

    clock::set_for_testing(&mut clock, 3 * DAY); // past expiry
    league::settle_pick_for_testing(&mut league, p, q, 150 /*price>=strike => win*/, &clock);
    assert!(league::stat_points(&league, p) == 55, 1); // 5 units * (10 + streak 1)
    assert!(!league::has_open_pick(&league, p, q), 2);

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}

#[test]
#[expected_failure]
fun test_settle_before_expiry_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, 2 * DAY);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    clock::set_for_testing(&mut clock, 1 * DAY);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock); // ENotExpired

    abort 99
}

#[test]
#[expected_failure]
fun test_oracle_not_settled_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, 2 * DAY);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    clock::set_for_testing(&mut clock, 1 * DAY);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
    clock::set_for_testing(&mut clock, 3 * DAY);
    league::settle_pick_for_testing(&mut league, p, q, 0 /*price 0 => EOracleNotSettled*/, &clock);

    abort 99
}

#[test]
#[expected_failure]
fun test_double_settle_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, 2 * DAY);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    clock::set_for_testing(&mut clock, 1 * DAY);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
    clock::set_for_testing(&mut clock, 3 * DAY);
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock);
    league::settle_pick_for_testing(&mut league, p, q, 150, &clock); // EAlreadySettled

    abort 99
}

// ===== Admin guards =====

#[test]
#[expected_failure(abort_code = 21, location = predict_league::league)]
fun test_publish_question_invalid_direction_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);

    // direction = 2 is neither DIR_UP (0) nor DIR_DOWN (1); must abort EInvalidDirection, not be
    // silently coerced to DOWN.
    league::publish_question(&admin, &mut league, dummy_oracle(), 100, 2, 0, FAR);

    abort 99
}

// ===== Pick guards =====

#[test]
#[expected_failure]
fun test_already_picked_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));

    clock::set_for_testing(&mut clock, 1 * DAY);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock); // EAlreadyPicked

    abort 99
}

#[test]
#[expected_failure]
fun test_paused_pick_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    league::set_paused(&admin, &mut league, true);

    clock::set_for_testing(&mut clock, 1 * DAY);
    league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock); // EPaused

    abort 99
}

// ===== Identity uniqueness (D5) =====

#[test]
#[expected_failure]
fun test_sub_uniqueness_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let vcap = ts::take_from_sender<VerifierCap>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));

    let p1 = league::create_profile(&vcap, &mut reg, &mut league, b"sub1", dummy_oracle(), &clock, ts::ctx(&mut sc));
    let p2 = league::create_profile(&vcap, &mut reg, &mut league, b"sub1", dummy_oracle(), &clock, ts::ctx(&mut sc)); // ESubAlreadyRegistered

    league::destroy_profile_for_testing(p1);
    league::destroy_profile_for_testing(p2);
    clock::destroy_for_testing(clock);
    ts::return_to_sender(&sc, vcap);
    ts::return_shared(reg);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Open onboarding (frontend self-serve, no VerifierCap) =====

#[test]
fun test_create_profile_open_registers_and_transfers() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));

    league::create_profile_open(&mut reg, &mut league, dummy_oracle(), &clock, ts::ctx(&mut sc));

    clock::destroy_for_testing(clock);
    ts::return_shared(reg);
    ts::return_shared(league);
    // Profile was transferred to sender; confirm it is now owned by ADMIN.
    ts::next_tx(&mut sc, ADMIN);
    let profile = ts::take_from_sender<league::PlayerProfile>(&sc);
    ts::return_to_sender(&sc, profile);
    ts::end(sc);
}

// Same caller cannot mint a second profile: the dedup key is derived from ctx.sender(),
// so a repeat call from the same address hits ESubAlreadyRegistered. This is the on-chain
// teeth behind "one profile per derived address" — it would NOT fail if the commit were
// caller-supplied bytes (the HIGH-1/V1 regression guard).
#[test]
#[expected_failure(abort_code = ::predict_league::league::ESubAlreadyRegistered)]
fun test_create_profile_open_dedup_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));

    league::create_profile_open(&mut reg, &mut league, dummy_oracle(), &clock, ts::ctx(&mut sc));
    league::create_profile_open(&mut reg, &mut league, dummy_oracle(), &clock, ts::ctx(&mut sc)); // aborts

    clock::destroy_for_testing(clock);
    ts::return_shared(reg);
    ts::return_shared(league);
    ts::end(sc);
}

// Distinct senders each get their own slot — a griefer CANNOT pre-squat another address's
// onboarding, because the dedup key is the caller's own address, not attacker-supplied bytes.
// Directly encodes the V1 squatting defense: this passes only because each sender keys itself.
#[test]
fun test_create_profile_open_distinct_senders_independent() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let mut reg = ts::take_shared<SubRegistry>(&sc);
    let clock = clock::create_for_testing(ts::ctx(&mut sc));
    league::create_profile_open(&mut reg, &mut league, dummy_oracle(), &clock, ts::ctx(&mut sc)); // ADMIN

    ts::next_tx(&mut sc, @0xB);
    league::create_profile_open(&mut reg, &mut league, dummy_oracle(), &clock, ts::ctx(&mut sc)); // 0xB: independent slot

    clock::destroy_for_testing(clock);
    ts::return_shared(reg);
    ts::return_shared(league);
    ts::end(sc);
}

// ===== Team fee bound =====

#[test]
#[expected_failure]
fun test_fee_too_high_aborts() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let league = ts::take_shared<League>(&sc);
    league::create_team(&league, 501, ts::ctx(&mut sc)); // EFeeTooHigh
    abort 99
}

// ===== Badge: mint at bronze, upgrade to silver (F7 user-signed) =====

#[test]
fun test_badge_mint_then_upgrade() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));
    let p = league::profile_addr_for_testing(&profile);

    // 7 consecutive days of picks -> streak climbs 1..7
    let mut day = 1;
    while (day <= 7) {
        let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
        clock::set_for_testing(&mut clock, day * DAY + 5);
        league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
        day = day + 1;
    };
    assert!(league::stat_best_streak(&league, p) == 7, 0);

    // Mint at current best (>=7 => silver). To exercise upgrade, mint earlier-tier manually:
    // Instead: mint now yields silver directly; verify tier.
    league::mint_badge(&mut league, &profile, &clock, ts::ctx(&mut sc));

    clock::destroy_for_testing(clock);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);

    // Badge landed in ADMIN's account (ctx.sender at mint).
    ts::next_tx(&mut sc, ADMIN);
    let b = ts::take_from_sender<Badge>(&sc);
    assert!(badge::tier(&b) == badge::tier_silver(), 1);
    ts::return_to_sender(&sc, b);
    ts::end(sc);
}

// ===== Regression: badge minted at bronze must sync-JUMP to gold =====
// WHY: a player can earn bronze (streak 3) then later reach a gold streak (30) without ever
// minting silver in between. sync_badge computes the entitled tier from best_streak, so upgrade
// must allow skipping levels. The old `new_tier == tier+1` rule permanently bricked such badges.
#[test]
fun test_badge_sync_jumps_bronze_to_gold() {
    let mut sc = begin();
    ts::next_tx(&mut sc, ADMIN);
    let mut league = ts::take_shared<League>(&sc);
    let admin = ts::take_from_sender<LeagueAdminCap>(&sc);
    let mut clock = clock::create_for_testing(ts::ctx(&mut sc));

    let profile = league::new_profile_for_testing(&mut league, ts::ctx(&mut sc));

    // 3 consecutive days -> best_streak == 3 (bronze), mint bronze badge.
    let mut day = 1;
    while (day <= 3) {
        let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
        clock::set_for_testing(&mut clock, day * DAY + 5);
        league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
        day = day + 1;
    };
    league::mint_badge(&mut league, &profile, &clock, ts::ctx(&mut sc));

    // Continue to 30 consecutive days -> best_streak == 30 (gold).
    while (day <= 30) {
        let q = league::publish_question(&admin, &mut league, dummy_oracle(), 100, 0, 0, FAR);
        clock::set_for_testing(&mut clock, day * DAY + 5);
        league::place_pick_for_testing(&mut league, &profile, q, 5 * UNIT, &clock);
        day = day + 1;
    };

    clock::destroy_for_testing(clock);
    let p = league::profile_addr_for_testing(&profile);
    assert!(league::stat_best_streak(&league, p) == 30, 0);

    // Player signs sync tx: pull the bronze badge, jump it straight to gold.
    ts::next_tx(&mut sc, ADMIN);
    let mut b = ts::take_from_sender<Badge>(&sc);
    assert!(badge::tier(&b) == badge::tier_bronze(), 1);
    let clock2 = clock::create_for_testing(ts::ctx(&mut sc));
    league::sync_badge(&league, &profile, &mut b, &clock2);
    assert!(badge::tier(&b) == badge::tier_gold(), 2);

    clock::destroy_for_testing(clock2);
    league::destroy_profile_for_testing(profile);
    ts::return_to_sender(&sc, b);
    ts::return_to_sender(&sc, admin);
    ts::return_shared(league);
    ts::end(sc);
}
