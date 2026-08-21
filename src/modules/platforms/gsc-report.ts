/**
 * GSC 週報：讀 a7-sites 的 registry/sites.json，對每個 live 站產兩張表。
 *
 * 表一 五站總覽：28 天點擊／曝光／CTR／平均排序（＋ --inspect 時的索引涵蓋抽樣）。
 * 表二 頁型分群：依 registry 宣告的 URL pattern 把「sitemap 頁數」與「GSC 曝光」
 *      對在同一列。**這張才是重點**——下一輪決定砍哪些頁型的唯一依據就是它。
 *
 * 為什麼兩個數字一定要並排：GSC 的 searchAnalytics 只回**有曝光的頁**，零曝光的
 * 頁根本不會出現在回應裡。只看 GSC 你永遠看不到「這個頁型有 1,764 頁、其中 0 頁
 * 拿到過曝光」——而那正是該砍的訊號。sitemap 那半張表是純 HTTP、免憑證的，所以
 * 就算 GSC 憑證還沒設好，這支指令仍然吐得出有用的東西。
 *
 * pattern 定義住在 registry/sites.json 的 pageTypes（單一真相來源），不寫死在這裡。
 */
import {
  getAccessToken,
  inspectUrl,
  listProperties,
  loadServiceAccount,
  queryAllPages,
  querySearchAnalytics,
  GscCredentialsError,
  type GscProperty,
  type SearchAnalyticsRow,
  type UrlInspection,
} from './gsc.js';
import {
  loadRegistry,
  resolveRegistryPath,
  type RegistryPageType,
  type RegistrySite,
} from './portfolio.js';

const LIVE_STATUS = 'live';
const SITEMAP_CONCURRENCY = 4;
const SITEMAP_TIMEOUT_MS = 30_000;
const INSPECT_CONCURRENCY = 4;

/** 未命中任何宣告 pattern 的頁都落在這裡。它變大＝registry 的 pageTypes 過時了。 */
const OTHER_TYPE: RegistryPageType = { id: '_other', match: '', label: '（未分類）' };

// ---------------------------------------------------------------- 頁型比對

/**
 * 分段前綴比對：`/s` 命中 `/s` 與 `/s/**`，但**不會**命中 `/sup`。
 *
 * 用分段而不是單純 startsWith 是因為這五站的路徑會互相吃掉：food 的 `/c` 用
 * startsWith 會把 `/cal`、`/class`、`/contaminant` 全吸走；factory 的 `/s` 會吃掉
 * `/sup`。分段規則讓 pattern 可以直接寫 `/guide`，同時涵蓋 hub 頁 `/guide` 與
 * 內容頁 `/guide/xxx`，不用寫兩條。
 *
 * 陣列順序＝優先序，**第一個命中者勝**（factory 的 `/en` 要放最前面，否則沒差別
 * 但語意上讓「英文頁自成一桶」看得出來是刻意的）。
 */
export function matchPageType(
  pathname: string,
  defs: RegistryPageType[]
): RegistryPageType | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  for (const def of defs) {
    // match "/" 專指首頁本身（不然分段規則會讓它吃掉全站）。首頁值得自成一型：
    // 它通常是曝光最高的單頁，混進「（未分類）」會毀掉那一桶「變大＝宣告過時」的訊號。
    if (def.match === '/') {
      if (p === '/') return def;
      continue;
    }
    const m = def.match.replace(/\/+$/, '');
    if (!m) continue;
    if (p === m || p.startsWith(`${m}/`)) return def;
  }
  return null;
}

// ---------------------------------------------------------------- sitemap 掃描

const RE_SITEMAP_BLOCK = /<sitemap\b[^>]*>[\s\S]*?<\/sitemap>/g;
const RE_URL_BLOCK = /<url\b[^>]*>[\s\S]*?<\/url>/g;
const RE_LOC = /<loc>\s*([\s\S]*?)\s*<\/loc>/;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractLocs(xml: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const block of xml.match(re) ?? []) {
    const m = RE_LOC.exec(block);
    if (m && m[1]) out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

async function getText(url: string, timeoutMs = SITEMAP_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    })
  );
  return out;
}

export interface SitemapScan {
  total: number;
  shards: number;
  /** pageType id → 該型的所有 URL（給抽樣用；總量最大的 factory 約 24.5 萬條，記憶體無虞）。 */
  byType: Map<string, string[]>;
  error?: string;
}

/** 抓一個站的 sitemap index + 所有分片，依 pageTypes 分桶。純 HTTP、免憑證。 */
export async function scanSitemap(origin: string, defs: RegistryPageType[]): Promise<SitemapScan> {
  const byType = new Map<string, string[]>();
  try {
    const indexXml = await getText(`${origin.replace(/\/$/, '')}/sitemap.xml`);
    const shards = extractLocs(indexXml, RE_SITEMAP_BLOCK);
    // 扁平 sitemap（沒有 index）也要能吃：直接把 index 本身當唯一一片。
    const bodies =
      shards.length > 0
        ? await mapWithConcurrency(shards, SITEMAP_CONCURRENCY, (u) => getText(u))
        : [indexXml];

    let total = 0;
    for (const body of bodies) {
      for (const loc of extractLocs(body, RE_URL_BLOCK)) {
        total++;
        let pathname: string;
        try {
          pathname = new URL(loc).pathname;
        } catch {
          continue;
        }
        const def = matchPageType(pathname, defs) ?? OTHER_TYPE;
        const bucket = byType.get(def.id);
        if (bucket) bucket.push(loc);
        else byType.set(def.id, [loc]);
      }
    }
    return { total, shards: shards.length || 1, byType };
  } catch (err) {
    return { total: 0, shards: 0, byType, error: (err as Error).message };
  }
}

/** 等距抽樣：跨整個清單均勻取 n 條，同一份清單每次結果相同（週與週之間可比）。 */
export function evenlySample<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return [...items];
  const stride = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * stride)] as T);
  return out;
}

// ---------------------------------------------------------------- 報表型別

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PageTypeStat {
  id: string;
  label: string;
  match: string;
  /** sitemap 裡屬於這個頁型的 URL 數。null = 這次沒掃 sitemap。 */
  sitemapPages: number | null;
  /** 28 天內至少拿到 1 次曝光的頁數。 */
  pagesWithImpressions: number;
  clicks: number;
  impressions: number;
  ctr: number;
  /** 曝光加權平均排序（不是各頁排序的算術平均——那會讓一頁 1 次曝光的長尾主導）。 */
  position: number;
  /** --inspect 時該頁型的抽樣索引結果。 */
  coverage?: CoverageBuckets & { sampled: number };
}

export interface CoverageBuckets {
  indexed: number;
  crawledNotIndexed: number;
  discoveredNotCrawled: number;
  otherNotIndexed: number;
  errored: number;
}

export interface CoverageSample extends CoverageBuckets {
  sampled: number;
  /** 原始 coverageState 字串分布，方便看到 Google 實際回了什麼。 */
  byState: Record<string, number>;
}

export interface GscSiteReport {
  id: string;
  name: string;
  origin: string;
  property: string;
  status?: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  totals?: GscTotals;
  /** page 維度翻到上限＝頁型曝光被低估，一定要標出來。 */
  truncated?: boolean;
  sitemapTotal?: number;
  sitemapShards?: number;
  sitemapError?: string;
  pageTypes: PageTypeStat[];
  coverage?: CoverageSample;
}

export interface GscReport {
  registryPath: string;
  generatedAt: string;
  range: { startDate: string; endDate: string; days: number };
  credentials: {
    configured: boolean;
    clientEmail?: string;
    error?: string;
    hint?: string;
  };
  /** service account 實際看得到的 property（憑證有效時才有）。 */
  visibleProperties?: GscProperty[];
  sites: GscSiteReport[];
  totals: GscTotals;
  /** 抓了 sitemap 但沒有 GSC 資料——半張表也是表。 */
  sitemapOnly: boolean;
}

export interface GscReportOptions {
  /** 統計天數，預設 28。 */
  days?: number;
  /** 往回推幾天當結束日（GSC 定稿資料有 lag），預設 3。 */
  lagDays?: number;
  /** 掃 sitemap 算每個頁型的總頁數。預設 true——沒有它表二只有一半。 */
  withSitemap?: boolean;
  /** 每個頁型抽驗幾個 URL 的索引狀態。0＝不驗（預設）。 */
  inspectPerType?: number;
  /** service account 金鑰檔路徑（覆蓋 env）。 */
  credentialsPath?: string;
  /** 只跑這幾個 registry id。 */
  onlySites?: string[];
}

// ---------------------------------------------------------------- 組裝

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function resolveRange(days: number, lagDays: number): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - lagDays * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: ymd(start), endDate: ymd(end) };
}

/**
 * registry 站 → GSC property 識別字串。
 * 五站都是 domain property（registry 的 _bing_note 記著「五站 domain property 全驗證」），
 * 所以預設推 sc-domain:<domain>；要用 URL-prefix property 就在 registry 明寫 gscProperty。
 */
export function resolveProperty(site: RegistrySite): string {
  const explicit = site.analytics?.gscProperty;
  if (explicit) return explicit;
  const domain = site.domain ?? (() => {
    try {
      return new URL(site.origin).host;
    } catch {
      return site.origin;
    }
  })();
  return `sc-domain:${domain}`;
}

function classifyCoverage(state: string): keyof CoverageBuckets {
  const s = state.toLowerCase();
  if (s.includes('inspect failed')) return 'errored';
  if (s.includes('crawled') && s.includes('not indexed')) return 'crawledNotIndexed';
  if (s.includes('discovered') && s.includes('not indexed')) return 'discoveredNotCrawled';
  if (s.includes('indexed')) return 'indexed'; // "Submitted and indexed" / "Indexed, not submitted in sitemap"
  return 'otherNotIndexed';
}

function emptyBuckets(): CoverageBuckets {
  return { indexed: 0, crawledNotIndexed: 0, discoveredNotCrawled: 0, otherNotIndexed: 0, errored: 0 };
}

function tally(rows: SearchAnalyticsRow[]): GscTotals {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const weighted = rows.reduce((a, r) => a + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

export async function runGscReport(
  registryPathArg?: string,
  options: GscReportOptions = {}
): Promise<GscReport> {
  const {
    days = 28,
    lagDays = 3,
    withSitemap = true,
    inspectPerType = 0,
    credentialsPath,
    onlySites,
  } = options;

  const registryPath = resolveRegistryPath(registryPathArg);
  const allSites = loadRegistry(registryPath);
  const range = resolveRange(days, lagDays);

  const only = onlySites && onlySites.length ? new Set(onlySites) : null;
  const targets = allSites.filter(
    (s) => s.status === LIVE_STATUS && (!only || only.has(s.id))
  );

  // 憑證：拿不到就繼續跑 sitemap 那半張表，不要整支炸掉。
  let token: string | null = null;
  const credentials: GscReport['credentials'] = { configured: false };
  let visibleProperties: GscProperty[] | undefined;
  try {
    const sa = loadServiceAccount(credentialsPath);
    credentials.clientEmail = sa.client_email;
    token = await getAccessToken(sa);
    visibleProperties = await listProperties(token);
    credentials.configured = true;
  } catch (err) {
    if (err instanceof GscCredentialsError) {
      credentials.error = err.message;
      credentials.hint = err.hint;
    } else {
      credentials.error = (err as Error).message;
      credentials.hint = '憑證本身看起來有效，但呼叫 GSC API 失敗。見 docs/gsc-setup.md 的「常見錯誤」。';
    }
  }

  const visible = new Set((visibleProperties ?? []).map((p) => p.siteUrl));

  const sites: GscSiteReport[] = [];
  for (const site of targets) {
    const property = resolveProperty(site);
    const defs = site.pageTypes ?? [];
    const report: GscSiteReport = {
      id: site.id,
      name: site.name,
      origin: site.origin,
      property,
      status: site.status,
      pageTypes: [],
    };

    // --- sitemap 那半張表（免憑證）
    const perType = new Map<string, PageTypeStat>();
    for (const def of [...defs, OTHER_TYPE]) {
      perType.set(def.id, {
        id: def.id,
        label: def.label,
        match: def.match,
        sitemapPages: withSitemap ? 0 : null,
        pagesWithImpressions: 0,
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: 0,
      });
    }

    let scan: SitemapScan | null = null;
    if (withSitemap) {
      scan = await scanSitemap(site.origin, defs);
      if (scan.error) report.sitemapError = scan.error;
      report.sitemapTotal = scan.total;
      report.sitemapShards = scan.shards;
      for (const [typeId, urls] of scan.byType) {
        const stat = perType.get(typeId);
        if (stat) stat.sitemapPages = urls.length;
      }
    }

    // --- GSC 那半張表
    if (token) {
      if (visible.size > 0 && !visible.has(property)) {
        report.error =
          `service account 看不到 property「${property}」。` +
          `目前看得到的是：${[...visible].join('、') || '（一個都沒有）'}。` +
          `到 GSC → 設定 → 使用者與權限，把 ${credentials.clientEmail} 加進去（權限選「完整」或「受限」皆可）。`;
      } else {
        try {
          const [siteTotalRows, pageResult] = await Promise.all([
            querySearchAnalytics(token, property, { ...range, dimensions: [] }),
            queryAllPages(token, property, range),
          ]);
          report.totals = tally(siteTotalRows);
          report.truncated = pageResult.truncated;

          for (const row of pageResult.rows) {
            const loc = row.keys?.[0];
            if (!loc) continue;
            let pathname: string;
            try {
              pathname = new URL(loc).pathname;
            } catch {
              continue;
            }
            const def = matchPageType(pathname, defs) ?? OTHER_TYPE;
            const stat = perType.get(def.id);
            if (!stat) continue;
            stat.clicks += row.clicks;
            stat.impressions += row.impressions;
            stat.position += row.position * row.impressions; // 先累加權重，最後再除
            if (row.impressions > 0) stat.pagesWithImpressions++;
          }
          for (const stat of perType.values()) {
            stat.ctr = stat.impressions > 0 ? stat.clicks / stat.impressions : 0;
            stat.position = stat.impressions > 0 ? stat.position / stat.impressions : 0;
          }
        } catch (err) {
          report.error = (err as Error).message;
        }
      }

      // --- 索引涵蓋抽樣（唯一能從 API 拿到涵蓋狀態的路，一次一個 URL）
      if (inspectPerType > 0 && scan && !report.error) {
        const sample: CoverageSample = { sampled: 0, byState: {}, ...emptyBuckets() };
        for (const [typeId, urls] of scan.byType) {
          const stat = perType.get(typeId);
          if (!stat) continue;
          const picked = evenlySample(urls, inspectPerType);
          const results = await mapWithConcurrency(picked, INSPECT_CONCURRENCY, (u) =>
            inspectUrl(token as string, property, u)
          );
          const buckets = emptyBuckets();
          for (const r of results as UrlInspection[]) {
            const k = classifyCoverage(r.coverageState);
            buckets[k]++;
            sample[k]++;
            sample.sampled++;
            sample.byState[r.coverageState] = (sample.byState[r.coverageState] ?? 0) + 1;
          }
          stat.coverage = { ...buckets, sampled: picked.length };
        }
        report.coverage = sample;
      }
    }

    // 沒有 sitemap 頁也沒有曝光的頁型不必佔一列（多半是 registry 寫了但站上還沒有）。
    report.pageTypes = [...perType.values()]
      .filter((s) => (s.sitemapPages ?? 0) > 0 || s.impressions > 0 || s.clicks > 0)
      .sort((a, b) => b.impressions - a.impressions || (b.sitemapPages ?? 0) - (a.sitemapPages ?? 0));

    sites.push(report);
  }

  const withData = sites.filter((s) => s.totals);
  const totals: GscTotals = {
    clicks: withData.reduce((a, s) => a + (s.totals?.clicks ?? 0), 0),
    impressions: withData.reduce((a, s) => a + (s.totals?.impressions ?? 0), 0),
    ctr: 0,
    position: 0,
  };
  totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  totals.position =
    totals.impressions > 0
      ? withData.reduce((a, s) => a + (s.totals?.position ?? 0) * (s.totals?.impressions ?? 0), 0) /
        totals.impressions
      : 0;

  return {
    registryPath,
    generatedAt: new Date().toISOString(),
    range: { ...range, days },
    credentials,
    visibleProperties,
    sites,
    totals,
    sitemapOnly: !credentials.configured,
  };
}

// ---------------------------------------------------------------- 輸出

/** 全形字算 2 欄寬，否則中文表格必歪。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function padRight(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function padLeft(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}

function table(headers: string[], rows: string[][], alignRight: boolean[]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? '')))
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (alignRight[i] ? padLeft(c, widths[i] as number) : padRight(c, widths[i] as number)))
      .join('  ')
      .trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

const num = (n: number): string => n.toLocaleString('en-US');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const pos = (n: number): string => (n > 0 ? n.toFixed(1) : '—');

export function formatGscReport(report: GscReport): string {
  const out: string[] = [];
  const { startDate, endDate, days } = report.range;

  out.push(`GSC 週報 — ${days} 天（${startDate} ~ ${endDate}，dataState=final）`);
  out.push(`來源：${report.registryPath}`);
  out.push('');

  if (!report.credentials.configured) {
    out.push('=== GSC 憑證未就緒，本次只有 sitemap 那半張表 ===');
    out.push(`原因：${report.credentials.error ?? '未知'}`);
    if (report.credentials.hint) out.push(`怎麼辦：${report.credentials.hint}`);
    out.push('');
    out.push('沒有憑證仍然看得到的：表二左半（每個頁型在 sitemap 裡有幾頁）。');
    out.push('拿到憑證後才會有的：點擊／曝光／CTR／排序，以及「頁數多但曝光為零」這個判斷。');
    out.push('');
  } else {
    out.push(`憑證：${report.credentials.clientEmail}`);
    const visible = report.visibleProperties ?? [];
    out.push(
      visible.length
        ? `可見 property（${visible.length}）：${visible.map((p) => p.siteUrl).join('、')}`
        : '可見 property：0 個 —— 金鑰有效，但這個 service account 還沒被加進任何 GSC property（最常漏的一步）。'
    );
    out.push('');
  }

  // ---- 表一
  out.push('【表一】五站總覽');
  const t1rows = report.sites.map((s) => {
    const cov = s.coverage;
    const covCell = cov
      ? `${cov.indexed}/${cov.sampled}（抽樣）`
      : report.credentials.configured
        ? '未抽驗'
        : '—';
    return [
      s.name,
      s.id,
      s.totals ? num(s.totals.clicks) : '—',
      s.totals ? num(s.totals.impressions) : '—',
      s.totals ? pct(s.totals.ctr) : '—',
      s.totals ? pos(s.totals.position) : '—',
      s.sitemapTotal !== undefined ? num(s.sitemapTotal) : '—',
      covCell,
    ];
  });
  const anyGsc = report.sites.some((s) => s.totals);
  t1rows.push([
    '合計',
    '',
    anyGsc ? num(report.totals.clicks) : '—',
    anyGsc ? num(report.totals.impressions) : '—',
    anyGsc ? pct(report.totals.ctr) : '—',
    anyGsc ? pos(report.totals.position) : '—',
    num(report.sites.reduce((a, s) => a + (s.sitemapTotal ?? 0), 0)),
    '',
  ]);
  out.push(
    ...table(
      ['站', 'id', '點擊', '曝光', 'CTR', '平均排序', 'sitemap 頁數', '已索引'],
      t1rows,
      [false, false, true, true, true, true, true, true]
    )
  );
  out.push('');
  out.push(
    '「已索引」是 urlInspection 的抽樣結果，不是 GSC UI 那個全站計數 —— Google 沒有'
  );
  out.push('任何 API 吐得出 UI 的索引涵蓋總數，只有一次一個 URL 的 urlInspection。');
  out.push('要抽樣加 --inspect N（每個頁型抽 N 個，配額每天每站 2,000 次）。');
  out.push('');

  // ---- 表二
  out.push('【表二】頁型分群 —— 下一輪決定砍哪些頁型的依據');
  for (const s of report.sites) {
    out.push('');
    out.push(`--- ${s.name}（${s.id}）  ${s.origin}`);
    if (s.error) out.push(`    ✖ ${s.error}`);
    if (s.sitemapError) out.push(`    ✖ sitemap 掃描失敗：${s.sitemapError}`);
    if (s.truncated) out.push('    ⚠ page 維度翻到上限，頁型曝光被低估。');
    if (s.pageTypes.length === 0) {
      out.push('    （registry 沒有替這個站宣告 pageTypes，或站上沒有任何頁）');
      continue;
    }
    // 沒有 GSC 資料時，曝光那半邊一律印 '—' 而不是 0 —— 印 0 會讓「還沒問到」
    // 長得跟「問過了，真的沒人搜」一模一樣，那正是這張表要分開的兩件事。
    const hasGsc = Boolean(s.totals);
    const rows = s.pageTypes.map((t) => {
      const sm = t.sitemapPages;
      const cov = t.coverage;
      return [
        t.label,
        t.match || '—',
        sm === null ? '—' : num(sm),
        hasGsc ? num(t.pagesWithImpressions) : '—',
        hasGsc && sm && sm > 0 ? pct(t.pagesWithImpressions / sm) : '—',
        hasGsc ? num(t.impressions) : '—',
        hasGsc ? num(t.clicks) : '—',
        hasGsc && t.impressions > 0 ? pct(t.ctr) : '—',
        hasGsc ? pos(t.position) : '—',
        cov ? `${cov.indexed}/${cov.sampled}` : '',
      ];
    });
    out.push(
      ...table(
        ['頁型', 'pattern', 'sitemap 頁數', '有曝光頁數', '曝光覆蓋率', '曝光', '點擊', 'CTR', '排序', '抽驗已索引'],
        rows,
        [false, false, true, true, true, true, true, true, true, true]
      ).map((l) => `    ${l}`)
    );
    const dead = hasGsc
      ? s.pageTypes.filter((t) => (t.sitemapPages ?? 0) >= 100 && t.impressions === 0)
      : [];
    if (dead.length) {
      out.push(
        `    → 零曝光但佔 sitemap 大量名額：${dead
          .map((t) => `${t.label} ${num(t.sitemapPages ?? 0)} 頁`)
          .join('、')}`
      );
    }
  }
  out.push('');
  out.push('曝光覆蓋率 = 有曝光頁數 / sitemap 頁數。頁數多但覆蓋率趨近 0 的頁型，');
  out.push('就是「印了幾千頁沒有人搜」的那種——砍它不會失去流量，只會拿回 crawl budget。');
  return out.join('\n');
}
