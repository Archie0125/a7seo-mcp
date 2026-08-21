/**
 * Bing Webmaster Tools 讀取層。
 *
 * 為什麼值得接：Bing 的 CTR 通常明顯高於 Google，因為 Copilot 把答案版位擺在
 * SERP 上的位置不同。五站在 Bing 都已驗證（registry 的 _bing_note 記著 2026-07-18
 * 的實查與三站補交 sitemap），但從來沒有人看過那邊的數字 —— 只看 GSC 等於預設
 * 「Google 以外的都可以忽略」，而本輪 GSC 實測已經證明 Google 那邊的天花板很低。
 *
 * 認證：query string `?apikey=<key>`。到 https://www.bing.com/webmasters →
 * 設定 → API 存取 → 產生 API 金鑰。**一把金鑰涵蓋這個帳號底下所有網站**，
 * 所以五站共用一把，不必一站一把。
 *
 * 回應格式是 OData 信封：{ "d": <payload> }。
 *
 * 兩個實戰踩過的坑（來自另一個專案的 analytics SOP，直接擋在這裡）：
 *   1. 日期是 `/Date(1779260400000-0700)/` 這種格式 —— 只抓 `\d+` 的 regex 會被
 *      後面那個時區位移噴掉，整批資料靜靜地變成「不在區間內」。
 *   2. `GetPageStats` 回來的列**仍然用 `Query` 當 key**（Page endpoint 直接沿用
 *      Query 的列 schema）。照文件寫 `row.Page` 會拿到 undefined，然後整張頁面表
 *      變成一堆 "undefined" —— 不會報錯，只會空掉。
 */

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const HTTP_TIMEOUT_MS = 45_000;

export class BingCredentialsError extends Error {
  constructor(
    message: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = 'BingCredentialsError';
  }
}

export class BingApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'BingApiError';
  }
}

/**
 * `/Date(1779260400000-0700)/` → `2026-05-20`。
 *
 * 那個位移是**顯示用的時區標註**，前面的毫秒數已經是 UTC epoch。Bing 給的是當地
 * 午夜，換算成 UTC 會落在同一天的 07:00 前後，所以直接取 UTC 的日期是對的。
 * 認不出格式時原樣回傳（不是回今天，也不是回空字串 —— 兩者都會讓壞掉的資料混進
 * 統計而不被發現）。
 */
export function parseBingDate(s: string): string {
  const m = /\/Date\((-?\d+)/.exec(s ?? '');
  if (!m || !m[1]) return s ?? '';
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return s;
  return new Date(ms).toISOString().slice(0, 10);
}

export function loadBingApiKey(explicit?: string): string {
  const key = explicit || process.env.A7_BING_API_KEY || process.env.BING_WMT_API_KEY;
  if (!key) {
    throw new BingCredentialsError(
      '沒有設定 Bing Webmaster API 金鑰',
      '設 A7_BING_API_KEY=<金鑰>。到 https://www.bing.com/webmasters → 設定 → API 存取 → 產生 API 金鑰；一把金鑰涵蓋帳號底下所有網站。見 docs/gsc-setup.md 的 Bing 那節。'
    );
  }
  return key;
}

export async function bingGet<T>(
  method: string,
  params: Record<string, string>,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/${method}?${qs}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new BingApiError(
        `Bing WMT ${method} HTTP ${res.status}`,
        res.status,
        text.slice(0, 500)
      );
    }
    const body = JSON.parse(text) as { d: T };
    return body.d;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 列型別

export interface BingTrafficRow {
  Date: string;
  Clicks: number;
  Impressions: number;
  Position?: number;
}

export interface BingCrawlRow {
  Date: string;
  CrawlErrors?: number;
  CrawledPages?: number;
  HttpStatus2xx?: number;
  HttpStatus4xx?: number;
  HttpStatus5xx?: number;
  InLinks?: number;
  InIndex?: number;
}

/**
 * Query 與 Page 兩種列的共同形狀。`Page` 刻意是 optional —— 見檔頭第 2 個坑，
 * `GetPageStats` 實際上是把 URL 塞在 `Query` 欄裡回來的。
 */
export interface BingStatRow {
  Query?: string;
  Page?: string;
  Clicks: number;
  Impressions: number;
  AvgClickPosition?: number;
  AvgImpressionPosition?: number;
}

/**
 * 從 `GetPageStats` 的列取出頁面 URL，並回報實際是從哪個欄位拿到的。
 *
 * 回報用到哪個欄位不是龜毛：哪天 Microsoft 真的把 schema 修成 `Page`，我們會在
 * 報表上看到欄位名變了，而不是某天資料靜靜地全空。
 */
export function pageOf(row: BingStatRow): { url: string; keyUsed: 'Page' | 'Query' | 'none' } {
  if (typeof row.Page === 'string' && row.Page) return { url: row.Page, keyUsed: 'Page' };
  if (typeof row.Query === 'string' && row.Query) return { url: row.Query, keyUsed: 'Query' };
  return { url: '', keyUsed: 'none' };
}

/** 日期字串（Bing 格式或已解析的 YYYY-MM-DD）落在 [start, end] 內嗎。 */
export function inRange(rawDate: string, start: string, end: string): boolean {
  const d = parseBingDate(rawDate);
  return d >= start && d <= end;
}
