import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const TEST_DIR = resolve('./test-data/init-test');
const CONFIG_PATH = resolve(TEST_DIR, 'seo-engine.config.json');

// We'll test the generateConfig function directly
let generateConfig: typeof import('../src/init.js').generateConfig;

describe('generateConfig', () => {
  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
    const mod = await import('../src/init.js');
    generateConfig = mod.generateConfig;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('generates a valid JSON config file', () => {
    generateConfig({
      projectId: 'test-project',
      domain: 'test.com',
      language: 'zh-TW',
      region: 'TW',
      publisherAdapter: 'markdown-files',
      outputPath: CONFIG_PATH,
    });

    assert.ok(existsSync(CONFIG_PATH));
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content);
    assert.equal(config.projectId, 'test-project');
    assert.equal(config.domain, 'test.com');
    assert.equal(config.language, 'zh-TW');
  });

  it('sets correct publisher config for markdown-files', () => {
    generateConfig({
      projectId: 'md-test',
      domain: 'test.com',
      language: 'zh-TW',
      region: 'TW',
      publisherAdapter: 'markdown-files',
      outputPath: CONFIG_PATH,
    });

    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(config.publisher.adapter, 'markdown-files');
    assert.ok(config.publisher.config.outputDir);
  });

  it('sets correct publisher config for blogposts-ts', () => {
    generateConfig({
      projectId: 'ts-test',
      domain: 'test.com',
      language: 'zh-TW',
      region: 'TW',
      publisherAdapter: 'blogposts-ts',
      outputPath: CONFIG_PATH,
    });

    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(config.publisher.adapter, 'blogposts-ts');
    assert.ok(config.publisher.config.blogPostsPath);
    assert.ok(config.publisher.config.imagesDir);
  });

  it('includes empty credential placeholders', () => {
    generateConfig({
      projectId: 'cred-test',
      domain: 'test.com',
      language: 'en',
      region: 'US',
      publisherAdapter: 'markdown-files',
      outputPath: CONFIG_PATH,
    });

    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.ok('googleAds' in config);
    assert.equal(config.googleAds.clientId, '');
    assert.ok('dataforseo' in config);
    assert.equal(config.dataforseo.login, '');
  });

  it('does not overwrite existing config', () => {
    // Write a config first
    generateConfig({
      projectId: 'first',
      domain: 'first.com',
      language: 'zh-TW',
      region: 'TW',
      publisherAdapter: 'markdown-files',
      outputPath: CONFIG_PATH,
    });

    // Try to overwrite — should return false
    const result = generateConfig({
      projectId: 'second',
      domain: 'second.com',
      language: 'en',
      region: 'US',
      publisherAdapter: 'markdown-files',
      outputPath: CONFIG_PATH,
      overwrite: false,
    });

    assert.equal(result, false);

    // Original should be preserved
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(config.projectId, 'first');
  });
});
