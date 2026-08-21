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
