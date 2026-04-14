#!/usr/bin/env node
import { loadConfig, detectProviders } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { discoverKeywords } from './modules/keywords/discovery.js';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
a7seo - Automated SEO Traffic Engine CLI

Usage:
  a7seo init                        Interactive project setup
  a7seo doctor                      Check dependencies and configuration
  a7seo discover <keywords>         Discover keyword opportunities
  a7seo trends <keywords>           Get Google Trends data

Options:
  --project <id>                    Project ID (default: from config)
  --help                            Show this help

Examples:
  a7seo discover "SEO優化,關鍵字研究"
  a7seo doctor
  a7seo init
`);
}

async function runDoctor() {
  console.log('a7seo doctor - Checking dependencies...\n');

  // Python
  const { spawnSync } = await import('child_process');
  const pyResult = spawnSync('python', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  const py3Result = spawnSync('python3', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  const hasPython = pyResult.status === 0 || py3Result.status === 0;
  const pyVersion = pyResult.status === 0 ? pyResult.stdout.trim() : py3Result.stdout?.trim();
  console.log(`  Python:     ${hasPython ? `OK (${pyVersion})` : 'NOT FOUND - install Python 3'}`);

  // pytrends
  if (hasPython) {
    const cmd = pyResult.status === 0 ? 'python' : 'python3';
    const ptResult = spawnSync(cmd, ['-c', 'import pytrends; print(pytrends.__version__)'], {
      encoding: 'utf-8', timeout: 5000,
    });
    console.log(`  pytrends:   ${ptResult.status === 0 ? `OK (${ptResult.stdout.trim()})` : 'NOT FOUND - run: pip install pytrends'}`);
  }

  // Config
  const config = loadConfig();
  console.log(`  Config:     OK (project: ${config.projectId})`);

  // Providers
  const providers = detectProviders(config);
  console.log(`  Providers:  ${providers.join(', ') || 'none configured'}`);

  // DB
  try {
    const db = getDb(config.dbPath);
    const tables = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number };
    console.log(`  Database:   OK (${config.dbPath}, ${tables.c} tables)`);
    closeDb();
  } catch (err) {
    console.log(`  Database:   ERROR - ${(err as Error).message}`);
  }

  // API keys
  console.log(`  Anthropic:  ${config.anthropicApiKey ? 'OK (key set)' : 'NOT SET - needed for content generation'}`);
  console.log(`  Google Ads: ${config.googleAds?.developerToken ? 'OK (token set)' : 'NOT SET - optional, for Keyword Planner'}`);
  console.log(`  DataForSEO: ${config.dataforseo?.login ? 'OK (credentials set)' : 'NOT SET - optional, for verified data'}`);

  console.log('\nDone.');
}

async function runDiscover(keywords: string) {
  const config = loadConfig();
  const db = getDb(config.dbPath);

  const seeds = keywords.split(',').map(s => s.trim()).filter(Boolean);
  console.log(`Discovering keywords: ${seeds.join(', ')}\n`);

  const result = await discoverKeywords(seeds, config, db);

  console.log(`Providers used: ${result.providersUsed.join(', ')}`);
  console.log(`DataForSEO verified: ${result.dataforseoVerified}\n`);

  for (const kw of result.keywords) {
    console.log(`  ${kw.keyword}`);
    console.log(`    Trend: ${kw.trend || 'unknown'} (interest: ${kw.trendInterest ?? 'N/A'})`);
    if (kw.relatedQueries.length > 0) {
      console.log(`    Related: ${kw.relatedQueries.slice(0, 5).join(', ')}`);
    }
    console.log();
  }

  closeDb();
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'doctor':
      await runDoctor();
      break;
    case 'discover':
      if (!args[1]) {
        console.error('Error: provide keywords. Example: a7seo discover "SEO優化,AI搜尋"');
        process.exit(1);
      }
      await runDiscover(args[1]);
      break;
    case 'init':
      console.log('TODO: Interactive init wizard coming in v0.2');
      console.log('For now, copy seo-engine.config.example.json to seo-engine.config.json and edit it.');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
