/// PredictLeague — `league` module.
///
/// Orchestration + accounting brain for the prediction season. As of M1 it composes DeepBook Predict
/// via real Move-level CPI (imports the `deepbook_predict` package), keeps all season accounting in a
/// shared `League`, enforces one-profile-per-zkLogin-sub (D5), runs permissionless settlement (D2),
/// and drives the soulbound `badge` via an embedded `BadgeMintCap`.
///
/// M1 coupling (this build): `place_pick` composes `manager.deposit + predict::mint` itself and records
/// the MEASURED DUSDC cash delta as stake (#1: stake cannot be faked — it is the at-risk cash, not an
/// unbacked number). `settle_pick` reads `settlement_price` ON-CHAIN from the question's bound,
/// settled `OracleSVI` (#2/F8 CLOSED: a permissionless keeper can no longer feed a fake price) and
/// requires `position(MarketKey) > 0` (held to settlement, anti early-close farming). Custody stays
/// trustless: funds live in the shared `PredictManager`; the user withdraws later with their own cap.
module predict_league::league;

use sui::clock::{Self, Clock};
use sui::table::{Self, Table};
use sui::bag::{Self, Bag};
use sui::coin::Coin;
use sui::event;
use predict_league::badge::{Self, Badge, BadgeMintCap};
use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::market_key::{Self, MarketKey};
use dusdc::dusdc::DUSDC;

// ===== Errors (codes per spec §7) =====
const ESubAlreadyRegistered: u64 = 1;
const EQuestionClosed: u64 = 2;
const EAlreadyPicked: u64 = 3;
const ENotExpired: u64 = 4;
const EAlreadySettled: u64 = 5;
const ECapExceeded: u64 = 6;
const ENotLeader: u64 = 7;
// 8 = EInvalidTier lives in `badge`.
const EPaused: u64 = 9;
const EFeeTooHigh: u64 = 10;
const EOracleNotSettled: u64 = 11;
const ENoProfileStat: u64 = 12;
const EQuestionNotFound: u64 = 13;
const ENoBadgeYet: u64 = 14;
// 15 retired: was EMarketMismatch — no ExpiryMarket object exists in the deployed API to bind.
const EOracleMismatch: u64 = 16; // passed oracle is not this question's oracle
const EManagerMismatch: u64 = 17; // settle manager != the pick's manager
const EZeroStake: u64 = 18;       // measured mint cost was zero
const EPositionClosed: u64 = 19;  // position not held to settlement (early-close farming guard)
const EBadgeAlreadyMinted: u64 = 20; // mint_badge once-guard (#3: unlimited soulbound mint)
const EInvalidDirection: u64 = 21;   // publish_question: direction outside {DIR_UP, DIR_DOWN}
const EMaxCostExceeded: u64 = 22; // place_pick: live mint cost exceeded the caller's max_cost (V11 slippage guard)
const EOracleNotActive: u64 = 23; // publish_question_for_market: oracle not active (expired/settled/inactive)

// ===== Constants =====
const MS_PER_DAY: u64 = 86_400_000;
/// dUSDC has 6 decimals; 1 unit = points granularity for stake weighting.
const POINT_UNIT: u64 = 1_000_000;
/// Base points per winning unit, before streak bonus.
const BASE_POINTS_PER_UNIT: u64 = 10;
const MAX_FEE_BPS: u16 = 500; // 5%

/// Direction encoding (mirrors predict MarketKey.direction).
const DIR_UP: u8 = 0;   // win if settlement_price >= strike
const DIR_DOWN: u8 = 1; // win if settlement_price <  strike

/// Streak thresholds for badge tiers.
const STREAK_BRONZE: u64 = 3;
const STREAK_SILVER: u64 = 7;
const STREAK_GOLD: u64 = 30;

// ===== Capabilities =====

/// Admin authority: publish questions, pause (D4). Owned by app multisig.
public struct LeagueAdminCap has key, store { id: UID }

/// Backend authority to attest a verified zkLogin sub commitment (D5). Single point of identity
/// trust, documented in spec §8. Cannot move funds or mint badges.
public struct VerifierCap has key, store { id: UID }

// ===== Core shared objects =====

/// Shared. One per season.
public struct League has key {
    id: UID,
    season: u64,
    questions: Table<u64, Question>,
    next_question_id: u64,
    stats: Table<address, PlayerStat>,
    badge_cap: BadgeMintCap, // F1: embedded, borrowed internally; never a caller arg.
    extra: Bag,              // F4: forward-compat surface (Move forbids adding struct fields).
    paused: bool,
}

/// Shared. Enforces one profile per sub (D5).
public struct SubRegistry has key {
    id: UID,
    used: Table<vector<u8>, address>, // sub_commit -> profile addr
}

// ===== Owned object =====

/// Per-zkLogin-sub player object. Owned by the derived address.
public struct PlayerProfile has key {
    id: UID,
    owner_sub_commit: vector<u8>,
    predict_manager: ID,
    created_ms: u64,
}

// ===== Stored (non-object) structs =====

/// One per daily market. Binds our question to a real DeepBook Predict market by value
/// (F2b: Predict has no market object; a market is a MarketKey value over a shared OracleSVI).
public struct Question has store {
    id: u64,
    oracle_id: ID,
    strike: u64,
    direction: u8,
    open_ms: u64,
    expiry_ms: u64,
    settled: bool, // global "question resolved" flag (informational; per-pick idempotency via open_picks)
}

/// Season accounting kept in `League.stats` so permissionless `settle_pick` can mutate it without
/// touching the owned `PlayerProfile` (F3: this is for correctness/simplicity, NOT parallelism —
/// everything still serializes through `&mut League`).
public struct PlayerStat has store {
    streak: u64,
    best_streak: u64,
    last_active_day: u64, // UTC day index; 0 = never active. Resets on a missed DAY, not a wrong pick.
    season_points: u64,
    total_staked: u64,
    badge_minted: bool, // #3 once-guard: first mint_badge flips this; further mints abort.
    open_picks: Table<u64, Pick>,
}

public struct Pick has store {
    question_id: u64,
    direction: u8,
    stake: u64,
    market_key: MarketKey, // the deployed market identity; position is keyed by this in PredictManager
    predict_manager: ID,
    placed_ms: u64,
}

// ===== Team (D3) =====

/// Shared. One per team.
public struct Team has key {
    id: UID,
    leader: address,
    fee_bps: u16,
    members: Table<address, Membership>,
    member_count: u64,
    season_realized: Table<address, u64>,
}

public struct Membership has store {
    per_pick_cap: u64,
    joined_ms: u64,
    active: bool,
}

// ===== Events =====
public struct ProfileCreated has copy, drop { profile: address, predict_manager: ID }
public struct QuestionPublished has copy, drop { question_id: u64, oracle_id: ID, strike: u64, direction: u8, expiry_ms: u64 }
public struct PickPlaced has copy, drop { player: address, question_id: u64, direction: u8, stake: u64 }
public struct PickSettled has copy, drop { player: address, question_id: u64, won: bool, points_awarded: u64 }
public struct StreakUpdated has copy, drop { player: address, streak: u64, best_streak: u64 }
public struct TeamCreated has copy, drop { team_id: ID, leader: address, fee_bps: u16 }
public struct TeamJoined has copy, drop { team_id: ID, follower: address, per_pick_cap: u64 }
public struct LeaderPick has copy, drop { team_id: ID, leader: address, question_id: u64 }

// ===== Init =====

fun init(ctx: &mut TxContext) {
    let league = League {
        id: object::new(ctx),
        season: 0,
        questions: table::new(ctx),
        next_question_id: 0,
        stats: table::new(ctx),
        badge_cap: badge::new_mint_cap(),
        extra: bag::new(ctx),
        paused: false,
    };
    let registry = SubRegistry { id: object::new(ctx), used: table::new(ctx) };

    transfer::share_object(league);
    transfer::share_object(registry);
    transfer::transfer(LeagueAdminCap { id: object::new(ctx) }, ctx.sender());
    transfer::transfer(VerifierCap { id: object::new(ctx) }, ctx.sender());
}

// ===== Admin (LeagueAdminCap-gated, D4) =====

/// Publish a daily question bound to a Predict market (by oracle id + strike + direction + expiry).
public fun publish_question(
    _: &LeagueAdminCap,
    league: &mut League,
    oracle_id: ID,
    strike: u64,
    direction: u8,
    open_ms: u64,
    expiry_ms: u64,
): u64 {
    // Direction is authoritative for settlement (outcome_is_win reads q.direction). An out-of-range
    // value would be silently coerced to DOWN; reject it at publish time instead.
    assert!(direction == DIR_UP || direction == DIR_DOWN, EInvalidDirection);
    let id = league.next_question_id;
    let q = Question { id, oracle_id, strike, direction, open_ms, expiry_ms, settled: false };
    league.questions.add(id, q);
    league.next_question_id = id + 1;
    event::emit(QuestionPublished { question_id: id, oracle_id, strike, direction, expiry_ms });
    id
}

/// Production entry: publish a question bound to an OracleSVI. Derives `oracle_id` and
/// `expiry_ms` from the oracle itself so they can never drift from the market `mint` will check
/// (`assert_key_matches`) — this closes the V6 expiry-misalignment footgun by construction.
/// Liveness gate: `is_active()` (the raw `active` flag) AND `!is_settled()` — the latter rejects a
/// SETTLED oracle that `is_active()` alone would not (red-team V1: `is_active()` is not the lifecycle
/// status). An expired-but-unsettled oracle still passes here but is self-correcting: `place_pick`
/// aborts `EQuestionClosed` (now >= expiry) and `mint::assert_live_oracle` rejects it — no funds at
/// risk, just a dead question, which off-chain admin tooling avoids publishing.
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
    assert!(oracle.is_active() && !oracle.is_settled(), EOracleNotActive);
    publish_question(cap, league, oracle.id(), strike, direction, open_ms, oracle.expiry())
}

public fun set_paused(_: &LeagueAdminCap, league: &mut League, paused: bool) {
    league.paused = paused;
}

// ===== Onboarding (VerifierCap attests sub, D5) =====

/// Create a player's profile, enforcing sub uniqueness. Returns the owned `PlayerProfile`.
/// Aborts `ESubAlreadyRegistered` if `sub_commit` already used.
public fun create_profile(
    _: &VerifierCap,
    reg: &mut SubRegistry,
    league: &mut League,
    sub_commit: vector<u8>,
    predict_manager: ID,
    clock: &Clock,
    ctx: &mut TxContext,
): PlayerProfile {
    assert!(!reg.used.contains(sub_commit), ESubAlreadyRegistered);
    // Stats are keyed by the profile OBJECT id address (stable, keeper-derivable for settle_pick),
    // NOT by ctx.sender() (which is the keeper during permissionless settlement).
    let uid = object::new(ctx);
    let profile_addr = object::uid_to_address(&uid);
    reg.used.add(sub_commit, profile_addr);

    if (!league.stats.contains(profile_addr)) {
        league.stats.add(profile_addr, new_stat(ctx));
    };

    event::emit(ProfileCreated { profile: profile_addr, predict_manager });
    PlayerProfile {
        id: uid,
        owner_sub_commit: sub_commit,
        predict_manager,
        created_ms: clock::timestamp_ms(clock),
    }
}

fun new_stat(ctx: &mut TxContext): PlayerStat {
    PlayerStat {
        streak: 0,
        best_streak: 0,
        last_active_day: 0,
        season_points: 0,
        total_staked: 0,
        badge_minted: false,
        open_picks: table::new(ctx),
    }
}

// ===== Pick =====

/// Place a pick by composing the REAL DeepBook-Predict trade (deposit + mint) and recording the
/// measured DUSDC cash delta as stake (#1: stake cannot be faked — it is the at-risk cash, not an
/// unbacked number). Also rolls the participation streak (streak = consecutive days played, UC2).
///
/// The market (a `MarketKey` value over a shared `OracleSVI`) is bound to the question's oracle so the
/// position can only exist on THIS market, and the manager is bound to the player's registered
/// `profile.predict_manager`.
///
/// Aborts: EPaused, EQuestionNotFound, EManagerMismatch, EQuestionClosed (clock >= expiry),
/// EOracleMismatch, ENoProfileStat, EAlreadyPicked, EZeroStake (measured cost == 0), EMaxCostExceeded.
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

/// Accounting tail shared by the real `place_pick` and the test-only wrapper: rolls the participation
/// streak and books the pick + events. Caller must have already run the guards (paused/expiry/
/// already-picked) and, for the real path, the predict trade that produced `stake`/`market_key`.
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

/// Streak only advances/resets on DAY boundaries (UC2: never resets on a wrong pick).
fun roll_streak(stat: &mut PlayerStat, day: u64) {
    if (stat.last_active_day == day) {
        // already counted today; no-op
    } else if (stat.last_active_day != 0 && day == stat.last_active_day + 1) {
        stat.streak = stat.streak + 1;
    } else {
        stat.streak = 1; // first ever, or a gap > 1 day
    };
    if (stat.streak > stat.best_streak) {
        stat.best_streak = stat.streak;
    };
    stat.last_active_day = day;
}

// ===== Settlement (PERMISSIONLESS, D2) =====

/// Settle a player's open pick. Permissionless: every arg is shared/value, so any keeper can call.
/// The matching `predict::redeem_permissionless` runs as a sibling PTB command (payout lands in the
/// shared PredictManager; user withdraws later with their own withdraw_cap — custody stays trustless).
///
/// #2/F8: the settlement price is read ON-CHAIN from the question's bound `OracleSVI` — a keeper
/// can no longer feed a fake price. The oracle is bound to the question, must report `is_settled()`
/// with a `settlement_price`, and the position must still be HELD (anti early-close farming).
///
/// Aborts: EQuestionNotFound, ENotExpired (clock < expiry), EOracleMismatch,
/// EOracleNotSettled, ENoProfileStat, EAlreadySettled, EManagerMismatch, EPositionClosed.
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
    // destroy_or! aborts on None — covers a settled-flag-true-but-price-none oracle in one step.
    let settlement_price = oracle.settlement_price().destroy_or!(abort EOracleNotSettled);

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

/// Scoring tail shared by the real `settle_pick` and the test-only wrapper. Removes the open pick,
/// applies the pure win/loss rule, awards stake-weighted points, and marks the question settled.
/// Assumes question/expiry validation (and, in the real path, manager + held-position checks) done.
fun book_settle(
    league: &mut League,
    profile_addr: address,
    question_id: u64,
    strike: u64,
    direction: u8,
    settlement_price: u64,
) {
    assert!(league.stats.contains(profile_addr), ENoProfileStat);

    // Scope the `stat` mutable borrow so it is released before we touch `league.questions` again.
    let (won, points) = {
        let stat = league.stats.borrow_mut(profile_addr);
        assert!(stat.open_picks.contains(question_id), EAlreadySettled);

        let Pick { stake, .. } = stat.open_picks.remove(question_id);
        // Question direction is authoritative for outcome (pick.direction was a copy at pick time).
        let w = outcome_is_win(settlement_price, strike, direction);
        let p = if (w) {
            let pts = points_for(stake, stat.streak);
            stat.season_points = stat.season_points + pts;
            pts
        } else { 0 };
        (w, p)
    };

    // Mark question globally settled (informational).
    league.questions.borrow_mut(question_id).settled = true;

    event::emit(PickSettled { player: profile_addr, question_id, won, points_awarded: points });
}

/// Pure win/loss rule. UP wins when price >= strike; DOWN wins when price < strike.
public fun outcome_is_win(settlement_price: u64, strike: u64, direction: u8): bool {
    if (direction == DIR_UP) { settlement_price >= strike }
    else { settlement_price < strike } // DIR_DOWN (any non-UP treated as DOWN)
}

/// Points = stake_units * (BASE + streak). Deterministic + stake-weighted (D5 anti-farming).
public fun points_for(stake: u64, streak: u64): u64 {
    let units = stake / POINT_UNIT;
    units * (BASE_POINTS_PER_UNIT + streak)
}

// ===== Badge sync (USER-SIGNED, F7) =====
//
// Badge mint/upgrade is split out of permissionless settlement because a `Badge` is an OWNED object
// the keeper cannot mutate. The player signs this tx; we read their on-chain stat and mint/upgrade to
// the tier their `best_streak` entitles them to.

/// First-time mint: player has no badge yet. Aborts if they don't qualify for at least bronze.
public fun mint_badge(league: &mut League, profile: &PlayerProfile, clock: &Clock, ctx: &mut TxContext) {
    let player = object::uid_to_address(&profile.id); // stats key
    assert!(league.stats.contains(player), ENoProfileStat);
    let stat = league.stats.borrow_mut(player);
    // #3 once-guard: a player mints exactly one badge ever; later tier changes go through `sync_badge`
    // (upgrade-only). Without this, mint_badge took `&League` and could be replayed for N soulbounds.
    assert!(!stat.badge_minted, EBadgeAlreadyMinted);
    let best = stat.best_streak;
    assert!(best >= STREAK_BRONZE, ENoBadgeYet);
    stat.badge_minted = true;
    let tier = tier_for_streak(best);
    let day = clock::timestamp_ms(clock) / MS_PER_DAY;
    // Recipient is the real wallet (ctx.sender); only the profile owner can pass `profile` (owned).
    badge::mint(&league.badge_cap, ctx.sender(), tier, best, day, ctx);
}

/// Upgrade an existing badge to whatever tier `best_streak` now entitles. Aborts `EInvalidTier`
/// (in `badge`) if there is nothing to upgrade (target == current).
public fun sync_badge(league: &League, profile: &PlayerProfile, badge: &mut Badge, clock: &Clock) {
    let player = object::uid_to_address(&profile.id);
    assert!(league.stats.contains(player), ENoProfileStat);
    let best = league.stats.borrow(player).best_streak;
    let target = tier_for_streak(best);
    let day = clock::timestamp_ms(clock) / MS_PER_DAY;
    badge::upgrade(&league.badge_cap, badge, target, day);
}

fun tier_for_streak(streak: u64): u8 {
    if (streak >= STREAK_GOLD) { badge::tier_gold() }
    else if (streak >= STREAK_SILVER) { badge::tier_silver() }
    else { badge::tier_bronze() }
}

// ===== Team (D3) =====

/// Create + share a team. Leader = sender.
public fun create_team(_league: &League, fee_bps: u16, ctx: &mut TxContext) {
    assert!(fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    let team = Team {
        id: object::new(ctx),
        leader: ctx.sender(),
        fee_bps,
        members: table::new(ctx),
        member_count: 0,
        season_realized: table::new(ctx),
    };
    event::emit(TeamCreated { team_id: object::id(&team), leader: ctx.sender(), fee_bps });
    transfer::share_object(team);
}

/// Follower joins with a per-pick sizing cap. Re-join updates the cap and reactivates.
public fun join_team(team: &mut Team, profile: &PlayerProfile, per_pick_cap: u64, clock: &Clock) {
    let follower = object::uid_to_address(&profile.id);
    let joined_ms = clock::timestamp_ms(clock);
    if (team.members.contains(follower)) {
        let m = team.members.borrow_mut(follower);
        m.per_pick_cap = per_pick_cap;
        m.active = true;
    } else {
        team.members.add(follower, Membership { per_pick_cap, joined_ms, active: true });
        team.member_count = team.member_count + 1;
    };
    event::emit(TeamJoined { team_id: object::id(team), follower, per_pick_cap });
}

/// Leader announces a pick; followers are copied off-chain via batched `place_pick` PTBs (≤50/cohort).
public fun leader_pick(team: &Team, profile: &PlayerProfile, question_id: u64) {
    assert!(object::uid_to_address(&profile.id) == team.leader, ENotLeader);
    event::emit(LeaderPick { team_id: object::id(team), leader: team.leader, question_id });
}

/// Clamp a follower's copy stake to their membership cap. Aborts `ECapExceeded` if over.
/// Called inside the orchestrated batch before each `place_pick`.
public fun assert_within_cap(team: &Team, follower: address, stake: u64) {
    assert!(team.members.contains(follower), ECapExceeded);
    let m = team.members.borrow(follower);
    assert!(m.active && stake <= m.per_pick_cap, ECapExceeded);
}

// ===== Read-only getters =====
public fun is_paused(league: &League): bool { league.paused }
public fun season(league: &League): u64 { league.season }
public fun stat_streak(league: &League, player: address): u64 { league.stats.borrow(player).streak }
public fun stat_best_streak(league: &League, player: address): u64 { league.stats.borrow(player).best_streak }
public fun stat_points(league: &League, player: address): u64 { league.stats.borrow(player).season_points }
public fun stat_total_staked(league: &League, player: address): u64 { league.stats.borrow(player).total_staked }
public fun has_open_pick(league: &League, player: address, question_id: u64): bool {
    league.stats.contains(player) && league.stats.borrow(player).open_picks.contains(question_id)
}

// ===== Test-only helpers =====
#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }

#[test_only]
/// Create a profile AND register its stat row, keyed by the profile object id (matches production).
public fun new_profile_for_testing(league: &mut League, ctx: &mut TxContext): PlayerProfile {
    let uid = object::new(ctx);
    let addr = object::uid_to_address(&uid);
    league.stats.add(addr, new_stat(ctx));
    PlayerProfile { id: uid, owner_sub_commit: b"test", predict_manager: object::id_from_address(addr), created_ms: 0 }
}

#[test_only]
public fun profile_addr_for_testing(profile: &PlayerProfile): address {
    object::uid_to_address(&profile.id)
}

#[test_only]
public fun destroy_profile_for_testing(profile: PlayerProfile) {
    let PlayerProfile { id, owner_sub_commit: _, predict_manager: _, created_ms: _ } = profile;
    id.delete();
}

#[test_only]
/// Exercises the accounting/streak path of `place_pick` WITHOUT the predict trade. The real
/// `place_pick` measures `stake` from the on-chain DUSDC delta and obtains `market_key` from the
/// question; here `stake` is supplied and a dummy `MarketKey` is used. The shared `book_pick` tail and the
/// guard set are identical to production, so streak/scoring intent stays covered. The predict-coupled
/// parts (manager/market binding, real cost, position hold) are covered by the testnet e2e (Task 6).
public fun place_pick_for_testing(
    league: &mut League,
    profile: &PlayerProfile,
    question_id: u64,
    stake: u64,
    clock: &Clock,
) {
    assert!(!league.paused, EPaused);
    assert!(league.questions.contains(question_id), EQuestionNotFound);

    let now = clock::timestamp_ms(clock);
    let direction = {
        let q = league.questions.borrow(question_id);
        assert!(now < q.expiry_ms, EQuestionClosed);
        q.direction
    };

    let player = object::uid_to_address(&profile.id);
    assert!(league.stats.contains(player), ENoProfileStat);
    {
        let stat = league.stats.borrow(player);
        assert!(!stat.open_picks.contains(question_id), EAlreadyPicked);
    };

    let predict_manager = profile.predict_manager;
    // Dummy market_key: the accounting/streak path under test never reads it (real binding +
    // position hold are covered by the Task 6 testnet e2e). MarketKey is constructible in tests.
    let key = market_key::new(object::id_from_address(@0x0), 0, 0, direction == DIR_UP);
    let stat = league.stats.borrow_mut(player);
    book_pick(stat, player, question_id, direction, stake, key, predict_manager, now);
}

#[test_only]
/// Exercises the scoring path of `settle_pick` WITHOUT reading a live `OracleSVI`. The real
/// `settle_pick` reads `settlement_price` from the bound, settled oracle and requires the position be
/// held; here the price is supplied and the predict checks are skipped. Shares the `book_settle` tail
/// with production. Keeps the `price == 0 => EOracleNotSettled` gate so the unsettled-oracle test
/// stays meaningful at the logic layer.
public fun settle_pick_for_testing(
    league: &mut League,
    profile_addr: address,
    question_id: u64,
    settlement_price: u64,
    clock: &Clock,
) {
    assert!(league.questions.contains(question_id), EQuestionNotFound);
    let now = clock::timestamp_ms(clock);
    let (strike, direction) = {
        let q = league.questions.borrow(question_id);
        assert!(now >= q.expiry_ms, ENotExpired);
        assert!(settlement_price > 0, EOracleNotSettled);
        (q.strike, q.direction)
    };
    book_settle(league, profile_addr, question_id, strike, direction, settlement_price);
}
