import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ProjectConfig } from './config.js';
import { discoverKeywords, getKeywordTrends } from './modules/keywords/discovery.js';
import { clusterKeywords } from './modules/keywords/clustering.js';
import { ok, fail } from './modules/keywords/providers/base.js';

export function registerAllTools(
  server: McpServer,
  config: ProjectConfig,
  db: Database.Database
): void {
  registerKeywordTools(server, config, db);
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
