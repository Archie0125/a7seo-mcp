import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWeeklyReport } from '../src/modules/platforms/weekly.js';

const realFetch = globalThis.fetch;

describe('runWeeklyReport — 四層匯流', () => {
  let dir: string;
  let registryPath: string;
  let d1Path: string;
  const savedEnv = {
    gsc: process.env.A7_GSC_CREDENTIALS,
    gscJson: process.env.A7_GSC_CREDENTIALS_JSON,
    google: process.env.A7_GOOGLE_CREDENTIALS,
    googleJson: process.env.A7_GOOGLE_CREDENTIALS_JSON,
    bing: process.env.A7_BING_API_KEY,
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'a7seo-weekly-'));
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
            pageTypes: [{ id: 'shop', match: '/s', label: '店家頁' }],
          },
        ],
      })
    );
    d1Path = join(dir, 'layer-d1.txt');
    writeFileSync(d1Path, '鮮度哨兵\n結果：12 CHECK ／ 1 FAIL ／ 2 WARN\n', 'utf8');
    delete process.env.A7_GSC_CREDENTIALS;
    delete process.env.A7_GSC_CREDENTIALS_JSON;
    delete process.env.A7_GOOGLE_CREDENTIALS;
    delete process.env.A7_GOOGLE_CREDENTIALS_JSON;
    delete process.env.A7_BING_API_KEY;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (savedEnv.gsc) process.env.A7_GSC_CREDENTIALS = savedEnv.gsc;
    if (savedEnv.gscJson) process.env.A7_GSC_CREDENTIALS_JSON = savedEnv.gscJson;
    if (savedEnv.google) process.env.A7_GOOGLE_CREDENTIALS = savedEnv.google;
    if (savedEnv.googleJson) process.env.A7_GOOGLE_CREDENTIALS_JSON = savedEnv.googleJson;
    if (savedEnv.bing) process.env.A7_BING_API_KEY = savedEnv.bing;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('四層全部出現在同一份報表裡，缺哪一層都看得出來', async () => {
    const report = await runWeeklyReport(registryPath, {
      d1File: d1Path,
      skip: ['http', 'gsc', 'bing', 'ga4'],
    });
    for (const heading of [
      'AI 搜尋 — GA4 referral',
      '搜尋 · Google — GSC 頁型分群',
      '搜尋 · Bing',
      'D1 層 — 資料鮮度',
      'HTTP 層 — portfolio 健康總表',
    ]) {
      assert.ok(report.markdown.includes(`## ${heading}`), `少了「${heading}」這一節`);
    }
  });

  it('D1 那層的結果行會被拉進標題與摘要表', async () => {
    const report = await runWeeklyReport(registryPath, {
      d1File: d1Path,
      skip: ['http', 'gsc', 'bing', 'ga4'],
    });
    assert.match(report.title, /D1 1紅/);
    assert.match(report.markdown, /1 FAIL/);
  });

  it('沒憑證時標題印破折號而不是 0 —— 那會讓「還沒問」跟「問過了是 0」長得一樣', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const report = await runWeeklyReport(registryPath, { skip: ['http', 'gsc'] });
    assert.match(report.title, /Bing —/);
    assert.match(report.title, /AI —/);
    assert.doesNotMatch(report.title, /Bing 0 點擊/);
  });

  it('--skip 與「沒憑證」在摘要表上要分得出來', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const report = await runWeeklyReport(registryPath, { skip: ['http', 'gsc'] });
    assert.match(report.markdown, /--skip gsc，這一層這次沒跑/);
    assert.match(report.markdown, /金鑰未就緒/);
  });

  it('讀不到 D1 檔就如實寫進報表，不是靜靜消失', async () => {
    const report = await runWeeklyReport(registryPath, {
      d1File: join(dir, 'does-not-exist.txt'),
      skip: ['http', 'gsc', 'bing', 'ga4'],
    });
    assert.equal(report.layers.d1.ok, false);
    assert.match(report.markdown, /讀不到/);
    assert.match(report.markdown, /## D1 層 — 資料鮮度 ✖/);
  });
});
