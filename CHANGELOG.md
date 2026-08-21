# Changelog

All notable changes to a7seo-mcp.

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
