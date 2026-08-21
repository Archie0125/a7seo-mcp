/**
 * Google Search Console 讀取層（service account / server-to-server）。
 *
 * 為什麼不裝 googleapis：這裡只用到三個 endpoint，而 googleapis 是整個 Google API
 * surface。service account 的 JWT bearer flow 用 node:crypto 就做得完（見
 * google-auth.ts），零新依賴 —— 這個 repo 會被 CI 每週 npm ci，依賴越小跑越快、
 * 越少東西會壞。
 *
 * 為什麼是 service account 而不是 OAuth user flow：這層存在的理由就是「每週自動
 * 一張表」。OAuth user flow 要有人開瀏覽器點同意、refresh token 還會過期，等於
 * 把我們正要消滅的那個手動步驟換個地方留著。
 *
 * API 文件：
 *   https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 *   https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
 *
 * 已知的 API 天花板（不是實作限制，是 Google 沒開）：GSC UI 那張「索引涵蓋範圍」
 * 的全站計數（已索引／已檢索-未索引／已找到-未爬）沒有任何 API 吐得出來。API 只有
 * urlInspection，一次一個 URL。所以本模組的涵蓋率是**抽樣估計**（gsc-report.ts 的
 * inspect 模式），報表會標示得清清楚楚，不會假裝成 UI 的那個數字。
 */
import {
  getGoogleAccessToken,
  googleFetchJson as fetchJson,
  GoogleApiError,
  GoogleCredentialsError,
  loadServiceAccount,
  type ServiceAccount,
} from './google-auth.js';

/**
 * 認證那一層搬去 google-auth.ts 了（GA4 用同一顆金鑰、不同 scope）。這裡把名字
 * 原樣再匯出，因為 docs、測試、gsc-report.ts 都是照 Gsc* 這組名字寫的，改名換
 * 不到任何好處。
 */
export {
  loadServiceAccount,
  GoogleCredentialsError as GscCredentialsError,
  GoogleApiError as GscApiError,
  type ServiceAccount,
};

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/** searchAnalytics 單次請求的最大列數（Google 硬上限 25,000）。 */
export const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;

/** 換 access token（GSC scope）。token 一小時有效，一次執行用同一顆就夠。 */
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  return getGoogleAccessToken(sa, GSC_SCOPE, 'Google Search Console API');
}

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
}

/** service account 看得到的 property 清單。空清單＝金鑰有效但沒被加進任何 property。 */
export async function listProperties(token: string): Promise<GscProperty[]> {
  const json = await fetchJson<{ siteEntry?: GscProperty[] }>(`${WEBMASTERS_BASE}/sites`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return json.siteEntry ?? [];
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  /** final = 只要定稿資料（不含最近幾天還會變動的 fresh data）。週報要可重現就用它。 */
  dataState?: 'final' | 'all';
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
}

export async function querySearchAnalytics(
  token: string,
  property: string,
  query: SearchAnalyticsQuery
): Promise<SearchAnalyticsRow[]> {
  const url = `${WEBMASTERS_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const json = await fetchJson<{ rows?: SearchAnalyticsRow[] }>(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dataState: 'final', type: 'web', ...query }),
  });
  return json.rows ?? [];
}

/**
 * 把 page 維度整包翻完（單次上限 25,000 列）。
 *
 * maxRows 是安全閥不是效能調校：factory 有 24.5 萬個 URL，全翻要打十次 API。
 * 但**有曝光的頁**遠少於總頁數（那正是頁型分群要量的東西），實務上一兩次就翻完。
 * 翻到上限會回報 truncated 並在報表標出來 —— 不標的話「頁型曝光」會靜靜地少算，
 * 而那正是下一輪拿來決定砍哪些頁型的數字。
 */
export async function queryAllPages(
  token: string,
  property: string,
  range: { startDate: string; endDate: string },
  maxRows = 100_000
): Promise<{ rows: SearchAnalyticsRow[]; truncated: boolean }> {
  const out: SearchAnalyticsRow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += SEARCH_ANALYTICS_ROW_LIMIT) {
    const rowLimit = Math.min(SEARCH_ANALYTICS_ROW_LIMIT, maxRows - startRow);
    const rows = await querySearchAnalytics(token, property, {
      ...range,
      dimensions: ['page'],
      rowLimit,
      startRow,
    });
    out.push(...rows);
    if (rows.length < rowLimit) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

export interface UrlInspection {
  url: string;
  verdict: string;
  coverageState: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  error?: string;
}

interface InspectResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
    };
  };
}

/**
 * 單一 URL 的索引狀態。配額：每 property 每天 2,000 次、每分鐘 600 次（Google
 * 明文限制），所以呼叫端一定要抽樣，不能全掃。
 */
export async function inspectUrl(
  token: string,
  property: string,
  inspectionUrl: string
): Promise<UrlInspection> {
  try {
    const json = await fetchJson<InspectResponse>(INSPECT_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ inspectionUrl, siteUrl: property, languageCode: 'zh-TW' }),
    });
    const r = json.inspectionResult?.indexStatusResult ?? {};
    return {
      url: inspectionUrl,
      verdict: r.verdict ?? 'UNKNOWN',
      coverageState: r.coverageState ?? '(no coverageState)',
      robotsTxtState: r.robotsTxtState,
      indexingState: r.indexingState,
      lastCrawlTime: r.lastCrawlTime,
    };
  } catch (err) {
    // 單一 URL 失敗（配額用完、暫時 5xx）不該讓整份報表爆掉；記下來讓報表如實呈現。
    return {
      url: inspectionUrl,
      verdict: 'ERROR',
      coverageState: '(inspect failed)',
      error: (err as Error).message.slice(0, 200),
    };
  }
}
