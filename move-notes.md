# Move Notes — PredictLeague

_Last updated: 2026-05-31_

## 目的
實作 spec (`docs/specs/2026-05-30-predict-league-spec.md`) 的兩個 Move module：`league` + `badge`。

## 已建立檔案
- `move/Move.toml` — package `predict_league`, edition `2024.beta`, Sui dep pin `framework/testnet`.
- `move/sources/badge.move` — soulbound `Badge` + v2 `Skin` + `BadgeMintCap`。
- `move/sources/league.move` — League/PlayerProfile/PlayerStat/Pick/Question/SubRegistry/Team + 全部 accounting 邏輯。
- `move/tests/league_tests.move` — 12 unit/flow tests。

## 測試結果
`sui move build` ✅（僅 warning，已用 `#[allow]` 清掉 DIR_DOWN / Skin 欄位）
`sui move test` ✅ 12/12 PASS：
outcome 邏輯、points formula、streak（連續+gap reset）、settle win 加分、settle 早呼叫/oracle 未結算/雙重結算 abort、重複 pick abort、暫停 abort、sub 唯一性 abort、fee 上限 abort、badge mint→tier。

## 實作期間的 spec 修正（F6–F8）
- **F6** `BadgeMintCap` 型別從 `league` 移到 `badge` 定義 → 否則 `badge` 要 import `league` 造成循環依賴。`League` 持有 `badge::BadgeMintCap` 實例。
- **F7** badge mint/upgrade **不能**在 permissionless `settle_pick` 內做 —— `Badge` 是 owned object，keeper 無法 mutate 別人的 owned object。拆成玩家自己簽的 `mint_badge` / `sync_badge`（讀自己 stat → mint/升級，badge 送到 `ctx.sender()`）。`settle_pick` 只滾 streak/points。
- **F8（未解硬化缺口，已誠實標註）** `league` 這版**不 import Predict package**（原始碼拿不到）。Predict 互動在 PTB 層組合。後果：`settle_pick` 的 `settlement_price` 目前由 caller 傳入，僅用 `EOracleNotSettled`（price==0）弱閘。真 trustless 需 `league` 自己讀 `OracleSVI` → 待 Predict dep 可用後接上（Move.toml 已留註解）。輸贏判定邏輯本身已是鏈上 pure（`outcome_is_win`）。資金託管不受影響（在 shared PredictManager，非 league）。

## 設計重點
- `stats` Table 以 **profile object-id address** 為 key（permissionless settle 可由 keeper 用 `profile_addr` 定位）。
- streak = 連續「天數」參與（UC2：錯 pick 不重置，漏天才重置），在 `place_pick` 滾動。
- points = `(stake / 1e6 units) * (10 + streak)`，stake-weighted 反 farming（D5）。
- badge tier 門檻：streak 3→bronze, 7→silver, 30→gold。
- module 間用 `public(package)` + `BadgeMintCap` 雙重門禁（防 A1）。

## 已知風險 / TODO
- **F8 oracle read** 為主要待補（trustless 結算的最後一哩）。
- `place_pick` 目前記帳 `stake: u64`（非 `Coin`），信任 sponsored PTB 正確組合 predict::mint；真版可考慮 league 消費 Coin 或讀 minted position。
- team copy（follower 批次）只到 `leader_pick` event + `assert_within_cap` 閘；實際複製在 off-chain orchestrator。
- 尚未跑 code review（CLAUDE.md 強制 Move 用 `sui-code-review` 鏈：move-code-quality → sui-security-guard → sui-red-team）。
- sui CLI 為 1.71.0（spec 寫 1.72.2 testnet）；edition 用 2024.beta 相容。

## Code Review 鏈結果（2026-05-31，CLAUDE.md 強制三關）

關卡：move-code-quality → sui-security-guard → sui-red-team。

### move-code-quality
- **R1（critical 邏輯 bug，已修+驗證）** `badge::upgrade` 原本強制 `new_tier == tier+1`（逐級），但 `sync_badge` 的 target 由 `best_streak` 算出可跳級 → 玩家 bronze 後直衝 gold streak 會 abort `EInvalidTier` 永久卡死，且與「mint 首鑄可跳級」自相矛盾。修法：`upgrade` 改 `new_tier > badge.tier`（允許跳級）。補 regression `test_badge_sync_jumps_bronze_to_gold`。**13/13 PASS**。
- 風格建議（未改，低優先）：error const 缺 `#[error]` 註解；method syntax 未一致；`Team.season_realized`/`season` dead code；`publish_question` 不驗 `direction`。

### sui-security-guard
- secret 掃描乾淨（無 privkey/API key/.env）。AdminCap/VerifierCap/BadgeMintCap 守衛正確（非 public_transfer）。
- 補了 `.gitignore`（secrets + `move/build/` + node）。專案目前**非 git repo**，pre-commit hook 待有 repo 再裝。

### sui-red-team — 3 EXPLOITED（可執行證明在 `move/tests/red_team.move`）
1. **🔴 STAKE INFLATION FARMING（上線 blocker）** `place_pick` 是 public 無 cap，`stake` 自報且鏈上不綁真實鎖倉 → 攻擊者跳過 `predict::mint`，0 元宣告 stake=1e9 units，settle 白拿 11e9 points。**直接擊穿 D5 anti-farming**。證明 `red_team_stake_inflation_farming` PASS。
   - 修法（推薦 C）：A=`place_pick` 收 `Coin<DUSDC>` 用實際面額；B=cap-gate（信任收回 backend，違 D2 精神需揭露）；C=收 predict 鑄出的 position object `&` 讀面額。**A/C 都需 Predict dependency（同 F8 blocker）→ #1 與 F8 綁同一 milestone。在此之前 leaderboard 不可宣稱 trustless/anti-farm。**
2. **🔴 KEEPER FAKES PRICE（= 已知 F8，現證實可達）** 任意地址自選 `settlement_price` 強制任何 pick 輸贏。證明 `red_team_keeper_fakes_settlement_price` PASS。修法：接 Predict dep 讀 `OracleSVI.settlement_price`。
3. **🔴 UNLIMITED BADGE MINT** `mint_badge` 無 once-guard，可連鑄 N 個。證明 `red_team_unlimited_badge_mint` PASS。修法：`PlayerStat` 加 `badge_minted: bool`（未上鏈可直接加 field；已上鏈走 `extra: Bag` dynamic field 避 F4）。

> `red_team.move` 刻意斷言「攻擊成功」，留作 exploit 種子——修好後測試會翻紅 = 修復訊號（再轉成 `#[expected_failure]` regression）。

### 待動工順序（建議）
- **M1（blocker，綁 Predict dep）**：修 #1 stake 綁定 + #2/F8 oracle read，一起做。leaderboard 上線前置。
- **M2（quick win）**：#3 badge once-guard。
- **M3（cleanup）**：move-code-quality 風格項 + dead code。

---

## §M1 — Predict Dependency: Trustless Settlement + Real-Stake (2026-06-15)

**目的**：把 `league` 接上真實 DeepBook-Predict 鏈上狀態，封掉兩個上線 blocker 紅隊漏洞（#1 stake inflation、#2/F8 fake price）。實作計畫 `docs/superpowers/plans/2026-06-15-m1-predict-dependency.md`，設計 `docs/specs/2026-06-15-m1-predict-dependency-design.md`。

### 修改的 module
- `move/Move.toml` — 加 `deepbook_predict` git dep（rev=main）+ **`dusdc` 直接 dep**（named address 需在 scope）+ `[dep-replacements.testnet]`（pyth_lazer/wormhole）。
- `move/sources/league.move` — `Pick` struct（+`order_id: u256` +`predict_manager: ID`）；error 15–19；改寫 `place_pick`/`settle_pick`；抽出共用 `book_pick`/`book_settle` 會計尾段 + `#[test_only]` wrapper（`place_pick_for_testing`/`settle_pick_for_testing`）。
- `move/tests/league_tests.move` — 改用 test wrapper；加 `points_weight_on_cash_not_leverage` 意圖測試。
- `move/tests/red_team.move` — 兩個 EXPLOITED PoC 轉負向/文件測試（exploit 入口已從型別層消失）。

### 新 place_pick / settle_pick 簽名（backend PTB builder 必讀）
```
place_pick(league, profile, manager: &mut PredictManager, market: &mut ExpiryMarket,
           config: &ProtocolConfig, oracle: &MarketOracle, pyth: &PythSource,
           question_id, lower_strike, higher_strike, quantity, leverage,
           stake_coin: Coin<DUSDC>, clock, ctx)
settle_pick(league, manager: &PredictManager, market: &ExpiryMarket, oracle: &MarketOracle,
            profile_addr, question_id, clock)   // 無 price 參數
```
- backend 須傳 predict 的 testnet shared objects：`ProtocolConfig` / `PythSource` / `ExpiryMarket` / `MarketOracle`（對照 predict testnet 部署）。
- **mint 需在同一 PTB 先刷新 Pyth**（predict mint 依賴 `PythSource` 新鮮度）。
- **stake = 全額 DUSDC cash delta（含 fee/penalty）**，非 net premium（鏈上拿不到）。delta 是安全 over-approximation。

### 驗證過的真實 predict API（rev 9f69985，與 Move.lock 釘的一致）
- module path 修正：`deepbook_predict::protocol_config::ProtocolConfig`（**非** `::config::protocol_config`）、`deepbook_predict::pyth_source::PythSource`（**非** `::oracle::pyth::pyth_source`）。plan 寫的舊路徑會 build fail。
- `manager.deposit(Coin<DUSDC>, ctx)` / `manager.balance(): u64` / `manager.generate_proof_as_owner(ctx): PredictTradeProof` / `manager.has_position(market_id: ID, order_id: u256): bool`。
- `market.mint(manager, &proof, config, oracle, pyth, lower, higher, qty, lev, clock, ctx): u256`（回 order_id）/ `market.market_oracle_id(): ID` / `market.id(): ID`。
- `oracle.is_settled(): bool` / `oracle.settlement_price(): u64`。
- `manager.new` 是 `public(package)` → league 無法自建 manager；player 自帶（owner 由 deposit/proof 驗證）。

### UX 影響（前端必提示）
- **hold-to-settle**：settle 重驗 `has_position`。玩家必須先讓 keeper settle 領分、再 withdraw；提早 redeem = 棄分。
- place_pick 內部組 deposit+mint；未被 mint 消耗的 deposit 餘額留在 manager，玩家事後自行 withdraw。

### 鏈上限制 / 踩雷
- new-style package：**transitive dep 的 named address 不自動暴露**給上層 → 用 `dusdc::dusdc::DUSDC` 必須把 dusdc 升為直接 dep（與 Task 0 的 old→new style 遷移是不同雷）。
- predict test scaffolding 對下游受限（`settle_*_for_testing` 是 `public(package)`、fixtures 在 `tests/helper/` 不可 import）→ predict-CPI happy path / 反 farming（需 live settled oracle）只能走 **testnet e2e**（Task 6，尚未做）。

### 測試結果
- `sui move build` EXIT=0；`sui move test` **16/16 PASS**（含 leverage-no-inflation 意圖測試）。
- 仍未覆蓋（Task 6 testnet e2e 待做）：真實 deposit+mint cost delta、EOracleNotSettled 正向 reject、EPositionClosed early-close reject、win path 加分。

### 已知風險 / 待辦
- **Task 6 testnet e2e 未做**（需 live testnet 部署 + DUSDC + 近到期 market）。M1 Move 邏輯完成但 CPI 端到端尚未鏈上實證。
- **Task 8 Move review chain 待跑**（move-code-quality → sui-security-guard → sui-red-team）。
- #3 badge 無限鑄仍開（M2）。
