/**
 * Google Search Console 讀取層（service account / server-to-server）。
 *
 * 為什麼不裝 googleapis：這裡只用到三個 endpoint，而 googleapis 是整個 Google API
 * surface。service account 的 JWT bearer flow 用 node:crypto 就做得完（下面
 * mintAssertion 那十行），零新依賴 —— 這個 repo 會被 CI 每週 npm ci，依賴越小
 * 跑越快、越少東西會壞。
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
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const HTTP_TIMEOUT_MS = 45_000;

/** searchAnalytics 單次請求的最大列數（Google 硬上限 25,000）。 */
export const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

/**
 * 憑證缺席／格式錯誤。刻意與 GscApiError 分開：這種不是「壞了」而是「還沒設定」，
 * CLI 對它印指引而不是 stack trace，而且不該讓每週報表紅燈。
 */
export class GscCredentialsError extends Error {
  constructor(
    message: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = 'GscCredentialsError';
  }
}

export class GscApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'GscApiError';
  }
}

/**
 * 讀 service account JSON。順序：明確參數 > A7_GSC_CREDENTIALS（檔案路徑）
 * > A7_GSC_CREDENTIALS_JSON（整包 JSON 字串，給 CI 用 —— GitHub secret 塞不了檔案）。
 */
export function loadServiceAccount(explicitPath?: string): ServiceAccount {
  const path = explicitPath || process.env.A7_GSC_CREDENTIALS;
  const inline = process.env.A7_GSC_CREDENTIALS_JSON;

  let raw: string;
  let origin: string;
  if (path) {
    origin = path;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new GscCredentialsError(
        `讀不到 service account 金鑰檔：${path}（${(err as Error).message}）`,
        'A7_GSC_CREDENTIALS 要指向下載下來的 JSON 金鑰檔絕對路徑。步驟見 docs/gsc-setup.md。'
      );
    }
  } else if (inline) {
    origin = 'A7_GSC_CREDENTIALS_JSON';
    raw = inline;
  } else {
    throw new GscCredentialsError(
      '沒有設定 GSC 憑證',
      '設 A7_GSC_CREDENTIALS=<service account JSON 金鑰檔路徑>，或 CI 上設 A7_GSC_CREDENTIALS_JSON=<整包 JSON>。完整步驟見 docs/gsc-setup.md。'
    );
  }

  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch (err) {
    throw new GscCredentialsError(
      `${origin} 不是合法 JSON（${(err as Error).message}）`,
      '要用 GCP「建立金鑰 → JSON」下載的那個檔，不要貼成 base64 或 PEM。'
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new GscCredentialsError(
      `${origin} 缺 client_email 或 private_key`,
      '確認下載的是 service account 金鑰（type: service_account），不是 OAuth client secret。'
    );
  }

  return {
    client_email: parsed.client_email,
    // GitHub secret 的常見坑：私鑰換行被存成字面上的反斜線 n。這裡還原，否則簽章
    // 失敗時的訊息只會是 "error:1E08010C:DECODER routines::unsupported"，完全看不出根因。
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
    token_uri: parsed.token_uri,
    project_id: parsed.project_id,
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function mintAssertion(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: GSC_SCOPE,
      aud: sa.token_uri || DEFAULT_TOKEN_URI,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = HTTP_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new GscApiError(
        `GSC API ${res.status} ${res.statusText} — ${url.replace(/\?.*$/, '')}`,
        res.status,
        text.slice(0, 800)
      );
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 換 access token。token 一小時有效，一次執行用同一顆就夠，不另做快取層。 */
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: mintAssertion(sa),
  });
  try {
    const json = await fetchJson<{ access_token: string; expires_in: number }>(
      sa.token_uri || DEFAULT_TOKEN_URI,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }
    );
    return json.access_token;
  } catch (err) {
    if (
      err instanceof GscApiError &&
      err.status === 400 &&
      /invalid_scope|unauthorized_client|access_denied/.test(err.body)
    ) {
      throw new GscCredentialsError(
        `拿 access token 被拒：${err.body}`,
        'GCP 專案多半沒有啟用 Google Search Console API。GCP Console → APIs & Services → Library → 搜 "Google Search Console API" → Enable。見 docs/gsc-setup.md。'
      );
    }
    throw err;
  }
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
