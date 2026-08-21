import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inRange, pageOf, parseBingDate } from '../src/modules/platforms/bing.js';
import {
  formatBingReport,
  resolveBingSiteUrl,
  runBingReport,
} from '../src/modules/platforms/bing-report.js';
import {
  CLARITY_MAX_DAYS,
  parseClarityResponse,
} from '../src/modules/platforms/clarity.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------- 日期格式

describe('parseBingDate — 那個時區位移會吃掉整批資料', () => {
  it('帶時區位移的格式（實際看到的那種）解得出來', () => {
    // /Date(1779260400000-0700)/ ——只抓 \d+ 然後要求緊接右括號的 regex 會整條失配，
    // 於是每一列都「不在區間內」，報表安靜地變成 0。
    assert.equal(parseBingDate('/Date(1779260400000-0700)/'), '2026-05-20');
    assert.equal(parseBingDate('/Date(1779260400000+0800)/'), '2026-05-20');
  });

  it('沒有位移的格式也解得出來', () => {
    assert.equal(parseBingDate('/Date(1787270400000)/'), '2026-08-21');
  });

  it('認不出來時原樣回傳 —— 不回今天、不回空字串', () => {
    assert.equal(parseBingDate('2026-08-21'), '2026-08-21');
    assert.equal(parseBingDate('garbage'), 'garbage');
  });

  it('inRange 吃 Bing 原始格式', () => {
    assert.equal(inRange('/Date(1779260400000-0700)/', '2026-05-01', '2026-05-31'), true);
    assert.equal(inRange('/Date(1779260400000-0700)/', '2026-06-01', '2026-06-30'), false);
  });
});

describe('pageOf — GetPageStats 的列仍然用 Query 當 key', () => {
  it('Page 欄不存在時退回 Query，並回報用了哪一個', () => {
    const r = pageOf({ Query: 'https://demo.example/s/a', Clicks: 1, Impressions: 10 });
    assert.equal(r.url, 'https://demo.example/s/a');
    assert.equal(r.keyUsed, 'Query');
  });

  it('哪天 Microsoft 真的修好 schema，這裡會看得出來', () => {
    const r = pageOf({ Page: 'https://demo.example/s/b', Clicks: 1, Impressions: 10 });
    assert.equal(r.keyUsed, 'Page');
  });

  it('兩個都沒有就回空字串（不要吐 "undefined" 進報表）', () => {
    assert.equal(pageOf({ Clicks: 0, Impressions: 0 }).url, '');
  });
});

// ---------------------------------------------------------------- 報表

const PAGE_TYPES = [
  { id: 'home', match: '/', label: '首頁' },
  { id: 'shop', match: '/s', label: '店家頁' },
  { id: 'model', match: '/m', label: '車型頁' },
];

function installBingMock(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = /api\.svc\/json\/([A-Za-z]+)/.exec(url)?.[1] ?? '';
    calls.push(method);
    const json = (d: unknown): Response => new Response(JSON.stringify({ d }), { status: 200 });

    if (method === 'GetRankAndTrafficStats') {
      return json([
        { Date: '/Date(1787270400000-0700)/', Clicks: 20, Impressions: 500, Position: 4 },
        { Date: '/Date(1787184000000-0700)/', Clicks: 10, Impressions: 100, Position: 8 },
        // 區間外，必須被濾掉
        { Date: '/Date(1600000000000-0700)/', Clicks: 999, Impressions: 9999, Position: 1 },
      ]);
    }
    if (method === 'GetQueryStats') {
      return json([
        { Query: '中壢 機車行', Clicks: 12, Impressions: 200 },
        { Query: '汽車保養', Clicks: 3, Impressions: 90 },
      ]);
    }
    if (method === 'GetPageStats') {
      // 注意：URL 塞在 Query 欄裡，這正是那個坑
      return json([
        { Query: 'https://demo.example/s/a', Clicks: 8, Impressions: 300 },
        { Query: 'https://demo.example/s/b', Clicks: 2, Impressions: 120 },
        { Query: 'https://demo.example/m/x', Clicks: 0, Impressions: 40 },
        { Query: 'https://demo.example/about', Clicks: 1, Impressions: 5 },
      ]);
    }
    if (method === 'GetCrawlStats') {
      return json([
        { Date: '/Date(1787270400000-0700)/', CrawledPages: 1200, CrawlErrors: 3, HttpStatus4xx: 2, HttpStatus5xx: 1 },
        { Date: '/Date(1600000000000-0700)/', CrawledPages: 99999, CrawlErrors: 500 },
      ]);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls };
}

describe('runBingReport', () => {
  let dir: string;
  let registryPath: string;
  const savedKey = process.env.A7_BING_API_KEY;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'a7seo-bing-'));
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
            pageTypes: PAGE_TYPES,
          },
          { id: 'parked-site', name: '擱置站', origin: 'https://parked.example', status: 'parked' },
        ],
      })
    );
    delete process.env.A7_BING_API_KEY;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (savedKey) process.env.A7_BING_API_KEY = savedKey;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('siteUrl 預設是 origin 加尾斜線（Bing 用 URL 不用 domain property）', () => {
    assert.equal(
      resolveBingSiteUrl({ id: 'x', name: 'x', origin: 'https://demo.example' }),
      'https://demo.example/'
    );
    assert.equal(
      resolveBingSiteUrl({
        id: 'x',
        name: 'x',
        origin: 'https://demo.example',
        analytics: { bingSiteUrl: 'https://www.demo.example/' },
      }),
      'https://www.demo.example/'
    );
  });

  it('只加總落在區間內的天數，曝光加權算平均排序', async () => {
    installBingMock();
    const report = await runBingReport(registryPath, { apiKey: 'k', days: 28 });
    const site = report.sites[0];
    assert.equal(report.sites.length, 1, 'parked 站不進報表');
    assert.equal(site?.totals?.clicks, 30, '區間外那筆 999 必須被濾掉');
    assert.equal(site?.totals?.impressions, 600);
    // (4×500 + 8×100) / 600
    assert.ok(Math.abs((site?.totals?.position ?? 0) - 2800 / 600) < 1e-9);
    assert.equal(site?.crawl?.crawledPages, 1200);
    assert.equal(site?.crawl?.crawlErrors, 3);
  });

  it('頁型分群用 registry 的 pageTypes（跟 GSC 表二同一組 pattern）', async () => {
    installBingMock();
    const report = await runBingReport(registryPath, { apiKey: 'k' });
    const byId = new Map(report.sites[0]?.pageTypes?.map((t) => [t.id, t]));
    assert.equal(byId.get('shop')?.impressions, 420);
    assert.equal(byId.get('shop')?.clicks, 10);
    assert.equal(byId.get('shop')?.pages, 2);
    assert.equal(byId.get('model')?.impressions, 40);
    assert.equal(byId.get('_other')?.pages, 1, '/about 沒宣告，落進未分類而不是被吃掉');
  });

  it('如實記下 URL 是從哪個欄位讀到的', async () => {
    installBingMock();
    const report = await runBingReport(registryPath, { apiKey: 'k' });
    assert.equal(report.sites[0]?.pageKeyUsed, 'Query');
    assert.ok(report.sites[0]?.notes?.some((n) => /Query 當 key/.test(n)));
  });

  it('沒有金鑰時給指引而不是 stack trace', async () => {
    globalThis.fetch = (async () => new Response('should not be called', { status: 500 })) as typeof fetch;
    const report = await runBingReport(registryPath, {});
    assert.equal(report.credentials.configured, false);
    assert.match(report.credentials.hint ?? '', /A7_BING_API_KEY/);
    assert.equal(report.sites[0]?.totals, undefined);
    assert.match(formatBingReport(report), /Bing API 金鑰未就緒/);
  });

  it('siteUrl 不對時（Bing 回 400/404）把「尾斜線算數」直接寫在提示裡', async () => {
    globalThis.fetch = (async () => new Response('bad site', { status: 400 })) as typeof fetch;
    const report = await runBingReport(registryPath, { apiKey: 'k' });
    assert.ok(report.sites[0]?.error);
    assert.match(report.sites[0]?.hint ?? '', /尾斜線/);
  });

  it('格式化輸出把總覽與頁型表印出來', async () => {
    installBingMock();
    const text = formatBingReport(await runBingReport(registryPath, { apiKey: 'k' }));
    assert.match(text, /【表一】五站總覽/);
    assert.match(text, /店家頁/);
    assert.match(text, /中壢 機車行/);
    assert.match(text, /不要拿來跟 GSC/);
  });
});

// ---------------------------------------------------------------- Clarity 解析

describe('parseClarityResponse — 寬容解析（尚未對線上 API 實跑過）', () => {
  it('認得維度欄與數值欄，metric 名保留', () => {
    const parsed = parseClarityResponse([
      {
        metricName: 'DeadClickCount',
        information: [
          { Url: '/s/abc', subTotal: '12', sessionsWithMetricPercentage: '3.5' },
          { Url: '/cal/milk', subTotal: 4 },
        ],
      },
      {
        metricName: 'Traffic',
        information: [{ Url: '/', totalSessionCount: '900', distinctUserCount: '700' }],
      },
    ]);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.metricName, 'DeadClickCount');
    assert.deepEqual(
      parsed[0]?.rows.map((r) => [r.dimension, r.value]),
      [
        ['/s/abc', 12],
        ['/cal/milk', 4],
      ]
    );
    // subTotal 優先於 totalSessionCount —— 前者才是「發生了幾次」
    assert.equal(parsed[1]?.rows[0]?.value, 900);
  });

  it('欄位名認不出來時標 unparsed，而不是安靜地回 0', () => {
    const parsed = parseClarityResponse([
      { metricName: 'Weird', information: [{ Url: '/x', somethingNew: 'not-a-number' }] },
    ]);
    assert.equal(parsed[0]?.unparsed, true);
  });

  it('不是陣列就回空，不炸', () => {
    assert.deepEqual(parseClarityResponse({ error: 'unauthorized' }), []);
  });

  it('配額常數就是官方硬限制，別偷偷放寬', () => {
    assert.equal(CLARITY_MAX_DAYS, 3);
  });
});
