# PredictLeague — F2P Prediction Season

**One-line pitch**: zkLogin + sponsored-TX free-to-play prediction season — daily binary picks, streaks, NFT badges, team mode, real DeepBook Predict settlement.

## Problem it solves
Retail can't read SVI and won't risk real money first. Sui lacks a viral consumer-facing app. Predict markets need volume across every strike/expiry.

## Core mechanism
- zkLogin (Google/Apple) → auto Sui address + PredictManager.
- Faucet 100 testnet dUSDC; sponsored TX for first interactions.
- Daily binary picks settle through `predict::mint/redeem`.
- Streak counter → NFT badge upgrades.
- Team mode: leader picks, followers auto-copy.
- Season points → real prize pool.

## Why this track
UX 20% maxed (mobile-first, zero-friction). Hits HANDBOOK idea bank #5 + #6. Brings retail volume Predict needs.

## Win probability: 65/100
Easy to demo, viral potential. But judges weighted toward "serious trading + composability" may dock it as a game. Also crowded category.

## Risks / weaknesses
- Game framing → "not infra."
- Sponsored TX quota limits.
- Reward economics easy to game.
- Doesn't differentiate Sui's tech.

## Required Sui primitives
- DeepBook Predict: `predict::mint/redeem`, `PredictManager`.
- zkLogin, Sponsored TX.
- Optional dynamic NFT module.

## MVP scope
- zkLogin flow + faucet.
- Daily binary picker UI.
- Streak + badge NFT.
- Team mode (single team in demo).
- Leaderboard.
- Share-card export.
