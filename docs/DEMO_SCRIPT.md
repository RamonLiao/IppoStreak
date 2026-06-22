# IppoStreak — Demo Script (5 min)

> Sui Overflow 2026 • DeepBook & Prediction Markets Track
> Format: 1 min slides · 3 min live demo · 1 min future vision · British English

---

## PART 1 — SLIDES (1:00)

**[Slide 1 — Title, 0:00–0:10]**
"Hi, we're **IppoStreak** — a free-to-play prediction season built on Sui, powered by DeepBook Predict, zkLogin and Sponsored Transactions."

**[Slide 2 — The Problem, 0:10–0:35]**
"Prediction markets like Polymarket have huge potential, but three things hold them back.
First, the **onboarding cliff** — install a wallet, bridge assets, buy gas tokens, all *before* your first pick. Most casual fans give up.
Second, **thin long-tail liquidity** — DeepBook Predict needs steady volume across every strike and expiry to mature its volatility surface, but arbitrage bots only touch the few liquid strikes.
Third, **pure speculation decays** — SocialFi apps die when there's no real gameplay or retention."

**[Slide 3 — The Solution, 0:35–1:00]**
"IppoStreak is the zero-friction consumer gateway. We wrap the engagement loop of fantasy sports around **real on-chain settlement**.
Sign in with Google — no seed phrase. Your first ten picks are **gasless and free**, sponsored by the app. Every pick is a real `predict::mint` against the DeepBook order book, so the entire leaderboard is auditable on-chain.
You get from sign-in to your first pick in under thirty seconds. Let me show you."

---

## PART 2 — LIVE DEMO (3:00)

> Pre-flight checklist (do BEFORE you present — do not show this):
> - `cd app && npm run dev` running on `http://localhost:5174`
> - `.env.local` filled (Enoki public key + Google client ID); Enoki Portal testnet enabled; Google OAuth redirect = `http://localhost:5174`
> - Open question **qid=1** is live on oracle `0x05306d43…` (BTC, ~26-day window) — Pick page will show it
> - Browser logged OUT of the demo Google account so onboarding shows fresh
> - Have a backup screen-recording in case OAuth/network flakes

**[2.1 — Onboarding, 1:00–1:45]**
- "I'm a brand-new user. I tap **Continue with Google**."
- *(Complete the OAuth pop-up.)*
- "That's it — no extension, no seed phrase. Behind the scenes zkLogin derived a Sui address, and we created a **PredictManager** and a player profile for them — two transactions the user never had to think about, **gas paid by us** via Sponsored Transactions."
- *(Point at the funding banner.)* "We've also topped them up with faucet dUSDC so they can play immediately."
- 💡 *Talking point:* "Onboarding here is a real contract entry, `create_profile_open` — ungated, with on-chain Sybil de-duplication per address. No backend custody key."

**[2.2 — Place a Pick, 1:45–2:30]**
- "Now the core loop. Here are live **BTC markets** — these prices are read **straight off the chain** over gRPC, no backend."
- *(Open a market → Pick page.)* "This shows a real published question: the **direction and strike come from the chain**, not hard-coded in the UI. I just choose my stake and submit."
- *(Submit the pick.)*
- "That fired a real **`predict::mint`** against the DeepBook CLOB. The stake we record is the *actual* dUSDC balance delta — the real money at risk — not a number we typed."
- 💡 *Talking point:* "Gas on this was about 0.025 SUI, and it's sponsored — the user pays nothing for their first ten picks."

**[2.3 — Proof & Streak, 2:30–4:00]**
- *(Go to MyPicks.)* "Here's the pick we just placed, read back from on-chain state and decoded — quantity, direction, strike, all matching the `PickPlaced` event."
- "When the oracle settles, **anyone** can call `settle_pick` permissionlessly — it's idempotent and time-gated, so it can't be double-counted or settled early. The winner's points, streak and stake update in the shared League object."
- *(Show the stats / streak, and the Seahorse badge concept.)* "Maintain a streak and your **Seahorse Badge NFT mutates in place** — Bronze to Silver to Gold — using Sui's object mutability, so history and social references are preserved without burn-and-mint."
- 💡 *Closing the loop:* "Sign-in → faucet → daily pick → streak → upgrade. Every step is real, on-chain, and auditable."

> If anything flakes live: switch to the backup recording and narrate the same beats. The pre-built proof exists: live pick on qid=1, stake 495279, digest `9KmCd36h…`, BCS-verified against the chain.

---

## PART 3 — FUTURE VISION (1:00)

**[4:00–4:30]**
"Where this goes next. The single-player loop you just saw is live. Next is **Team Mode — social copy-trading**: you subscribe to a KOL leader's team, and when they place a pick, every follower's position is mirrored automatically in **one batched PTB** — up to fifty copies in a single atomic transaction to keep gas minimal. That turns one good predictor into liquidity across the whole order book."

**[4:30–4:55]**
"And that's the bigger play for the **DeepBook ecosystem**. Every casual pick is genuine volume spread across strikes and expiries — exactly the long-tail flow the SVI volatility surface needs to mature. IppoStreak isn't just a game on top of DeepBook; it's a **liquidity funnel feeding it.**"

**[4:55–5:00]**
"Zero-friction onboarding, real settlement, and a flywheel for liquidity. That's IppoStreak. Thank you."

---

## ONE-LINER (if cut for time)
"IppoStreak turns DeepBook prediction markets into a free-to-play streak game — Google sign-in, gasless first picks, real on-chain `predict::mint` settlement — funnelling casual liquidity into DeepBook's long tail."
