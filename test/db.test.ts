import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDb } from '../src/db/client.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = resolve('./test-data/test.db');

function cleanTestDb() {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    const f = TEST_DB + ext;
    if (existsSync(f)) unlinkSync(f);
  }
}

describe('Database', () => {
  beforeEach(() => {
    mkdirSync(resolve('./test-data'), { recursive: true });
    cleanTestDb();
  });

  afterEach(() => {
    cleanTestDb();
  });

  it('creates database with all tables', () => {
    const db = getDb(TEST_DB);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes('projects'));
    assert.ok(tableNames.includes('keywords'));
    assert.ok(tableNames.includes('articles'));
    assert.ok(tableNames.includes('rank_history'));
    assert.ok(tableNames.includes('provider_cache'));
    assert.ok(tableNames.includes('schema_version'));
  });

  it('sets WAL journal mode', () => {
    const db = getDb(TEST_DB);
    const mode = db.pragma('journal_mode') as { journal_mode: string }[];
    assert.equal(mode[0].journal_mode, 'wal');
  });

  it('records migration version', () => {
    const db = getDb(TEST_DB);
    const row = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number };
    assert.equal(row.v, 1);
  });

  it('migration is idempotent', () => {
    const db1 = getDb(TEST_DB);
    closeDb();
    // Open again — should not crash or re-run migration
    const db2 = getDb(TEST_DB);
    const row = db2
      .prepare('SELECT COUNT(*) as c FROM schema_version')
      .get() as { c: number };
    assert.equal(row.c, 1); // Only 1 migration record
  });

  it('inserts and retrieves keywords', () => {
    const db = getDb(TEST_DB);

    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)')
      .run('test', 'Test', 'test.com');

    db.prepare(`
      INSERT INTO keywords (project_id, keyword, volume, volume_source, trend, trend_interest)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('test', 'SEO優化', 5000, 'google-trends', 'rising', 78);

    const kw = db
      .prepare('SELECT * FROM keywords WHERE project_id = ? AND keyword = ?')
      .get('test', 'SEO優化') as Record<string, unknown>;

    assert.equal(kw.keyword, 'SEO優化');
    assert.equal(kw.volume, 5000);
    assert.equal(kw.trend, 'rising');
    assert.equal(kw.trend_interest, 78);
  });

  it('enforces unique keyword per project', () => {
    const db = getDb(TEST_DB);

    db.prepare('INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)')
      .run('test', 'Test', 'test.com');

    db.prepare('INSERT INTO keywords (project_id, keyword) VALUES (?, ?)')
      .run('test', 'SEO');

    assert.throws(() => {
      db.prepare('INSERT INTO keywords (project_id, keyword) VALUES (?, ?)')
        .run('test', 'SEO');
    });
  });

  it('cache insert and retrieval works', () => {
    const db = getDb(TEST_DB);

    db.prepare(`
      INSERT INTO provider_cache (provider, cache_key, response_json, expires_at)
      VALUES (?, ?, ?, datetime('now', '+1 hour'))
    `).run('test-provider', 'key-1', '{"data":"cached"}');

    const row = db
      .prepare(
        "SELECT response_json FROM provider_cache WHERE provider = ? AND cache_key = ? AND expires_at > datetime('now')"
      )
      .get('test-provider', 'key-1') as { response_json: string } | undefined;

    assert.ok(row);
    assert.equal(JSON.parse(row.response_json).data, 'cached');
  });

  it('expired cache not returned', () => {
    const db = getDb(TEST_DB);

    db.prepare(`
      INSERT INTO provider_cache (provider, cache_key, response_json, expires_at)
      VALUES (?, ?, ?, datetime('now', '-1 hour'))
    `).run('test-provider', 'expired-key', '{"data":"old"}');

    const row = db
      .prepare(
        "SELECT response_json FROM provider_cache WHERE provider = ? AND cache_key = ? AND expires_at > datetime('now')"
      )
      .get('test-provider', 'expired-key') as { response_json: string } | undefined;

    assert.equal(row, undefined);
  });
});
