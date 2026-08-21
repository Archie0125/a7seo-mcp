/**
 * 四層匯流週報。
 *
 * 每一層各自回答一個別層答不了的問題，缺一層就有一整類故障看不見：
 *
 *   D1（鮮度哨兵，a7-sites）  資料還在進來嗎？          ← ETL 靜默失敗
 *   HTTP（portfolio）         頁面活著、追蹤碼在嗎？    ← 部署／設定壞掉
 *   搜尋（GSC + Bing）        有人在搜嗎、搜哪個頁型？  ← 做了很多沒人要的東西
 *   AI（GA4 referral）        AI 在引用我們的哪一種頁？ ← 新的需求結構
 *
 * 為什麼一定要合成一份：2026-08 真的發生過「總表全綠、實際已掛五週」——portfolio
 * 說五站全綠的同時 food 的 goods-weekly 連掛 5 週，因為那是 D1 層的事，而沒有人
 * 把兩層擺在一起看。第三層（GSC）在 phase 1 接上了，這一輪補的是「Google 以外」：
 * Bing 與 AI 搜尋。四層分開跑就會重演同一個故障模式，只是換一組層。
 *
 * D1 那層留在 a7-sites（它要 wrangler 與 Cloudflare token，跟這個 repo 無關），
 * 用 --d1 <檔案> 併進來。合成器只有一個，CI 與本機跑的是同一支 —— 兩份實作的
 * 下場就是報表在 CI 上長一個樣、在本機長另一個樣。
 *
 * 這份報表**永遠是綠的**：紅燈是哨兵的工作（只在真的壞掉時寄信），週報是每週都
 * 要讀的表。任何一層跑失敗會如實寫進報表，不是靜靜消失。
 */
import { readFileSync } from 'node:fs';
import { runBingReport, formatBingReport, type BingReport } from './bing-report.js';
import { runGa4WeeklyReport, formatGa4Report, type Ga4Report } from './ga4-report.js';
import { runGscReport, formatGscReport, type GscReport } from './gsc-report.js';
import { runPortfolioHealth, formatPortfolioTable, type PortfolioReport } from './portfolio.js';
import { num, pct } from './report-format.js';

export interface WeeklyLayer<T> {
  ok: boolean;
  text: string;
  data?: T;
  error?: string;
}

export interface WeeklyReport {
  title: string;
  markdown: string;
  layers: {
    d1: WeeklyLayer<never>;
    http: WeeklyLayer<PortfolioReport>;
    gsc: WeeklyLayer<GscReport>;
    bing: WeeklyLayer<BingReport>;
    ga4: WeeklyLayer<Ga4Report>;
  };
}

export interface WeeklyOptions {
  days?: number;
  inspectPerType?: number;
  onlySites?: string[];
  credentialsPath?: string;
  bingApiKey?: string;
  /** D1 鮮度那層的輸出檔（a7-sites 的 tools/check-freshness.mjs 產的）。 */
  d1File?: string;
  /** 跳過某幾層（給只想重跑一層的人用）。 */
  skip?: Array<'http' | 'gsc' | 'bing' | 'ga4'>;
}

async function layer<T>(
  name: string,
  skip: boolean,
  run: () => Promise<{ text: string; data: T }>
): Promise<WeeklyLayer<T>> {
  if (skip) return { ok: true, text: `（--skip ${name}，這一層這次沒跑）` };
  try {
    const { text, data } = await run();
    return { ok: true, text, data };
  } catch (err) {
    // 一層炸掉不該讓整份報表消失 —— 那正是我們要消滅的靜默失敗。
    return { ok: false, text: `（這一層失敗了：${(err as Error).message}）`, error: (err as Error).message };
  }
}

function twDate(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export async function runWeeklyReport(
  registryPathArg?: string,
  options: WeeklyOptions = {}
): Promise<WeeklyReport> {
  const { days = 28, inspectPerType = 0, onlySites, credentialsPath, bingApiKey, d1File } = options;
  const skip = new Set(options.skip ?? []);

  let d1: WeeklyLayer<never>;
  if (!d1File) {
    d1 = {
      ok: true,
      text: '（沒有帶 --d1 <檔案>；D1 鮮度那層住在 a7-sites，由 tools/check-freshness.mjs 產出）',
    };
  } else {
    try {
      d1 = { ok: true, text: readFileSync(d1File, 'utf8').trimEnd() };
    } catch (err) {
      d1 = { ok: false, text: `（讀不到 ${d1File}：${(err as Error).message}）`, error: (err as Error).message };
    }
  }

  // 四層各打各的外部服務，彼此無依賴 —— 並行跑，週報從四段序列時間變成最慢那一段。
  const [http, gsc, bing, ga4] = await Promise.all([
    layer('http', skip.has('http'), async () => {
      const data = await runPortfolioHealth(registryPathArg, {});
      return { text: formatPortfolioTable(data), data };
    }),
    layer('gsc', skip.has('gsc'), async () => {
      const data = await runGscReport(registryPathArg, { days, inspectPerType, onlySites, credentialsPath });
      return { text: formatGscReport(data), data };
    }),
    layer('bing', skip.has('bing'), async () => {
      const data = await runBingReport(registryPathArg, { days, onlySites, apiKey: bingApiKey });
      return { text: formatBingReport(data), data };
    }),
    layer('ga4', skip.has('ga4'), async () => {
      const data = await runGa4WeeklyReport(registryPathArg, { days, onlySites, credentialsPath });
      return { text: formatGa4Report(data), data };
    }),
  ]);

  const layers = { d1, http, gsc, bing, ga4 };

  // --- 標題：一眼看得出「這週要不要點進來」
  const httpRed = http.data?.totals.red;
  const d1Line = /^結果：.*$/m.exec(d1.text)?.[0] ?? '';
  const d1Fail = /(\d+)\s*FAIL/.exec(d1Line)?.[1];
  // 憑證沒設好時一律印 — 而不是 0。印 0 會讓「還沒問到」跟「問過了、真的是 0」
  // 長得一模一樣，而標題正是唯一會被掃過一眼的地方 —— 在這裡混淆兩者最傷。
  const gscClicks = gsc.data?.credentials.configured ? gsc.data.totals.clicks : undefined;
  const bingClicks = bing.data?.credentials.configured ? bing.data.totals.clicks : undefined;
  const aiSessions = ga4.data?.credentials.configured ? ga4.data.aiTotals.sessions : undefined;
  const bits = [
    `站群週報 ${twDate()}`,
    d1Fail !== undefined ? `D1 ${d1Fail}紅` : 'D1 —',
    httpRed !== undefined ? `HTTP ${httpRed}紅` : 'HTTP —',
    gscClicks !== undefined ? `Google ${num(gscClicks)} 點擊` : 'Google —',
    bingClicks !== undefined ? `Bing ${num(bingClicks)} 點擊` : 'Bing —',
    aiSessions !== undefined ? `AI ${num(aiSessions)} 階段` : 'AI —',
  ];
  const title = bits.join('｜');

  // --- 四層一句話摘要表
  const summary: string[] = [];
  summary.push('| 層 | 問的問題 | 這次 |');
  summary.push('|---|---|---|');
  summary.push(`| D1（鮮度哨兵） | 資料還在進來嗎 | ${d1Line.replace(/^結果：/, '') || '（見下方）'} |`);
  summary.push(
    `| HTTP（portfolio） | 頁面活著、追蹤碼在嗎 | ${
      http.data
        ? `🟢${http.data.totals.green} 🟡${http.data.totals.yellow} 🔴${http.data.totals.red}`
        : http.text.replace(/^（|）$/g, '')
    } |`
  );
  // 沒跑（--skip）與跑了但沒憑證是兩件事，摘要欄要分得出來 —— 兩者都印同一句
  // 「未就緒」的話，這張表就開始說謊了。
  const cell = (l: WeeklyLayer<unknown>, ready: boolean, ok: string, notReady: string): string =>
    !l.data ? l.text.replace(/^（|）$/g, '') : ready ? ok : notReady;
  summary.push(
    `| 搜尋 · Google（GSC） | 有人在搜嗎、搜哪個頁型 | ${cell(
      gsc,
      Boolean(gsc.data?.credentials.configured),
      gsc.data
        ? `${num(gsc.data.totals.clicks)} 點擊 / ${num(gsc.data.totals.impressions)} 曝光 / CTR ${pct(gsc.data.totals.ctr)}`
        : '',
      '憑證未就緒（只有 sitemap 那半張表）'
    )} |`
  );
  summary.push(
    `| 搜尋 · Bing | Google 以外還有沒有人搜 | ${cell(
      bing,
      Boolean(bing.data?.credentials.configured),
      bing.data
        ? `${num(bing.data.totals.clicks)} 點擊 / ${num(bing.data.totals.impressions)} 曝光 / CTR ${pct(bing.data.totals.ctr)}`
        : '',
      '金鑰未就緒'
    )} |`
  );
  summary.push(
    `| AI 搜尋（GA4 referral） | AI 在引用我們的哪一種頁 | ${cell(
      ga4,
      Boolean(ga4.data?.credentials.configured),
      ga4.data
        ? `${num(ga4.data.aiTotals.sessions)} 個 AI 工作階段（全站 ${num(ga4.data.totals.sessions)}）`
        : '',
      '憑證未就緒'
    )} |`
  );

  const md: string[] = [];
  md.push('四層一起看。單看任何一層都會漏掉一整類故障：D1 綠不代表頁面活著，HTTP 綠不代表');
  md.push('資料還在進來，兩者都綠也不代表有人在搜，而 Google 沒人搜不代表 AI 沒在引用。');
  md.push('');
  md.push(...summary);
  md.push('');
  const section = (heading: string, l: WeeklyLayer<unknown>): void => {
    md.push(`## ${heading}${l.ok ? '' : ' ✖'}`);
    md.push('');
    md.push('```');
    md.push(l.text);
    md.push('```');
    md.push('');
  };
  section('AI 搜尋 — GA4 referral', ga4);
  section('搜尋 · Google — GSC 頁型分群', gsc);
  section('搜尋 · Bing', bing);
  section('D1 層 — 資料鮮度', d1);
  section('HTTP 層 — portfolio 健康總表', http);
  md.push('---');
  md.push('本報表**永遠是綠的**：紅燈是哨兵的工作（只在真的壞掉時寄信）。');
  md.push('閾值與理由：`registry/freshness.json`｜頁型 pattern：`registry/sites.json` 的 `pageTypes`');
  md.push('Clarity 摩擦點刻意不在這裡：配額是每站每天 10 次、單次最多 3 天，視窗跟這份的 28 天');
  md.push('對不起來。要看就按需跑 `a7seo clarity`。');

  return { title, markdown: md.join('\n'), layers };
}
