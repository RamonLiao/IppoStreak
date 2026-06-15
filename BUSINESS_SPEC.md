# BUSINESS_SPEC — PredictLeague (F2P Prediction Season)

> Track 2 · DeepBook & Prediction Markets · Sui Overflow 2026
> HANDBOOK pillar: **Frontends & Consumer Apps** (ideas #5 + #6)

---

## 1. Executive Summary

PredictLeague is a free-to-play prediction season app: zkLogin + sponsored TX onboard a user from Google sign-in to a live BTC binary pick in under 30 seconds, with no seed phrase, no wallet extension, and no real money required to start. Daily picks settle through real DeepBook **`predict::mint/redeem`** calls; streak counters drive dynamic NFT badge upgrades; team mode lets a leader's picks auto-copy to followers; season points convert to a real prize pool funded by sponsor fees + opt-in entry tickets.

The funnel anchor is solid: Polymarket reached **~478k MAU in 2025-10** and **1.26M cumulative unique traders** [source: Dune Analytics — Polymarket User Metrics, https://dune.com/polymarket/users]; Sleeper hit **7–9M MAU with 14-min daily session times** [source: Sensor Tower 2025 Fantasy Sports Industry Analysis, https://sensortower.com/blog/fantasy-sports-apps-report-2025]; DraftKings 4.8M monthly unique paid users / 10.9M annual unique [source: DraftKings Q4 2025 Earnings via AlphaStreet]. The combined "people who already pick things daily" pool is 15–20M+ globally — and none of them touch DeFi today because the onboarding friction is 100× too high. PredictLeague is the friction-removal layer.

Win probability: **65/100**. Hackathon target: working zkLogin → daily-pick → settle loop on testnet, streak badge NFT upgrade visible after 3+ picks, team mode demo (1 leader + 3 followers), shareable result card export, leaderboard PWA.

---

## 2. Problem Statement

Sui has no flagship consumer-facing dApp despite shipping the best mobile-grade primitives in the industry. Three concrete gaps:

- **Prediction markets gate retail at the wallet step**. Polymarket converts a tiny single-digit % of visitors into traders because the path is install MetaMask → bridge to Polygon → KYC-ish geofence → fund USDC → place bet. The protocols know this: Polymarket's growth in 2025 came from politics, not product UX [source: Dune Analytics; The Block Prediction Market Quarterly 2025-Q4]. zkLogin + sponsored TX skip all five steps.
- **DeepBook Predict needs volume across every strike + expiry to validate the SVI surface**, but pro arb bots (idea #1 Vol-Arb) concentrate flow on the few liquid strikes. Retail F2P picks fill the long tail — exactly the flow the PLP and SVI feed need to mature.
- **SocialFi on Sui is empty whitespace**. Friend.tech and Stepn proved viral consumer crypto works with the right hook, but both decayed because the underlying economic loop was speculation, not utility [source: Foresight Ventures retrospective 2025-12]. A prediction game where the *game* is the value (real picks, real settlement, real leaderboard) sidesteps that decay curve.

**The gap**: nobody on Sui has shipped a consumer-grade prediction app that real users (not crypto Twitter) would download. PredictLeague is the bid for that surface area.

---

## 3. Target Users & Personas

### Persona A — Casual Sports / Markets Fan ("Tyler, 24, US, follows NFL + crypto news")
- Already uses DraftKings + reads Polymarket prices for vibes; doesn't trade.
- Pain: real-money apps geofence him out of crypto picks; Polymarket UX too crypto-native.
- Wants: daily 10-second pick on his phone, leaderboard with friends, occasional cash payout, no wallet headaches.

### Persona B — Crypto-Native Streak Hunter ("Aiko, 19, JP, plays Stepn, owns 3 NFTs")
- Loves achievement loops + collectible mechanics.
- Pain: nothing in crypto right now combines daily-engagement + skill + NFTs without devolving into farming.
- Wants: streak badges that visibly upgrade, season points, share-card flexing on Twitter / Lens.

### Persona C — Telegram KOL / Mini-Influencer ("Davi, 12k Twitter, runs a paid TG channel")
- Already sells "alpha picks" via private TG; struggles with verification + trust.
- Wants: on-chain track record of his picks, team mode where followers auto-copy with transparent PnL, revenue share from team fees.

### Persona D — DeepBook Predict Core Team (indirect)
- Wants real long-tail flow across the strike/expiry surface to harden PLP economics and surface SVI bugs early.

---

## 4. Use Cases — Three Concrete Loops

### UC1 — Daily Binary Pick (flagship)
Every day at 00:00 UTC the app posts 3 binary questions (e.g. "BTC close > $100k by 23:59 UTC?", "ETH/BTC > 0.04 by 23:59?"). User opens app, taps "Yes" or "No" on each, optionally stakes 10–100 dUSDC. Behind the scenes a single sponsored PTB calls `predict::mint`. Settlement auto-runs at 23:59 UTC; PnL + streak update posted as push notification.

### UC2 — Streak + Badge Upgrade
3-day streak → bronze badge NFT minted. 7-day → silver upgrade (same object, dynamic NFT swap of metadata + visual). 30-day → gold + perks (lower fee, priority team mode). Streak resets on a missed day, not on a wrong pick — the loop rewards engagement not just accuracy, mirroring Duolingo / Sleeper retention mechanics [source: Sleeper 14-min DAU session per Sensor Tower 2025].

### UC3 — Team Mode (Leader / Follower Copy)
A leader (Persona C) publishes their daily picks publicly. Followers tap "join team" and their `PredictManager` auto-mirrors each pick at their chosen sizing (sponsored PTB batches up to 50 followers per leader-pick into a single tx for gas amortisation). End-of-season prize pool splits 50% leader + 50% top-10 followers by realised return. Builds a verifiable on-chain track record for KOLs — the missing primitive that Polymarket can't offer.

---

## 5. Market Analysis

### TAM / SAM / SOM
- **TAM** — global daily-engagement prediction + fantasy + sports betting users (people already in the habit of picking outcomes daily):
  - Polymarket: ~478k MAU 2025-10 → ~600k by year-end [source: Dune Analytics; The Block 2025-Q4]
  - Sleeper: 7–9M MAU, +39% YoY [source: Sensor Tower 2025]
  - DraftKings: 4.8M MUP / 10.9M annual unique [source: DraftKings Q4 2025 Earnings]
  - Combined directly-addressable: **~15–20M monthly active "pickers" globally**
- **SAM** — subset reachable without geofencing (non-US-regulated prediction + international fantasy + crypto-curious): **~5–8M MAU** (Internal projection — no consolidated public benchmark).
- **SOM (year 1)** — Sui-native consumer app capture target: **50k–250k MAU** by mainnet+12mo (Internal projection — assumes 1–3% conversion of crypto-Twitter + KOL-driven funnel). At 30% paying-user share + $5 ARPU/mo on premium tiers/fees → **$0.9M–4.5M ARR** ceiling for year one.

Anchor sanity check: Polymarket onboarded ~1.26M cumulative traders in 4 years with worse UX [source: Dune Analytics]. Hitting 100k MAU on Sui with frictionless onboarding is structurally plausible.

### Competitive Landscape

| App | Onboarding friction | Real settlement | NFT / streak loop | Team / copy mode | Sui-native |
|---|---|---|---|---|---|
| Polymarket | High (wallet + bridge + KYC) | Yes | No | No | No (Polygon) |
| Kalshi | Very high (US KYC) | Yes | No | No | No |
| DraftKings | Medium (KYC, geofence) | Yes (fiat) | No | Limited (pools) | No |
| Sleeper | Low (email signup) | Free-to-play + paid pools | Limited | Yes (leagues) | No |
| Friend.tech / clones | Medium (wallet) | n/a (speculation) | No | Loose | No |
| **PredictLeague** | **Near-zero (zkLogin)** | **Yes (Predict)** | **Yes (dynamic NFT)** | **Yes (on-chain)** | **Yes** |

The whitespace: zero-friction onboarding + real on-chain settlement + verifiable team mode. No incumbent has all three.

---

## 6. Differentiation — Why Sui + DeepBook Predict + zkLogin + Sponsored TX

1. **zkLogin = Polymarket's missing onboarding layer**. Google sign-in → derived Sui address + auto-`PredictManager`, no extension, no seed. Polymarket has explicitly stated UX is their primary funnel bottleneck; we ship the fix and Sui is the only L1 where zkLogin is a production primitive [source: Mysten Labs Enoki adoption notes 2025].
2. **Sponsored TX = no-fiat onboarding**. First 10 picks free (gas + faucet dUSDC), funded by app treasury. Users only need real money once they cross the engagement threshold — mirroring F2P mobile game psychology that Polymarket can't replicate.
3. **Real settlement, not points**. Every pick is a real `predict::mint` against the PLP, so the leaderboard is on-chain auditable and team mode track records are verifiable. F2P apps that use points-only systems lose users to perceived fakeness; on-chain settlement removes that ceiling.
4. **Dynamic NFT badges natively on Sui**. Move object mutability lets the same badge NFT visually upgrade in place across bronze/silver/gold tiers — no burn-and-mint required, preserving social-graph references and resale history.
5. **Batched PTB for team mode**. One leader pick → one sponsored PTB that mints for 50 followers atomically. On Ethereum this would need either off-chain orchestration (centralisation) or per-user transactions (cost prohibitive). Sui's parallel execution + PTB structure makes this trivial.
6. **Sub-400ms finality** keeps the daily-pick UX feeling instant — critical for a consumer app where any "pending..." spinner kills retention.

---

## 7. Product Scope

### MVP (Hackathon, ~5 weeks)
- **zkLogin onboarding** (Google + Apple) → derived address + auto `PredictManager` + faucet 100 dUSDC.
- **Daily binary picker UI** (mobile-first PWA) — 3 BTC questions per day, tap to pick, optional stake.
- **Streak counter + 3 NFT badge tiers** (bronze/silver/gold), dynamic upgrade on tier-up.
- **Team mode** — single demo team (1 leader + 3 followers), copy-pick PTB.
- **Leaderboard** — global + team-scoped, ranked by season points (function of correct picks × streak multiplier).
- **Share-card export** — auto-generated PNG of daily PnL + streak for Twitter/Lens/TG.

### v1 (mainnet day one — 6 weeks)
- **Push notifications** (PWA + native iOS/Android wrap).
- **Multi-asset questions** (ETH, SOL, SUI, ATTN index from idea #4).
- **Paid premium tier** ($4.99/mo): more daily questions, lower fees, exclusive badge skins.
- **KOL team onboarding flow** — KOL claims a team, sets fee share, invites followers via deeplink.
- **Telegram bot interface** (HANDBOOK idea #5 merger): `/up 70k 15m 100usdc` triggers the same `predict::mint`.

### v2 (Q4 2026)
- **Sports + politics questions** (gated by jurisdiction).
- **Season prize pool sponsorship** (CEX / wallet sponsor contributes pool for branded season).
- **On-chain manager-to-manager social graph**: follow / unfollow / endorse leaders.
- **Cross-app composability**: badge ownership unlocks discounts at partner Sui apps (kiosks, Slush themes).

### Strategic call: app-first, token-last
No token at launch. Streak + badge + leaderboard are the engagement loop. Token only considered at v2 when there's organic seasonal pool TVL justifying governance. This avoids the Stepn / Friend.tech decay pattern.

---

## 8. User Flow — First-Time Onboarding

1. **Open PWA link** (share-card-driven viral entry, no app store required).
2. **Tap "Continue with Google"** → zkLogin OAuth → Sui address derived in ~3 seconds, `PredictManager` auto-created via sponsored PTB.
3. **Faucet** auto-credits 100 dUSDC; tutorial card explains "testnet play money — real prize pool real later."
4. **Today's 3 picks** appear: BTC > $100k, ETH > $3.2k, SOL > $200 → user taps "Yes" on BTC, stakes 10 dUSDC; sponsored PTB submits `predict::mint`, confirmation in <400ms.
5. **Profile screen** shows: streak (Day 1), bronze badge progress (2/3), today's open positions.
6. **Push notification at 23:59 UTC**: "Your BTC pick won! +12 dUSDC, streak now Day 2 🔥".
7. **Day 3 → bronze badge mints**, share-card auto-generated, prompt to share on Twitter ("I'm on a 3-day PredictLeague streak").
8. **Join team flow**: user discovers a leader on the leaderboard, taps join, sets per-pick cap (e.g. 20 dUSDC), all future leader picks auto-copy via batched PTB.

---

## 9. Technical Architecture (summary, no code)

- **On-chain (Sui Move)**:
  - `league` module — daily question registry, season point accounting, team membership.
  - `badge` module — dynamic NFT object with tier metadata; `upgrade()` mutates in-place on streak threshold.
  - Existing DeepBook Predict modules — `predict::mint`, `predict::redeem`, `PredictManager`. No fork required.
- **zkLogin layer**: Mysten Enoki SDK for OAuth → Sui address derivation, ephemeral keypair management, JWT proof verification.
- **Sponsored TX layer**: backend signer pays gas for onboarding txs + first N picks per user; rate-limited by zkLogin sub (Google account ID) to prevent farming.
- **Batched PTB orchestrator**: backend service watches leader picks, builds one PTB per (leader, follower-cohort) batch, signs as sponsor.
- **Settlement keeper**: cron at 23:59 UTC iterates expired picks, calls `predict::redeem_permissionless` (or relies on HANDBOOK #8 keeper network).
- **Indexer + PWA**: Postgres indexer for picks, streaks, team rosters; Next.js PWA frontend; Push API for notifications.
- **Share-card generator**: serverless function renders PNG from pick data + branding template.

No new Move primitives required beyond `league` and `badge` modules. Tight integration with existing Predict + Enoki + Sponsored TX → audit scope minimal.

---

## 10. Business Model

Layered, retention-driven:

1. **Premium subscription** ($4.99/mo, v1) — more daily questions, lower fees, exclusive badge skins, push priority.
2. **Pick fee** — 50bps on each staked pick above 10 dUSDC threshold (free below to preserve onboarding); routed to season prize pool + protocol treasury 70/30.
3. **Team fee share** — leaders set their team fee (0–5% of follower stakes); platform takes 20% cut of team fee.
4. **Sponsor pools** — branded seasons funded by exchange / wallet / RWA sponsor; sponsor pays $50k–$250k pool + brand placement; platform retains 10%.
5. **NFT cosmetics** (v2) — limited-edition badge skins sold via Sui kiosk, royalties to platform.

Unit economics: 50k MAU × 30% paying × $5 ARPU/mo = **$75k MRR / $900k ARR** from subscriptions alone. Pick fees + team fees + sponsor pools likely 2–3× that on top (Internal projection — no external benchmark for Sui-native consumer apps).

Cost structure: sponsored TX gas (~$0.001/tx × est 5M tx/mo at 50k MAU = $5k/mo), Enoki API, indexer hosting, push notification service. Margins healthy by month six.

---

## 11. Go-to-Market

- **Phase 0 — hackathon proof**: working onboarding + daily loop + team mode + 1 KOL demo team. Demo win = legitimacy + grant + co-marketing with Sui Foundation.
- **Phase 1 — KOL alpha seeding (weeks 6–10)**: recruit 10–20 crypto-Twitter / crypto-TG KOLs to lead teams; pay them $500–2000 setup fee + perpetual team-fee share; their followers become the user funnel.
- **Phase 2 — viral share-card growth (weeks 10–20)**: every settled pick auto-generates a share-card; leaderboard memorabilia drive organic Twitter / TG distribution. Target: 10k MAU.
- **Phase 3 — sponsor pool launch (months 5–8)**: partner with a Sui CEX (e.g. Bitget, OKX Sui Wave) for a $100k branded season pool → press cycle + influencer push. Target: 50k MAU.
- **Phase 4 — multi-asset + native app wrap (Q4 2026)**: iOS/Android wrap via TWA; multi-asset questions; Telegram bot full feature parity.
- **Phase 5 — sports + politics (gated)**: jurisdiction-aware question packs; partnerships with regulated sportsbooks for cross-promotion (where legal).

Anchor partners to pursue at hackathon: Mysten Enoki team (sponsorship of sponsored-tx quota), Slush wallet (deeplink integration), Bitget / OKX (sponsor pool LOI).

---

## 12. Hackathon Demo Plan + Judging Mapping

### 7-minute demo script
1. (0:00–0:45) **Hook**: phone-recorded clip — Polymarket onboarding (60 seconds, 5 screens, MetaMask popup, bridge, KYC modal) vs PredictLeague (12 seconds, Google tap, you're in, first pick placed).
2. (0:45–2:30) **Live onboarding**: judge taps Google sign-in on phone mirror → zkLogin address derived → faucet 100 dUSDC → place 3 daily picks → all 3 PTBs land on Sui testnet under 1 second.
3. (2:30–4:00) **Streak + dynamic NFT**: fast-forward demo state to Day 3 → bronze badge auto-mints, screen shows the in-place NFT metadata upgrade (visual swap, no burn).
4. (4:00–5:30) **Team mode**: switch persona to leader → leader places one pick → 3 follower wallets show auto-mirrored picks via batched PTB on explorer (one tx, multiple `predict::mint` calls).
5. (5:30–6:30) **Leaderboard + share card**: show season leaderboard, top KOLs ranked by realised return; tap "share" → auto-generated PNG with PnL + streak + Twitter handle.
6. (6:30–7:00) **Pitch**: "Sui's first consumer app with real PMF mechanics, real settlement, real retention; 15–20M global pickers, near-zero friction" → ask for grant + sponsor partnership.

### Judging criteria mapping
- **Real-World (50%)** — real prediction-market settlement, real users at scale via zkLogin removal of friction; targets a 15–20M-user market (Polymarket + Sleeper + DraftKings combined directly addressable).
- **Technical Quality (20%)** — zkLogin + sponsored TX + dynamic NFT + batched PTB team mode; multiple non-trivial primitives composed.
- **Innovation (15%)** — first verifiable on-chain copy-trading for prediction markets; first Sui consumer app that uses settlement (not points) for engagement.
- **UX (10%)** — under-30-second onboarding is the demo-clip moment; mobile-first PWA.
- **Sui Ecosystem Fit (5%)** — Predict + zkLogin + Sponsored TX + dynamic NFT + (v1) Telegram bot.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Judges dock as "a game, not infra" | High | High | Demo lead with onboarding-friction comparison + real-settlement framing; explicitly position as "Sui's consumer onramp" not "another picks app" |
| Crowded category — every chain has a picks dApp | High | Medium | Differentiate on (a) zkLogin friction-zero (b) real Predict settlement (c) verifiable team mode track record; all three together = whitespace |
| Sponsored TX quota exhausted by farming | Medium | High | Per-zkLogin-sub rate limit; require email verify above 100 picks; geo-throttle on suspicious patterns; cap free quota to $X/month |
| Reward economics gamed (multi-account farming) | High | Medium | zkLogin sub uniqueness check; streak rewards weighted by stake size (not just pick count); rate-limit badge upgrades; gold tier requires real-money entry |
| Doesn't differentiate Sui's tech enough — judges want infra demo | Medium | Medium | Foreground batched-PTB team mode + dynamic NFT in-place upgrade as Sui-specific impossibilities elsewhere |
| zkLogin OAuth provider outage during demo | Low | High | Multi-provider fallback (Google + Apple + Twitch); pre-warmed test account as backup |
| Predict testnet question pool too thin for daily cadence | Medium | Medium | Coordinate with Predict team on question schedule; fallback to synthetic questions sourced from Pyth feed thresholds |
| Telegram bot ToS issues (HANDBOOK #5 merger) | Low | Low | Optional v1 feature; PWA is primary surface |
| Mobile push notification reliability | Medium | Low | PWA + native wrap fallback; web fallback always works |
| Regulator views NFT badges as securities | Low | High | No revenue distribution tied to badge ownership; cosmetic only; explicit ToS |
| Single-day engagement insufficient (low DAU/MAU ratio) | Medium | High | Team mode + push notification + share-card flywheel; aim for ≥30% DAU/MAU like Sleeper's 14-min sessions [source: Sensor Tower 2025] |

---

## 14. Open Questions

1. **Premium tier pricing** — $4.99/mo is iOS-default; should we test $2.99 or $9.99 for first cohort?
2. **Sponsor pool deal structure** — flat $100k for season vs revenue share vs equity-like brand-token swap?
3. **Telegram bot priority** — merge HANDBOOK #5 into MVP, or strict v1 add-on?
4. **Question authorship** — Predict-team-only, or open question proposals with stake-weighted voting?
5. **Native app wrap timing** — TWA at v1 or wait until 25k+ MAU justifies App Store review effort?
6. **Cross-chain expansion** — stay Sui-pure (defensible moat: zkLogin + Sponsored TX + Predict), or bridge results from Polymarket / Kalshi for richer question pool?
7. **KOL team caps** — max followers per leader (5? 50? unlimited)? Affects batched-PTB gas + UX.
8. **NFT badge resale** — open Kiosk listing, or soulbound to preserve track-record integrity?
9. **Settlement keeper ownership** — own keeper or integrate HANDBOOK #8 Settled-Redeem Keeper Network from day one?
10. **Token / DAO timing** — v2 governance token, or stay token-free indefinitely to avoid speculation decay?

---

*End of spec. ~2,300 words.*
