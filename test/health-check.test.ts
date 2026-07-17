import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSeoHealthCheck } from '../src/modules/platforms/health-check.js';
import { runPortfolioHealth } from '../src/modules/platforms/portfolio.js';

/** 一個 route → 回應的假 fetch。沒對到的 route 回 404。 */
interface Route {
  status?: number;
  body?: string;
  throws?: string;
}

const realFetch = globalThis.fetch;

function mockFetch(routes: Record<string, Route>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    if (route.throws) throw new Error(route.throws);
    return new Response(route.body ?? '', { status: route.status ?? 200 });
  }) as typeof fetch;
}

function sitemapIndex(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`;
}

function urlset(n: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
    { length: n },
    (_, i) => `<url><loc>https://x.test/p/${i}</loc></url>`
  ).join('')}</urlset>`;
}

/** 基本的非 sitemap route，讓其他檢查不干擾 sitemap 斷言。 */
function baseRoutes(origin: string): Record<string, Route> {
  return {
    [`${origin}/`]: { body: '<html lang="zh-TW"></html>' },
    [`${origin}/robots.txt`]: { body: 'User-agent: *\nAllow: /\n' },
    [`${origin}/llms.txt`]: { status: 404 },
  };
}

function sitemapFinding(findings: { label: string; level: string; detail: string }[]) {
  return findings.find((f) => f.label === 'Sitemap')!;
}

describe('checkSitemap — sitemap index shard verification', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('verifies every child shard and reports the real total URL count', async () => {
    const o = 'https://ok.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex([`${o}/sitemaps/a.xml`, `${o}/sitemaps/b.xml`]) },
      [`${o}/sitemaps/a.xml`]: { body: urlset(30) },
      [`${o}/sitemaps/b.xml`]: { body: urlset(12) },
    });

    const res = await runSeoHealthCheck(o);
    const f = sitemapFinding(res.findings);

    assert.equal(f.level, 'green');
    assert.match(f.detail, /2 shard\(s\), 42 URLs total/);
    assert.equal(res.sitemap?.totalUrls, 42);
    assert.equal(res.sitemap?.shardsTotal, 2);
    assert.equal(res.sitemap?.shardsChecked, 2);
    assert.equal(res.sitemap?.partialCoverage, false);
  });

  // 這是本次修復的核心迴歸測試：舊版偵測到 <sitemap> 就回綠 return，
  // 分片 500 照樣全綠。這個測試必須是紅的。
  it('goes RED when a child shard returns 500 (old code returned green)', async () => {
    const o = 'https://broken.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex([`${o}/sitemaps/a.xml`, `${o}/sitemaps/boom.xml`]) },
      [`${o}/sitemaps/a.xml`]: { body: urlset(30) },
      [`${o}/sitemaps/boom.xml`]: { status: 500, body: 'internal error' },
    });

    const res = await runSeoHealthCheck(o);
    const f = sitemapFinding(res.findings);

    assert.equal(f.level, 'red');
    assert.match(f.detail, /1\/2 child sitemap\(s\) BROKEN/);
    assert.match(f.detail, /boom\.xml → HTTP 500/);
    assert.equal(res.sitemap?.shards.filter((s) => !s.ok).length, 1);
  });

  it('goes RED when a child shard 404s (shard count miscalculated)', async () => {
    const o = 'https://missing.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex([`${o}/sitemaps/a.xml`, `${o}/sitemaps/ghost.xml`]) },
      [`${o}/sitemaps/a.xml`]: { body: urlset(30) },
      // ghost.xml 沒註冊 → 假 fetch 回 404
    });

    const res = await runSeoHealthCheck(o);
    const f = sitemapFinding(res.findings);

    assert.equal(f.level, 'red');
    assert.match(f.detail, /ghost\.xml → HTTP 404/);
  });

  it('goes RED when a child shard is empty (0 <url> entries)', async () => {
    const o = 'https://empty.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex([`${o}/sitemaps/a.xml`, `${o}/sitemaps/empty.xml`]) },
      [`${o}/sitemaps/a.xml`]: { body: urlset(30) },
      [`${o}/sitemaps/empty.xml`]: { body: urlset(0) },
    });

    const res = await runSeoHealthCheck(o);
    const f = sitemapFinding(res.findings);

    assert.equal(f.level, 'red');
    assert.match(f.detail, /empty\.xml → no <url> entries/);
  });

  it('goes RED when a child shard times out / connection fails', async () => {
    const o = 'https://timeout.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex([`${o}/sitemaps/a.xml`, `${o}/sitemaps/slow.xml`]) },
      [`${o}/sitemaps/a.xml`]: { body: urlset(30) },
      [`${o}/sitemaps/slow.xml`]: { throws: 'ECONNRESET' },
    });

    const res = await runSeoHealthCheck(o);
    assert.equal(sitemapFinding(res.findings).level, 'red');
  });

  it('still handles a flat (non-index) sitemap', async () => {
    const o = 'https://flat.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: urlset(20) },
    });

    const res = await runSeoHealthCheck(o);
    const f = sitemapFinding(res.findings);

    assert.equal(f.level, 'green');
    assert.equal(res.sitemap?.isIndex, false);
    assert.equal(res.sitemap?.totalUrls, 20);
  });

  it('samples and flags partial coverage when shards exceed the cap', async () => {
    const o = 'https://many.test';
    const locs = Array.from({ length: 60 }, (_, i) => `${o}/sitemaps/s-${i}.xml`);
    const shardRoutes: Record<string, Route> = {};
    for (const l of locs) shardRoutes[l] = { body: urlset(10) };

    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: sitemapIndex(locs) },
      ...shardRoutes,
    });

    const res = await runSeoHealthCheck(o, { maxSitemapShards: 20 });
    const f = sitemapFinding(res.findings);

    assert.equal(res.sitemap?.shardsTotal, 60);
    assert.equal(res.sitemap?.shardsChecked, 20);
    assert.equal(res.sitemap?.partialCoverage, true);
    // 抽樣時不假裝全綠
    assert.equal(f.level, 'yellow');
    assert.match(f.detail, /NOT known-good/);
  });

  it('reports RED when the index itself is unreachable', async () => {
    const o = 'https://down.test';
    mockFetch({ ...baseRoutes(o), [`${o}/sitemap.xml`]: { status: 503 } });

    const res = await runSeoHealthCheck(o);
    assert.equal(sitemapFinding(res.findings).level, 'red');
  });
});

describe('checkRobotsTxt — allow vs block', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // 舊版只看 user-agent 字串在不在，Disallow: / 也算「explicitly listed」回綠。
  it('reports blocked crawlers as blocked, not as a blanket green', async () => {
    const o = 'https://robots.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: urlset(20) },
      [`${o}/robots.txt`]: {
        body: [
          'User-agent: *',
          'Allow: /',
          '',
          'User-agent: GPTBot',
          'Disallow: /',
          '',
          'User-agent: ClaudeBot',
          'Disallow: /',
          '',
          'User-agent: PerplexityBot',
          'Allow: /',
          '',
          'User-agent: Google-Extended',
          'Disallow: /',
          '',
          'User-agent: CCBot',
          'Disallow: /',
          '',
          'User-agent: OAI-SearchBot',
          'Allow: /',
          '',
          'User-agent: Applebot-Extended',
          'Disallow: /',
        ].join('\n'),
      },
    });

    const res = await runSeoHealthCheck(o);
    const f = res.findings.find((x) => x.label === 'robots.txt AI crawlers')!;

    assert.match(f.detail, /Blocked \(Disallow: \/\): GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended/);
    assert.match(f.detail, /Allowed: PerplexityBot, OAI-SearchBot/);
  });

  it('yellows when some crawlers have no explicit rule', async () => {
    const o = 'https://partial-robots.test';
    mockFetch({
      ...baseRoutes(o),
      [`${o}/sitemap.xml`]: { body: urlset(20) },
      [`${o}/robots.txt`]: { body: 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\n' },
    });

    const res = await runSeoHealthCheck(o);
    const f = res.findings.find((x) => x.label === 'robots.txt AI crawlers')!;

    assert.equal(f.level, 'yellow');
    assert.match(f.detail, /No explicit rule/);
  });
});

describe('runPortfolioHealth — non-live sites', () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a7seo-portfolio-'));
    registryPath = join(dir, 'sites.json');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips non-live sites instead of reporting them as errors', async () => {
    const o = 'https://live.test';
    writeFileSync(
      registryPath,
      JSON.stringify({
        sites: [
          { id: 'live-one', name: 'Live One', origin: o, status: 'live' },
          { id: 'laoren', name: '老人愛進步', origin: 'https://elder.invalid', status: 'building' },
        ],
      })
    );

    mockFetch({ ...baseRoutes(o), [`${o}/sitemap.xml`]: { body: urlset(20) } });

    const report = await runPortfolioHealth(registryPath);

    assert.equal(report.count, 2);
    assert.equal(report.checked, 1);
    assert.equal(report.skipped, 1);

    const laoren = report.sites.find((s) => s.id === 'laoren')!;
    assert.equal(laoren.skipped, true);
    assert.equal(laoren.error, undefined, 'non-live site must not surface as an error');
    assert.match(laoren.skipReason!, /not live/);
  });

  it('includeNonLive checks every site', async () => {
    const o = 'https://live2.test';
    writeFileSync(
      registryPath,
      JSON.stringify({
        sites: [
          { id: 'live-one', name: 'Live One', origin: o, status: 'live' },
          { id: 'laoren', name: '老人愛進步', origin: 'https://elder.invalid', status: 'building' },
        ],
      })
    );

    mockFetch({ ...baseRoutes(o), [`${o}/sitemap.xml`]: { body: urlset(20) } });

    const report = await runPortfolioHealth(registryPath, { includeNonLive: true });

    assert.equal(report.checked, 2);
    assert.equal(report.skipped, 0);
    assert.equal(report.sites.find((s) => s.id === 'laoren')!.skipped, undefined);
  });
});
