import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface PublisherConfig {
  adapter: string;
  config: Record<string, string>;
}

export interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  customerId: string;
}

export interface DataForSEOConfig {
  login: string;
  password: string;
}

export interface ProjectConfig {
  projectId: string;
  domain: string;
  language: string;
  region: string;
  dbPath: string;
  publisher: PublisherConfig;
  googleAds?: GoogleAdsConfig;
  dataforseo?: DataForSEOConfig;
  anthropicApiKey?: string;
}

export function loadConfig(): ProjectConfig {
  const configPath = process.env.SEO_ENGINE_CONFIG
    ? resolve(process.env.SEO_ENGINE_CONFIG)
    : resolve(process.cwd(), 'seo-engine.config.json');

  let fileConfig: Partial<ProjectConfig> = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      console.error(`Warning: Could not parse config at ${configPath}`);
    }
  }

  // Env vars override file config for secrets
  const config: ProjectConfig = {
    projectId: fileConfig.projectId || process.env.SEO_PROJECT_ID || 'default',
    domain: fileConfig.domain || process.env.SEO_DOMAIN || 'localhost',
    language: fileConfig.language || process.env.SEO_LANGUAGE || 'zh-TW',
    region: fileConfig.region || process.env.SEO_REGION || 'TW',
    dbPath: fileConfig.dbPath || process.env.SEO_DB_PATH || './data/seo-engine.db',
    publisher: fileConfig.publisher || {
      adapter: 'markdown-files',
      config: { outputDir: './content' },
    },
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey,
  };

  // Google Ads — env vars take precedence
  const gadsClientId =
    process.env.GOOGLE_ADS_CLIENT_ID || fileConfig.googleAds?.clientId;
  const gadsToken =
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN ||
    fileConfig.googleAds?.developerToken;
  if (gadsClientId && gadsToken) {
    config.googleAds = {
      clientId: gadsClientId,
      clientSecret:
        process.env.GOOGLE_ADS_CLIENT_SECRET ||
        fileConfig.googleAds?.clientSecret ||
        '',
      developerToken: gadsToken,
      refreshToken:
        process.env.GOOGLE_ADS_REFRESH_TOKEN ||
        fileConfig.googleAds?.refreshToken ||
        '',
      customerId:
        process.env.GOOGLE_ADS_CUSTOMER_ID ||
        fileConfig.googleAds?.customerId ||
        '',
    };
  }

  // DataForSEO — env vars take precedence
  const dfsLogin =
    process.env.DATAFORSEO_LOGIN || fileConfig.dataforseo?.login;
  const dfsPassword =
    process.env.DATAFORSEO_PASSWORD || fileConfig.dataforseo?.password;
  if (dfsLogin && dfsPassword) {
    config.dataforseo = { login: dfsLogin, password: dfsPassword };
  }

  return config;
}

export function detectProviders(config: ProjectConfig): string[] {
  const providers: string[] = ['google-trends']; // Always available (if Python exists)
  if (config.googleAds?.developerToken) providers.push('google-planner');
  if (config.dataforseo?.login) providers.push('dataforseo');
  return providers;
}
