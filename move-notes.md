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

## §D5 — 身份模型 + Sybil 邊界 + zkLogin 升級路徑（2026-06-16）

### 鏈上身份抽象（已實作，無需改動）
身份不綁 wallet address，綁 `sub_commit`（`vector<u8>` hash）：

```
sub_commit ──VerifierCap 證明──▶ PlayerProfile (owned, owner_sub_commit)
SubRegistry: sub_commit → profile_addr   （一個 sub 一個 profile，ESubAlreadyRegistered）
PlayerStat keyed by profile object id（NOT ctx.sender()）→ permissionless settle 不會錯帳
```

- `create_profile`（`league.move:224`）由 `VerifierCap` gated，attest `sub_commit`。
- `PlayerStat` 用 profile object id 當 key（`league.move:234-235`），keeper 當 settle sender 也安全。

### Sybil 防護分兩層
1. **leaderboard 排名 = stake-weighted**（points = `(stake/1e6)*(10+streak)`，已實作）→ 多錢包拆分總 stake 不變，刷分零經濟優勢，**純鏈上 trustless**。
2. **非線性獎勵**（badge / 賽季名額）= 一人一份，靠 `SubRegistry` + `VerifierCap` 擋一人多 sub。

### v1 → v2 升級路徑（zkLogin 留到下一輪，現在零成本）
- **v1（現況）**：backend 持 `VerifierCap`，驗使用者身份後寫 `sub_commit`（**半信任邊界，誠實揭露**）。
- **v2（zkLogin）**：`sub_commit` = OAuth `sub` hash。backend 驗 JWT 後 attest——**同一個 `create_profile`、同一 schema、同一欄位（`owner_sub_commit`），Move 一行不改**。
- `VerifierCap` 在 v2 仍保留：Sui zkLogin 證的是 address derivation，不直接證 sub，仍需 backend 橋 JWT→sub。
- **結論**：schema 已 zkLogin-ready，現在做 zkLogin 是純前端/backend 整合工程（無前端殼前等於空轉），延後無反悔成本。

### 已知邊界（誠實揭露）
- 身份唯一性最終仍依賴 `VerifierCap` holder（backend）誠實 attest sub。完全去中心化 proof-of-personhood（World ID 類）屬 over-engineering，非 hackathon scope。

## M1-REVISIT (2026-06-17) — M1 CPI 打錯版本，須對齊 deployed 舊架構

### 發現（Task 6 偵察觸發）
- M1（2026-06-15）把 predict CPI 從 `OracleSVI` 改成 `MarketOracle`/`ExpiryMarket`/`ProtocolConfig`/`PythSource`，依據是 deepbookv3 **source HEAD（rev=main, 9f69985）**。
- 但 testnet 上 live 的 predict（`0xf5ea2b…`，indexer 服務、4232 oracles 全是 `oracle::OracleSVI`）是**舊單體架構**：deployed module = constants,i64,market_key,math,oracle,oracle_config,plp,predict,predict_manager,pricing_config,range_key,rate_limiter,registry,risk_config,strike_matrix,treasury_config,vault。**無 expiry_market/market_oracle/protocol_config/pyth_source**。
- `Move.lock` deepbook_predict **無 published-at** → rev=main 版未部署 testnet → league 既無法 publish、物件型別也對不上 live markets。
- 教訓重演 lesson-2：「真實型別是 MarketOracle」是看 source HEAD，沒驗 deployed。實為倒退。2026-05-31 spec（F1–F5, OracleSVI/MarketKey）才對著 deployed。

### 決策：採 Option A — M1 改寫對齊 deployed 舊架構（OracleSVI / MarketKey / predict::Predict）
理由：唯一能對「真實 live 結算市場」跑 e2e 的路；M1 安全設計（真實 stake delta / 鏈上 settlement_price / hold-to-settle）全部仍成立。Option B（自部署重構版協議）對 hackathon 不現實；Option C（放棄 e2e）少鏈上實證。

### Deployed ABI 對照（已鏈上驗，可行）
- `predict::create_manager(ctx) -> ID`（建+share manager）
- `predict::mint<DUSDC>(&mut Predict, &mut PredictManager, &OracleSVI, MarketKey, u64 qty, &Clock, ctx)` — 無 proof/config/pyth/leverage，**不回 order_id**
- `predict::redeem_permissionless<DUSDC>(&mut Predict, &mut PredictManager, &OracleSVI, MarketKey, u64, &Clock, ctx)`
- `predict_manager::{deposit<DUSDC>, balance<DUSDC>()->u64, withdraw<DUSDC>, position(MarketKey)->u64}`
- `oracle::is_settled()->bool`、`oracle::settlement_price()->Option<u64>`（unwrap=EOracleNotSettled，回到舊 F2c）
- `market_key::new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool) -> MarketKey`（Copy+Drop+Store；DIR_UP→is_up=true）

### 三大安全設計對映
- 真實 stake = `deposit`→`balance()` 前後 delta（不變）
- 鏈上 settlement_price = `oracle.settlement_price()` Option unwrap（不變）
- hold-to-settle 防 early-close：mint 不回 order_id → 改 `predict_manager::position(manager, MarketKey) > 0`（per-MarketKey；per-question 單 pick guard 仍防重複 mint）

### Build 解法（風險#1 RESOLVED）
- deployed `0xf5ea2b` 部署於 2026-04-16 23:48 UTC；部署前最後一個 predict 變更 commit = **`19f86ebad9c6371c4f5c07229faabb2020dc691c`**（2026-04-14），module 集合與 deployed 逐一相符。
- Move.toml：`deepbook_predict`/`dusdc`/transitive 釘 `rev = "19f86ebad9c6371c4f5c07229faabb2020dc691c"`；`[dep-replacements.testnet]` 加 `deepbook_predict = { …, published-at = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138", original-id = 同上 }`。
- publish 用 `--skip-dependency-verification`。

### 須改檔（core logic → plan track，待 brainstorming/plan 確認後實作）
1. `league.move` imports 換舊 module；`Pick.order_id: u256` → 存 `MarketKey`。
2. `place_pick` 簽名移除 config/pyth/leverage/lower&higher_strike/proof，由 Question 組 MarketKey + qty 呼叫 `predict::mint`。
3. `settle_pick`：settlement_price Option unwrap；hold-to-settle 改 `position()>0`。
4. red_team/unit 測試 fixtures 隨型別調整；22/22 須維持。
5. 之後才做 Task 6 e2e（`scripts/m1_e2e.ts`）。

### 待 planning 解的剩餘小風險
- grid strike 合法值（須落在 oracle min_strike + tick_size 網格；indexer 有 min_strike/tick_size）。
- mint 的單一 u64 確認是 quantity 語意 + 最小可行下單量（min size / 保證 balance delta>0 不觸 EZeroStake）。
- Pyth/oracle 須處於可 mint 狀態（status active）；近到期視窗下單時間。

---

## §M1-REVISIT IMPLEMENTED (2026-06-19)

實作完成並 **testnet 端到端鏈上實證**。計畫：`docs/superpowers/plans/2026-06-19-m1-revisit-oraclesvi.md`。

### 改了什麼
- **`league.move` 重寫 CPI 對齊 deployed 單體 OracleSVI**（非 source HEAD 的 MarketOracle/ExpiryMarket）。`place_pick` 組 `predict_manager::deposit` + `predict::mint<DUSDC>`（deployed mint 無 proof/config/pyth/leverage），stake = `manager.balance<DUSDC>()` delta（#1 反 farming）。新增 `max_cost` slippage guard（`EMaxCostExceeded=22`）。
- **`publish_question_for_market`**（新 production entry）：從 live `OracleSVI` 推導 `oracle_id`/`expiry`（V6 by-construction，不可漂移），gate `is_active() && !is_settled()`（`EOracleNotActive=23`；`!is_settled` 是 red-team V1 補強）。V5 strike-on-grid 走 off-chain（grid 是 `public(package)` 鏈上讀不到）。
- **`create_profile_and_keep`**（新 onboarding entry）：`PlayerProfile` 是 key-only，PTB 的 TransferObjects 搬不動 → module 內 `transfer::transfer` 給 caller。**e2e 才抓到的 gap**。
- **`settle_pick` 拿掉 hold-to-settle**（`position(key) > 0`）+ manager 綁定/param；`EPositionClosed=15→19` 退役。改純粹用 `direction` vs 鏈上 `settlement_price` 計分。
- 退役 error：`15`(EMarketMismatch)、`19`(EPositionClosed)。新增 `22`/`23`。

### 為何拿掉 hold-to-settle（關鍵發現，只有 live e2e 抓得到）
deployed predict 跑一個 **permissionless auto-redeem keeper bot**（`0x49c56cac…`，只做 `redeem_permissionless`，34 calls/15 batched txs）。實測：oracle 結算後 **14 秒**（tx `8VdgBb…`，`PositionRedeemed`）就把我的 position 歸零，早於 settle_pick → 舊版必 abort `EPositionClosed`。`position > 0` 在這條鏈上「常態」就不可滿足，不是只有 griefing。反 farming 改靠 #1（stake=真實 cost）+ V10（`assert_live_oracle` 擋結算後 re-mint），與 hold 無關。詳 `docs/security/threat-model.md`。re-review（sui-red-team）verdict = SAFE，5 vectors 全 DEFENDED。

### Dependency / publish 踩雷（sui 1.73）
deployed predict/deepbook/dusdc @ rev `19f86eb` 是 old-style（`[addresses]=0x0`，lock 無 `[env]`）。`sui client publish` 只認「dep 自己 manifest/lock 宣告 published」的 DIRECT dep；`[dep-replacements]` 的 published-at 對 direct dep 無效（對 transitive 的 deepbook 才有效）。**解法**：vendor 三個 package 到 `move/vendor/`，各自 `Move.toml` 加 `published-at` + named address = deployed id（token/DEEP 同模式）。build 即 link 到鏈上 0xf5ea2b/0x74cd56/0xe95040。

### Testnet e2e 證據（active addr 0x1509…bc4c）
最終套件 `predict_league` = **`0xc76cfc044354aab402cfd007c866a6ba95546bd35783dc251bc28b4cd467e250`**（v1 `0x8d1340…` / upgrade `0x966cdb…` 已棄；signature 改動不可 upgrade → fresh publish）。
- League `0x2e1cad6d…7d8a716c`、SubRegistry `0x506c64d6…40f5088b`、AdminCap `0xd94e69c1…15eddac1`、VerifierCap `0x3a38a065…ea92bb33c`、UpgradeCap `0x57fd26b8…98b2cda5`、PredictManager `0x29981867…214e634d`。
- **place_pick**（digest `G1JQ8w…` 首輪 / fresh 輪同模式）：deposit 200 DUSDC，**stake 記 550234（真實 mint cost delta，非存入額）** → #1 鏈上實證。
- **settle_pick**（digest `FebcGc3b…`）：position 已被 bot 歸零仍 **成功**，`won=true`（62763119653670 ≥ strike 62488000000000，UP 勝），`points=0`（stake < POINT_UNIT，sub-unit floor，符合 `red_dust_stake_zero_points`）→ 新設計（不依賴 position）鏈上驗證。
- 負向：settle 早於 expiry → abort **code 4**（ENotExpired，tx `DD8vRA…`）；重複 settle → abort **code 5**（EAlreadySettled）→ 時間閘 + idempotency 鏈上實證。EOracleNotSettled 由 unit test 覆蓋。

### 已知邊界
- League 積分 = 「付費 pick 的方向正確性」，與 DeepBook 實際 PnL/redeem 解耦（red-team V-D5，明確產品決策）。
- vendor/ 是 deepbookv3 @19f86eb 副本 + 手加 published-at；勿 bump source rev（會回到未部署的重構版）。
