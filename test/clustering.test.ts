import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clusterKeywords } from '../src/modules/keywords/clustering.js';
import { getDb, closeDb } from '../src/db/client.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = resolve('./test-data/cluster-test.db');

function cleanTestDb() {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    const f = TEST_DB + ext;
    if (existsSync(f)) unlinkSync(f);
  }
}

const testConfig = {
  projectId: 'test',
  domain: 'test.com',
  language: 'zh-TW',
  region: 'TW',
  dbPath: TEST_DB,
  publisher: { adapter: 'markdown-files', config: { outputDir: './test-content' } },
};

describe('clusterKeywords', () => {
  beforeEach(() => {
    mkdirSync(resolve('./test-data'), { recursive: true });
    cleanTestDb();
  });

  afterEach(() => {
    cleanTestDb();
  });

  it('returns error for empty input', async () => {
    const db = getDb(TEST_DB);
    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)').run('test', 'Test', 'test.com');

    const result = await clusterKeywords([], testConfig, db);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'EMPTY_INPUT');
  });

  it('clusters related keywords together', async () => {
    const db = getDb(TEST_DB);
    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)').run('test', 'Test', 'test.com');

    const keywords = ['SEO優化', 'SEO工具', 'SEO教學', '關鍵字研究', '關鍵字工具'];
    const result = await clusterKeywords(keywords, testConfig, db);

    assert.equal(result.success, true);
    assert.ok(result.data);
    assert.ok(result.data.length > 0);
    assert.ok(result.data.length <= keywords.length);

    // Every keyword should be in exactly one cluster
    const allKeywords = result.data.flatMap((c) => c.keywords);
    assert.equal(allKeywords.length, keywords.length);
    for (const kw of keywords) {
      assert.ok(allKeywords.includes(kw), `${kw} should be in a cluster`);
    }
  });

  it('saves clusters to database', async () => {
    const db = getDb(TEST_DB);
    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)').run('test', 'Test', 'test.com');

    await clusterKeywords(['SEO', 'AI'], testConfig, db);

    const clusters = db
      .prepare('SELECT * FROM keyword_clusters WHERE project_id = ?')
      .all('test');
    assert.ok(clusters.length > 0);
  });

  it('each cluster has a name and primary keyword', async () => {
    const db = getDb(TEST_DB);
    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)').run('test', 'Test', 'test.com');

    const result = await clusterKeywords(['SEO', 'AI', 'ML'], testConfig, db);
    assert.ok(result.data);
    for (const cluster of result.data) {
      assert.ok(cluster.name, 'cluster should have a name');
      assert.ok(cluster.primaryKeyword, 'cluster should have a primary keyword');
      assert.ok(cluster.keywords.length > 0, 'cluster should have keywords');
    }
  });
});
