/**
 * Bing 週報：跟 GSC 那層同一份 registry、同一套頁型 pattern，問的是同一個問題在
 * 另一個引擎上的答案。
 *
 * 為什麼要有：五站在 Bing 都已驗證、sitemap 也都交了，但從來沒人看過那邊的數字。
 * 只看 GSC 等於預設「Google 以外可以忽略」，而本輪 GSC 實測已經證明 Google 那邊
 * 的天花板很低（五站 28 天 68,350 曝光、CTR 2.1%）。Bing 的 CTR 通常明顯較高，
 * 而且 Copilot 的答案就長在那個 SERP 上 —— 它同時是「傳統搜尋的第二個引擎」
 * 與「AI 搜尋的其中一條入口」。
 *
 * 刻意跟 GSC 表二用同一組 pageTypes：兩張表擺在一起才看得出「Google 不要的頁型
 * Bing 要不要」。分開定義 pattern 的話這個比較就不成立。
 */
import {
  bingGet,
  inRange,
  loadBingApiKey,
  pageOf,
  parseBingDate,
  BingCredentialsError,
  type BingCrawlRow,
  type BingStatRow,
  type BingTrafficRow,
} from './bing.js';
import { matchPageType } from './gsc-report.js';
import { loadRegistry, resolveRegistryPath, type RegistrySite } from './portfolio.js';
import { formatTable, num, pct, pos } from './report-format.js';

const LIVE_STATUS = 'live';
const OTHER_TYPE = { id: '_other', label: '（未分類）' };

export interface BingTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  /** 曝光加權平均排序。0 = 沒有資料。 */
  position: number;
}

export interface BingPageTypeStat {
  id: string;
  label: string;
  clicks: number;
  impressions: number;
  ctr: number;
  pages: number;
}

export interface BingSiteReport {
  id: string;
  name: string;
  siteUrl: string;
  error?: string;
  hint?: string;
  totals?: BingTotals;
  /** 期間內被檢索的頁數合計與抓取錯誤（Bing 沒有「已索引總數」的 API）。 */
  crawl?: { crawledPages: number; crawlErrors: number; http4xx: number; http5xx: number; days: number };
  topQueries?: Array<{ query: string; clicks: number; impressions: number }>;
  pageTypes?: BingPageTypeStat[];
  /** GetPageStats 實際把 URL 放在哪個欄位。schema 哪天真的修好了，這裡會看得到。 */
  pageKeyUsed?: 'Page' | 'Query' | 'none';
  /** 頁面／查詢統計是**累計**還是可過濾到區間，Bing 沒有明說；如實記錄。 */
  notes?: string[];
}

export interface BingReport {
  registryPath: string;
  generatedAt: string;
  range: { startDate: string; endDate: string; days: number };
  credentials: { configured: boolean; error?: string; hint?: string };
  sites: BingSiteReport[];
  totals: BingTotals;
}

export interface BingReportOptions {
  days?: number;
  apiKey?: string;
  onlySites?: string[];
  topQueries?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bing 的網站識別字串。Bing 用 URL 不用 domain property，而且**要跟驗證時填的
 * 那一串一模一樣**（尾斜線算數）。registry 可以用 analytics.bingSiteUrl 覆蓋。
 */
export function resolveBingSiteUrl(site: RegistrySite): string {
  const explicit = site.analytics?.bingSiteUrl;
  if (explicit) return explicit;
  return `${site.origin.replace(/\/$/, '')}/`;
}

function tallyTraffic(rows: BingTrafficRow[]): BingTotals {
  const clicks = rows.reduce((a, r) => a + (r.Clicks ?? 0), 0);
  const impressions = rows.reduce((a, r) => a + (r.Impressions ?? 0), 0);
  const weighted = rows.reduce((a, r) => a + (r.Position ?? 0) * (r.Impressions ?? 0), 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

export async function runBingReport(
  registryPathArg?: string,
  options: BingReportOptions = {}
): Promise<BingReport> {
  const { days = 28, apiKey: apiKeyArg, onlySites, topQueries = 10 } = options;

  const registryPath = resolveRegistryPath(registryPathArg);
  const allSites = loadRegistry(registryPath);
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const range = { startDate: ymd(start), endDate: ymd(end) };

  const only = onlySites && onlySites.length ? new Set(onlySites) : null;
  const targets = allSites.filter((s) => s.status === LIVE_STATUS && (!only || only.has(s.id)));

  const report: BingReport = {
    registryPath,
    generatedAt: new Date().toISOString(),
    range: { ...range, days },
    credentials: { configured: false },
    sites: [],
    totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
  };

  let apiKey: string;
  try {
    apiKey = loadBingApiKey(apiKeyArg);
    report.credentials.configured = true;
  } catch (err) {
    const e = err as BingCredentialsError;
    report.credentials.error = e.message;
    report.credentials.hint = e.hint;
    report.sites = targets.map((s) => ({
      id: s.id,
      name: s.name,
      siteUrl: resolveBingSiteUrl(s),
      error: '沒有 Bing API 金鑰',
    }));
    return report;
  }

  for (const site of targets) {
    const siteUrl = resolveBingSiteUrl(site);
    const sr: BingSiteReport = { id: site.id, name: site.name, siteUrl, notes: [] };
    const params = { siteUrl, apikey: apiKey };

    try {
      const [traffic, queries, pages, crawl] = await Promise.all([
        bingGet<BingTrafficRow[]>('GetRankAndTrafficStats', params),
        bingGet<BingStatRow[]>('GetQueryStats', params),
        bingGet<BingStatRow[]>('GetPageStats', params),
        bingGet<BingCrawlRow[]>('GetCrawlStats', params),
      ]);

      const inWindow = (traffic ?? []).filter((r) => inRange(r.Date, range.startDate, range.endDate));
      sr.totals = tallyTraffic(inWindow);
      if (inWindow.length === 0 && (traffic ?? []).length > 0) {
        const seen = (traffic ?? []).map((r) => parseBingDate(r.Date)).sort();
        sr.notes?.push(
          `區間內沒有任何一天的資料；Bing 實際回傳的日期範圍是 ${seen[0]} ~ ${seen[seen.length - 1]}`
        );
      }

      const crawlWindow = (crawl ?? []).filter((r) => inRange(r.Date, range.startDate, range.endDate));
      sr.crawl = {
        crawledPages: crawlWindow.reduce((a, r) => a + (r.CrawledPages ?? 0), 0),
        crawlErrors: crawlWindow.reduce((a, r) => a + (r.CrawlErrors ?? 0), 0),
        http4xx: crawlWindow.reduce((a, r) => a + (r.HttpStatus4xx ?? 0), 0),
        http5xx: crawlWindow.reduce((a, r) => a + (r.HttpStatus5xx ?? 0), 0),
        days: crawlWindow.length,
      };

      sr.topQueries = [...(queries ?? [])]
        .sort((a, b) => (b.Clicks ?? 0) - (a.Clicks ?? 0))
        .slice(0, topQueries)
        .map((r) => ({
          query: r.Query ?? '(no query)',
          clicks: r.Clicks ?? 0,
          impressions: r.Impressions ?? 0,
        }));

      // --- 頁型分群（跟 GSC 表二同一組 pattern）
      const buckets = new Map<string, BingPageTypeStat>();
      let keyUsed: 'Page' | 'Query' | 'none' | undefined;
      for (const row of pages ?? []) {
        const { url, keyUsed: k } = pageOf(row);
        if (!keyUsed || keyUsed === 'none') keyUsed = k;
        if (!url) continue;
        let pathname: string;
        try {
          pathname = new URL(url, site.origin).pathname;
        } catch {
          continue;
        }
        const def = matchPageType(pathname, site.pageTypes ?? []) ?? OTHER_TYPE;
        const b = buckets.get(def.id) ?? {
          id: def.id,
          label: def.label,
          clicks: 0,
          impressions: 0,
          ctr: 0,
          pages: 0,
        };
        b.clicks += row.Clicks ?? 0;
        b.impressions += row.Impressions ?? 0;
        b.pages++;
        buckets.set(def.id, b);
      }
      for (const b of buckets.values()) b.ctr = b.impressions > 0 ? b.clicks / b.impressions : 0;
      sr.pageKeyUsed = keyUsed ?? 'none';
      sr.pageTypes = [...buckets.values()].sort((a, b) => b.impressions - a.impressions);
      if (keyUsed === 'Query') {
        sr.notes?.push(
          'GetPageStats 的列仍然用 Query 當 key（Page 欄不存在）—— 已按實際欄位讀，不是資料異常'
        );
      }
      sr.notes?.push(
        'GetQueryStats / GetPageStats 是 Bing 自己的統計視窗（約 6 個月累計），不吃日期參數，所以頁型與查詢那兩張表的區間比上面的點擊／曝光寬'
      );
    } catch (err) {
      sr.error = (err as Error).message;
      if (/40[034]/.test(sr.error)) {
        sr.hint = `siteUrl 要跟 Bing Webmaster 裡驗證的那一串一模一樣（尾斜線算數）。目前送的是「${siteUrl}」；不對的話在 registry 的 analytics 加 "bingSiteUrl": "<正確的>"。`;
      }
    }

    report.sites.push(sr);
  }

  const withData = report.sites.filter((s) => s.totals);
  report.totals.clicks = withData.reduce((a, s) => a + (s.totals?.clicks ?? 0), 0);
  report.totals.impressions = withData.reduce((a, s) => a + (s.totals?.impressions ?? 0), 0);
  report.totals.ctr =
    report.totals.impressions > 0 ? report.totals.clicks / report.totals.impressions : 0;
  report.totals.position =
    report.totals.impressions > 0
      ? withData.reduce((a, s) => a + (s.totals?.position ?? 0) * (s.totals?.impressions ?? 0), 0) /
        report.totals.impressions
      : 0;

  return report;
}

// ---------------------------------------------------------------- 輸出

export function formatBingReport(report: BingReport): string {
  const out: string[] = [];
  const { startDate, endDate, days } = report.range;
  out.push(`Bing 週報 — ${days} 天（${startDate} ~ ${endDate}）`);
  out.push(`來源：${report.registryPath}`);
  out.push('');

  if (!report.credentials.configured) {
    out.push('=== Bing API 金鑰未就緒 ===');
    out.push(`原因：${report.credentials.error ?? '未知'}`);
    if (report.credentials.hint) out.push(`怎麼辦：${report.credentials.hint}`);
    return out.join('\n');
  }

  out.push('【表一】五站總覽');
  const t1 = report.sites.map((s) => [
    s.name,
    s.id,
    s.totals ? num(s.totals.clicks) : '—',
    s.totals ? num(s.totals.impressions) : '—',
    s.totals ? pct(s.totals.ctr) : '—',
    s.totals ? pos(s.totals.position) : '—',
    s.crawl ? num(s.crawl.crawledPages) : '—',
    s.crawl ? num(s.crawl.crawlErrors) : '—',
  ]);
  t1.push([
    '合計',
    '',
    num(report.totals.clicks),
    num(report.totals.impressions),
    pct(report.totals.ctr),
    pos(report.totals.position),
    '',
    '',
  ]);
  out.push(
    ...formatTable(
      ['站', 'id', '點擊', '曝光', 'CTR', '平均排序', '期間檢索頁數', '抓取錯誤'],
      t1,
      [false, false, true, true, true, true, true, true]
    )
  );
  out.push('');
  out.push('Bing 沒有「已索引總數」的 API（跟 GSC 一樣的天花板）。「期間檢索頁數」是');
  out.push('GetCrawlStats 逐日 CrawledPages 的合計，是爬取量不是索引量，不要拿來跟 GSC');
  out.push('的已索引數對帳。');
  out.push('');

  for (const s of report.sites) {
    if (s.error) {
      out.push(`✖ ${s.name}：${s.error}`);
      if (s.hint) out.push(`   → ${s.hint}`);
      continue;
    }
    out.push(`--- ${s.name}（${s.id}）  ${s.siteUrl}`);
    if (s.pageTypes?.length) {
      out.push(
        ...formatTable(
          ['頁型', '有數據頁數', '曝光', '點擊', 'CTR'],
          s.pageTypes.map((t) => [t.label, num(t.pages), num(t.impressions), num(t.clicks), pct(t.ctr)]),
          [false, true, true, true, true]
        ).map((l) => `    ${l}`)
      );
    } else {
      out.push('    （沒有頁面統計）');
    }
    if (s.topQueries?.length) {
      out.push('    熱門查詢：');
      out.push(
        ...formatTable(
          ['查詢', '點擊', '曝光'],
          s.topQueries.map((q) => [q.query, num(q.clicks), num(q.impressions)]),
          [false, true, true]
        ).map((l) => `      ${l}`)
      );
    }
    for (const n of s.notes ?? []) out.push(`    註：${n}`);
    out.push('');
  }

  return out.join('\n');
}
