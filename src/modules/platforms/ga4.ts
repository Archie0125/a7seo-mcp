/**
 * GA4 讀取層：Data API v1beta（跑報表）+ Admin API v1beta（把 measurement id
 * 對回 property id）。
 *
 * 為什麼這一層現在才值得做：五站的 robots.txt 早就對 OAI-SearchBot /
 * PerplexityBot / Claude-SearchBot 開 Allow、對純訓練 bot Disallow，GA4 與
 * Clarity 也裝了半年，**但從來沒有人看過那些資料**。傳統 SERP 那邊的天花板已經
 * 量出來了（五站 28 天 68,350 曝光、CTR 2.1%），AI 搜尋這邊卻連分母都沒有。
 * 這個模組的存在理由就是把那個分母變出來。
 *
 * 為什麼不裝 @google-analytics/data：跟 gsc.ts 同一個理由——只用到三個 endpoint，
 * 認證共用 google-auth.ts 的 JWT flow，拉整包 SDK 只是讓 CI 每週多編譯一次。
 *
 * API 文件：
 *   https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 *   https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list
 */
import {
  getGoogleAccessToken,
  googleFetchJson,
  GoogleApiError,
  GoogleCredentialsError,
  type ServiceAccount,
} from './google-auth.js';

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';

export async function getGa4AccessToken(sa: ServiceAccount): Promise<string> {
  return getGoogleAccessToken(sa, GA4_SCOPE, 'Google Analytics Data API');
}

// ---------------------------------------------------------------- metric 守衛

/**
 * `conversions` 不是 GA4 Data API 的 metric —— 送出去會回 400，而錯誤訊息只說
 * 「Field conversions is not a valid metric」，不會告訴你正確的名字。這是實戰
 * 踩過的坑（另一個專案的 analytics SOP 把它列在已知地雷第 6 條），所以擋在送出
 * 之前、把正解直接寫在訊息裡。
 */
const METRIC_ALIASES: Record<string, string> = {
  conversions: 'keyEvents',
  users: 'totalUsers',
  pageviews: 'screenPageViews',
  bounceRate: 'bounceRate', // 這個是合法的，列在這裡只是為了不被誤改
};

export class Ga4MetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ga4MetricError';
  }
}

export function assertValidMetrics(metrics: string[]): void {
  for (const m of metrics) {
    if (m === 'conversions') {
      throw new Ga4MetricError(
        'GA4 Data API 沒有 `conversions` 這個 metric（GA4 已經把它改叫 key event）。用 `keyEvents`。'
      );
    }
    if (m === 'users' || m === 'pageviews') {
      throw new Ga4MetricError(
        `GA4 Data API 沒有 \`${m}\` 這個 metric（那是 Universal Analytics 的名字）。用 \`${METRIC_ALIASES[m]}\`。`
      );
    }
  }
}

// ---------------------------------------------------------------- Data API

export interface Ga4Range {
  startDate: string;
  endDate: string;
}

export interface Ga4ReportRequest extends Ga4Range {
  dimensions: string[];
  metrics: string[];
  limit?: number;
  offset?: number;
}

interface RawRunReport {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
}

/** 一列報表：維度名 → 值、metric 名 → 數字。攤平比原始巢狀好用太多。 */
export interface Ga4Row {
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export interface Ga4ReportResult {
  rows: Ga4Row[];
  rowCount: number;
  /** true = 撈到 limit 上限，還有沒撈到的列。 */
  truncated: boolean;
}

/**
 * 刻意**不用** `dimensionFilter`：舊範例的 `{ filter: { fieldName: ... } }` 結構會回
 * `Unknown field for Filter: fieldName`，而正確的 schema（stringFilter / inListFilter）
 * 每個維度型別又不一樣。這幾站的列數是幾十到幾百列的量級，撈回來在本機切比在
 * 請求裡濾便宜太多，也少一整類「濾錯了但看起來很正常」的靜默失敗。
 */
export async function runGa4Report(
  token: string,
  propertyId: string,
  req: Ga4ReportRequest
): Promise<Ga4ReportResult> {
  assertValidMetrics(req.metrics);
  const limit = req.limit ?? 10_000;
  const url = `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`;
  const json = await googleFetchJson<RawRunReport>(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: req.startDate, endDate: req.endDate }],
      dimensions: req.dimensions.map((name) => ({ name })),
      metrics: req.metrics.map((name) => ({ name })),
      limit,
      offset: req.offset ?? 0,
      keepEmptyRows: false,
    }),
  });

  const dimNames = (json.dimensionHeaders ?? []).map((h) => h.name);
  const metNames = (json.metricHeaders ?? []).map((h) => h.name);
  const rows: Ga4Row[] = (json.rows ?? []).map((r) => {
    const dimensions: Record<string, string> = {};
    dimNames.forEach((n, i) => {
      dimensions[n] = r.dimensionValues?.[i]?.value ?? '';
    });
    const metrics: Record<string, number> = {};
    metNames.forEach((n, i) => {
      metrics[n] = Number(r.metricValues?.[i]?.value ?? 0) || 0;
    });
    return { dimensions, metrics };
  });

  return { rows, rowCount: json.rowCount ?? rows.length, truncated: rows.length >= limit };
}

/**
 * 到達頁維度的名字在 GA4 改過一輪：`landingPagePlusQueryString` 是現行名，`landingPage`
 * 在部分 property 上才有。猜錯的代價不是報錯而是**整張落點表消失**，所以這裡試第一個、
 * 400 就換第二個，並把實際用到的那個名字回報出去（報表要標，不然下次看到欄位變了會以為
 * 是資料變了）。
 */
export const LANDING_PAGE_DIMENSIONS = ['landingPagePlusQueryString', 'landingPage'] as const;

export async function runGa4ReportWithLandingPage(
  token: string,
  propertyId: string,
  req: Omit<Ga4ReportRequest, 'dimensions'> & { extraDimensions?: string[] }
): Promise<Ga4ReportResult & { landingDimension: string }> {
  let lastErr: unknown;
  for (const dim of LANDING_PAGE_DIMENSIONS) {
    try {
      const res = await runGa4Report(token, propertyId, {
        ...req,
        dimensions: [...(req.extraDimensions ?? []), dim],
      });
      return { ...res, landingDimension: dim };
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 400) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('GA4 落點頁維度兩個名字都不被接受');
}

// ---------------------------------------------------------------- Admin API

export interface Ga4PropertySummary {
  /** "properties/123456789" */
  property: string;
  /** "123456789" */
  propertyId: string;
  displayName: string;
  account?: string;
}

interface RawAccountSummaries {
  accountSummaries?: Array<{
    account?: string;
    displayName?: string;
    propertySummaries?: Array<{ property?: string; displayName?: string }>;
  }>;
  nextPageToken?: string;
}

export async function listGa4Properties(token: string): Promise<Ga4PropertySummary[]> {
  const out: Ga4PropertySummary[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ pageSize: '200' });
    if (pageToken) qs.set('pageToken', pageToken);
    const json = await googleFetchJson<RawAccountSummaries>(
      `${ADMIN_BASE}/accountSummaries?${qs.toString()}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    for (const acc of json.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        if (!p.property) continue;
        out.push({
          property: p.property,
          propertyId: p.property.replace(/^properties\//, ''),
          displayName: p.displayName ?? p.property,
          account: acc.displayName ?? acc.account,
        });
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

interface RawDataStreams {
  dataStreams?: Array<{
    name?: string;
    displayName?: string;
    webStreamData?: { measurementId?: string; defaultUri?: string };
  }>;
}

/** 一個 property 底下所有 web 資料串流的 measurement id（G-XXXX）。 */
export async function listMeasurementIds(token: string, propertyId: string): Promise<string[]> {
  const json = await googleFetchJson<RawDataStreams>(
    `${ADMIN_BASE}/properties/${encodeURIComponent(propertyId)}/dataStreams?pageSize=200`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  return (json.dataStreams ?? [])
    .map((s) => s.webStreamData?.measurementId)
    .filter((m): m is string => Boolean(m));
}

/**
 * measurement id（registry 裡有的那個 G-XXXX）→ property id（Data API 要的那個純數字）。
 *
 * 這一步存在是因為 registry 記的是網頁上貼的那顆 G-XXXX，而 Data API 只認 property id，
 * 兩者沒有任何字面關係、也沒有直接查表的 endpoint —— 只能列出所有 property 再逐個問
 * 它的資料串流。所以結果會被呼叫端記在報表裡，讓人一次貼回 registry 的
 * `analytics.ga4Property`，之後就不必再走這條（每次省 1 + N 次 API）。
 */
export async function mapMeasurementIdsToProperties(
  token: string,
  wanted: Set<string>
): Promise<Map<string, Ga4PropertySummary>> {
  const found = new Map<string, Ga4PropertySummary>();
  const properties = await listGa4Properties(token);
  for (const p of properties) {
    if (found.size === wanted.size) break;
    let ids: string[];
    try {
      ids = await listMeasurementIds(token, p.propertyId);
    } catch {
      // 單一 property 讀不到資料串流（權限只給了部分 property）不該讓整批對照失敗。
      continue;
    }
    for (const id of ids) {
      if (wanted.has(id) && !found.has(id)) found.set(id, p);
    }
  }
  return found;
}

export { GoogleCredentialsError, type ServiceAccount };
