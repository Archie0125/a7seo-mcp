/**
 * Cross-stack SEO + GEO health check.
 *
 * Inspired by NewDawnHealth's app/Console/Commands/SeoHealthCheck.php
 * (Laravel) — same logic recast as a TypeScript tool so non-PHP projects
 * (React/Vue/static sites) get the same monitoring surface without
 * needing a PHP backend.
 *
 * Inputs: site URL (derived from config.domain or explicit override).
 * Outputs: green/yellow/red findings across sitemap, robots.txt allow
 * rules for AI crawlers, llms.txt presence, and tracking pixel render
 * (GA4 gtag + Microsoft Clarity).
 *
 * Future scope: pull GA4 volume baseline / GSC indexation / Bing crawl
 * errors / Clarity dead-click ratio by chaining the corresponding MCP
 * tools. For now this is the artefact-level check that runs over plain
 * HTTP without any platform credentials.
 */

export type HealthLevel = 'green' | 'yellow' | 'red';

export interface HealthFinding {
  level: HealthLevel;
  label: string;
  detail: string;
}

/** 單一子 sitemap（分片）的驗證結果。 */
export interface SitemapShardReport {
  url: string;
  ok: boolean;
  status: number | null;
  urlCount: number;
  error?: string;
}

/** sitemap 檢查的機器可讀明細——讓呼叫端看得出「幾片、幾個 URL、哪片壞了」。 */
export interface SitemapDetail {
  isIndex: boolean;
  shardsTotal: number;
  shardsChecked: number;
  totalUrls: number;
  /** true 代表分片數超過上限、只驗了抽樣子集——未驗的片不代表健康。 */
  partialCoverage: boolean;
  shards: SitemapShardReport[];
}

export interface HealthCheckResult {
  siteUrl: string;
  summary: { green: number; yellow: number; red: number };
  findings: HealthFinding[];
  sitemap?: SitemapDetail;
}

export interface HealthCheckOptions {
  /** 最多驗幾片子 sitemap。超過就改抽樣（前 N + 隨機 N），並標記 partialCoverage。 */
  maxSitemapShards?: number;
  /**
   * 預期的最少分片數（來自 a7-sites registry/sites.json 的 sitemap.minShards）。
   * 給了就檢查「分片數有沒有少」。**下限語意**：多了不報（資料長大是常態），
   * 少了報紅（分片靜默消失）。沒給就跳過這項檢查——沒有基準時不假裝有。
   */
  expectedMinShards?: number;
}

interface CheckContext {
  siteUrl: string;
  homepageHtml: string | null;
  findings: HealthFinding[];
  maxSitemapShards: number;
  expectedMinShards?: number;
  sitemap?: SitemapDetail;
}

const TRACKING_PIXEL_SIGNATURES: Record<string, string> = {
  'GA4 gtag': 'googletagmanager.com/gtag/js?id=G-',
  'Google Ads gtag': 'googletagmanager.com/gtag/js?id=AW-',
  'Microsoft Clarity': 'clarity.ms/tag',
  'Meta Pixel': 'connect.facebook.net',
};

const AI_CRAWLER_USER_AGENTS = [
  'GPTBot',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
  'OAI-SearchBot',
  'Applebot-Extended',
];

/**
 * 驗幾片子 sitemap 的上限。五站現況最多 47 片（factory），所以預設 50 =
 * 今天全部站都是「全驗」，不抽樣。上限只是防未來分片爆炸的保險絲。
 */
const SITEMAP_SHARD_CAP = 50;
/** 超過上限時，固定驗前 N 片（misc/areas 這類穩定片通常排在前面）。 */
const SITEMAP_HEAD_SHARDS = 10;
const SITEMAP_CONCURRENCY = 6;
const SITEMAP_SHARD_TIMEOUT_MS = 30_000;

interface FetchResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error?: string;
}

async function fetchWithStatus(url: string, timeoutMs = 10_000): Promise<FetchResult> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, status: res.status, body: null, error: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, body: await res.text() };
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err as Error).message;
    return { ok: false, status: null, body: null, error: msg };
  }
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  return (await fetchWithStatus(url, timeoutMs)).body;
}

/** 併發上限的 map——不要一次對同一個 origin 開幾十條連線。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 只抓 <sitemap> 區塊裡的 <loc>（不是 <url> 裡的）。 */
function extractIndexLocs(xml: string): string[] {
  const locs: string[] = [];
  const blocks = xml.match(/<sitemap\b[^>]*>[\s\S]*?<\/sitemap>/g) || [];
  for (const block of blocks) {
    const m = /<loc>\s*([\s\S]*?)\s*<\/loc>/.exec(block);
    if (m) locs.push(decodeXmlEntities(m[1].trim()));
  }
  return locs;
}

function countUrlEntries(xml: string): number {
  return (xml.match(/<url\b[^>]*>/g) || []).length;
}

/**
 * 分片數超過上限時的抽樣：前 N 片（固定）+ 其餘隨機抽到補滿上限。
 * 隨機而非固定尾巴，是為了讓每次 health check 覆蓋到不同分片——
 * 長期下來壞片跑不掉，單次則有明確的 partialCoverage 標記不假裝全綠。
 */
function selectShards(locs: string[], cap: number): { selected: string[]; partial: boolean } {
  if (locs.length <= cap) return { selected: locs, partial: false };
  const head = locs.slice(0, SITEMAP_HEAD_SHARDS);
  const rest = locs.slice(SITEMAP_HEAD_SHARDS);
  const quota = Math.max(0, cap - head.length);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { selected: [...head, ...rest.slice(0, quota)], partial: true };
}

async function verifyShard(url: string): Promise<SitemapShardReport> {
  const res = await fetchWithStatus(url, SITEMAP_SHARD_TIMEOUT_MS);
  if (!res.ok || res.body === null) {
    return { url, ok: false, status: res.status, urlCount: 0, error: res.error ?? 'fetch failed' };
  }
  const urlCount = countUrlEntries(res.body);
  if (urlCount === 0) {
    const nested = extractIndexLocs(res.body).length;
    return {
      url,
      ok: false,
      status: res.status,
      urlCount: 0,
      error: nested > 0 ? `nested sitemap index (${nested} children) — not supported` : 'no <url> entries',
    };
  }
  return { url, ok: true, status: res.status, urlCount };
}

function green(ctx: CheckContext, label: string, detail: string): void {
  ctx.findings.push({ level: 'green', label, detail });
}

function yellow(ctx: CheckContext, label: string, detail: string): void {
  ctx.findings.push({ level: 'yellow', label, detail });
}

function red(ctx: CheckContext, label: string, detail: string): void {
  ctx.findings.push({ level: 'red', label, detail });
}

/**
 * Sitemap 檢查。
 *
 * 舊版偵測到 <sitemap> 就直接回綠 return——從不 fetch 任何子 sitemap。
 * 五站全是 sitemap index 架構，所以任何分片 500／空／URL 壞掉，報表照樣全綠。
 * 分片正是最容易壞的地方（D1 查詢逾時、shard 數量算錯），這個檢查等於沒做。
 *
 * 現在：抓 index 內每個 <loc>、逐片驗 HTTP 200 + <url> 數 > 0、回報總 URL 數。
 */
async function checkSitemap(ctx: CheckContext): Promise<void> {
  const url = new URL('/sitemap.xml', ctx.siteUrl).toString();
  const res = await fetchWithStatus(url);
  if (!res.ok || res.body === null) {
    red(ctx, 'Sitemap', `GET ${url} failed: ${res.error ?? 'non-2xx'}`);
    return;
  }
  const body = res.body;
  const childLocs = extractIndexLocs(body);

  if (childLocs.length === 0) {
    // 扁平 sitemap：本身就該有 <url>
    const urlCount = countUrlEntries(body);
    ctx.sitemap = {
      isIndex: false,
      shardsTotal: 0,
      shardsChecked: 0,
      totalUrls: urlCount,
      partialCoverage: false,
      shards: [],
    };
    if (urlCount < 5) {
      red(ctx, 'Sitemap', `Only ${urlCount} URLs in sitemap.xml — likely misconfigured`);
      return;
    }
    green(ctx, 'Sitemap', `${urlCount} URLs in sitemap.xml (flat)`);
    return;
  }

  const { selected, partial } = selectShards(childLocs, ctx.maxSitemapShards);
  const shards = await mapWithConcurrency(selected, SITEMAP_CONCURRENCY, verifyShard);
  const failures = shards.filter((s) => !s.ok);
  const totalUrls = shards.reduce((sum, s) => sum + s.urlCount, 0);

  ctx.sitemap = {
    isIndex: true,
    shardsTotal: childLocs.length,
    shardsChecked: shards.length,
    totalUrls,
    partialCoverage: partial,
    shards,
  };

  const coverage = partial
    ? `verified ${shards.length}/${childLocs.length} shards (sampled — unverified shards are NOT known-good)`
    : `all ${childLocs.length} shards verified`;

  if (failures.length > 0) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.url} → ${f.error}`)
      .join('; ');
    const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : '';
    red(
      ctx,
      'Sitemap',
      `${failures.length}/${shards.length} child sitemap(s) BROKEN: ${detail}${more}. ` +
        `${totalUrls} URLs reachable across ${shards.length - failures.length} healthy shard(s); ${coverage}.`
    );
    return;
  }

  if (totalUrls < 5) {
    red(ctx, 'Sitemap', `sitemap index has ${childLocs.length} shard(s) but only ${totalUrls} URLs total — likely misconfigured`);
    return;
  }

  // 分片數少了 = 靜默失敗。每一片都回 200、都有 URL，逐片驗證全綠——但 index 少列
  // 一片，那一片的幾萬頁就從此不進索引，沒有任何人會發現。所以要拿基準比。
  // 只在「變少」時報紅：資料長大→分片變多是常態，設等號會每次長大都誤報。
  if (ctx.expectedMinShards !== undefined && childLocs.length < ctx.expectedMinShards) {
    red(
      ctx,
      'Sitemap',
      `sitemap index has ${childLocs.length} shard(s) but registry expects at least ${ctx.expectedMinShards} — ` +
        `${ctx.expectedMinShards - childLocs.length} shard(s) went missing. Every remaining shard still returns 200, ` +
        `so per-shard checks cannot see this. Either the ETL wrote a wrong shard count, or the data shrank ` +
        `(if the shrink is intentional, lower sitemap.minShards in a7-sites registry/sites.json).`
    );
    return;
  }

  const level = partial ? yellow : green;
  const baseline =
    ctx.expectedMinShards !== undefined
      ? `; shard baseline ≥${ctx.expectedMinShards} (registry)`
      : '; no shard baseline in registry — a vanished shard would go unnoticed';
  level(
    ctx,
    'Sitemap',
    `sitemap index: ${childLocs.length} shard(s), ${totalUrls} URLs total — ${coverage}${baseline}`
  );
}

/**
 * 解析 robots.txt 成 group：連續的 User-agent 行共用其後的規則，直到下一個 group。
 * 回傳 user-agent（小寫）→ 該 group 的 rule 行（小寫）。
 */
function parseRobotsGroups(body: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let currentUas: string[] = [];
  let collectingUas = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].trim().toLowerCase();
    const value = m[2].trim();

    if (field === 'user-agent') {
      if (!collectingUas) {
        currentUas = [];
        collectingUas = true;
      }
      const ua = value.toLowerCase();
      currentUas.push(ua);
      if (!groups.has(ua)) groups.set(ua, []);
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      collectingUas = false;
      for (const ua of currentUas) {
        groups.get(ua)!.push(`${field}: ${value.toLowerCase()}`);
      }
    }
  }
  return groups;
}

/**
 * robots.txt AI crawler 檢查。
 *
 * 舊版只看 `user-agent: X` 這個字串有沒有出現，出現就算數——
 * 於是 `User-agent: GPTBot\nDisallow: /`（明確封鎖）也被算成
 * 「All major AI crawler user agents explicitly listed」回綠。
 * 五站實測全部命中：7 個 crawler 有 5 個是 Disallow: /，報表卻全綠。
 *
 * 現在：解析 group 規則，分清 allowed / blocked / 未列出，照實回報。
 * 注意封鎖多半是**刻意政策**（這幾站 robots 標了 ai-train=no），
 * 所以 blocked 不報紅——照實描述即可，不要製造常態雜訊。
 */
async function checkRobotsTxt(ctx: CheckContext): Promise<void> {
  const url = new URL('/robots.txt', ctx.siteUrl).toString();
  const res = await fetchWithStatus(url);
  if (!res.ok || res.body === null) {
    red(ctx, 'robots.txt', `GET ${url} failed: ${res.error ?? 'non-2xx'}`);
    return;
  }

  const groups = parseRobotsGroups(res.body);
  const allowed: string[] = [];
  const blocked: string[] = [];
  const notListed: string[] = [];

  for (const ua of AI_CRAWLER_USER_AGENTS) {
    const rules = groups.get(ua.toLowerCase());
    if (!rules) {
      notListed.push(ua);
      continue;
    }
    // `Disallow: /` 擋光整站；有更細的 Allow 才算部分開放
    const blocksRoot = rules.includes('disallow: /');
    const hasAllow = rules.some((r) => r.startsWith('allow: '));
    if (blocksRoot && !hasAllow) blocked.push(ua);
    else allowed.push(ua);
  }

  const parts: string[] = [];
  if (allowed.length) parts.push(`Allowed: ${allowed.join(', ')}`);
  if (blocked.length) parts.push(`Blocked (Disallow: /): ${blocked.join(', ')}`);
  if (notListed.length) parts.push(`No explicit rule (falls back to User-agent: *): ${notListed.join(', ')}`);
  const detail = parts.join('. ');

  if (notListed.length === AI_CRAWLER_USER_AGENTS.length) {
    yellow(
      ctx,
      'robots.txt AI crawlers',
      `No explicit User-agent block for any of: ${AI_CRAWLER_USER_AGENTS.join(', ')}. Wildcard "User-agent: *" may still allow them, but explicit rules improve trust signals.`
    );
    return;
  }

  if (notListed.length > 0) {
    yellow(ctx, 'robots.txt AI crawlers', detail);
    return;
  }

  green(ctx, 'robots.txt AI crawlers', `All ${AI_CRAWLER_USER_AGENTS.length} AI crawlers have explicit rules. ${detail}`);
}

async function checkLlmsTxt(ctx: CheckContext): Promise<void> {
  const url = new URL('/llms.txt', ctx.siteUrl).toString();
  const body = await fetchText(url);
  if (!body) {
    yellow(
      ctx,
      'llms.txt',
      `${url} not found. Emerging standard (https://llmstxt.org) for AI crawlers — generate one from your sitemap + core pages.`
    );
    return;
  }
  if (body.length < 200) {
    yellow(ctx, 'llms.txt', `Found at ${url} but suspiciously small (${body.length} bytes)`);
    return;
  }
  green(ctx, 'llms.txt', `${body.length} bytes at ${url}`);
}

function checkTrackingPixels(ctx: CheckContext): void {
  if (!ctx.homepageHtml) {
    yellow(ctx, 'Tracking pixels', 'Homepage fetch failed — pixel render not verified');
    return;
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const [name, needle] of Object.entries(TRACKING_PIXEL_SIGNATURES)) {
    if (ctx.homepageHtml.includes(needle)) present.push(name);
    else missing.push(name);
  }

  if (present.length === 0) {
    red(
      ctx,
      'Tracking pixels',
      `Homepage contains none of: ${Object.keys(TRACKING_PIXEL_SIGNATURES).join(', ')}. The site is effectively analytics-blind.`
    );
    return;
  }

  if (missing.length > 0) {
    yellow(
      ctx,
      'Tracking pixels',
      `Present: ${present.join(', ')}. Missing: ${missing.join(', ')}`
    );
    return;
  }

  green(ctx, 'Tracking pixels', `All 4 pixels present: ${present.join(', ')}`);
}

function checkCanonical(ctx: CheckContext): void {
  if (!ctx.homepageHtml) return;
  if (!/<link\s+rel=["']canonical["']/i.test(ctx.homepageHtml)) {
    yellow(ctx, 'Canonical link', 'No <link rel="canonical"> on homepage HTML');
  } else {
    green(ctx, 'Canonical link', 'Present on homepage');
  }
}

function checkOgImage(ctx: CheckContext): void {
  if (!ctx.homepageHtml) return;
  if (!/<meta\s+property=["']og:image["']/i.test(ctx.homepageHtml)) {
    yellow(ctx, 'og:image', 'No og:image meta tag — social sharing shows generic preview');
  } else {
    green(ctx, 'og:image', 'Present on homepage');
  }
}

function checkLangAttr(ctx: CheckContext): void {
  if (!ctx.homepageHtml) return;
  const match = /<html[^>]+lang=["']([^"']+)["']/i.exec(ctx.homepageHtml);
  if (!match) {
    yellow(ctx, '<html lang>', 'Missing lang attribute on <html>');
    return;
  }
  green(ctx, '<html lang>', `lang="${match[1]}"`);
}

export async function runSeoHealthCheck(
  siteUrl: string,
  options: HealthCheckOptions = {}
): Promise<HealthCheckResult> {
  const normalisedUrl = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const ctx: CheckContext = {
    siteUrl: normalisedUrl,
    homepageHtml: await fetchText(normalisedUrl),
    findings: [],
    maxSitemapShards: options.maxSitemapShards ?? SITEMAP_SHARD_CAP,
    expectedMinShards: options.expectedMinShards,
  };

  await checkSitemap(ctx);
  await checkRobotsTxt(ctx);
  await checkLlmsTxt(ctx);
  checkTrackingPixels(ctx);
  checkCanonical(ctx);
  checkOgImage(ctx);
  checkLangAttr(ctx);

  const summary = {
    green: ctx.findings.filter((f) => f.level === 'green').length,
    yellow: ctx.findings.filter((f) => f.level === 'yellow').length,
    red: ctx.findings.filter((f) => f.level === 'red').length,
  };

  return { siteUrl: normalisedUrl, summary, findings: ctx.findings, sitemap: ctx.sitemap };
}
