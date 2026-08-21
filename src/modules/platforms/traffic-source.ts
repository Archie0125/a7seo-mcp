/**
 * 把 GA4 的 sessionSource / sessionMedium 分組，重點是把「AI 搜尋」獨立成一組。
 *
 * 為什麼要獨立一組：GA4 的預設管道分組（sessionDefaultChannelGroup）把
 * chatgpt.com、perplexity.ai 這些全部丟進 Referral，跟部落格外連、跟自家姊妹站
 * 連結混在同一桶。那一桶對這五站來說沒有意義，而「AI 引用我們」正好是本輪唯一
 * 一條數據還沒攤開的假設 —— 混在 Referral 裡等於永遠量不到。
 *
 * 這份清單住在程式裡不住 registry：它是「AI 搜尋生態長什麼樣」的事實，五站共用、
 * 跟哪個站無關。registry 放的是「這個站長什麼樣子」（pageTypes、minShards）。
 */

/** AI 搜尋／助理來源。key = 正規化後的 host，值 = 報表上的顯示名。 */
export const AI_SOURCE_HOSTS: Record<string, string> = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'openai.com': 'ChatGPT',
  'perplexity.ai': 'Perplexity',
  'claude.ai': 'Claude',
  'copilot.microsoft.com': 'Copilot',
  'copilot.cloud.microsoft': 'Copilot',
  'gemini.google.com': 'Gemini',
  'bard.google.com': 'Gemini',
  'you.com': 'You.com',
  'phind.com': 'Phind',
};

/** 報表固定用這個順序列 AI 來源，讓週與週之間欄位位置穩定、好對照。 */
export const AI_ENGINE_ORDER = [
  'ChatGPT',
  'Perplexity',
  'Copilot',
  'Gemini',
  'Claude',
  'You.com',
  'Phind',
] as const;

const SEARCH_ENGINE_HINTS = [
  'google',
  'bing',
  'yahoo',
  'duckduckgo',
  'yandex',
  'baidu',
  'ecosia',
  'naver',
  'brave',
];

const SOCIAL_HINTS = [
  'facebook',
  'instagram',
  'threads',
  'twitter',
  'x.com',
  't.co',
  'line.me',
  'linkedin',
  'youtube',
  'dcard',
  'ptt',
  'reddit',
  'tiktok',
];

export type SourceGroup = 'ai' | 'search' | 'social' | 'direct' | 'referral' | 'unset';

export interface SourceClassification {
  group: SourceGroup;
  /** group === 'ai' 時的引擎顯示名。 */
  engine?: string;
  /** 非空 = 這個 source 值本身看起來就不對，報表要單獨列出來而不是混進統計。 */
  suspicious?: string;
}

/** 去掉 scheme / www. / path / 大小寫，讓 "https://www.Perplexity.ai/" 與 "perplexity.ai" 對得上。 */
export function normalizeSource(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/^www\./, '');
  return s;
}

function matchesHost(host: string, key: string): boolean {
  return host === key || host.endsWith(`.${key}`);
}

/**
 * GA4 的 source/medium 是保留參數名：自訂事件如果送了同名參數，會**覆蓋**
 * sessionSource，於是報表上會冒出根本不是流量來源的值（另一個專案實際看過
 * `package_card`、`127.0.0.1:8000`）。這種值混進統計不會報錯，只會讓數字慢慢
 * 失真，所以在這裡先攔下來、單獨列一欄，而不是讓它安靜地變成一個「來源」。
 *
 * selfHosts = 本站自己的網域，自我參照不是外部來源（多半是跨子網域或錨點跳轉）。
 */
export function classifySource(
  source: string,
  medium?: string,
  selfHosts: string[] = []
): SourceClassification {
  const raw = (source ?? '').trim();
  const host = normalizeSource(raw);
  const med = (medium ?? '').trim().toLowerCase();

  if (!host || host === '(not set)') {
    return { group: 'unset', suspicious: 'source 是 (not set)／空字串' };
  }
  if (host === '(direct)' || host === 'direct') return { group: 'direct' };

  // --- 可疑值：形狀就不像流量來源
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { group: 'referral', suspicious: '本機／內網位址 —— 開發流量打到正式 measurement id 了' };
  }
  if (/\s/.test(raw)) {
    return { group: 'referral', suspicious: 'source 含空白 —— 幾乎一定是事件參數覆蓋了 sessionSource' };
  }
  if (raw.includes('_')) {
    return {
      group: 'referral',
      suspicious:
        'source 含底線 —— GA4 的 source/medium/campaign 是保留參數名，自訂事件送同名參數會覆蓋它',
    };
  }

  for (const self of selfHosts) {
    const s = normalizeSource(self);
    if (s && matchesHost(host, s)) {
      return { group: 'referral', suspicious: '自我參照（本站網域），不是外部來源' };
    }
  }

  for (const [key, engine] of Object.entries(AI_SOURCE_HOSTS)) {
    if (matchesHost(host, key)) return { group: 'ai', engine };
  }

  if (med === 'organic' || SEARCH_ENGINE_HINTS.some((h) => host.split('.')[0] === h || matchesHost(host, `${h}.com`))) {
    return { group: 'search' };
  }
  if (SOCIAL_HINTS.some((h) => matchesHost(host, h) || host.split('.')[0] === h)) {
    return { group: 'social' };
  }
  return { group: 'referral' };
}

/** 只在乎「是不是 AI」的呼叫端用這支，省得每次解構。 */
export function aiEngineOf(source: string, medium?: string, selfHosts: string[] = []): string | null {
  const c = classifySource(source, medium, selfHosts);
  return c.group === 'ai' && !c.suspicious ? (c.engine ?? null) : null;
}
