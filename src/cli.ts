#!/usr/bin/env node
import { loadConfig, detectProviders } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { discoverKeywords } from './modules/keywords/discovery.js';
import { generateConfig, generatePlatformsScaffold } from './init.js';
import { startServer, startAutopilot } from './agent/server.js';
import { runPortfolioHealth, formatPortfolioTable } from './modules/platforms/portfolio.js';
import { runGscReport, formatGscReport } from './modules/platforms/gsc-report.js';
import { runGa4WeeklyReport, formatGa4Report } from './modules/platforms/ga4-report.js';
import { runBingReport, formatBingReport } from './modules/platforms/bing-report.js';
import { runClarityReport, formatClarityReport } from './modules/platforms/clarity-report.js';
import { runWeeklyReport } from './modules/platforms/weekly.js';
import { CLARITY_DIMENSIONS, type ClarityDimension } from './modules/platforms/clarity.js';
import { writeFileSync } from 'fs';
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
  a7seo portfolio [registryPath] [--all]
                                    Cross-site SEO/GEO health across all live registry sites
                                    (--all also checks sites not yet marked live)
  a7seo gsc [registryPath] [options]
                                    GSC weekly report: per-site totals + page-type breakdown.
                                    Page-type patterns come from registry pageTypes.
                                    Runs without credentials too (sitemap half of the table).
                                      --days N        window length, default 28
                                      --lag N         days back for the end date, default 3
                                      --no-sitemap    skip the sitemap crawl (drops page counts)
                                      --inspect N     sample N URLs per page type for index status
                                      --only a,b      limit to these registry ids
                                      --credentials P service account JSON path (else A7_GSC_CREDENTIALS)
                                      --json          raw JSON instead of the tables
  a7seo ga4 [registryPath] [options]
                                    GA4 weekly report: AI-search referrals per site, per engine,
                                    and - the point of it - which PAGE TYPES that traffic lands on.
                                      --days N        window length, default 28
                                      --lag N         days back for the end date, default 1
                                      --only a,b      limit to these registry ids
                                      --credentials P service account JSON path (same key as gsc)
                                      --json          raw JSON instead of the tables
  a7seo bing [registryPath] [options]
                                    Bing Webmaster report: clicks/impressions/CTR + the SAME
                                    page-type breakdown as the gsc command, so the two engines compare.
                                      --days N        window length, default 28
                                      --only a,b      limit to these registry ids
                                      --bing-key K    API key (else A7_BING_API_KEY)
                                      --json          raw JSON
  a7seo clarity [registryPath] [options]
                                    On-demand friction report (dead/rage/quickback by page type).
                                    NOT part of the weekly report - quota is 10 calls/day per site,
                                    3 days max per call.
                                      --days N        1-3, default 3
                                      --dimensions D  comma list from URL,Source,Medium,Campaign,
                                                      Browser,Device,OS,Country (max 3, default URL)
                                      --only a,b      limit to these registry ids
                                      --json          raw JSON (use this the first time - the
                                                      response parser has not met the live API yet)
  a7seo weekly [registryPath] [options]
                                    The four layers in ONE report (markdown): D1 freshness +
                                    portfolio HTTP + GSC + Bing + GA4 AI referrals.
                                      --d1 FILE       splice in a7-sites check-freshness output
                                      --out FILE      write markdown to FILE, print only the title
                                      --skip a,b      skip layers: http,gsc,bing,ga4
                                      --days N        window length, default 28
                                      --inspect N     GSC index sampling per page type, default 0
                                      --only a,b      limit to these registry ids

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

  const scaffold = generatePlatformsScaffold(process.cwd());

  console.log('');
  if (created) console.log(`  ✓ seo-engine.config.json written`);
  else console.log(`  • seo-engine.config.json already exists (skipped)`);
  if (scaffold.mcp) console.log(`  ✓ .mcp.json written (4-platform MCP servers)`);
  else console.log(`  • .mcp.json already exists (skipped)`);
  if (scaffold.envExample) console.log(`  ✓ .env.platforms.example written`);
  else console.log(`  • .env.platforms.example already exists (skipped)`);

  console.log('\nNext steps:');
  console.log('  1. Add .mcp.json + .env + .env.local to your .gitignore');
  console.log('  2. Copy .env.platforms.example → .env and fill in real values');
  console.log('     (GA4 propertyId, Clarity token, Bing WMT key, etc.)');
  console.log('  3. Set ANTHROPIC_API_KEY env var (for content generation)');
  console.log('  4. Run: a7seo doctor');
  console.log('\nCredential walk-through: see PLATFORMS_SETUP.md in any');
  console.log('existing a7seo-mcp project (e.g., topclass) for a 5-step checklist.');
}

/**
 * 共用的 flag 解析：`--x`（不帶值）與 `--x 5` 都要成立，而且位置參數
 * （registryPath）不能把某個 flag 的值誤認成自己。四個平台指令共用同一套，
 * 各抄一份的下場是「--only 在某支指令上莫名其妙不生效」。
 */
function makeFlagParser(argv: string[], valueFlags: string[]) {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = argv[i + 1];
    return next === undefined || next.startsWith('--') ? undefined : next;
  };
  const int = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`Error: --${name} needs a non-negative number (got "${raw}")`);
      process.exit(1);
    }
    return n;
  };
  const list = (name: string): string[] | undefined =>
    flag(name)?.split(',').map((x) => x.trim()).filter(Boolean);
  const taken = new Set(valueFlags.map((n) => flag(n)).filter((v): v is string => v !== undefined));
  const positional = argv.slice(1).find((a) => !a.startsWith('--') && !taken.has(a));
  return { flag, int, list, positional, has: (name: string) => argv.includes(`--${name}`) };
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
    case 'portfolio': {
      const includeNonLive = args.includes('--all');
      const registryPath = args.slice(1).find((a) => !a.startsWith('--'));
      const report = await runPortfolioHealth(registryPath, { includeNonLive });
      console.log(formatPortfolioTable(report));
      break;
    }
    case 'gsc': {
      // 讓 `--inspect`（不帶值）與 `--inspect 8` 都成立：下一個 token 是另一個 flag 就當沒給值。
      const flag = (name: string): string | undefined => {
        const i = args.indexOf(`--${name}`);
        if (i === -1) return undefined;
        const next = args[i + 1];
        return next === undefined || next.startsWith('--') ? undefined : next;
      };
      const int = (name: string, fallback: number): number => {
        const raw = flag(name);
        if (raw === undefined) return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          console.error(`Error: --${name} needs a non-negative number (got "${raw}")`);
          process.exit(1);
        }
        return n;
      };
      // 第一個不是 flag、也不是某個 flag 的值的位置參數 = registryPath。
      const flagValues = new Set(
        ['days', 'lag', 'inspect', 'only', 'credentials']
          .map((n) => flag(n))
          .filter((v): v is string => v !== undefined)
      );
      const registryPath = args
        .slice(1)
        .find((a) => !a.startsWith('--') && !flagValues.has(a));

      const report = await runGscReport(registryPath, {
        days: int('days', 28),
        lagDays: int('lag', 3),
        withSitemap: !args.includes('--no-sitemap'),
        inspectPerType: args.includes('--inspect') ? int('inspect', 5) : 0,
        credentialsPath: flag('credentials'),
        onlySites: flag('only')?.split(',').map((s) => s.trim()).filter(Boolean),
      });
      console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatGscReport(report));
      break;
    }
    case 'ga4': {
      const p = makeFlagParser(args, ['days', 'lag', 'only', 'credentials']);
      const report = await runGa4WeeklyReport(p.positional, {
        days: p.int('days', 28),
        lagDays: p.int('lag', 1),
        credentialsPath: p.flag('credentials'),
        onlySites: p.list('only'),
      });
      console.log(p.has('json') ? JSON.stringify(report, null, 2) : formatGa4Report(report));
      break;
    }
    case 'bing': {
      const p = makeFlagParser(args, ['days', 'only', 'bing-key']);
      const report = await runBingReport(p.positional, {
        days: p.int('days', 28),
        apiKey: p.flag('bing-key'),
        onlySites: p.list('only'),
      });
      console.log(p.has('json') ? JSON.stringify(report, null, 2) : formatBingReport(report));
      break;
    }
    case 'clarity': {
      const p = makeFlagParser(args, ['days', 'dimensions', 'only']);
      const raw = p.list('dimensions') ?? ['URL'];
      const bad = raw.filter((d) => !CLARITY_DIMENSIONS.includes(d as ClarityDimension));
      if (bad.length) {
        console.error(`Error: unknown Clarity dimension(s): ${bad.join(', ')}`);
        console.error(`Valid: ${CLARITY_DIMENSIONS.join(', ')}`);
        process.exit(1);
      }
      const report = await runClarityReport(p.positional, {
        numOfDays: p.int('days', 3),
        dimensions: raw as ClarityDimension[],
        onlySites: p.list('only'),
        includeRaw: p.has('json'),
      });
      console.log(p.has('json') ? JSON.stringify(report, null, 2) : formatClarityReport(report));
      break;
    }
    case 'weekly': {
      const p = makeFlagParser(args, [
        'days', 'inspect', 'only', 'credentials', 'bing-key', 'd1', 'out', 'skip',
      ]);
      const skip = (p.list('skip') ?? []).filter((x): x is 'http' | 'gsc' | 'bing' | 'ga4' =>
        ['http', 'gsc', 'bing', 'ga4'].includes(x)
      );
      const report = await runWeeklyReport(p.positional, {
        days: p.int('days', 28),
        inspectPerType: p.has('inspect') ? p.int('inspect', 5) : 0,
        onlySites: p.list('only'),
        credentialsPath: p.flag('credentials'),
        bingApiKey: p.flag('bing-key'),
        d1File: p.flag('d1'),
        skip,
      });
      const out = p.flag('out');
      if (out) {
        // 寫檔時 stdout 只吐標題，讓 CI 可以 title=$(a7seo weekly ... --out report.md)
        writeFileSync(out, report.markdown + '\n', 'utf8');
        console.log(report.title);
      } else {
        console.log('# ' + report.title);
        console.log('');
        console.log(report.markdown);
      }
      break;
    }
    case 'autopilot': {
      const config = loadConfig();
      const apPortIdx = args.indexOf('--port');
      const apPort = apPortIdx !== -1 ? parseInt(args[apPortIdx + 1], 10) : undefined;
      startAutopilot({
        port: apPort,
        domain: config.domain,
        cwd: process.cwd(),
        reportsPath: resolve(process.cwd(), 'data', 'reports'),
      });
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
