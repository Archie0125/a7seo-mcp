/**
 * Bing Webmaster Tools provider.
 *
 * No first-party MCP server exists for Bing WMT (compare with mcp-gsc /
 * google-analytics-mcp / @microsoft/clarity-mcp-server which cover the
 * other three platforms in NewDawnHealth/.mcp.json). This module fills
 * the gap so every web project sharing a7seo-mcp gets a unified
 * 4-platform surface.
 *
 * API docs:
 *   https://learn.microsoft.com/en-us/bingwebmaster/getting-access
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
 *
 * Auth: query-string ?apikey=<key>. Generate at
 *   https://www.bing.com/webmasters/ → Settings → API access.
 *
 * Response format: { "d": <payload> } OData envelope.
 *
 * The HTTP + parsing primitives live in bing.ts (shared with bing-report.ts,
 * which is the registry-driven cross-site version). Two bugs that used to live
 * here are fixed there, once:
 *   - dates arrive as `/Date(1779260400000-0700)/`; the old regex demanded
 *     `/Date(<digits>)/` and silently dropped every row with a timezone offset;
 *   - `GetPageStats` rows are still keyed by `Query`, not `Page`, so reading
 *     `row.Page` produced a table of `undefined` without ever erroring.
 */

import {
  bingGet,
  inRange,
  pageOf,
  type BingCrawlRow,
  type BingStatRow,
  type BingTrafficRow,
} from './bing.js';
import type { PlatformDateRange, PlatformProvider, PlatformReport } from './types.js';
import { PlatformConfigError } from './types.js';

export interface BingWmtConfig {
  siteUrl: string;
  apiKey: string;
}

export function createBingWmtProvider(config: BingWmtConfig): PlatformProvider {
  return {
    name: 'bing-wmt',

    isConfigured() {
      return Boolean(config.apiKey && config.siteUrl);
    },

    async fetch(range: PlatformDateRange): Promise<PlatformReport> {
      if (!this.isConfigured()) {
        throw new PlatformConfigError(
          'bing-wmt',
          [config.siteUrl ? null : 'siteUrl', config.apiKey ? null : 'apiKey'].filter(
            (s): s is string => s !== null
          )
        );
      }

      const params = { siteUrl: config.siteUrl, apikey: config.apiKey };

      const [crawlStats, queryStats, pageStats, trafficStats] = await Promise.all([
        bingGet<BingCrawlRow[]>('GetCrawlStats', params),
        bingGet<BingStatRow[]>('GetQueryStats', params),
        bingGet<BingStatRow[]>('GetPageStats', params),
        bingGet<BingTrafficRow[]>('GetRankAndTrafficStats', params),
      ]);

      const dateInRange = (d: string): boolean => inRange(d, range.startDate, range.endDate);

      const inRangeCrawl = crawlStats.filter((r) => dateInRange(r.Date));
      const inRangeTraffic = trafficStats.filter((r) => dateInRange(r.Date));

      const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

      const metrics = [
        {
          metric: 'pagesCrawled',
          value: sum(inRangeCrawl.map((r) => r.CrawledPages ?? 0)),
        },
        {
          metric: 'crawlErrors',
          value: sum(inRangeCrawl.map((r) => r.CrawlErrors ?? 0)),
        },
        {
          metric: 'impressions',
          value: sum(inRangeTraffic.map((r) => r.Impressions)),
        },
        {
          metric: 'clicks',
          value: sum(inRangeTraffic.map((r) => r.Clicks)),
        },
        {
          metric: 'avgPosition',
          value:
            inRangeTraffic.length > 0
              ? Number(
                  (
                    inRangeTraffic.reduce((a, r) => a + (r.Position ?? 0), 0) /
                    inRangeTraffic.length
                  ).toFixed(2)
                )
              : 0,
        },
      ];

      const sortDesc = <T extends { Clicks: number }>(arr: T[], n: number): T[] =>
        [...arr].sort((a, b) => b.Clicks - a.Clicks).slice(0, n);

      const topQueries = sortDesc(queryStats, 20).map((r) => ({
        query: r.Query ?? '(no query)',
        clicks: r.Clicks,
        impressions: r.Impressions,
      }));

      // pageOf, not r.Page — GetPageStats reuses the Query row schema (see bing.ts).
      const topPages = sortDesc(pageStats, 20).map((r) => ({
        url: pageOf(r).url,
        clicks: r.Clicks,
        impressions: r.Impressions,
      }));

      return {
        platform: 'bing-wmt',
        siteUrl: config.siteUrl,
        range,
        metrics,
        topQueries,
        topPages,
        raw: { crawlStats: inRangeCrawl, trafficStats: inRangeTraffic },
      };
    },
  };
}
