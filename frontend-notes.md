# 🎨 IppoStreak Frontend Notes

本文件記錄 `IppoStreak` 的前端設計系統、視覺資產、Logo 設計決策以及後續實作細節。

---

## 🎨 視覺設計系統 (Design System)

### 1. 核心色調 (Color System)
*   **深海科技底色 (Base Dark)**: `#0A1128` (深邃海底靛藍)
*   **活力珊瑚橘 (Accent Orange)**: `#FF5E3A` (連勝火焰橘)
*   **Sui 水光綠 (Sui Cyan)**: `#00F2FE` (經典 Sui 綠松石)

### 2. 字體與排版 (Typography)
*   預計採用 Google Fonts: **Outfit** 與 **Space Grotesk**，營造現代 Web3 科技與電競感。

---

## 🖼️ 視覺資產路徑 (Visual Assets Path)

所有精選的日系手繪動漫風視覺資產已複製至專案目錄與前端公用目錄中：

| 資源名稱 | 專案庫存路徑 | 前端靜態目錄路徑 (Vite Public) | 解析度/比例 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| **主品牌 Logo** | [assets/logos/ippostreak_anime_flat_cute.png](./assets/logos/ippostreak_anime_flat_cute.png) | [app/public/ippostreak_logo.png](./app/public/ippostreak_logo.png) | 1:1 Square | 2D 扁平手繪日系 Chibi 海馬，戴著橘色拳擊手套，乾淨無 AI 感。 |
| **官方背景圖** | [assets/ippostreak_bg.png](./assets/ippostreak_bg.png) | [app/public/ippostreak_bg.png](./app/public/ippostreak_bg.png) | 1:1 Pattern (Seamless) | 搭配 `#0A1128` 深海靛藍底色，周圍帶有簡潔水流、氣泡與亮橘、亮藍能量折線的精美背景，中間留白供 UI 顯示。 |
| **官方橫幅 (Banner)** | [assets/ippostreak_banner.png](./assets/ippostreak_banner.png) | [app/public/ippostreak_banner.png](./app/public/ippostreak_banner.png) | 16:9 Landscape | 左側為可愛揮手 Q 版海馬，右側整合了 "IppoStreak" 的極簡扁平動漫標題字，背景為深海波浪。 |

---

## 🛠️ 前端代碼引用指南

### 1. 設置網站背景
在 `app/src/index.css` 或主組件的最外層容器中：
```css
body {
  background-image: url('/ippostreak_bg.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-color: #0A1128;
  color: #FFFFFF;
}
```

### 2. 引入 Logo
在導覽列組件 `Navbar.tsx` 中：
```tsx
import React from 'react';

export const Navbar = () => {
  return (
    <nav className="flex justify-between items-center p-4 bg-[#0A1128]/80 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <img src="/ippostreak_logo.png" alt="IppoStreak Logo" className="w-10 h-10 object-contain" />
        <span className="font-bold text-xl text-white">IppoStreak</span>
      </div>
      {/* 錢包連接等其他組件 */}
    </nav>
  );
};
```

---

## 🛠️ 本次子任務工作重點與變更

*   **完成工作**:
    *   根據無 AI 感的日系手繪可愛 Logo，延伸生成對齊色調的 1:1 背景圖與 16:9 Landscape 橫幅。
    *   將這三項核心視覺資產統一存入 `assets/` 與前端網站的 `app/public/` 目錄中。
    *   更新並完善 `frontend-notes.md` 引用說明，以作為長期記憶。
*   **變更檔案**:
    *   [MODIFY] [frontend-notes.md](file:///Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/2-DeepBook-Predict/06-predict-league/frontend-notes.md)
    *   [NEW] `assets/logos/ippostreak_anime_flat_cute.png`
    *   [NEW] `assets/ippostreak_bg.png`
    *   [NEW] `assets/ippostreak_banner.png`
    *   [NEW] `app/public/ippostreak_logo.png`
    *   [NEW] `app/public/ippostreak_bg.png`
    *   [NEW] `app/public/ippostreak_banner.png`
