import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, detectProviders } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns defaults when no config file or env vars', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    delete process.env.SEO_PROJECT_ID;
    delete process.env.SEO_DOMAIN;

    const config = loadConfig();
    assert.equal(config.projectId, 'default');
    assert.equal(config.domain, 'localhost');
    assert.equal(config.language, 'zh-TW');
    assert.equal(config.region, 'TW');
  });

  it('env vars override defaults', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    process.env.SEO_PROJECT_ID = 'my-project';
    process.env.SEO_DOMAIN = 'example.com';
    process.env.SEO_LANGUAGE = 'en';
    process.env.SEO_REGION = 'US';

    const config = loadConfig();
    assert.equal(config.projectId, 'my-project');
    assert.equal(config.domain, 'example.com');
    assert.equal(config.language, 'en');
    assert.equal(config.region, 'US');
  });

  it('loads Google Ads config from env vars', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    process.env.GOOGLE_ADS_CLIENT_ID = 'client-123';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'token-456';

    const config = loadConfig();
    assert.ok(config.googleAds);
    assert.equal(config.googleAds.clientId, 'client-123');
    assert.equal(config.googleAds.developerToken, 'token-456');
  });

  it('does not create googleAds when no credentials', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    delete process.env.GOOGLE_ADS_CLIENT_ID;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    const config = loadConfig();
    assert.equal(config.googleAds, undefined);
  });

  it('loads DataForSEO config from env vars', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    process.env.DATAFORSEO_LOGIN = 'user@test.com';
    process.env.DATAFORSEO_PASSWORD = 'secret';

    const config = loadConfig();
    assert.ok(config.dataforseo);
    assert.equal(config.dataforseo.login, 'user@test.com');
    assert.equal(config.dataforseo.password, 'secret');
  });
});

describe('detectProviders', () => {
  it('always includes google-trends', () => {
    const config = loadConfig();
    const providers = detectProviders(config);
    assert.ok(providers.includes('google-trends'));
  });

  it('includes google-planner when googleAds configured', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    process.env.GOOGLE_ADS_CLIENT_ID = 'x';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'x';

    const config = loadConfig();
    const providers = detectProviders(config);
    assert.ok(providers.includes('google-planner'));

    delete process.env.GOOGLE_ADS_CLIENT_ID;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  });

  it('includes dataforseo when credentials configured', () => {
    process.env.SEO_ENGINE_CONFIG = '/nonexistent/path.json';
    process.env.DATAFORSEO_LOGIN = 'x';
    process.env.DATAFORSEO_PASSWORD = 'x';

    const config = loadConfig();
    const providers = detectProviders(config);
    assert.ok(providers.includes('dataforseo'));

    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
  });
});
