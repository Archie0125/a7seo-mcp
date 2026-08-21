/**
 * Microsoft Clarity 摩擦點（dead click / rage click / quickback）。
 *
 * 五站都裝了 Clarity（registry 的 analytics.clarity 記著各站 project id），資料收了
 * 好幾個月，一次都沒被看過。這一層把它接起來 —— 但**刻意不進每週報表的預設路徑**。
 *
 * 理由是配額：Clarity 的 Data Export API 是 **每個 project 每天 10 次呼叫、單次最多
 * 3 天**。五站 × 三個維度就是 15 次，已經超過單站配額的用法上限，而且 3 天的視窗
 * 跟週報的 28 天對不起來。硬塞進週報只會每週把配額燒光、還拿到一段跟其他三層無法
 * 對照的資料。所以做成獨立指令，按需呼叫。
 *
 * ⚠️ 這個模組是**照文件寫的、尚未對線上 API 實跑過**（本機沒有任何一站的 Clarity
 * API token）。回應的欄位名在文件與實務之間有出入，所以解析刻意寫得寬容：維度值
 * 認一組已知的維度欄名，數值依序找 subTotal → totalSessionCount → 第一個數字欄。
 * 認不出來的時候回報「認不出來」而不是回 0 —— 第一次真的拿到 token 時，先跑
 * `--json` 看原始回應，再決定要不要收緊。
 *
 * API 文件：https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export
 */

const CLARITY_ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const HTTP_TIMEOUT_MS = 45_000;

/** 官方硬限制，寫成常數是為了讓「為什麼不進週報」這件事在程式裡也看得到。 */
export const CLARITY_MAX_CALLS_PER_DAY = 10;
export const CLARITY_MAX_DAYS = 3;

export const CLARITY_DIMENSIONS = [
  'URL',
  'Source',
  'Medium',
  'Campaign',
  'Browser',
  'Device',
  'OS',
  'Country',
] as const;
export type ClarityDimension = (typeof CLARITY_DIMENSIONS)[number];

/** 回應裡哪些欄位是維度（其餘都是數值）。比列舉數值欄名穩：數值欄每個 metric 都不同。 */
const DIMENSION_KEYS = new Set(
  ['url', 'source', 'medium', 'campaign', 'browser', 'device', 'os', 'country', 'page'].map((s) => s)
);

/** 取數值時的優先序。subTotal 是該 metric 的實際次數，最貼近「發生了幾次」。 */
const VALUE_KEYS = [
  'subTotal',
  'totalSessionCount',
  'sessionsWithMetricPercentage',
  'averageScrollDepth',
  'distinctUserCount',
];

export class ClarityCredentialsError extends Error {
  constructor(
    message: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = 'ClarityCredentialsError';
  }
}

/**
 * 一站一顆 token（Clarity 的 token 綁 project，不是綁帳號）。
 * 找法：A7_CLARITY_TOKENS（JSON 物件 {registryId: token}）> A7_CLARITY_TOKEN_<ID 大寫>。
 */
export function loadClarityToken(siteId: string, explicit?: string): string {
  if (explicit) return explicit;
  const bundle = process.env.A7_CLARITY_TOKENS;
  if (bundle) {
    try {
      const map = JSON.parse(bundle) as Record<string, string>;
      if (map[siteId]) return map[siteId] as string;
    } catch {
      throw new ClarityCredentialsError(
        'A7_CLARITY_TOKENS 不是合法 JSON',
        '格式是 {"xiuchequ":"<token>","food":"<token>"}，key 用 registry 的站 id。'
      );
    }
  }
  const perSite = process.env[`A7_CLARITY_TOKEN_${siteId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (perSite) return perSite;
  throw new ClarityCredentialsError(
    `站 ${siteId} 沒有 Clarity API token`,
    'Clarity 後台 → Settings → Data Export → Generate new API token（token 綁 project，一站一顆）。設 A7_CLARITY_TOKENS={"<站 id>":"<token>"} 或 A7_CLARITY_TOKEN_<站 id 大寫>。'
  );
}

export interface ClarityRow {
  /** 維度值（URL 路徑／來源／裝置…）。認不出維度欄時是空字串。 */
  dimension: string;
  value: number;
  /** 原始欄位，供 --json 與「解析對不對」的事後查核。 */
  raw: Record<string, unknown>;
}

export interface ClarityMetric {
  metricName: string;
  rows: ClarityRow[];
  /** true = 這個 metric 的列裡找不到任何已知的數值欄，數字不可信。 */
  unparsed?: boolean;
}

interface RawClarityMetric {
  metricName?: string;
  information?: Array<Record<string, unknown>>;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseClarityResponse(raw: unknown): ClarityMetric[] {
  const arr = Array.isArray(raw) ? (raw as RawClarityMetric[]) : [];
  return arr.map((m) => {
    let unparsed = false;
    const rows: ClarityRow[] = (m.information ?? []).map((info) => {
      let dimension = '';
      for (const [k, v] of Object.entries(info)) {
        if (DIMENSION_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
          dimension = v;
          break;
        }
      }
      let value: number | null = null;
      for (const key of VALUE_KEYS) {
        const n = toNumber(info[key]);
        if (n !== null) {
          value = n;
          break;
        }
      }
      if (value === null) {
        for (const [k, v] of Object.entries(info)) {
          if (DIMENSION_KEYS.has(k.toLowerCase())) continue;
          const n = toNumber(v);
          if (n !== null) {
            value = n;
            break;
          }
        }
      }
      if (value === null) unparsed = true;
      return { dimension, value: value ?? 0, raw: info };
    });
    return { metricName: m.metricName ?? '(unnamed)', rows, ...(unparsed ? { unparsed } : {}) };
  });
}

export async function fetchClarityInsights(
  token: string,
  dimensions: ClarityDimension[],
  numOfDays: number
): Promise<{ metrics: ClarityMetric[]; raw: unknown }> {
  if (numOfDays > CLARITY_MAX_DAYS) {
    throw new Error(
      `Clarity 單次最多 ${CLARITY_MAX_DAYS} 天（要了 ${numOfDays}）。這是官方硬限制，不是這裡的設定。`
    );
  }
  const qs = new URLSearchParams({ numOfDays: String(numOfDays) });
  dimensions.slice(0, 3).forEach((d, i) => qs.set(`dimension${i + 1}`, d));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${CLARITY_ENDPOINT}?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.status === 429) {
      throw new Error(
        `Clarity 配額用完（每個 project 每天 ${CLARITY_MAX_CALLS_PER_DAY} 次）。明天再試，或改用已存下的原始回應。`
      );
    }
    if (!res.ok) throw new Error(`Clarity API HTTP ${res.status}: ${text.slice(0, 300)}`);
    const raw = JSON.parse(text) as unknown;
    return { metrics: parseClarityResponse(raw), raw };
  } finally {
    clearTimeout(timer);
  }
}
