# Changelog

All notable changes to a7seo-mcp.

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
