import type Database from 'better-sqlite3';
import type { ProjectConfig } from '../../config.js';
import type { KeywordResult, KeywordProvider } from './providers/base.js';
import { googleTrendsProvider } from './providers/google-trends.js';

export interface DiscoveryResult {
  keywords: KeywordResult[];
  providersUsed: string[];
  dataforseoVerified: boolean;
}

export async function discoverKeywords(
  seeds: string[],
  config: ProjectConfig,
  db: Database.Database
): Promise<DiscoveryResult> {
  const options = { language: config.language, region: config.region };
  const providersUsed: string[] = [];
  let results: KeywordResult[] = [];

  // Check cache first
  const cacheKey = `discover:${seeds.sort().join(',')}:${config.region}`;
  const cached = getCachedResult(db, 'discovery', cacheKey);
  if (cached) {
    return cached as DiscoveryResult;
  }

  // Step 1: Google Trends (free, always try)
  if (await googleTrendsProvider.isAvailable()) {
    try {
      const trendsData = await googleTrendsProvider.discover(seeds, options);
      results = trendsData;
      providersUsed.push('google-trends');
    } catch (err) {
      console.error('Google Trends failed:', (err as Error).message);
    }
  }

  // Step 2: Google Keyword Planner (free, needs credentials)
  // TODO: Implement in Phase 2
  // if (config.googleAds?.developerToken) { ... }

  // Step 3: DataForSEO verification (paid, optional)
  // TODO: Implement when DataForSEO provider is added
  const dataforseoVerified = false;

  const result: DiscoveryResult = {
    keywords: results,
    providersUsed,
    dataforseoVerified,
  };

  // Cache for 24 hours
  setCachedResult(db, 'discovery', cacheKey, result, 24 * 60 * 60);

  // Upsert keywords into DB
  upsertKeywords(db, config.projectId, results);

  return result;
}

export async function getKeywordTrends(
  keywords: string[],
  config: ProjectConfig,
  db: Database.Database,
  timeframe?: string
): Promise<KeywordResult[]> {
  const options = {
    language: config.language,
    region: config.region,
    timeframe: timeframe || 'today 12-m',
  };

  if (!(await googleTrendsProvider.isAvailable())) {
    throw new Error(
      'Google Trends requires Python + pytrends. Run: pip install pytrends'
    );
  }

  return googleTrendsProvider.discover(keywords, options);
}

function upsertKeywords(
  db: Database.Database,
  projectId: string,
  keywords: KeywordResult[]
): void {
  // Ensure project exists
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)`
  ).run(projectId, projectId, 'unknown');

  const stmt = db.prepare(`
    INSERT INTO keywords (project_id, keyword, volume, volume_source, volume_confidence,
      difficulty, cpc, intent, trend, trend_interest, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, keyword) DO UPDATE SET
      volume = COALESCE(excluded.volume, volume),
      volume_source = COALESCE(excluded.volume_source, volume_source),
      volume_confidence = COALESCE(excluded.volume_confidence, volume_confidence),
      difficulty = COALESCE(excluded.difficulty, difficulty),
      cpc = COALESCE(excluded.cpc, cpc),
      intent = COALESCE(excluded.intent, intent),
      trend = COALESCE(excluded.trend, trend),
      trend_interest = COALESCE(excluded.trend_interest, trend_interest),
      source = COALESCE(excluded.source, source),
      updated_at = datetime('now')
  `);

  const txn = db.transaction((kws: KeywordResult[]) => {
    for (const kw of kws) {
      stmt.run(
        projectId,
        kw.keyword,
        kw.volume,
        kw.volumeSource,
        kw.volumeConfidence,
        kw.difficulty,
        kw.cpc,
        kw.intent,
        kw.trend,
        kw.trendInterest,
        kw.volumeSource
      );
    }
  });

  txn(keywords);
}

function getCachedResult(
  db: Database.Database,
  provider: string,
  cacheKey: string
): unknown | null {
  const row = db
    .prepare(
      `SELECT response_json FROM provider_cache
       WHERE provider = ? AND cache_key = ? AND expires_at > datetime('now')`
    )
    .get(provider, cacheKey) as { response_json: string } | undefined;

  if (row) {
    try {
      return JSON.parse(row.response_json);
    } catch {
      return null;
    }
  }
  return null;
}

function setCachedResult(
  db: Database.Database,
  provider: string,
  cacheKey: string,
  data: unknown,
  ttlSeconds: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO provider_cache (provider, cache_key, response_json, expires_at)
     VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))`
  ).run(provider, cacheKey, JSON.stringify(data), ttlSeconds);
}
