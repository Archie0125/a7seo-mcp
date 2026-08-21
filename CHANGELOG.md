# Changelog

All notable changes to a7seo-mcp.

## [0.5.0] — 2026-08-21

### Added — 量測從「只有 GSC」擴充到「Google + Bing + AI 搜尋」，四層出在同一份週報

本輪 GSC 實測攤開了一件事：**這五個站在傳統 SERP 上的天花板很低。** 五站 28 天合計
68,350 曝光、1,408 點擊、CTR 2.1%；car 平均排序 6.6（很前面）卻只有 1.5% CTR ——
因為搜店名／公司名／建案名的人要的是**那個實體本身**（Google 商家、地圖、電話），
目錄站只能撿殘渣。但同一批內容對 **AI 搜尋**的價值結構完全不同：AI 回答需要引用
結構化的事實資料源，而這五站正好就是台灣政府開放資料的結構化呈現。

基礎建設早就鋪好了 —— 五站 robots.txt 全部 `Content-Signal: search=yes,
ai-input=yes, ai-train=no`，對 OAI-SearchBot / PerplexityBot / Claude-SearchBot 開
Allow、對純訓練 bot Disallow。**問題是鋪好了但沒有任何人在量它帶來多少流量。**

- **`a7seo ga4` + `portfolio_ga4`** — AI 搜尋 referral。三張表：五站 AI 佔比、
  AI 來源 × 站、**AI 落點頁型**。第三張才是會改變決策的那張：總量小的時候
  「ChatGPT 帶了 12 個 session」什麼都證明不了，但「那 12 個全部落在 `/cal` 與
  `/additive`」會告訴我們 AI 要的是結構化事實頁，而不是我們印了幾萬頁的店家目錄。
  落點頁用**跟 GSC 表二同一組** registry `pageTypes` 分群，兩張表才對得起來。
- **`a7seo bing` + `portfolio_bing`** — Bing Webmaster，同一組頁型 pattern。
  Bing 的 CTR 通常明顯高於 Google，因為 Copilot 的答案版位就長在那個 SERP 上。
- **`a7seo clarity`** — dead click / rage click 依頁型分群。**刻意不進週報**：
  配額是每站每天 10 次呼叫、單次最多 3 天，視窗跟另外三層的 28 天對不起來，
  硬塞只會每週把配額燒光還拿到無法對照的資料。
- **`a7seo weekly` + `portfolio_weekly`** — 四層匯流成一份 markdown。存在的理由是
  2026-08 真的發生過「總表全綠、實際已掛五週」（portfolio 說五站全綠的同時 food 的
  `goods-weekly` 連掛 5 週）。D1 那層留在 a7-sites，用 `--d1 <檔案>` 併進來。
  **合成器只有一個**，CI 與本機跑同一支 —— 兩份實作的下場是報表在兩邊長得不一樣。

### Changed

- `google-auth.ts`：service account 的讀檔與 JWT 簽章從 `gsc.ts` 抽出來共用
  （GSC 與 GA4 是同一顆金鑰、不同 scope）。`gsc.ts` 原樣再匯出 `Gsc*` 那組名字，
  docs / 測試 / 呼叫端零改動。新增 `A7_GOOGLE_CREDENTIALS(_JSON)` 作為別名，
  `A7_GSC_CREDENTIALS(_JSON)` 繼續有效（已經寫進 docs 與 GitHub secret，改名換不到好處）。
- `report-format.ts`：表格排版抽出來。四層要出在同一份報表裡，各抄一份 `padRight`
  的下場是欄寬規則慢慢漂、同一份報表裡的表格對不齊。

### Fixed — `bing-wmt.ts` 兩個「不會報錯、只會空掉」的 bug

- **日期 regex**：Bing 回的是 `/Date(1779260400000-0700)/`，舊 regex 要求毫秒後
  緊接右括號，帶時區位移的列**全部失配** → 每一列都「不在區間內」→ 統計靜靜地變成 0。
- **`GetPageStats` 的列仍然用 `Query` 當 key**（Page endpoint 沿用 Query 的列
  schema）。照文件寫 `row.Page` 拿到 `undefined`，頁面表整欄變成 `undefined`
  而不會拋任何錯。現在兩個欄位都認，並把**實際用到的欄位名**寫進報表 —— 哪天
  Microsoft 真的修好 schema，我們會看到欄位名變了，而不是某天資料靜靜地全空。

### 已知地雷（實戰紀錄，程式已擋，測試守著）

- GA4 的 `source`/`medium`/`campaign` 是**保留參數名**：自訂事件送同名參數會覆蓋
  `sessionSource`，於是報表冒出 `package_card`、`127.0.0.1:8000` 這種假來源。
  形狀不像來源的值被抓出來單獨列表、不計入 AI。
- GA4 沒有 `conversions` 這個 metric（要用 `keyEvents`）；`assertValidMetrics`
  擋在送出前並直接給正解。
- GA4 `dimensionFilter` 舊範例結構會回 `Unknown field for Filter: fieldName` ——
  **刻意不用**，撈回來在本機切。
- GA4 落點頁維度改過名（`landingPage` ↔ `landingPagePlusQueryString`），猜錯的代價
  是整張落點表消失 → 先試現行名、被 400 就換，並在報表標明用了哪個。
- Bing **沒有**索引數 API（跟 GSC 一樣的天花板）；報表給的是爬取量並標明。

### 誠實記著的限制

- **本機沒有任何一組憑證**（GCP service account 是用戶待辦、Bing 金鑰未產、Clarity
  token 未產），所以 GA4 / Bing / Clarity 三層**沒有對線上 API 實跑過**。可驗的都驗了：
  型別、135 條測試（新增 43 條，含 mock 掉網路的完整路徑）、無憑證時的指引輸出、
  以及 `a7seo weekly` 對五站真實 sitemap 實跑（209,056 URL）。
- Clarity 的回應欄位名在文件與實務之間有出入，解析刻意寬容且會標「認不出來」而不是
  回 0。第一次拿到 token 請先跑 `--json` 看原始回應。

### Docs

- `docs/gsc-setup.md` 擴成四平台：GA4（要多開 Data API + Admin API、要加進「資源存取
  管理」、measurement id → property id 怎麼對照與怎麼貼回 registry）、Bing（金鑰哪裡拿、
  siteUrl 尾斜線算數）、Clarity（配額策略）、四層週報。

## [0.4.0] — 2026-08-21

### Added — GSC 量測層（第三層，把「哪個頁型值得留」變成可回答的問題）

- **`a7seo gsc [registryPath]` CLI** + **`portfolio_gsc` MCP tool**：讀同一份
  `a7-sites/registry/sites.json`，產兩張表 ——
  **表一** 五站點擊／曝光／CTR／平均排序／sitemap 頁數；
  **表二 頁型分群**，每個 URL pattern 一列，把「sitemap 有幾頁」與「拿到多少曝光」
  對在同一列。**表二是重點**：GSC 的 searchAnalytics 只回*有曝光的頁*，零曝光的頁
  根本不出現在回應裡，所以單看 GSC 永遠看不到「這個頁型有 1,764 頁、其中 0 頁
  拿過曝光」——而那正是該砍的訊號。
- **頁型 pattern 住 registry（`pageTypes`）不寫死在程式**，理由與 `sitemap.minShards`
  相同：那是「這個站長什麼樣子」的事實，改站型的人才知道要改它。比對規則是
  **分段前綴**而非 `startsWith` —— 這幾站的路徑會互相吃掉（food 的 `/c` 會把
  `/cal`、`/class`、`/contaminant` 全吸走；factory 的 `/s` 會吃掉 `/sup`）。
- `src/modules/platforms/gsc.ts`：service account JWT bearer flow（`node:crypto`
  簽 RS256）、`searchAnalytics.query`（page 維度自動翻頁）、`urlInspection`。
  **零新依賴** —— 只用到三個 endpoint，不值得為此拉進整個 `googleapis`。
- `src/modules/platforms/gsc-report.ts`：registry 驅動的組裝與輸出，含免憑證的
  sitemap 掃描（每個頁型幾頁）與等距抽樣。

### 誠實記著的兩個限制

- **GSC API 吐不出 UI 那個索引涵蓋總數**（已索引／已檢索-未索引／已找到-未爬）。
  Google 只開了 `urlInspection`，一次一個 URL、每站每天 2,000 次。所以
  `--inspect N` 是**每個頁型**等距抽 N 個去問，得到「該頁型的索引率」——報表會
  標明是抽樣，不會偽裝成 UI 的數字。（而且逐頁型的索引率比全站總數更能決定砍誰。）
- **沒有憑證不算失敗**：報表照出，曝光那半邊全印 `—`（刻意不印 0 —— 印 0 會讓
  「還沒問到」跟「問過了、真的沒人搜」長得一模一樣），並印出缺什麼、去哪設，
  exit 0。排程哨兵不該因為金鑰沒設好就每週紅一次。

### Docs

- `docs/gsc-setup.md`：GCP 專案 → 啟用 API → service account → JSON 金鑰 →
  **把 service account email 加進五個 GSC property 的使用者**（最常漏的一步）→ 設 env，
  含常見錯誤對照表。

## [0.3.0] — 2026-07-12

### Added — Portfolio 跨站監控（"一次看所有網址"）

- **`portfolio_health` MCP tool** + **`a7seo portfolio [registryPath] [--all]` CLI**：
  讀 a7-sites 的 `registry/sites.json`，對每個 **live** 站一次跑 `seo_health_check`
  （純 HTTP、免憑證），彙整成跨站健康總表（每站 green/yellow/red + 合計）。
  registry 路徑解析：arg > `A7_REGISTRY_PATH` 環境變數 > 已知 a7-sites 預設。
- `src/modules/platforms/portfolio.ts`：`runPortfolioHealth()` /
  `formatPortfolioTable()` / `loadRegistry()`。這是 a7seo-mcp 從 per-project
  擴到 portfolio-wide 的第一步（免憑證層）；四平台流量指標
  （GA4/GSC/Clarity/Bing）roll-up 為後續層。
- **只監控 live 站**：registry `status !== 'live'` 的站（網域還沒指過來）標成
  `skipped` 而不是檢測失敗——未上線的站每次必然紅，那是常態雜訊不是發現問題。
  `--all` / `includeNonLive: true` 可強制全檢。報表帶 `checked` / `skipped` 計數，
  跳過的事實留在檯面上，不會被靜靜吃掉。

### Fixed

- `health-check.ts` 的 `checkSitemap` 現在正確辨識 **sitemap index**
  （`<sitemapindex>`/`<sitemap>`），不再對只含子 sitemap、無 `<url>` 的
  索引檔誤判為「Only 0 URLs」。
- **`checkSitemap` 真的驗子 sitemap**：辨識出 index 後不再直接回綠 return
  （那是假陽性——五站全是 index 架構，任何分片 500／空掉，報表照樣全綠，
  而分片正是最容易壞的地方：D1 查詢逾時、shard 數量算錯）。現在逐片驗
  HTTP 200 + `<url>` 數 > 0，回報總 URL 數與壞掉的分片。
  分片數上限 50（factory 現為 47 = 全驗）；超過改抽樣並標 `partialCoverage`，
  抽樣時回黃不回綠——沒驗過的分片不會被當成健康的。
- **`checkRobotsTxt` 分清 allow 與 block**：舊版只看 `user-agent: X` 字串在不在，
  於是 `User-agent: GPTBot` + `Disallow: /`（明確封鎖）也被算成
  「All major AI crawler user agents explicitly listed」回綠。現在解析 group 規則，
  照實回報 Allowed / Blocked / 未列出。封鎖多為刻意政策（本站群 robots 標
  `ai-train=no`），故不報紅，只是照實描述。

## [0.2.0] — 2026-05-23

### Added — Platform analytics layer

- **`bing_wmt_fetch` MCP tool**: query Bing Webmaster Tools for pages crawled,
  crawl errors, impressions, clicks, average position, top queries, and top
  pages over a custom date range. Fills the gap left by Bing having no
  first-party MCP server (vs GA4 / GSC / Clarity which all do).
- **`seo_health_check` MCP tool**: cross-stack SEO + GEO health check
  adapted from NewDawnHealth's Laravel `SeoHealthCheck.php`. Runs over
  plain HTTP — probes sitemap.xml, robots.txt (AI crawler allow rules),
  llms.txt, tracking pixels (GA4 / Clarity / Meta / Google Ads),
  `<link rel="canonical">`, og:image, and `<html lang>`. Outputs
  green/yellow/red findings. No platform credentials required.
- **`a7seo init` now scaffolds 4-platform MCP config**: in addition to
  `seo-engine.config.json`, the command now emits `.mcp.json` (with GSC +
  GA4 + Clarity MCP server entries using `${VAR}` env interpolation) and
  `.env.platforms.example` covering the 6 required values
  (`GOOGLE_SERVICE_ACCOUNT_PATH`, `GA4_PROPERTY_ID`, `CLARITY_API_TOKEN`,
  `BING_WMT_API_KEY`, etc.).

### Added — Config schema

- `platforms.bingWmt` block in `seo-engine.config.json` (siteUrl + apiKey).
- Env override: `BING_WMT_API_KEY` and `BING_WMT_SITE_URL` (siteUrl
  defaults to `https://<config.domain>/` if not set).
- `detectProviders()` now reports `bing-wmt` when configured.

### Modules

- `src/modules/platforms/types.ts`: shared `PlatformProvider`,
  `PlatformReport`, `PlatformConfigError`.
- `src/modules/platforms/bing-wmt.ts`: Bing Webmaster JSON API wrapper.
- `src/modules/platforms/health-check.ts`: cross-stack HTTP health checks.

### Documentation

- Updated `seo-engine.config.example.json` with `platforms.bingWmt` example.

## [0.1.0] — Earlier

Initial release: keyword research (Google Trends / Keyword Planner /
DataForSEO fallback), content generation (Anthropic-powered semantic HTML),
publishing (markdown-files / blogposts-ts / wordpress adapters), SQLite
storage, MCP server transport, basic `a7seo` CLI.
