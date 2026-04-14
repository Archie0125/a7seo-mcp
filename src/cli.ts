#!/usr/bin/env node
import { loadConfig, detectProviders } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { discoverKeywords } from './modules/keywords/discovery.js';
import { generateConfig } from './init.js';
import { startServer } from './agent/server.js';
import { resolve } from 'path';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
a7seo - Automated SEO Traffic Engine CLI

Usage:
  a7seo init                        Interactive project setup
  a7seo doctor                      Check dependencies and configuration
  a7seo discover <keywords>         Discover keyword opportunities
  a7seo serve                       Start HTTP agent server
  a7seo serve --port 8080           Start on custom port

Options:
  --project <id>                    Project ID (default: from config)
  --port <number>                   Agent server port (default: 4000)
  --help                            Show this help

Examples:
  a7seo discover "SEO優化,關鍵字研究"
  a7seo serve
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

function ask(rl: ReturnType<typeof createInterface>, question: string, defaultVal?: string): Promise<string> {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function runInit() {
  const outputPath = resolve(process.cwd(), 'seo-engine.config.json');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\na7seo init — Project setup\n');

  const projectId = await ask(rl, 'Project ID', 'my-project');
  const domain = await ask(rl, 'Domain', 'example.com');
  const language = await ask(rl, 'Language', 'zh-TW');
  const region = await ask(rl, 'Region', 'TW');

  console.log('\nPublisher adapters:');
  console.log('  1) markdown-files — Write .md files (Astro, Next.js, Hugo)');
  console.log('  2) blogposts-ts  — Insert into data/blogPosts.ts (React SPA)');
  console.log('  3) wordpress     — WordPress REST API');
  const adapterChoice = await ask(rl, 'Choose publisher (1/2/3)', '1');

  const adapterMap: Record<string, 'markdown-files' | 'blogposts-ts' | 'wordpress'> = {
    '1': 'markdown-files',
    '2': 'blogposts-ts',
    '3': 'wordpress',
    'markdown-files': 'markdown-files',
    'blogposts-ts': 'blogposts-ts',
    'wordpress': 'wordpress',
  };
  const publisherAdapter = adapterMap[adapterChoice] || 'markdown-files';

  rl.close();

  const created = generateConfig({
    projectId,
    domain,
    language,
    region,
    publisherAdapter,
    outputPath,
  });

  if (created) {
    console.log(`\nConfig written to: ${outputPath}`);
    console.log('\nNext steps:');
    console.log('  1. Set ANTHROPIC_API_KEY env var (for content generation)');
    console.log('  2. Optional: Set GOOGLE_ADS_* or DATAFORSEO_* env vars');
    console.log('  3. Add a7seo to .claude/mcp.json (see README)');
    console.log('  4. Run: a7seo doctor');
  } else {
    console.log(`\nConfig already exists at ${outputPath}. Use --force to overwrite.`);
  }
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
      await runInit();
      break;
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined;
      startServer(port);
      break;
    }
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
