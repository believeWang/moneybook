# 記帳 PWA

個人記帳工具：iPhone 快速記帳、Google Sheet 對帳。

- 線上網址：https://believewang.github.io/moneybook/
- token 不進版控：`test.sh` 已 gitignore；前端 token 首次開啟時輸入、存 localStorage

## 架構

```
PWA (GitHub Pages，加入 iPhone 主畫面)          ← 本 repo 根目錄
├─ 記帳頁：分類九宮格 → 自動帶預設帳戶 → 金額/標籤 → 送出
└─ 統計頁：依月份/分類/標籤彙總，Chart.js 畫圖（Step 4）
        │ fetch (JSON + token)
        ▼
Google Apps Script (web app)                    ← gas/Code.gs
├─ doPost：寫入一筆記錄
└─ doGet ：action=config 設定（預設）
           action=records&from=&to= 交易明細
           action=balances 各帳戶餘額
        │
        ▼
Google Sheet「記帳」
├─ 記錄：所有交易（支出/收入/轉帳共用一張表）
├─ 設定：帳戶(A:C)、分類與預設帳戶(E:H)、常用標籤(J)
└─ 舊資料：AndroMoney 匯出，切換日匯入「記錄」後退役
```

```
index.html / style.css / app.js   PWA 前端（無 build step，純靜態）
manifest.json / icons/            加入主畫面用
gas/Code.gs                       GAS 後端（token 為佔位字串，真值只在 Apps Script）
test.sh                           後端驗證腳本（含真 token，已 gitignore）
```

## 「記錄」分頁格式（11 欄）

| 日期 | 類型 | 分類 | 子分類 | 金額 | 幣別 | 付款帳戶 | 收款帳戶 | 標籤 | 備註 | 記錄時間 |
|------|------|------|--------|------|------|----------|----------|------|------|----------|

- 類型：支出（填付款帳戶）/ 收入（填收款帳戶）/ 轉帳（兩個都填）
- 標籤：逗號分隔，放跨分類的維度（如「沖繩2026」），不要複製分類
- 語意與 AndroMoney 匯出格式相容，舊資料可無痛匯入

## Step 2：部署 GAS 後端

1. 開試算表 → 擴充功能 → Apps Script，貼上 `gas/Code.gs` 全部內容
2. 改第一行 `TOKEN` 為一長串隨機字串（`openssl rand -hex 24`）
3. 函式下拉選 `initSheets` → 執行（跳授權照走：進階 → 仍要前往）
   - 跑完會建立「記錄」「設定」分頁
   - 到「設定」分頁 E:H 區，把「預設帳戶」欄填上對應（點類別自動選帳戶的來源）
4. 部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」、存取權「任何人」→ 複製 `/exec` URL
5. 把 URL 填進 `app.js` 的 `API_URL` 和 `test.sh`，跑 `./test.sh` 驗證

注意：GAS code 改動後要「部署 → 管理部署作業 → 編輯 → 新版本」才會生效，直接存檔不會。

## Step 3：啟用 GitHub Pages + iPhone 安裝

1. GitHub repo → Settings → Pages → Source「Deploy from a branch」→ Branch `main` / `/ (root)` → Save
2. 等 1-2 分鐘，開 https://believewang.github.io/moneybook/ 確認能載入
3. iPhone Safari 開同一網址 → 分享 → 加入主畫面
4. 首次開啟會要求輸入 token（跟 GAS 的 `TOKEN` 同一個值），只存在該裝置 localStorage
5. 設定頁（右上 ⚙︎）可重設 token 或重新載入設定（改了 Sheet「設定」分頁後按這個）

## Roadmap

- [x] Step 1：建 Sheet、定 schema
- [x] Step 2：GAS doPost/doGet + token 驗證，部署 web app（2026-07-05 測通）
- [x] Step 3：PWA 記帳頁 — 分類九宮格、預設帳戶、標籤快選、支出/收入/轉帳
- [x] Step 3.5：AndroMoney 風格改版 — 計算機鍵盤（支援 + − × ÷）、明細頁（按日翻頁+當日小計）、帳戶頁（總資產/負債/結餘）
- [x] Step 4：統計頁 — 月切換、分類圓環圖（純 CSS conic-gradient）、分類排行（點擊展開子分類）、標籤篩選；另加 dark mode（跟隨系統）、分類/帳戶 emoji、記住上次分類+帳戶組合、預設落在明細頁
- [x] Step 4.5：明細點擊可編輯/複製/刪除（以「記錄時間」為唯一鍵，後端加 update/delete action）、日期點一下回今天、每類型記住上次選擇（選了就存）、records/balances 快取進 localStorage（各頁加 ↻ 手動更新）、loading spinner、子分類 emoji
- [ ] Step 5：切換日 — AndroMoney 匯出最新 CSV → importOldData() 匯入「記錄」

## 技術備忘

- GAS web app 存取權必須「任何人」，安全靠 request 內的 token 驗證
- 前端 fetch 不設 Content-Type（預設 text/plain）以避開 CORS preflight（GAS 無法自訂 response header）
- curl 要加 `-L`（GAS 會 302 redirect 到 googleusercontent）
- 設定（帳戶/分類/預設帳戶/標籤）會 cache 在 localStorage，開 app 秒載入、背景更新
- 明細/統計/帳戶資料也 cache 在 localStorage：只有新增/編輯/刪除會自動失效，直接改 Sheet 後要按頁面上的 ↻ 才會重抓
- 編輯/刪除用「記錄時間」欄當唯一鍵——手動在 Sheet 加資料時，記錄時間留空的列無法從 app 編輯
