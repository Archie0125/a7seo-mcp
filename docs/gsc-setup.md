# 量測層設定：GSC ／ GA4 ／ Bing ／ Clarity

> 這份文件涵蓋四個平台。GSC 那節是第一版（phase 1）寫的，GA4 / Bing / Clarity /
> 四層週報是後來補的，往下捲。**GA4 與 GSC 用同一顆 service account**，只是要多
> 啟用兩個 API、多把它加進 GA4 的資源存取管理。

## 目錄

- [GSC](#gsc-量測層設定a7seo-gsc--portfolio_gsc)（下面就是）
- [GA4 — AI 搜尋 referral](#ga4-量測層設定a7seo-ga4--portfolio_ga4)
- [Bing Webmaster](#bing-量測層設定a7seo-bing--portfolio_bing)
- [Clarity 摩擦點](#clarity-摩擦點a7seo-clarity--按需不進週報)
- [四層匯流週報](#四層匯流週報a7seo-weekly)

---

# GSC 量測層設定（`a7seo gsc` / `portfolio_gsc`）

這一步做完，五站的搜尋表現就從「人開瀏覽器兩三週查一次、而且無法歸因到頁型」
變成「每週一自動一張表」。全部是 Google Cloud Console 上的點擊操作，約 15 分鐘，
只做一次。

> 這份文件的價值集中在**第 5 步**。前四步網路上到處都有，第 5 步是最常漏掉的
> 那一步：金鑰建好了、API 也開了，但 service account 沒被加進 GSC property，
> 於是 `sites.list` 回一個空陣列，而 Google 不會告訴你為什麼。

---

## 1. 建 GCP 專案

<https://console.cloud.google.com/projectcreate> → 名稱隨意（例 `a7-sites-gsc`）→ 建立。

已經有專案就沿用，不必開新的。

## 2. 啟用 Search Console API

專案內：**APIs & Services → Library** → 搜尋 **Google Search Console API** → **Enable**。

漏了這步的症狀：換 token 時回 `403 accessNotConfigured` 或 `invalid_scope`。
`a7seo gsc` 會把這種錯誤翻成中文指引，不會只丟一串 stack trace。

## 3. 建 service account

**APIs & Services → Credentials → Create credentials → Service account**

- 名稱：`a7-weekly-report`（隨意）
- 角色：**不用給**。GSC 的權限不看 GCP IAM 角色，看的是第 5 步在 GSC 那邊加的使用者。
- 建好後把它的 email 記下來，長這樣：
  `a7-weekly-report@<專案id>.iam.gserviceaccount.com`

## 4. 下載 JSON 金鑰

點進剛建好的 service account → **Keys → Add key → Create new key → JSON** → 下載。

存到一個**不會進版控**的地方，例如 `C:\Users\A7\.secrets\a7-gsc.json`。
這個檔等同密碼，外洩就是別人能讀你的 GSC 資料。

## 5. 把 service account 加進五個 GSC property ← 最常漏的一步

**每一站都要做一次**，五站少一站，那一站在週報上就是一行錯誤訊息。

到 <https://search.google.com/search-console> → 左上角切到該站 →
**設定 → 使用者與權限 → 新增使用者**：

- 電子郵件地址：第 3 步那個 `...iam.gserviceaccount.com`
- 權限：**受限**就夠（這層只讀不寫）。要用 `--inspect` 抽驗索引狀態的話也是**受限**即可。

五個 property（都是 domain property）：

| 站 | GSC property |
|---|---|
| 修車趣 | `sc-domain:car.codecity.com.tw` |
| 好社區 | `sc-domain:build.codecity.com.tw` |
| 美容美髮 | `sc-domain:beauty.codecity.com.tw` |
| 好食物 | `sc-domain:food.codecity.com.tw` |
| 找工廠 | `sc-domain:factory.codecity.com.tw` |

property 識別字串由 `registry/sites.json` 的 `domain` 自動推成 `sc-domain:<domain>`。
若哪一站改用 URL-prefix property，在該站的 `analytics` 加一行
`"gscProperty": "https://例.com/"` 覆蓋即可，程式不用改。

## 6. 設環境變數

**本機**（指向金鑰檔）：

```bash
export A7_GSC_CREDENTIALS="C:/Users/A7/.secrets/a7-gsc.json"
```

**CI**（GitHub secret 塞不了檔案，所以走整包 JSON）：
在 `a7-sites` repo → Settings → Secrets and variables → Actions → New repository secret

- Name：`A7_GSC_CREDENTIALS_JSON`
- Value：把金鑰檔**整個內容**貼上（含大括號）

貼的時候不用手動處理換行 —— private key 裡字面上的 `\n` 程式會自己還原。

## 7. 驗一下

```bash
a7seo gsc                                  # 五站，28 天
a7seo gsc --only xiuchequ                  # 只看 car
a7seo gsc --inspect 10                     # 每個頁型抽 10 個 URL 驗索引狀態
a7seo gsc --days 7 --lag 3                 # 換視窗
a7seo gsc --json                           # 原始 JSON
```

成功的樣子：報表開頭列出 `可見 property（5）：sc-domain:car... sc-domain:build...`。

---

## 這支指令產出什麼

**表一 五站總覽** —— 點擊／曝光／CTR／平均排序／sitemap 頁數。

**表二 頁型分群** —— 每個 URL pattern 一列，把「sitemap 有幾頁」與「拿到多少曝光」
對在同一列。這張才是重點：**下一輪決定砍哪些頁型的依據就是它**。
一個頁型如果頁數上千而曝光覆蓋率趨近 0，就是「印了幾千頁沒有人搜」的那種，
砍掉不會失去流量，只會把 crawl budget 拿回來。

頁型定義住在 `a7-sites/registry/sites.json` 的 `pageTypes`，不寫死在程式裡。
新增頁型的人要順手在那裡補一條；沒補的頁會落進報表自動補的「（未分類）」桶，
那一桶變大就是宣告過時的訊號。

---

## 沒有憑證會怎樣

**不會爆炸，也不會紅燈。** 報表照出，只是曝光那半邊全部印 `—`（刻意不印 0 ——
印 0 會讓「還沒問到」跟「問過了、真的沒人搜」長得一模一樣），並在最上面印出
缺什麼、去哪設。sitemap 那半張表（每個頁型有幾頁）純 HTTP、免憑證，一直都在。

---

## 常見錯誤對照

| 症狀 | 根因 | 怎麼修 |
|---|---|---|
| `可見 property：0 個` | service account 沒被加進任何 property | 回第 5 步，五站都要加 |
| 某一站報 `看不到 property「sc-domain:...」` | 只漏了那一站 | 那一站的 GSC → 使用者與權限 |
| `拿 access token 被拒 … invalid_scope` | 專案沒啟用 Search Console API | 回第 2 步 |
| `DECODER routines::unsupported` | private key 換行壞了 | 重貼一次 secret，別自己加跳脫 |
| `缺 client_email 或 private_key` | 下載到 OAuth client secret 而不是 service account 金鑰 | 回第 4 步 |
| 表一「已索引」全是 `—` | 沒加 `--inspect` | 見下方 |

## 為什麼「已索引」是抽樣而不是 GSC 那個數字

**Google 沒有開這個 API。** GSC UI 的「索引涵蓋範圍」總數（已索引／已檢索-未索引／
已找到-未爬）沒有任何 endpoint 吐得出來；API 只有 `urlInspection`，一次一個 URL，
配額每 property 每天 2,000 次。

所以 `--inspect N` 的做法是：**每個頁型**等距抽 N 個 URL 去問，得到「這個頁型的
索引率」。這比 UI 那個全站總數更有用 —— 全站「已索引 8,217」不會告訴你該砍誰，
「`/m` 車型頁抽 20 個有 1 個被索引」會。抽樣是等距的（不是取開頭），同一份 URL
清單每次抽到同一批，所以週與週之間可比。

報表不會把抽樣結果印成 UI 那個數字的樣子，會標明是抽樣。

---

# GA4 量測層設定（`a7seo ga4` / `portfolio_ga4`）

**這一層要回答的問題跟上面那層不同。** GSC 問「傳統 SERP 上有沒有人搜」，答案本輪
已經量出來了：五站 28 天 68,350 曝光、CTR 2.1%，car 平均排序 6.6 卻只有 1.5% CTR
——因為搜店名的人要的是那家店本身（Google 商家、地圖、電話），目錄站只能撿殘渣。

GA4 這層問的是：**同一批內容餵給 AI 搜尋時，價值結構是不是不一樣。** 五站的
robots.txt 早就對 OAI-SearchBot / PerplexityBot / Claude-SearchBot 開 Allow、
對純訓練 bot 擋掉，GA4 也裝了半年，但**從來沒有人看過那些資料**。

## 1. 沿用同一顆 service account

不用另外建。GSC 那節第 3 步建的那顆 service account 同時給 GA4 用，只是換 token
時要的 scope 不同（程式自己處理）。

## 2. 啟用兩個 API（GSC 那個不夠）

GCP Console → **APIs & Services → Library**，各按一次 Enable：

| API | 用來做什麼 | 漏掉的症狀 |
|---|---|---|
| **Google Analytics Data API** | 跑報表（來源、落點頁） | 換 token 回 `invalid_scope` |
| **Google Analytics Admin API** | 把 measurement id 對回 property id | 報表說「找不到 property id」 |

Admin API 只在 registry 沒寫 `ga4Property` 時才會用到（見第 4 步），但第一次一定要開。

## 3. 把 service account 加進五個 GA4 資源 ← 最常漏的一步

**每一站都要做一次。** GA4 → **管理（左下齒輪）→ 資源存取管理 → 右上角「+」→
新增使用者**：

- 電子郵件地址：`...iam.gserviceaccount.com`（GSC 那節第 3 步那個）
- 角色：**檢視者**（這層只讀）
- 取消勾選「通知新使用者」（service account 沒有信箱）

五站的 measurement id（registry `analytics.ga4`，用來認資源）：

| 站 | measurement id |
|---|---|
| 修車趣 | `G-HE4DDM8GQV` |
| 好社區 | `G-4YSJB2FNQ3` |
| 美容美髮 | `G-DYVED389RQ` |
| 好食物 | `G-Y2D0THJ71W` |
| 找工廠 | `G-G95PEEBVG1` |

## 4. 第一次跑完，把 property id 貼回 registry

GA4 Data API 只認**純數字的 property id**，而 registry 記的是網頁上貼的
`G-XXXX`，兩者沒有任何字面關係、也沒有直接查表的 endpoint。所以第一次跑會走
Admin API 逐個對照，並把結果印在報表開頭：

```
這次靠 Admin API 對照出來的 property id（貼回 registry 的 analytics.ga4Property
就不用每週再對照一次，每站省兩次 API）：
  G-HE4DDM8GQV → 123456789（修車趣）
```

把它貼進 `registry/sites.json` 該站的 `analytics`：

```json
"analytics": { "ga4": "G-HE4DDM8GQV", "ga4Property": "123456789", ... }
```

貼完之後 Admin API 就不會再被呼叫（也就不必一直開著）。

## 5. 驗一下

```bash
a7seo ga4                        # 五站，28 天
a7seo ga4 --only food            # 只看 food
a7seo ga4 --days 7               # 換視窗
a7seo ga4 --json                 # 原始 JSON
```

## 這支指令產出什麼

**表一** 五站 × 工作階段／使用者／**AI 佔比** —— 分母，看得到規模。
**表二** AI 來源 × 站 —— 哪個引擎在引用我們。
**表三 AI 落點頁型** ← **重點在這張。**

總量小的時候「ChatGPT 帶了 12 個 session」什麼都證明不了，但「那 12 個全部落在
`/cal` 與 `/additive`」會告訴我們 AI 要的是**結構化事實頁**，而不是我們印了幾萬頁
的店家目錄。那正是下一輪該押哪一邊的依據。

落點頁用的是跟 GSC 表二同一組 `pageTypes` pattern（住 `registry/sites.json`），
兩張表才對得起來。

## AI 來源清單

`chatgpt.com`（含 `chat.openai.com`）、`perplexity.ai`、`claude.ai`、
`copilot.microsoft.com`、`gemini.google.com`（含 `bard.google.com`）、`you.com`、
`phind.com`。這份清單住在程式裡（`traffic-source.ts`）不住 registry —— 它是
「AI 搜尋生態長什麼樣」的事實，五站共用，跟哪個站無關。

⚠️ `gemini.google.com` 必須排在「Google 自然搜尋」前面判定，否則會被當成 Google
organic 吃掉。有測試守著這條。

## GA4 已知地雷（程式已經擋掉，但你該知道為什麼）

| 症狀 | 根因 | 這裡怎麼處理 |
|---|---|---|
| 報表冒出 `package_card`、`127.0.0.1:8000` 這種「來源」 | GA4 的 `source`/`medium`/`campaign` 是**保留參數名**，自訂事件送同名參數會覆蓋 `sessionSource` | 形狀不像來源的值（含底線／含空白／內網位址／自我參照）被抓出來單獨列一張「可疑來源」表，不計入 AI |
| `Field conversions is not a valid metric` | GA4 沒有 `conversions` 這個 metric | `assertValidMetrics` 在送出前擋下並直接給正解 `keyEvents` |
| `Unknown field for Filter: fieldName` | 舊範例的 `dimensionFilter` 結構是錯的 | **刻意不用 dimensionFilter**，撈回來在本機切（這幾站的列數是幾十到幾百列，便宜太多，也少一整類「濾錯了但看起來很正常」的靜默失敗） |
| 落點頁那張表整個消失 | 維度名 GA4 改過一輪（`landingPage` ↔ `landingPagePlusQueryString`） | 先試現行名，被 400 就換另一個，並在報表標明實際用了哪個 |

## 沒有憑證會怎樣

跟 GSC 那層一樣：印指引、`exit 0`，不紅燈。但**沒有「免憑證也看得到的一半」**
——GSC 還有 sitemap 可以掃，AI referral 只存在於 GA4 裡。所以憑證沒設好時這一層
是**空白**，不是 0。報表會這樣寫，不會印一堆 0 讓人以為「量過了，AI 沒帶流量」。

---

# Bing 量測層設定（`a7seo bing` / `portfolio_bing`）

Bing 的 CTR 通常明顯高於 Google，因為 Copilot 的答案版位就長在那個 SERP 上。
五站在 Bing 都已驗證、sitemap 也都交了（registry `_bing_note` 記著 2026-07-18 的
實查），但那邊的數字一次都沒被看過。

## 1. 拿 API 金鑰

<https://www.bing.com/webmasters> → 右上角 **設定 → API 存取 → API 金鑰** →
產生。**一把金鑰涵蓋這個帳號底下所有網站**，不必一站一把。

## 2. 設環境變數

```bash
export A7_BING_API_KEY="<金鑰>"
```

CI：`a7-sites` repo → Settings → Secrets → `A7_BING_API_KEY`。

## 3. 網站識別字串

Bing 用 **URL** 不用 domain property，而且要跟驗證時填的那一串**一模一樣**
（尾斜線算數）。預設推 `<origin>/`；不對的話在該站的 `analytics` 加一行覆蓋：

```json
"analytics": { ..., "bingSiteUrl": "https://www.例.com/" }
```

送錯會回 400/404，報表的提示會直接把這句寫出來。

## 4. 驗一下

```bash
a7seo bing
a7seo bing --only xiuchequ
a7seo bing --json
```

## Bing 已知地雷（程式已經擋掉）

| 症狀 | 根因 | 這裡怎麼處理 |
|---|---|---|
| 資料整批「不在區間內」，報表安靜地變成 0 | Bing 回的日期是 `/Date(1779260400000-0700)/`，只抓 `\d+` 後緊接右括號的 regex 會整條失配 | `parseBingDate` 用 `/\/Date\((-?\d+)/`，位移不影響（前面的毫秒已經是 UTC epoch） |
| 頁面表整欄變成 `undefined` | `GetPageStats` 回來的列**仍然用 `Query` 當 key**（Page endpoint 沿用 Query 的列 schema） | `pageOf()` 兩個欄位都認，並把實際用到的欄位名寫進報表 —— 哪天 Microsoft 真的修好，我們會看到欄位名變了而不是資料變空 |
| 想拿「已索引頁數」 | **Bing 沒有這個 API**（跟 GSC 一樣的天花板） | 報表給的是 `GetCrawlStats` 的逐日 `CrawledPages` 合計，標明是**爬取量不是索引量**，不要拿去跟 GSC 的已索引數對帳 |
| 頁型／查詢那兩張表的區間看起來比點擊曝光寬 | `GetQueryStats` / `GetPageStats` 是 Bing 自己的統計視窗（約 6 個月累計），不吃日期參數 | 如實寫在報表的「註」裡，不假裝它被過濾過 |

---

# Clarity 摩擦點（`a7seo clarity`）—— 按需，不進週報

五站都裝了 Clarity（registry `analytics.clarity` 有各站 project id）。這層看的是
**人被帶進來之後卡在哪一頁**：dead click / rage click / quickback，依 `pageTypes`
分群。

## 為什麼刻意不進每週報表

配額是**每個 project 每天 10 次呼叫、單次最多 3 天**。五站 × 三個維度就 15 次，
已經超過單站上限；而且 3 天的視窗跟另外三層的 28 天對不起來。硬塞進週報只會每週
把配額燒光，還拿到一段無法跟其他層對照的資料。

## 設定

Clarity 後台 → **Settings → Data Export → Generate new API token**（token 綁
project，**一站一顆**）。

```bash
# 一次設五站
export A7_CLARITY_TOKENS='{"xiuchequ":"<t>","build":"<t>","beauty":"<t>","food":"<t>","factory":"<t>"}'
# 或單站
export A7_CLARITY_TOKEN_FOOD="<t>"
```

```bash
a7seo clarity --only food                 # 一次一站，省配額
a7seo clarity --dimensions URL,Source     # 最多 3 個維度
a7seo clarity --json                      # ← 第一次請用這個
```

⚠️ **這個模組還沒對線上 API 實跑過**（本機沒有任何一站的 token）。回應的欄位名在
文件與實務之間有出入，所以解析寫得寬容：維度值認一組已知欄名，數值依序找
`subTotal` → `totalSessionCount` → 第一個數字欄；認不出來時報表會標
「這些 metric 的數值欄認不出來」而**不是回 0**。第一次真的拿到 token 時，先跑
`--json` 看原始回應，再決定要不要把解析收緊。

---

# 四層匯流週報（`a7seo weekly`）

```bash
a7seo weekly                                        # 印到 stdout
a7seo weekly --d1 layer-d1.txt --out report.md      # 寫檔，stdout 只吐標題
a7seo weekly --skip bing,ga4                        # 只重跑某幾層
```

| 層 | 問的問題 | 抓得到哪一類故障 |
|---|---|---|
| D1（鮮度哨兵，住 a7-sites） | 資料還在進來嗎 | ETL 靜默失敗 |
| HTTP（portfolio） | 頁面活著、追蹤碼在嗎 | 部署／設定壞掉 |
| 搜尋 · Google（GSC） | 有人在搜嗎、搜哪個頁型 | 做了很多沒人要的東西 |
| 搜尋 · Bing | Google 以外還有沒有人搜 | 只看單一引擎的偏誤 |
| AI 搜尋（GA4 referral） | AI 在引用我們的哪一種頁 | 新的需求結構被忽略 |

**為什麼一定要合成一份**：2026-08 真的發生過「總表全綠、實際已掛五週」——
`portfolio` 說五站全綠的同時，food 的 `goods-weekly` 連掛 5 週、`/goods` 停更
35 天，因為那是 D1 層的事，而沒有人把兩層擺在一起看。分開跑就會重演同一個故障
模式，只是換一組層。

D1 那層留在 `a7-sites`（它要 wrangler 與 Cloudflare token），用 `--d1 <檔案>`
併進來。**合成器只有一個**，CI 與本機跑的是同一支 —— 兩份實作的下場就是報表在
CI 上長一個樣、在本機長另一個樣。

任何一層跑失敗會如實寫進報表（該節標題加 ✖），不是靜靜消失。憑證沒設好時標題印
`—` 而不是 `0`：印 0 會讓「還沒問到」跟「問過了、真的是 0」長得一模一樣，而標題
正是唯一會被掃過一眼的地方。
