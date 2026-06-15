/// PredictLeague — `badge` module.
///
/// Dynamic, soulbound achievement NFT. Deliberately "dumb": holds no business logic, only
/// presentation state (`tier`). Mint/upgrade authority is gated by `BadgeMintCap`, an instance
/// of which lives embedded inside `league::League` (created once at league init).
///
/// Design notes:
/// - `Badge` has `key` ONLY (no `store`) => soulbound: cannot enter Kiosk or be transferred by
///   `public_transfer`. The defining module never exposes a transfer fn after mint (D1).
/// - F6 correction vs spec §4.1: `BadgeMintCap` is defined HERE (not in `league`). Otherwise
///   `badge` would have to import `league` for the type, creating a `league <-> badge` dependency
///   cycle. Dependency direction stays one-way: `league -> badge`.
/// - Tier upgrade mutates IN PLACE (same object id) => "dynamic NFT, no burn-and-mint".
module predict_league::badge;

use sui::event;

// ===== Errors =====
/// Invalid tier: above GOLD, or an upgrade that skips/downgrades (code 8 in spec §7).
const EInvalidTier: u64 = 8;

// ===== Tiers =====
const TIER_BRONZE: u8 = 0;
const TIER_SILVER: u8 = 1;
const TIER_GOLD: u8 = 2;

// ===== Objects =====

/// Soulbound achievement badge. `key` only.
public struct Badge has key {
    id: UID,
    tier: u8,
    minted_day: u64,
    streak_at_mint: u64,
}

/// Tradeable cosmetic (D1, v2). `key + store` => Kiosk-listable. Defined but not wired this hackathon.
#[allow(unused_field)]
public struct Skin has key, store {
    id: UID,
    skin_id: u64,
    royalty_bps: u16,
}

/// Authority to mint/upgrade badges. `store`-only => not a standalone object; held embedded in
/// `League`. Created once via `new_mint_cap` (package-visible) at league init, never exposed to users.
public struct BadgeMintCap has store {}

// ===== Events =====
public struct BadgeMinted has copy, drop {
    badge_id: ID,
    owner: address,
    tier: u8,
    day: u64,
}

public struct BadgeUpgraded has copy, drop {
    badge_id: ID,
    old_tier: u8,
    new_tier: u8,
    day: u64,
}

// ===== Tier helpers =====
public fun tier_bronze(): u8 { TIER_BRONZE }
public fun tier_silver(): u8 { TIER_SILVER }
public fun tier_gold(): u8 { TIER_GOLD }

// ===== Capability lifecycle (package-only) =====

/// Create the single mint authority. Callable only from sibling package modules (i.e. `league::init`).
public(package) fun new_mint_cap(): BadgeMintCap {
    BadgeMintCap {}
}

// ===== Mint / upgrade (package-only, cap-gated) =====
//
// Both are `public(package)` AND require `&BadgeMintCap`. The `public(package)` visibility already
// prevents external callers (defeats threat A1: "user calls mint_badge directly"); the cap is
// belt-and-suspenders + documents authority flow. Mint transfers to `owner`; since the calling
// tx is signed by the owner (see league::sync_badge, F7), this respects Sui ownership rules.

/// Mint a fresh badge at `tier` to `owner`. Aborts `EInvalidTier` if tier > GOLD.
public(package) fun mint(
    _cap: &BadgeMintCap,
    owner: address,
    tier: u8,
    streak: u64,
    day: u64,
    ctx: &mut TxContext,
) {
    assert!(tier <= TIER_GOLD, EInvalidTier);
    let badge = Badge {
        id: object::new(ctx),
        tier,
        minted_day: day,
        streak_at_mint: streak,
    };
    event::emit(BadgeMinted { badge_id: object::id(&badge), owner, tier, day });
    transfer::transfer(badge, owner);
}

/// Upgrade an existing badge to any strictly-higher tier (sync to entitled tier; may skip levels,
/// mirroring `mint` which also lets a first badge start at any tier). Aborts `EInvalidTier` on
/// downgrade / no-op / overflow.
public(package) fun upgrade(_cap: &BadgeMintCap, badge: &mut Badge, new_tier: u8, day: u64) {
    assert!(new_tier <= TIER_GOLD && new_tier > badge.tier, EInvalidTier);
    let old_tier = badge.tier;
    badge.tier = new_tier;
    event::emit(BadgeUpgraded { badge_id: object::id(badge), old_tier, new_tier, day });
}

// ===== Read-only getters (for tests / off-chain) =====
public fun tier(badge: &Badge): u8 { badge.tier }
public fun minted_day(badge: &Badge): u64 { badge.minted_day }
public fun streak_at_mint(badge: &Badge): u64 { badge.streak_at_mint }
