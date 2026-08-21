import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evenlySample,
  formatGscReport,
  matchPageType,
  resolveProperty,
  resolveRange,
  runGscReport,
} from '../src/modules/platforms/gsc-report.js';
import type { RegistryPageType, RegistrySite } from '../src/modules/platforms/portfolio.js';

// ---------------------------------------------------------------- 純函式

describe('matchPageType — 分段前綴，不是 startsWith', () => {
  const defs: RegistryPageType[] = [
    { id: 'home', match: '/', label: '首頁' },
    { id: 'en', match: '/en', label: '英文頁' },
    { id: 'supplier', match: '/s', label: '供應商頁' },
    { id: 'supHub', match: '/sup', label: '供應商專區' },
    { id: 'cal', match: '/cal', label: '熱量頁' },
    { id: 'category', match: '/c', label: '分類頁' },
  ];

  it('/s 不會吃掉 /sup（這正是不能用 startsWith 的原因）', () => {
    assert.equal(matchPageType('/sup/abc', defs)?.id, 'supHub');
    assert.equal(matchPageType('/sup', defs)?.id, 'supHub');
    assert.equal(matchPageType('/s/abc', defs)?.id, 'supplier');
  });

  it('/c 不會吃掉 /cal', () => {
    assert.equal(matchPageType('/cal/milk', defs)?.id, 'cal');
    assert.equal(matchPageType('/c/taipei', defs)?.id, 'category');
  });

  it('match "/" 只命中首頁，不會吃掉全站', () => {
    assert.equal(matchPageType('/', defs)?.id, 'home');
    assert.equal(matchPageType('/s/abc', defs)?.id, 'supplier');
  });

  it('hub 頁與內容頁共用同一條 pattern（/guide 與 /guide/x）', () => {
    const g: RegistryPageType[] = [{ id: 'guide', match: '/guide', label: '教學' }];
    assert.equal(matchPageType('/guide', g)?.id, 'guide');
    assert.equal(matchPageType('/guide/how-to', g)?.id, 'guide');
    assert.equal(matchPageType('/guidelines', g), null);
  });

  it('尾斜線不影響判定', () => {
    assert.equal(matchPageType('/s/abc/', defs)?.id, 'supplier');
  });

  it('沒命中回 null（呼叫端才決定要不要丟進「（未分類）」）', () => {
    assert.equal(matchPageType('/about', defs), null);
  });
});

describe('evenlySample — 等距抽樣，同一份清單每次結果相同', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  it('跨整個清單取樣，不是只取開頭', () => {
    const picked = evenlySample(items, 5);
    assert.deepEqual(picked, [0, 20, 40, 60, 80]);
  });

  it('清單比要求短就整包回', () => {
    assert.deepEqual(evenlySample([1, 2], 5), [1, 2]);
  });

  it('n<=0 或空清單回空陣列', () => {
    assert.deepEqual(evenlySample(items, 0), []);
    assert.deepEqual(evenlySample([], 5), []);
  });
});

describe('resolveProperty', () => {
  const base = { id: 'x', name: 'x', origin: 'https://demo.example' } as RegistrySite;

  it('預設推 domain property（五站都是 domain property）', () => {
    assert.equal(resolveProperty({ ...base, domain: 'demo.example' }), 'sc-domain:demo.example');
  });

  it('沒有 domain 欄位就從 origin 取 host', () => {
    assert.equal(resolveProperty(base), 'sc-domain:demo.example');
  });

  it('registry 明寫 gscProperty 就用它（URL-prefix property 的逃生口）', () => {
    assert.equal(
      resolveProperty({ ...base, analytics: { gscProperty: 'https://demo.example/' } }),
      'https://demo.example/'
    );
  });
});

describe('resolveRange', () => {
  it('lag 天數往回推當結束日，往前數 days 天當起始日', () => {
    const { startDate, endDate } = resolveRange(28, 3);
    const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
    assert.equal(span, 27, '28 天視窗的頭尾相差 27 天');
    const lag = (Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${endDate}T00:00:00Z`)) / 86_400_000;
    assert.ok(lag >= 2 && lag <= 4, `結束日應落在今天前 3 天上下，實得 ${lag}`);
  });
});

// ---------------------------------------------------------------- 有憑證的路徑（mock）

const realFetch = globalThis.fetch;

/** 造一把真的 RSA 金鑰：JWT 是真的簽出來的，只有網路那層是假的。 */
function fakeServiceAccount(dir: string): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const path = join(dir, 'sa.json');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'service_account',
      project_id: 'test',
      client_email: 'weekly@test.iam.gserviceaccount.com',
      private_key: privateKey,
    })
  );
  return path;
}

const PAGE_TYPES: RegistryPageType[] = [
  { id: 'home', match: '/', label: '首頁' },
  { id: 'shop', match: '/s', label: '店家頁' },
  { id: 'model', match: '/m', label: '車型頁' },
  { id: 'tag', match: '/t', label: '標籤頁' },
];

/** 150 個 /t/ 頁（sitemap 有、GSC 完全沒曝光）＝「該砍的頁型」那個訊號。 */
const TAG_URLS = Array.from({ length: 150 }, (_, i) => `https://demo.example/t/tag-${i}`);
const SITEMAP_URLS = [
  'https://demo.example/',
  'https://demo.example/about',
  'https://demo.example/s/a',
  'https://demo.example/s/b',
  'https://demo.example/s/c',
  'https://demo.example/m/x',
  'https://demo.example/m/y',
  ...TAG_URLS,
];

const PAGE_ROWS = [
  { keys: ['https://demo.example/s/a'], clicks: 10, impressions: 1000, ctr: 0.01, position: 5 },
  { keys: ['https://demo.example/s/b'], clicks: 0, impressions: 100, ctr: 0, position: 20 },
  { keys: ['https://demo.example/m/x'], clicks: 1, impressions: 10, ctr: 0.1, position: 8 },
  { keys: ['https://demo.example/'], clicks: 5, impressions: 50, ctr: 0.1, position: 2 },
];

interface Calls {
  token: number;
  sites: number;
  searchAnalytics: number;
  inspect: number;
}

function installMock(opts: { visible: string[] }): Calls {
  const calls: Calls = { token: 0, sites: 0, searchAnalytics: 0, inspect: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      calls.token++;
      return json({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
      calls.sites++;
      return json({ siteEntry: opts.visible.map((siteUrl) => ({ siteUrl, permissionLevel: 'siteFullUser' })) });
    }
    if (url.includes('/searchAnalytics/query')) {
      calls.searchAnalytics++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { dimensions?: string[] };
      if (!body.dimensions || body.dimensions.length === 0) {
        return json({ rows: [{ clicks: 16, impressions: 1160, ctr: 0.0138, position: 6.1 }] });
      }
      return json({ rows: PAGE_ROWS });
    }
    if (url.includes('urlInspection/index:inspect')) {
      calls.inspect++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { inspectionUrl?: string };
      const indexed = (body.inspectionUrl ?? '').includes('/s/');
      return json({
        inspectionResult: {
          indexStatusResult: {
            verdict: indexed ? 'PASS' : 'NEUTRAL',
            coverageState: indexed ? 'Submitted and indexed' : 'Crawled - currently not indexed',
          },
        },
      });
    }
    if (url === 'https://demo.example/sitemap.xml') {
      return new Response(
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://demo.example/sitemaps/all.xml</loc></sitemap></sitemapindex>`,
        { status: 200 }
      );
    }
    if (url === 'https://demo.example/sitemaps/all.xml') {
      return new Response(
        `<?xml version="1.0"?><urlset>${SITEMAP_URLS.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
        { status: 200 }
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

describe('runGscReport — 有憑證的路徑', () => {
  let dir: string;
  let saPath: string;
  let registryPath: string;
  const savedEnv = { file: process.env.A7_GSC_CREDENTIALS, inline: process.env.A7_GSC_CREDENTIALS_JSON };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'a7seo-gsc-'));
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
            pageTypes: PAGE_TYPES,
          },
          { id: 'parked-site', name: '擱置站', origin: 'https://parked.example', status: 'parked' },
        ],
      })
    );
    delete process.env.A7_GSC_CREDENTIALS;
    delete process.env.A7_GSC_CREDENTIALS_JSON;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (savedEnv.file) process.env.A7_GSC_CREDENTIALS = savedEnv.file;
    if (savedEnv.inline) process.env.A7_GSC_CREDENTIALS_JSON = savedEnv.inline;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('簽 JWT → 換 token → 列 property → 查 searchAnalytics，整條串得起來', async () => {
    const calls = installMock({ visible: ['sc-domain:demo.example'] });
    const report = await runGscReport(registryPath, { credentialsPath: saPath });

    assert.equal(calls.token, 1, 'access token 只換一次');
    assert.equal(calls.sites, 1);
    assert.equal(calls.searchAnalytics, 2, '一次總計 + 一次 page 維度');
    assert.equal(report.credentials.configured, true);
    assert.equal(report.credentials.clientEmail, 'weekly@test.iam.gserviceaccount.com');
    assert.equal(report.sites.length, 1, 'parked 站不進報表');
    assert.equal(report.sites[0]?.property, 'sc-domain:demo.example');
    assert.equal(report.sites[0]?.totals?.clicks, 16);
    assert.equal(report.sites[0]?.totals?.impressions, 1160);
  });

  it('頁型分群把 sitemap 頁數與 GSC 曝光對在同一列，排序用曝光加權', async () => {
    installMock({ visible: ['sc-domain:demo.example'] });
    const report = await runGscReport(registryPath, { credentialsPath: saPath });
    const byId = new Map(report.sites[0]?.pageTypes.map((t) => [t.id, t]));

    const shop = byId.get('shop');
    assert.equal(shop?.sitemapPages, 3);
    assert.equal(shop?.pagesWithImpressions, 2);
    assert.equal(shop?.clicks, 10);
    assert.equal(shop?.impressions, 1100);
    // (5×1000 + 20×100) / 1100 —— 加權而不是算術平均，否則一頁 1 次曝光的長尾會主導
    assert.ok(Math.abs((shop?.position ?? 0) - 7000 / 1100) < 1e-9);
    assert.ok(Math.abs((shop?.ctr ?? 0) - 10 / 1100) < 1e-9);

    assert.equal(byId.get('home')?.sitemapPages, 1);
    assert.equal(byId.get('home')?.impressions, 50);
    assert.equal(byId.get('model')?.sitemapPages, 2);
    assert.equal(byId.get('model')?.pagesWithImpressions, 1);

    // 這一條才是整張表存在的理由：150 頁、0 曝光
    const tag = byId.get('tag');
    assert.equal(tag?.sitemapPages, 150);
    assert.equal(tag?.impressions, 0);
    assert.equal(tag?.pagesWithImpressions, 0);

    // 沒宣告的 /about 落進「（未分類）」而不是被靜靜吃掉
    assert.equal(byId.get('_other')?.sitemapPages, 1);

    const text = formatGscReport(report);
    assert.match(text, /零曝光但佔 sitemap 大量名額：標籤頁 150 頁/);
  });

  it('service account 沒被加進 property 時，報表直接講出要加誰、加去哪', async () => {
    installMock({ visible: ['sc-domain:someone-else.example'] });
    const report = await runGscReport(registryPath, { credentialsPath: saPath });
    const site = report.sites[0];
    assert.ok(site?.error, '應該有 error');
    assert.match(site.error as string, /看不到 property/);
    assert.match(site.error as string, /weekly@test\.iam\.gserviceaccount\.com/);
    assert.equal(site?.totals, undefined, '拿不到資料就不要編一個 0 出來');
    // sitemap 那半張表不受影響，仍然算得出來
    assert.equal(site?.sitemapTotal, SITEMAP_URLS.length);
  });

  it('--inspect 會逐頁型抽樣索引狀態，並把結果掛回該頁型', async () => {
    const calls = installMock({ visible: ['sc-domain:demo.example'] });
    const report = await runGscReport(registryPath, { credentialsPath: saPath, inspectPerType: 2 });
    // 5 個桶（home 1 + shop 3 + model 2 + tag 150 + _other 1），每桶最多 2 個
    assert.equal(calls.inspect, 1 + 2 + 2 + 2 + 1);
    const byId = new Map(report.sites[0]?.pageTypes.map((t) => [t.id, t]));
    assert.equal(byId.get('shop')?.coverage?.sampled, 2);
    assert.equal(byId.get('shop')?.coverage?.indexed, 2, '/s/ 在 mock 裡都是已索引');
    assert.equal(byId.get('tag')?.coverage?.indexed, 0);
    assert.equal(byId.get('tag')?.coverage?.crawledNotIndexed, 2);
    assert.equal(report.sites[0]?.coverage?.sampled, 8);
  });

  it('沒有憑證時給指引而不是丟例外，而且 sitemap 那半張表照樣產出', async () => {
    installMock({ visible: [] });
    const report = await runGscReport(registryPath, {});
    assert.equal(report.credentials.configured, false);
    assert.equal(report.sitemapOnly, true);
    assert.match(report.credentials.hint ?? '', /A7_GSC_CREDENTIALS/);
    assert.equal(report.sites[0]?.totals, undefined);
    assert.equal(report.sites[0]?.sitemapTotal, SITEMAP_URLS.length);

    const text = formatGscReport(report);
    assert.match(text, /GSC 憑證未就緒/);
    // 沒問到就不能印 0——那會跟「問過了、真的沒人搜」長得一樣
    assert.doesNotMatch(text, /零曝光但佔 sitemap 大量名額/);
  });
});
