import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ProjectConfig } from './config.js';
import { discoverKeywords, getKeywordTrends } from './modules/keywords/discovery.js';
import { clusterKeywords } from './modules/keywords/clustering.js';
import { generateBrief, generateArticle, optimizeContent } from './modules/content/generator.js';
import { createMarkdownAdapter } from './modules/publisher/adapters/markdown-files.js';
import { createBlogPostsTsAdapter } from './modules/publisher/adapters/blogposts-ts.js';
import { ok, fail } from './modules/keywords/providers/base.js';
import { createBingWmtProvider } from './modules/platforms/bing-wmt.js';
import { runSeoHealthCheck } from './modules/platforms/health-check.js';
import { runPortfolioHealth, lookupMinShards } from './modules/platforms/portfolio.js';
import { runGscReport } from './modules/platforms/gsc-report.js';
import { runGa4WeeklyReport } from './modules/platforms/ga4-report.js';
import { runBingReport } from './modules/platforms/bing-report.js';
import { runWeeklyReport } from './modules/platforms/weekly.js';

export function registerAllTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  registerKeywordTools(server, config, db);
  registerContentTools(server, config, db);
  registerPublisherTools(server, config, db);
  registerPlatformTools(server, config);
}

function registerPlatformTools(server: McpServer, config: ProjectConfig): void {
  // Bing Webmaster Tools — no first-party MCP server exists, so a7seo-mcp
  // ships one. GA4/GSC/Clarity continue to be served by their dedicated
  // MCP packages registered in the consuming project's .mcp.json.
  // Cross-stack SEO + GEO health check — no platform credentials required.
  // Runs entirely over plain HTTP against the configured site URL.
  server.tool(
    'seo_health_check',
    'Cross-stack SEO + GEO health check for the current project. Probes sitemap.xml, robots.txt (AI crawler allow rules), llms.txt presence, tracking pixel render (GA4/Clarity/Meta), canonical link, og:image, and <html lang> attribute. Returns green/yellow/red findings. No platform credentials required — works against any site URL. If the target site is in the a7-sites registry, its sitemap.minShards is used as a baseline so a vanished shard (silent de-indexing) is caught.',
    {
      siteUrl: z
        .string()
        .optional()
        .describe('Site URL to probe. Defaults to https://<config.domain>/ if omitted.'),
      registryPath: z
        .string()
        .optional()
        .describe('Path to a7-sites registry/sites.json, used to look up this site\'s sitemap.minShards baseline. Defaults to A7_REGISTRY_PATH env or the known a7-sites path. Ignored if the site is not in the registry.'),
    },
    async ({ siteUrl, registryPath }) => {
      const target =
        siteUrl ||
        (config.domain
          ? `https://${config.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`
          : '');
      if (!target) {
        const res = fail(
          'NO_SITE_URL',
          'No siteUrl provided and config.domain is empty',
          'Pass siteUrl explicitly, or set domain in seo-engine.config.json'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
      try {
        // 從 registry 接分片下限——portfolio 早就這樣餵了，單站路徑之前漏接。
        // best-effort：不在 registry 或讀不到就是 undefined，健檢照跑（少分片下限那項）。
        const expectedMinShards = lookupMinShards(target, registryPath);
        const report = await runSeoHealthCheck(target, { expectedMinShards });
        const res = ok(report);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'HEALTH_CHECK_FAILED',
          (err as Error).message,
          'Verify the site URL is reachable from this machine and returns 2xx.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'bing_wmt_fetch',
    'Fetch Bing Webmaster Tools metrics (pages crawled, crawl errors, impressions, clicks, avg position, top queries, top pages) for the current project. Requires platforms.bingWmt.apiKey and platforms.bingWmt.siteUrl in seo-engine.config.json or BING_WMT_API_KEY + BING_WMT_SITE_URL env vars.',
    {
      dateFrom: z
        .string()
        .describe('Start date (ISO YYYY-MM-DD). Bing keeps ~6 months of history.'),
      dateTo: z.string().describe('End date (ISO YYYY-MM-DD), inclusive.'),
    },
    async ({ dateFrom, dateTo }) => {
      if (!config.platforms?.bingWmt) {
        const res = fail(
          'BING_WMT_NOT_CONFIGURED',
          'Bing Webmaster Tools credentials missing',
          'Set platforms.bingWmt.apiKey + platforms.bingWmt.siteUrl in seo-engine.config.json, or env BING_WMT_API_KEY + BING_WMT_SITE_URL. Generate the API key at https://www.bing.com/webmasters → Settings → API access.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
      try {
        const provider = createBingWmtProvider(config.platforms.bingWmt);
        const report = await provider.fetch({ startDate: dateFrom, endDate: dateTo });
        const res = ok(report);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'BING_WMT_FETCH_FAILED',
          (err as Error).message,
          'Verify the apikey is valid and the siteUrl exactly matches the verified property URL in Bing Webmaster Tools (trailing slash matters).'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  // Portfolio-wide SEO/GEO health — reads the a7-sites registry (sites.json)
  // and runs seo_health_check across EVERY site at once. "一次看所有網址".
  server.tool(
    'portfolio_health',
    'Run the cross-stack SEO+GEO health check across ALL live sites in the a7-sites registry (registry/sites.json) at once and return a combined report. No credentials required — pure HTTP. Use this to see every site\'s health in one call. Sites with status !== "live" are reported as skipped (not errors) unless includeNonLive is set. Registry path resolves from the registryPath arg, else A7_REGISTRY_PATH env, else the default a7-sites path.',
    {
      registryPath: z
        .string()
        .optional()
        .describe('Path to a7-sites registry/sites.json. Defaults to A7_REGISTRY_PATH env or the known a7-sites path.'),
      includeNonLive: z
        .boolean()
        .optional()
        .describe('Also check sites whose registry status is not "live" (e.g. still building, domain not pointed yet). Default false — these are skipped to avoid constant noise.'),
    },
    async ({ registryPath, includeNonLive }) => {
      try {
        const report = await runPortfolioHealth(registryPath, { includeNonLive });
        const res = ok(report);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'PORTFOLIO_HEALTH_FAILED',
          (err as Error).message,
          'Verify registry/sites.json exists and is valid JSON. Pass registryPath or set A7_REGISTRY_PATH.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  // GSC 量測層。與 portfolio_health 讀同一份 registry，但問的是不同的層：
  // portfolio 檢 HTTP（頁面活著嗎），這支檢搜尋表現（有人搜嗎、哪個頁型有人搜）。
  server.tool(
    'portfolio_gsc',
    'Google Search Console weekly report across every live site in the a7-sites registry: per-site clicks/impressions/CTR/position, plus a PAGE-TYPE breakdown that pairs each URL pattern\'s sitemap page count with its impressions — the table that shows which page types have many pages but zero demand. Page-type patterns are declared in the registry (pageTypes), not hardcoded. Needs a Google service account (A7_GSC_CREDENTIALS / A7_GSC_CREDENTIALS_JSON) added as a user on each GSC property; without credentials it still returns the sitemap half of the breakdown plus setup guidance instead of failing. Note: the GSC API cannot return the UI\'s index-coverage totals — set inspectPerType to sample per-page-type index status via urlInspection instead.',
    {
      registryPath: z
        .string()
        .optional()
        .describe('Path to a7-sites registry/sites.json. Defaults to A7_REGISTRY_PATH env or the known a7-sites path.'),
      days: z.number().optional().describe('Window length in days. Default 28.'),
      lagDays: z
        .number()
        .optional()
        .describe('How many days back the window ends, to stay inside GSC final (non-fresh) data. Default 3.'),
      withSitemap: z
        .boolean()
        .optional()
        .describe('Crawl each site\'s sitemap to get per-page-type page counts. Default true — without it the "many pages, zero impressions" signal is unavailable.'),
      inspectPerType: z
        .number()
        .optional()
        .describe('Sample N URLs per page type through urlInspection for index status. Default 0 (off). Quota is 2,000/day per property.'),
      onlySites: z
        .array(z.string())
        .optional()
        .describe('Limit to these registry site ids (e.g. ["xiuchequ"]).'),
    },
    async ({ registryPath, days, lagDays, withSitemap, inspectPerType, onlySites }) => {
      try {
        const report = await runGscReport(registryPath, {
          days,
          lagDays,
          withSitemap,
          inspectPerType,
          onlySites,
        });
        const res = ok(report);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'PORTFOLIO_GSC_FAILED',
          (err as Error).message,
          'Missing credentials is NOT an error here — it comes back inside the report. This code means the registry itself could not be read. Verify registry/sites.json exists and is valid JSON.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  // AI 搜尋量測層。GSC 那層問「傳統 SERP 上有沒有人搜」，這層問「AI 在引用我們的
  // 哪一種頁」—— 五站的 robots.txt 早就對 AI 搜尋 bot 開 Allow，但從來沒人量過。
  server.tool(
    'portfolio_ga4',
    'GA4 weekly report across every live site in the a7-sites registry, focused on AI-SEARCH REFERRALS: sessions/users/engagement grouped by AI engine (ChatGPT, Perplexity, Copilot, Gemini, Claude, You.com, Phind) and — the point of it — which PAGE TYPES that AI traffic lands on, using the same registry pageTypes patterns as portfolio_gsc so the two are comparable. Uses the same Google service account as GSC (A7_GSC_CREDENTIALS / A7_GSC_CREDENTIALS_JSON) but needs the Analytics Data + Admin APIs enabled and the service account added as a Viewer on each GA4 property. Without credentials it returns setup guidance instead of failing (there is no credential-free half here — AI referral data only exists inside GA4). Sources whose shape does not look like real traffic (GA4 reserved-param leakage, localhost, self-referral) are listed separately and excluded from the AI numbers.',
    {
      registryPath: z
        .string()
        .optional()
        .describe('Path to a7-sites registry/sites.json. Defaults to A7_REGISTRY_PATH env or the known a7-sites path.'),
      days: z.number().optional().describe('Window length in days. Default 28.'),
      lagDays: z.number().optional().describe('How many days back the window ends. Default 1.'),
      onlySites: z.array(z.string()).optional().describe('Limit to these registry site ids.'),
    },
    async ({ registryPath, days, lagDays, onlySites }) => {
      try {
        const report = await runGa4WeeklyReport(registryPath, { days, lagDays, onlySites });
        return { content: [{ type: 'text' as const, text: JSON.stringify(ok(report), null, 2) }] };
      } catch (err) {
        const res = fail(
          'PORTFOLIO_GA4_FAILED',
          (err as Error).message,
          'Missing credentials is NOT an error here — it comes back inside the report. This code means the registry itself could not be read.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  // Bing 是同一個問題的第二個引擎。刻意跟 portfolio_gsc 共用 registry 的 pageTypes：
  // 兩張表擺在一起才看得出「Google 不要的頁型 Bing 要不要」。
  server.tool(
    'portfolio_bing',
    'Bing Webmaster Tools report across every live site in the a7-sites registry: clicks/impressions/CTR/position plus a page-type breakdown using the SAME registry pageTypes patterns as portfolio_gsc, so Google and Bing can be compared per page type. Needs A7_BING_API_KEY (one key covers every site in the account; generate at bing.com/webmasters → Settings → API access). Bing has no index-count API — the crawl numbers are crawl volume, not index size. Without a key it returns setup guidance instead of failing.',
    {
      registryPath: z
        .string()
        .optional()
        .describe('Path to a7-sites registry/sites.json. Defaults to A7_REGISTRY_PATH env or the known a7-sites path.'),
      days: z.number().optional().describe('Window length in days. Default 28.'),
      onlySites: z.array(z.string()).optional().describe('Limit to these registry site ids.'),
    },
    async ({ registryPath, days, onlySites }) => {
      try {
        const report = await runBingReport(registryPath, { days, onlySites });
        return { content: [{ type: 'text' as const, text: JSON.stringify(ok(report), null, 2) }] };
      } catch (err) {
        const res = fail(
          'PORTFOLIO_BING_FAILED',
          (err as Error).message,
          'Missing API key is NOT an error here — it comes back inside the report. This code means the registry itself could not be read.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  // 四層匯流。存在的理由是 2026-08 真的發生過「總表全綠、實際已掛五週」——
  // 分開看每一層就會重演同一個故障模式。
  server.tool(
    'portfolio_weekly',
    'The whole weekly picture in ONE report: portfolio HTTP health + GSC page types + Bing + GA4 AI referrals (and, if you pass d1File, the a7-sites D1 freshness sentinel output). Returns a title line plus the full markdown. Use this instead of calling the individual portfolio_* tools when you want the weekly read-out — the layers exist precisely because each one hides a class of failure the others cannot see. Any layer that fails is written into the report rather than dropped. Clarity is deliberately NOT included (quota is 10 calls/day per site, 3-day window — it does not line up with the 28-day window).',
    {
      registryPath: z.string().optional().describe('Path to a7-sites registry/sites.json.'),
      days: z.number().optional().describe('Window length in days. Default 28.'),
      inspectPerType: z
        .number()
        .optional()
        .describe('GSC urlInspection samples per page type. Default 0 (off). Quota 2,000/day per property.'),
      onlySites: z.array(z.string()).optional().describe('Limit to these registry site ids.'),
      d1File: z
        .string()
        .optional()
        .describe("Path to a file holding a7-sites' check-freshness.mjs output, to splice in as the D1 layer."),
      skip: z
        .array(z.enum(['http', 'gsc', 'bing', 'ga4']))
        .optional()
        .describe('Layers to skip. Skipped layers are labelled as skipped, not as missing data.'),
    },
    async ({ registryPath, days, inspectPerType, onlySites, d1File, skip }) => {
      try {
        const report = await runWeeklyReport(registryPath, {
          days,
          inspectPerType,
          onlySites,
          d1File,
          skip,
        });
        const res = ok({ title: report.title, markdown: report.markdown });
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'PORTFOLIO_WEEKLY_FAILED',
          (err as Error).message,
          'Individual layer failures are written into the report, not thrown. This code means the registry itself could not be read.'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );
}

function registerKeywordTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_keywords_discover',
    'Discover keywords with search volume, trends, and competition data. Uses Google Trends (free), Google Keyword Planner (free), and DataForSEO (paid) in a fallback chain.',
    {
      seeds: z.string().describe('Comma-separated seed keywords (e.g. "SEO優化,關鍵字研究")'),
    },
    async ({ seeds }) => {
      try {
        const seedList = seeds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (seedList.length === 0) {
          const res = fail('EMPTY_SEEDS', 'No seed keywords provided', 'Provide comma-separated keywords, e.g. "SEO優化,關鍵字研究"');
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
        }
        const result = await discoverKeywords(seedList, config, db);
        const res = ok(result);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'DISCOVERY_FAILED',
          (err as Error).message,
          'Check that Python + pytrends is installed, or configure Google Keyword Planner credentials'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_keywords_trends',
    'Get Google Trends data for specific keywords. Returns relative interest (0-100), trend direction, and related queries.',
    {
      keywords: z.string().describe('Comma-separated keywords to check trends for'),
      timeframe: z.string().optional().describe('Timeframe (default: "today 12-m"). Options: "today 3-m", "today 12-m", "today 5-y"'),
    },
    async ({ keywords, timeframe }) => {
      try {
        const kwList = keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const result = await getKeywordTrends(kwList, config, db, timeframe);
        const res = ok(result);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail(
          'TRENDS_FAILED',
          (err as Error).message,
          'Install Python 3 and pytrends: pip install pytrends'
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_keywords_cluster',
    'Group keywords into topical clusters with search intent classification.',
    {
      keywords: z.string().describe('Comma-separated keywords to cluster'),
    },
    async ({ keywords }) => {
      const kwList = keywords
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await clusterKeywords(kwList, config, db);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_keywords_gaps',
    'Find keyword gaps: keywords in the database that do not have published articles yet.',
    {
      limit: z.number().optional().describe('Max results to return (default: 20)'),
    },
    async ({ limit }) => {
      const maxResults = limit || 20;
      const rows = db
        .prepare(
          `SELECT k.keyword, k.volume, k.trend, k.trend_interest, k.intent
           FROM keywords k
           LEFT JOIN articles a ON a.target_keyword_id = k.id AND a.project_id = k.project_id
           WHERE k.project_id = ? AND a.id IS NULL
           ORDER BY k.trend_interest DESC NULLS LAST, k.volume DESC NULLS LAST
           LIMIT ?`
        )
        .all(config.projectId, maxResults);

      const res = ok({ gaps: rows, total: rows.length });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );
}

function registerContentTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_content_brief',
    'Generate a content brief from a target keyword. Analyzes search intent and produces an article outline with headings, FAQ questions, and word count target.',
    {
      keyword: z.string().describe('Target keyword for the article'),
      related_queries: z.string().optional().describe('Comma-separated related keywords to include'),
      intent: z.string().optional().describe('Search intent: informational, commercial, transactional, navigational'),
    },
    async ({ keyword, related_queries, intent }) => {
      const related = related_queries
        ? related_queries.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      // Try to enrich from DB
      if (related.length === 0) {
        const row = db
          .prepare('SELECT trend, intent FROM keywords WHERE project_id = ? AND keyword = ?')
          .get(config.projectId, keyword) as { trend: string; intent: string } | undefined;
        if (row?.intent && !intent) {
          // Use DB intent as fallback
        }
      }

      const result = await generateBrief(keyword, related, intent || null, config);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_content_generate',
    'Generate a full SEO article as semantic HTML from a content brief. Outputs pure HTML (no classes, no divs) plus JSON-LD schema.',
    {
      keyword: z.string().describe('Target keyword'),
      title: z.string().optional().describe('Article title (auto-generated if omitted)'),
      headings: z.string().optional().describe('JSON array of headings: [{"level":2,"text":"..."},...]'),
      faq_questions: z.string().optional().describe('Comma-separated FAQ questions'),
      target_word_count: z.number().optional().describe('Target word count (default: 2000)'),
    },
    async ({ keyword, title, headings, faq_questions, target_word_count }) => {
      // Build brief from parameters or generate one
      let brief;
      if (title && headings) {
        let parsedHeadings;
        try {
          parsedHeadings = JSON.parse(headings);
        } catch {
          parsedHeadings = [{ level: 2, text: keyword }];
        }
        brief = {
          keyword,
          title,
          metaDescription: `${title} - ${keyword}`,
          headings: parsedHeadings,
          targetWordCount: target_word_count || 2000,
          faqQuestions: faq_questions ? faq_questions.split(',').map((s) => s.trim()) : [],
          relatedKeywords: [],
          intent: 'informational',
        };
      } else {
        const briefResult = await generateBrief(keyword, [], null, config);
        if (!briefResult.success || !briefResult.data) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(briefResult, null, 2) }] };
        }
        brief = briefResult.data;
      }

      const result = await generateArticle(brief, config);

      // Save to DB as draft
      if (result.success && result.data) {
        const article = result.data;
        // Ensure project exists
        db.prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
          .run(config.projectId, config.projectId, config.domain);

        db.prepare(`
          INSERT OR REPLACE INTO articles
            (project_id, title, slug, status, content_html, schema_json, meta_description, word_count, created_at, updated_at)
          VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          config.projectId,
          article.title,
          article.slug,
          article.html,
          JSON.stringify(article.jsonLd),
          article.metaDescription,
          article.wordCount
        );
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'seo_content_optimize',
    'Analyze existing article HTML and provide SEO optimization suggestions. Optionally rewrites the article.',
    {
      html: z.string().describe('Existing article HTML to optimize'),
      keyword: z.string().describe('Target keyword for optimization'),
    },
    async ({ html, keyword }) => {
      try {
        const result = await optimizeContent(html, keyword, config);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const res = fail('OPTIMIZE_FAILED', (err as Error).message, 'Check API key and article HTML format');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );
}

function registerPublisherTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  server.tool(
    'seo_publish_draft',
    'Save an article as a draft in the local database.',
    {
      title: z.string().describe('Article title'),
      slug: z.string().describe('URL slug'),
      html: z.string().describe('Article HTML content'),
      meta_description: z.string().optional().describe('Meta description'),
      keyword: z.string().optional().describe('Target keyword'),
    },
    async ({ title, slug, html, meta_description, keyword }) => {
      try {
        db.prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
          .run(config.projectId, config.projectId, config.domain);

        const wordCount = html.replace(/<[^>]+>/g, '').length;

        db.prepare(`
          INSERT OR REPLACE INTO articles
            (project_id, title, slug, status, content_html, meta_description, word_count, created_at, updated_at)
          VALUES (?, ?, ?, 'draft', ?, ?, ?, datetime('now'), datetime('now'))
        `).run(config.projectId, title, slug, html, meta_description || '', wordCount);

        // Link to keyword if provided
        if (keyword) {
          const kw = db.prepare('SELECT id FROM keywords WHERE project_id = ? AND keyword = ?')
            .get(config.projectId, keyword) as { id: number } | undefined;
          if (kw) {
            db.prepare('UPDATE articles SET target_keyword_id = ? WHERE project_id = ? AND slug = ?')
              .run(kw.id, config.projectId, slug);
          }
        }

        const res = ok({ slug, status: 'draft', wordCount });
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        const res = fail('DRAFT_FAILED', (err as Error).message, 'Check article data and database');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }
    }
  );

  server.tool(
    'seo_publish_push',
    'Publish a draft article to the configured publishing target (markdown files, WordPress, etc.).',
    {
      slug: z.string().describe('Slug of the draft article to publish'),
    },
    async ({ slug }) => {
      const article = db
        .prepare('SELECT * FROM articles WHERE project_id = ? AND slug = ?')
        .get(config.projectId, slug) as Record<string, unknown> | undefined;

      if (!article) {
        const res = fail('NOT_FOUND', `No article found with slug "${slug}"`, 'Check the slug or use seo_publish_list to see available drafts');
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      }

      // Get keyword for the article
      let keywords: string[] = [];
      if (article.target_keyword_id) {
        const kw = db.prepare('SELECT keyword FROM keywords WHERE id = ?').get(article.target_keyword_id) as { keyword: string } | undefined;
        if (kw) keywords = [kw.keyword];
      }

      // Create adapter based on config
      const adapter = config.publisher.adapter === 'blogposts-ts'
        ? createBlogPostsTsAdapter({
            blogPostsPath: config.publisher.config.blogPostsPath || './data/blogPosts.ts',
            imagesDir: config.publisher.config.imagesDir || './public/images',
          })
        : createMarkdownAdapter({
            outputDir: config.publisher.config.outputDir || './content',
          });

      const result = await adapter.publish({
        title: article.title as string,
        slug: article.slug as string,
        contentHtml: article.content_html as string,
        metaDescription: (article.meta_description as string) || '',
        keywords,
        schemaJson: article.schema_json as string | undefined,
      });

      if (result.success) {
        db.prepare("UPDATE articles SET status = 'published', published_url = ?, published_at = datetime('now') WHERE project_id = ? AND slug = ?")
          .run(result.url, config.projectId, slug);
      }

      const res = result.success
        ? ok({ slug, url: result.url, status: 'published' })
        : fail('PUBLISH_FAILED', result.error || 'Unknown error', 'Check publisher config and permissions');
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    'seo_publish_list',
    'List all articles in the database with their publish status.',
    {
      status: z.string().optional().describe('Filter by status: draft, published, needs_update'),
      limit: z.number().optional().describe('Max results (default: 50)'),
    },
    async ({ status, limit }) => {
      const maxResults = limit || 50;
      let query = 'SELECT title, slug, status, word_count, published_url, published_at, created_at FROM articles WHERE project_id = ?';
      const params: unknown[] = [config.projectId];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(maxResults);

      const rows = db.prepare(query).all(...params);
      const res = ok({ articles: rows, total: rows.length });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
    }
  );
}
