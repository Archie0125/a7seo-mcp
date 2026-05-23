/**
 * Shared types for platform analytics providers.
 * Mirrors the shape of src/modules/keywords/providers/base.ts so platform
 * tools surface the same { success, data, error } envelope to MCP callers.
 */

export interface PlatformDateRange {
  startDate: string; // ISO YYYY-MM-DD
  endDate: string; // ISO YYYY-MM-DD
}

export interface PlatformMetricRow {
  date?: string;
  metric: string;
  value: number;
  dimensions?: Record<string, string>;
}

export interface PlatformReport {
  platform: 'ga4' | 'gsc' | 'bing-wmt' | 'clarity';
  siteUrl: string;
  range: PlatformDateRange;
  metrics: PlatformMetricRow[];
  topQueries?: Array<{ query: string; clicks: number; impressions?: number }>;
  topPages?: Array<{ url: string; clicks: number; impressions?: number }>;
  raw?: unknown;
}

export interface PlatformProvider {
  name: 'ga4' | 'gsc' | 'bing-wmt' | 'clarity';
  isConfigured(): boolean;
  fetch(range: PlatformDateRange): Promise<PlatformReport>;
}

export class PlatformConfigError extends Error {
  constructor(
    public readonly platform: string,
    public readonly missing: string[]
  ) {
    super(`Platform ${platform} not configured (missing: ${missing.join(', ')})`);
    this.name = 'PlatformConfigError';
  }
}
