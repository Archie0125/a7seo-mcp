/**
 * Google service-account 認證的共用底層（JWT bearer flow）。
 *
 * 為什麼抽出來：GSC 與 GA4 用的是**同一顆 service account 金鑰**，只是換 token 時
 * 要的 scope 不同（webmasters.readonly vs analytics.readonly）。第一版把簽章與讀檔
 * 寫在 gsc.ts 裡是對的（當時只有一個消費者），現在有第二個就該抽——不抽的下場是
 * 兩份幾乎一樣的 JWT 程式各自漂，而「私鑰換行被存成字面反斜線」這種坑要修兩次。
 *
 * 一樣零新依賴：node:crypto 十行就簽得出 RS256，不值得為此拉進整個 googleapis。
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const HTTP_TIMEOUT_MS = 45_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

/**
 * 憑證缺席／格式錯誤。刻意與 GoogleApiError 分開：這種不是「壞了」而是「還沒設定」，
 * CLI 對它印指引而不是 stack trace，而且不該讓每週報表紅燈。
 */
export class GoogleCredentialsError extends Error {
  constructor(
    message: string,
    public readonly hint: string
  ) {
    super(message);
    this.name = 'GoogleCredentialsError';
  }
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/**
 * 讀 service account JSON。
 *
 * 順序：明確參數 > A7_GOOGLE_CREDENTIALS > A7_GSC_CREDENTIALS（檔案路徑）
 * > A7_GOOGLE_CREDENTIALS_JSON > A7_GSC_CREDENTIALS_JSON（整包 JSON，給 CI 用）。
 *
 * 兩組名字並存不是為了向後相容好看：A7_GSC_* 已經寫進 docs、寫進 a7-sites 的
 * GitHub secret，改名等於要用戶重設一次 secret 換零好處。A7_GOOGLE_* 是給後來
 * 才加進來的 GA4 用的——同一顆金鑰同時要餵兩個 API，繼續叫它「GSC 憑證」會讓
 * 下一個人以為要再建一顆。
 */
export function loadServiceAccount(explicitPath?: string): ServiceAccount {
  const path =
    explicitPath || process.env.A7_GOOGLE_CREDENTIALS || process.env.A7_GSC_CREDENTIALS;
  const inline =
    process.env.A7_GOOGLE_CREDENTIALS_JSON || process.env.A7_GSC_CREDENTIALS_JSON;

  let raw: string;
  let origin: string;
  if (path) {
    origin = path;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new GoogleCredentialsError(
        `讀不到 service account 金鑰檔：${path}（${(err as Error).message}）`,
        'A7_GSC_CREDENTIALS（或 A7_GOOGLE_CREDENTIALS）要指向下載下來的 JSON 金鑰檔絕對路徑。步驟見 docs/gsc-setup.md。'
      );
    }
  } else if (inline) {
    origin = 'A7_GOOGLE_CREDENTIALS_JSON / A7_GSC_CREDENTIALS_JSON';
    raw = inline;
  } else {
    throw new GoogleCredentialsError(
      '沒有設定 Google service account 憑證',
      '設 A7_GSC_CREDENTIALS=<service account JSON 金鑰檔路徑>，或 CI 上設 A7_GSC_CREDENTIALS_JSON=<整包 JSON>。同一顆金鑰同時給 GSC 與 GA4 用。完整步驟見 docs/gsc-setup.md。'
    );
  }

  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch (err) {
    throw new GoogleCredentialsError(
      `${origin} 不是合法 JSON（${(err as Error).message}）`,
      '要用 GCP「建立金鑰 → JSON」下載的那個檔，不要貼成 base64 或 PEM。'
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new GoogleCredentialsError(
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

function mintAssertion(sa: ServiceAccount, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri || DEFAULT_TOKEN_URI,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

export async function googleFetchJson<T>(
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
      throw new GoogleApiError(
        `Google API ${res.status} ${res.statusText} — ${url.replace(/\?.*$/, '')}`,
        res.status,
        text.slice(0, 800)
      );
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 換 access token。token 一小時有效，一次執行同一個 scope 用同一顆就夠。
 *
 * apiLabel 只影響錯誤訊息：同樣是 `invalid_scope`，GSC 缺的是 Search Console API、
 * GA4 缺的是 Analytics Data API，指錯地方會讓人在 GCP Console 上白找十分鐘。
 */
export async function getGoogleAccessToken(
  sa: ServiceAccount,
  scope: string,
  apiLabel = 'Google API'
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: mintAssertion(sa, scope),
  });
  try {
    const json = await googleFetchJson<{ access_token: string; expires_in: number }>(
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
      err instanceof GoogleApiError &&
      err.status === 400 &&
      /invalid_scope|unauthorized_client|access_denied/.test(err.body)
    ) {
      throw new GoogleCredentialsError(
        `拿 access token 被拒：${err.body}`,
        `GCP 專案多半沒有啟用 ${apiLabel}。GCP Console → APIs & Services → Library → 搜 "${apiLabel}" → Enable。見 docs/gsc-setup.md。`
      );
    }
    throw err;
  }
}
