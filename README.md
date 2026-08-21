# A7SEO MCP

Automated SEO traffic engine as an MCP server for Claude Code.

Discover keywords, generate SEO-optimized articles, and publish to any CMS — all from your Claude Code session.

## Features

- **Keyword Intelligence** — Google Trends (free) → Keyword Planner (free) → DataForSEO (paid, optional)
- **AI Content Engine** — Claude-powered semantic HTML article generation (coming in v0.2)
- **Auto Publisher** — Publish to WordPress, static sites, or custom adapters (coming in v0.2)
- **SQLite Storage** — Local, portable, per-project database
- **Provider Abstraction** — Swap free/paid providers via config, no code changes

## Quick Start

### 1. Install

```bash
npm install -g a7seo-mcp
# or use directly with npx
```

### 2. Configure

```bash
# Copy the example config
cp seo-engine.config.example.json seo-engine.config.json
# Edit with your project details
```

Or use environment variables (recommended for secrets):
```bash
export SEO_PROJECT_ID=my-site
export SEO_DOMAIN=example.com
export ANTHROPIC_API_KEY=sk-...
```

### 3. Add to Claude Code

Add to your project's `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "a7seo": {
      "command": "npx",
      "args": ["-y", "a7seo-mcp"],
      "env": {
        "SEO_ENGINE_CONFIG": "./seo-engine.config.json"
      }
    }
  }
}
```

### 4. Use

In Claude Code, call any `seo_*` tool:

```
seo_keywords_discover("SEO優化,關鍵字研究")
seo_keywords_trends("醫美 台北")
seo_keywords_cluster("SEO優化,SEO工具,SEO教學,關鍵字研究,關鍵字工具")
seo_keywords_gaps()
```

## CLI Usage

```bash
a7seo doctor                          # Check all dependencies
a7seo discover "SEO優化,AI搜尋"       # Discover keywords
a7seo portfolio                       # Cross-site health (HTTP layer, no credentials)
a7seo gsc                             # Cross-site GSC weekly report (see below)
a7seo ga4                             # AI-search referrals + which page types they land on
a7seo bing                            # Bing Webmaster, same page-type breakdown as gsc
a7seo weekly                          # All four layers in ONE report
a7seo clarity --only food             # On-demand friction (quota: 10 calls/day per site)
a7seo --help                          # Show all commands
```

## Portfolio measurement (a7-sites registry)

Two commands read the same single source of truth — `a7-sites/registry/sites.json` —
and answer different questions:

| Command | Layer | Question | Credentials |
|---|---|---|---|
| `a7seo portfolio` | HTTP | Are the pages alive, tracked, and is any sitemap shard missing? | none |
| `a7seo gsc` | Search · Google | Is anyone searching, and **which page types** get the impressions? | Google service account |
| `a7seo bing` | Search · Bing | Does anyone search outside Google — same page types? | Bing WMT API key |
| `a7seo ga4` | AI search | Which page types is **AI** citing us for? | same Google service account |
| `a7seo weekly` | all of the above | The weekly read-out, in one document | whatever is configured |

`a7seo weekly` is the one to run. The layers exist because each hides a class of
failure the others cannot see: in 2026-08 `portfolio` reported five green sites while
food's `goods-weekly` had been broken for five weeks — that was a D1-layer fact, and
nobody had the two layers side by side. The D1 layer itself lives in `a7-sites`
(it needs wrangler + a Cloudflare token); pass its output with `--d1 <file>`.
There is exactly one composer, used by both CI and local runs.

Clarity is deliberately **not** in the weekly report: its quota is 10 calls/day per
site with a 3-day maximum window, which does not line up with the 28-day one.

`a7seo gsc` prints two tables: a five-site overview, and a **page-type breakdown**
that pairs each URL pattern's sitemap page count with its impressions — so a page
type with thousands of pages and near-zero impression coverage becomes visible.
Patterns are declared per site in the registry (`pageTypes`), never hardcoded.

Without credentials it still prints the sitemap half of that table plus setup
guidance, and exits 0 — it never fails a scheduled run just because a key is missing.

Setup (about 15 minutes, once): **[docs/gsc-setup.md](docs/gsc-setup.md)**.
The step people miss is adding the service account email as a user on every GSC
property; that doc calls it out.

```bash
a7seo gsc                          # five sites, last 28 days
a7seo gsc --only xiuchequ          # one site
a7seo gsc --inspect 10             # also sample index status, 10 URLs per page type
a7seo gsc --json                   # raw JSON

a7seo ga4                          # AI-search referrals per site / engine / page type
a7seo bing                         # Bing clicks, impressions, CTR + page types
a7seo weekly --d1 layer-d1.txt --out report.md   # one document, stdout is just the title
a7seo weekly --skip bing,ga4       # re-run only some layers
```

### AI search, in one paragraph

Every one of the five sites already serves `Content-Signal: search=yes, ai-input=yes,
ai-train=no` and allows OAI-SearchBot / PerplexityBot / Claude-SearchBot while
blocking training-only crawlers. That groundwork was laid months ago and **nobody
had ever measured what it returns.** `a7seo ga4` groups `chatgpt.com`,
`perplexity.ai`, `claude.ai`, `copilot.microsoft.com`, `gemini.google.com`,
`you.com` and `phind.com` into their own bucket (GA4's default channel grouping
buries them all in "Referral") and — the part that changes decisions — breaks their
landing pages down by the same registry `pageTypes` used by `a7seo gsc`. Twelve
sessions from ChatGPT prove nothing; twelve sessions that all land on `/cal` and
`/additive` tell you AI wants structured fact pages, not the shop directory.

Sources whose *shape* is not a real traffic source (GA4 reserved-param leakage such
as `package_card`, localhost, self-referral) are listed separately and excluded from
the AI numbers instead of quietly becoming a channel.

## Available Tools (v0.1)

| Tool | Description |
|------|-------------|
| `seo_keywords_discover` | Find keywords with volume, trends, competition |
| `seo_keywords_trends` | Google Trends data for specific keywords |
| `seo_keywords_cluster` | Group keywords by topic and search intent |
| `seo_keywords_gaps` | Find keywords without published articles |

## Provider Tiers

| Provider | Tier | Data | Setup |
|----------|------|------|-------|
| Google Trends | Free | Relative interest (0-100), trends, related queries | Python + `pip install pytrends` |
| Google Keyword Planner | Free | Search volume ranges, competition, CPC | Google Ads account + API credentials |
| DataForSEO | Paid | Exact volumes, difficulty scores, SERP data | API credentials ($0.001/query) |

The system auto-detects available providers. No provider = no crash. Each additional provider enriches the data.

## Requirements

- Node.js >= 18
- Python 3 + pytrends (optional, for Google Trends)

## Configuration

All secrets can be set via environment variables (recommended) or `seo-engine.config.json`:

| Env Variable | Description |
|-------------|-------------|
| `SEO_ENGINE_CONFIG` | Path to config file |
| `SEO_PROJECT_ID` | Project identifier |
| `SEO_DOMAIN` | Your website domain |
| `ANTHROPIC_API_KEY` | For content generation |
| `GOOGLE_ADS_CLIENT_ID` | Google Keyword Planner |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Keyword Planner |
| `DATAFORSEO_LOGIN` | DataForSEO credentials |
| `DATAFORSEO_PASSWORD` | DataForSEO credentials |

## License

MIT

---

# A7SEO MCP（繁體中文）

自動化 SEO 流量引擎，以 MCP Server 形式運行於 Claude Code。

從關鍵字研究到文章生成、發布，全部在 Claude Code 對話中完成。

## 功能

- **關鍵字情報** — Google Trends（免費）→ Keyword Planner（免費）→ DataForSEO（付費，選用）
- **AI 內容引擎** — Claude 驅動的 semantic HTML 文章生成（v0.2）
- **自動發布** — 支援 WordPress、靜態網站或自訂 adapter（v0.2）
- **SQLite 儲存** — 本地、可攜、每專案獨立資料庫
- **Provider 抽象層** — 透過設定切換免費/付費，無需改程式碼

## 快速開始

```bash
# 1. 安裝
npm install -g a7seo-mcp

# 2. 設定
cp seo-engine.config.example.json seo-engine.config.json

# 3. 加到 Claude Code（.claude/mcp.json）
# 4. 在 Claude Code 中呼叫 seo_keywords_discover
```

詳細設定請參考上方英文文件。
