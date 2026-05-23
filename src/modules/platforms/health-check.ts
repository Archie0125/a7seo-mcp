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

export interface HealthCheckResult {
  siteUrl: string;
  summary: { green: number; yellow: number; red: number };
  findings: HealthFinding[];
}

interface CheckContext {
  siteUrl: string;
  homepageHtml: string | null;
  findings: HealthFinding[];
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

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
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

async function checkSitemap(ctx: CheckContext): Promise<void> {
  const url = new URL('/sitemap.xml', ctx.siteUrl).toString();
  const body = await fetchText(url);
  if (!body) {
    red(ctx, 'Sitemap', `GET ${url} failed or returned non-2xx`);
    return;
  }
  const urlCount = (body.match(/<url>/g) || []).length;
  if (urlCount < 5) {
    red(ctx, 'Sitemap', `Only ${urlCount} URLs in sitemap.xml — likely misconfigured`);
    return;
  }
  green(ctx, 'Sitemap', `${urlCount} URLs in sitemap.xml`);
}

async function checkRobotsTxt(ctx: CheckContext): Promise<void> {
  const url = new URL('/robots.txt', ctx.siteUrl).toString();
  const body = await fetchText(url);
  if (!body) {
    red(ctx, 'robots.txt', `GET ${url} failed`);
    return;
  }

  const missing = AI_CRAWLER_USER_AGENTS.filter(
    (ua) => !body.toLowerCase().includes(`user-agent: ${ua.toLowerCase()}`)
  );

  if (missing.length === AI_CRAWLER_USER_AGENTS.length) {
    yellow(
      ctx,
      'robots.txt AI crawlers',
      `No explicit User-agent block for any of: ${AI_CRAWLER_USER_AGENTS.join(', ')}. Wildcard "User-agent: *" may still allow them, but explicit rules improve trust signals.`
    );
    return;
  }

  if (missing.length > 0) {
    yellow(
      ctx,
      'robots.txt AI crawlers',
      `Missing explicit allow for: ${missing.join(', ')}`
    );
    return;
  }

  green(ctx, 'robots.txt AI crawlers', 'All major AI crawler user agents explicitly listed');
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

export async function runSeoHealthCheck(siteUrl: string): Promise<HealthCheckResult> {
  const normalisedUrl = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const ctx: CheckContext = {
    siteUrl: normalisedUrl,
    homepageHtml: await fetchText(normalisedUrl),
    findings: [],
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

  return { siteUrl: normalisedUrl, summary, findings: ctx.findings };
}
