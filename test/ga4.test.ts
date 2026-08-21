import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidMetrics,
  runGa4Report,
  runGa4ReportWithLandingPage,
  Ga4MetricError,
} from '../src/modules/platforms/ga4.js';
import { formatGa4Report, runGa4WeeklyReport } from '../src/modules/platforms/ga4-report.js';
import {
  aiEngineOf,
  classifySource,
  normalizeSource,
} from '../src/modules/platforms/traffic-source.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------- 來源分組

describe('classifySource — AI 搜尋必須自成一組', () => {
  it('七個指定來源都認得，含 host 變體', () => {
    assert.equal(aiEngineOf('chatgpt.com'), 'ChatGPT');
    assert.equal(aiEngineOf('chat.openai.com'), 'ChatGPT');
    assert.equal(aiEngineOf('https://www.perplexity.ai/'), 'Perplexity');
    assert.equal(aiEngineOf('claude.ai'), 'Claude');
    assert.equal(aiEngineOf('copilot.microsoft.com'), 'Copilot');
    assert.equal(aiEngineOf('gemini.google.com'), 'Gemini');
    assert.equal(aiEngineOf('you.com'), 'You.com');
    assert.equal(aiEngineOf('phind.com'), 'Phind');
  });

  it('gemini.google.com 是 AI 不是 Google 自然搜尋（順序錯就會被吃掉）', () => {
    assert.equal(classifySource('gemini.google.com', 'referral').group, 'ai');
    assert.equal(classifySource('google', 'organic').group, 'search');
    assert.equal(aiEngineOf('google', 'organic'), null);
  });

  it('子網域也算（m.chatgpt.com），但同字首的別站不算', () => {
    assert.equal(aiEngineOf('m.chatgpt.com'), 'ChatGPT');
    assert.equal(aiEngineOf('notchatgpt.com'), null);
  });

  it('normalizeSource 去掉 scheme / www / 路徑', () => {
    assert.equal(normalizeSource('HTTPS://WWW.Perplexity.ai/search?q=1'), 'perplexity.ai');
  });

  it('(direct) 與 (not set) 不會被算成 referral', () => {
    assert.equal(classifySource('(direct)', '(none)').group, 'direct');
    assert.equal(classifySource('(not set)').group, 'unset');
  });

  // 這幾條是另一個專案實際踩過的坑：GA4 的 source/medium/campaign 是保留參數名，
  // 自訂事件送同名參數會覆蓋 sessionSource，於是報表上冒出根本不是來源的值。
  it('事件參數洩漏成 source 時要被標可疑，而不是安靜地變成一個來源', () => {
    const leaked = classifySource('package_card', 'referral');
    assert.equal(leaked.group, 'referral');
    assert.match(leaked.suspicious ?? '', /保留參數名/);
  });

  it('本機／內網位址要被標可疑（開發流量打到正式 measurement id）', () => {
    assert.match(classifySource('127.0.0.1:8000').suspicious ?? '', /本機／內網/);
    assert.match(classifySource('localhost:5173').suspicious ?? '', /本機／內網/);
  });

  it('自我參照不是外部來源', () => {
    const c = classifySource('car.codecity.com.tw', 'referral', ['car.codecity.com.tw']);
    assert.match(c.suspicious ?? '', /自我參照/);
    assert.equal(aiEngineOf('car.codecity.com.tw', 'referral', ['car.codecity.com.tw']), null);
  });
});

// ---------------------------------------------------------------- metric 守衛

describe('assertValidMetrics — 擋在送出之前', () => {
  it('conversions 不是 GA4 metric，錯誤訊息直接給正解', () => {
    assert.throws(() => assertValidMetrics(['sessions', 'conversions']), (err: unknown) => {
      assert.ok(err instanceof Ga4MetricError);
      assert.match((err as Error).message, /keyEvents/);
      return true;
    });
  });

  it('UA 時代的名字也擋（users / pageviews）', () => {
    assert.throws(() => assertValidMetrics(['users']), /totalUsers/);
    assert.throws(() => assertValidMetrics(['pageviews']), /screenPageViews/);
  });

  it('合法的組合放行', () => {
    assertValidMetrics(['sessions', 'totalUsers', 'engagedSessions', 'keyEvents']);
  });
});

// ---------------------------------------------------------------- Data API

describe('runGa4Report — 攤平巢狀回應', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('把 dimensionValues/metricValues 對回欄位名，數字轉成 number', async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          dimensionHeaders: [{ name: 'sessionSource' }],
          metricHeaders: [{ name: 'sessions' }, { name: 'totalUsers' }],
          rows: [
            { dimensionValues: [{ value: 'chatgpt.com' }], metricValues: [{ value: '12' }, { value: '9' }] },
          ],
          rowCount: 1,
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const res = await runGa4Report('tok', '123', {
      startDate: '2026-07-24',
      endDate: '2026-08-20',
      dimensions: ['sessionSource'],
      metrics: ['sessions', 'totalUsers'],
    });
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]?.dimensions.sessionSource, 'chatgpt.com');
    assert.equal(res.rows[0]?.metrics.sessions, 12);
    assert.equal(res.rows[0]?.metrics.totalUsers, 9);
    // 刻意不送 dimensionFilter：舊範例的 { filter: { fieldName } } 會回
    // "Unknown field for Filter: fieldName"，而在本機切一樣便宜。
    assert.equal(sentBody.dimensionFilter, undefined);
  });

  it('落點頁維度改過名，第一個被拒就換第二個（不然整張落點表會消失）', async () => {
    const tried: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        dimensions?: Array<{ name: string }>;
      };
      const dim = body.dimensions?.[body.dimensions.length - 1]?.name ?? '';
      tried.push(dim);
      if (dim === 'landingPagePlusQueryString') {
        return new Response(JSON.stringify({ error: 'bad dimension' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          dimensionHeaders: [{ name: 'landingPage' }],
          metricHeaders: [{ name: 'sessions' }],
          rows: [{ dimensionValues: [{ value: '/cal/milk' }], metricValues: [{ value: '3' }] }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const res = await runGa4ReportWithLandingPage('tok', '123', {
      startDate: '2026-07-24',
      endDate: '2026-08-20',
      metrics: ['sessions'],
    });
    assert.deepEqual(tried, ['landingPagePlusQueryString', 'landingPage']);
    assert.equal(res.landingDimension, 'landingPage');
    assert.equal(res.rows[0]?.dimensions.landingPage, '/cal/milk');
  });
});

// ---------------------------------------------------------------- 整條串起來

function fakeServiceAccount(dir: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const path = join(dir, 'sa.json');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'service_account',
      client_email: 'weekly@test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
  );
  return path;
}

const PAGE_TYPES = [
  { id: 'home', match: '/', label: '首頁' },
  { id: 'cal', match: '/cal', label: '熱量頁' },
  { id: 'shop', match: '/s', label: '店家頁' },
];

/** 來源維度那一次的回傳：兩個 AI、一個自然搜尋、一個被事件參數污染的假來源。 */
const SOURCE_ROWS = [
  { source: 'google', medium: 'organic', sessions: 400, users: 350, engaged: 200, dur: 8000 },
  { source: 'chatgpt.com', medium: 'referral', sessions: 30, users: 28, engaged: 24, dur: 900 },
  { source: 'perplexity.ai', medium: 'referral', sessions: 10, users: 9, engaged: 8, dur: 300 },
  { source: 'package_card', medium: 'referral', sessions: 7, users: 7, engaged: 1, dur: 20 },
];

const LANDING_ROWS = [
  { source: 'chatgpt.com', page: '/cal/milk?utm=x', sessions: 20 },
  { source: 'chatgpt.com', page: '/cal/rice', sessions: 8 },
  { source: 'perplexity.ai', page: '/cal/milk', sessions: 6 },
  { source: 'chatgpt.com', page: '/s/abc', sessions: 2 },
  { source: 'google', page: '/s/zzz', sessions: 999 }, // 非 AI，必須被排除
];

interface Calls {
  token: number;
  accountSummaries: number;
  dataStreams: number;
  runReport: number;
}

function installGa4Mock(opts: { measurementId: string }): Calls {
  const calls: Calls = { token: 0, accountSummaries: 0, dataStreams: 0, runReport: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      calls.token++;
      return json({ access_token: 'fake', expires_in: 3600 });
    }
    if (url.includes('/accountSummaries')) {
      calls.accountSummaries++;
      return json({
        accountSummaries: [
          {
            account: 'accounts/1',
            displayName: 'A7',
            propertySummaries: [{ property: 'properties/98765', displayName: '好食物' }],
          },
        ],
      });
    }
    if (url.includes('/dataStreams')) {
      calls.dataStreams++;
      return json({
        dataStreams: [
          { name: 'x', webStreamData: { measurementId: opts.measurementId, defaultUri: 'https://demo.example' } },
        ],
      });
    }
    if (url.includes(':runReport')) {
      calls.runReport++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        dimensions?: Array<{ name: string }>;
      };
      const dims = (body.dimensions ?? []).map((d) => d.name);
      if (dims.includes('sessionMedium')) {
        return json({
          dimensionHeaders: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
          metricHeaders: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'engagedSessions' },
            { name: 'userEngagementDuration' },
          ],
          rows: SOURCE_ROWS.map((r) => ({
            dimensionValues: [{ value: r.source }, { value: r.medium }],
            metricValues: [
              { value: String(r.sessions) },
              { value: String(r.users) },
              { value: String(r.engaged) },
              { value: String(r.dur) },
            ],
          })),
        });
      }
      const landingDim = dims[dims.length - 1] as string;
      return json({
        dimensionHeaders: [{ name: 'sessionSource' }, { name: landingDim }],
        metricHeaders: [{ name: 'sessions' }],
        rows: LANDING_ROWS.map((r) => ({
          dimensionValues: [{ value: r.source }, { value: r.page }],
          metricValues: [{ value: String(r.sessions) }],
        })),
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

describe('runGa4WeeklyReport', () => {
  let dir: string;
  let saPath: string;
  let registryPath: string;
  const savedEnv = {
    file: process.env.A7_GSC_CREDENTIALS,
    inline: process.env.A7_GSC_CREDENTIALS_JSON,
    gfile: process.env.A7_GOOGLE_CREDENTIALS,
    ginline: process.env.A7_GOOGLE_CREDENTIALS_JSON,
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'a7seo-ga4-'));
    saPath = fakeServiceAccount(dir);
    registryPath = join(dir, 'sites.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        sites: [
          {
            id: 'demo',
            name: '示範站',
            domain: 'demo.example',
            origin: 'https://demo.example',
            status: 'live',
            analytics: { ga4: 'G-DEMO123' },
            pageTypes: PAGE_TYPES,
          },
          { id: 'parked-site', name: '擱置站', origin: 'https://parked.example', status: 'parked' },
        ],
      })
    );
    delete process.env.A7_GSC_CREDENTIALS;
    delete process.env.A7_GSC_CREDENTIALS_JSON;
    delete process.env.A7_GOOGLE_CREDENTIALS;
    delete process.env.A7_GOOGLE_CREDENTIALS_JSON;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (savedEnv.file) process.env.A7_GSC_CREDENTIALS = savedEnv.file;
    if (savedEnv.inline) process.env.A7_GSC_CREDENTIALS_JSON = savedEnv.inline;
    if (savedEnv.gfile) process.env.A7_GOOGLE_CREDENTIALS = savedEnv.gfile;
    if (savedEnv.ginline) process.env.A7_GOOGLE_CREDENTIALS_JSON = savedEnv.ginline;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('measurement id → property id 靠 Admin API 對照，結果要回報給人貼回 registry', async () => {
    const calls = installGa4Mock({ measurementId: 'G-DEMO123' });
    const report = await runGa4WeeklyReport(registryPath, { credentialsPath: saPath });

    assert.equal(calls.token, 1);
    assert.equal(calls.accountSummaries, 1);
    assert.equal(calls.dataStreams, 1);
    assert.equal(report.sites.length, 1, 'parked 站不進報表');
    assert.equal(report.sites[0]?.propertyId, '98765');
    assert.equal(report.sites[0]?.propertyResolvedBy, 'discovery');
    assert.deepEqual(report.discovered, [
      { measurementId: 'G-DEMO123', propertyId: '98765', displayName: '好食物' },
    ]);
  });

  it('registry 明寫 ga4Property 就不打 Admin API', async () => {
    const declaredPath = join(dir, 'sites-declared.json');
    writeFileSync(
      declaredPath,
      JSON.stringify({
        sites: [
          {
            id: 'demo',
            name: '示範站',
            origin: 'https://demo.example',
            status: 'live',
            analytics: { ga4: 'G-DEMO123', ga4Property: '55555' },
            pageTypes: PAGE_TYPES,
          },
        ],
      })
    );
    const calls = installGa4Mock({ measurementId: 'G-DEMO123' });
    const report = await runGa4WeeklyReport(declaredPath, { credentialsPath: saPath });
    assert.equal(calls.accountSummaries, 0, 'registry 有寫就不該再去對照');
    assert.equal(report.sites[0]?.propertyId, '55555');
    assert.equal(report.sites[0]?.propertyResolvedBy, 'registry');
  });

  it('AI 來源獨立成組，污染來源不計入 AI', async () => {
    installGa4Mock({ measurementId: 'G-DEMO123' });
    const report = await runGa4WeeklyReport(registryPath, { credentialsPath: saPath });
    const site = report.sites[0];

    assert.equal(site?.totals?.sessions, 447, '全站工作階段含所有列');
    assert.equal(site?.ai?.totals.sessions, 40, 'AI 只算 chatgpt + perplexity');
    assert.deepEqual(
      site?.ai?.byEngine.map((e) => [e.engine, e.sessions]),
      [
        ['ChatGPT', 30],
        ['Perplexity', 10],
      ]
    );
    assert.equal(site?.byGroup?.search.sessions, 400);
    assert.equal(site?.suspicious?.length, 1);
    assert.equal(site?.suspicious?.[0]?.source, 'package_card');
  });

  it('AI 落點頁依 registry 的 pageTypes 分群，非 AI 的落點不混進來', async () => {
    installGa4Mock({ measurementId: 'G-DEMO123' });
    const report = await runGa4WeeklyReport(registryPath, { credentialsPath: saPath });
    const byType = new Map(report.sites[0]?.aiLanding?.map((t) => [t.id, t]));

    // /cal/milk 的兩個來源要合併（20 + 6），query string 要被剝掉
    assert.equal(byType.get('cal')?.sessions, 34);
    assert.equal(byType.get('shop')?.sessions, 2);
    assert.equal(byType.size, 2, 'google 帶進來的 /s/zzz 999 階段不該出現');
    const milk = byType.get('cal')?.topPages.find((p) => p.path === '/cal/milk');
    assert.equal(milk?.sessions, 26);
    assert.deepEqual(milk?.engines, ['ChatGPT', 'Perplexity']);
  });

  it('AI 為 0 時不去問落點頁，而且說明是「沒得問」不是「問失敗」', async () => {
    const calls = { runReport: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'x' });
      if (url.includes('/accountSummaries'))
        return json({
          accountSummaries: [{ propertySummaries: [{ property: 'properties/1', displayName: 'p' }] }],
        });
      if (url.includes('/dataStreams'))
        return json({ dataStreams: [{ webStreamData: { measurementId: 'G-DEMO123' } }] });
      if (url.includes(':runReport')) {
        calls.runReport++;
        return json({
          dimensionHeaders: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
          metricHeaders: [{ name: 'sessions' }],
          rows: [
            { dimensionValues: [{ value: 'google' }, { value: 'organic' }], metricValues: [{ value: '5' }] },
          ],
        });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const report = await runGa4WeeklyReport(registryPath, { credentialsPath: saPath });
    assert.equal(calls.runReport, 1, '沒有 AI 就不該再問落點頁');
    assert.match(report.sites[0]?.aiLandingSkipReason ?? '', /不是查失敗/);
  });

  it('沒有憑證時給指引而不是丟例外，而且不編一個 0 出來', async () => {
    globalThis.fetch = (async () => new Response('should not be called', { status: 500 })) as typeof fetch;
    const report = await runGa4WeeklyReport(registryPath, {});
    assert.equal(report.credentials.configured, false);
    assert.match(report.credentials.hint ?? '', /A7_GSC_CREDENTIALS/);
    assert.equal(report.sites[0]?.totals, undefined);
    const text = formatGa4Report(report);
    assert.match(text, /GA4 憑證未就緒/);
    assert.match(text, /憑證沒設好＝這一層是空白，不是 0/);
  });

  it('格式化輸出把三張表都印出來', async () => {
    installGa4Mock({ measurementId: 'G-DEMO123' });
    const report = await runGa4WeeklyReport(registryPath, { credentialsPath: saPath });
    const text = formatGa4Report(report);
    assert.match(text, /【表一】/);
    assert.match(text, /【表二】AI 來源 × 站/);
    assert.match(text, /【表三】AI 落點頁型/);
    assert.match(text, /ChatGPT/);
    assert.match(text, /可疑來源/);
    assert.match(text, /package_card/);
  });
});
