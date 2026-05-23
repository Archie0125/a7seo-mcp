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
 */

import type { PlatformDateRange, PlatformProvider, PlatformReport } from './types.js';
import { PlatformConfigError } from './types.js';

export interface BingWmtConfig {
  siteUrl: string;
  apiKey: string;
}

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

interface BingResponse<T> {
  d: T;
}

interface CrawlStatsRow {
  CrawlErrors: number;
  CrawledPages: number;
  Date: string; // "/Date(1234567890000)/"
  HttpStatus2xx: number;
  HttpStatus3xx: number;
  HttpStatus4xx: number;
  HttpStatus5xx: number;
  InLinks: number;
}

interface QueryStatsRow {
  AvgClickPosition: number;
  AvgImpressionPosition: number;
  Clicks: number;
  Impressions: number;
  Query: string;
}

interface PageStatsRow {
  AvgClickPosition: number;
  AvgImpressionPosition: number;
  Clicks: number;
  Impressions: number;
  Page: string;
}

interface RankAndTrafficRow {
  Date: string;
  Clicks: number;
  Impressions: number;
  Position: number;
}

function parseBingDate(s: string): string {
  // "/Date(1234567890000)/" → "YYYY-MM-DD"
  const match = /\/Date\((\d+)\)\//.exec(s);
  if (!match || !match[1]) return s;
  return new Date(Number(match[1])).toISOString().slice(0, 10);
}

async function bingGet<T>(method: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/${method}?${qs}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Bing WMT ${method} HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as BingResponse<T>;
  return body.d;
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
        bingGet<CrawlStatsRow[]>('GetCrawlStats', params),
        bingGet<QueryStatsRow[]>('GetQueryStats', params),
        bingGet<PageStatsRow[]>('GetPageStats', params),
        bingGet<RankAndTrafficRow[]>('GetRankAndTrafficStats', params),
      ]);

      const dateInRange = (s: string): boolean => {
        const d = parseBingDate(s);
        return d >= range.startDate && d <= range.endDate;
      };

      const inRangeCrawl = crawlStats.filter((r) => dateInRange(r.Date));
      const inRangeTraffic = trafficStats.filter((r) => dateInRange(r.Date));

      const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

      const metrics = [
        {
          metric: 'pagesCrawled',
          value: sum(inRangeCrawl.map((r) => r.CrawledPages)),
        },
        {
          metric: 'crawlErrors',
          value: sum(inRangeCrawl.map((r) => r.CrawlErrors)),
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
                    inRangeTraffic.reduce((a, r) => a + r.Position, 0) /
                    inRangeTraffic.length
                  ).toFixed(2)
                )
              : 0,
        },
      ];

      const sortDesc = <T extends { Clicks: number }>(arr: T[], n: number): T[] =>
        [...arr].sort((a, b) => b.Clicks - a.Clicks).slice(0, n);

      const topQueries = sortDesc(queryStats, 20).map((r) => ({
        query: r.Query,
        clicks: r.Clicks,
        impressions: r.Impressions,
      }));

      const topPages = sortDesc(pageStats, 20).map((r) => ({
        url: r.Page,
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
