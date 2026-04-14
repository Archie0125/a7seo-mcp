import { spawn, spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  KeywordProvider,
  KeywordResult,
  DiscoveryOptions,
} from './base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = resolve(__dirname, '..', '..', '..', '..', 'python', 'google_trends.py');

// Validate keyword characters: allow alphanumeric, CJK, spaces, hyphens, underscores
const SAFE_KEYWORD_PATTERN = /^[\p{L}\p{N}\s\-_.,]+$/u;

function findPython(): string | null {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.status === 0) return cmd;
    } catch {
      // continue
    }
  }
  return null;
}

let pythonCmd: string | null | undefined;

export const googleTrendsProvider: KeywordProvider = {
  name: 'google-trends',
  tier: 'free',

  async isAvailable(): Promise<boolean> {
    if (pythonCmd === undefined) {
      pythonCmd = findPython();
    }
    return pythonCmd !== null;
  },

  async discover(
    seeds: string[],
    options: DiscoveryOptions
  ): Promise<KeywordResult[]> {
    if (pythonCmd === undefined) {
      pythonCmd = findPython();
    }
    if (!pythonCmd) {
      throw new Error('Python not found. Install Python 3 and pytrends to use Google Trends.');
    }

    // Validate seeds
    const safeSeedsList = seeds
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && SAFE_KEYWORD_PATTERN.test(s));

    if (safeSeedsList.length === 0) {
      return [];
    }

    // pytrends allows max 5 keywords at a time
    const batches: string[][] = [];
    for (let i = 0; i < safeSeedsList.length; i += 5) {
      batches.push(safeSeedsList.slice(i, i + 5));
    }

    const allResults: KeywordResult[] = [];

    for (const batch of batches) {
      const args = [
        PYTHON_SCRIPT,
        '--keywords',
        batch.join(','),
        '--geo',
        options.region || 'TW',
        '--timeframe',
        options.timeframe || 'today 12-m',
        '--hl',
        options.language || 'zh-TW',
      ];

      const result = await runPython(pythonCmd, args);
      const parsed = JSON.parse(result);

      for (const kw of parsed.keywords || []) {
        allResults.push({
          keyword: kw.keyword,
          volume: null,
          volumeSource: 'google-trends',
          volumeConfidence: 'relative_only',
          difficulty: null,
          cpc: null,
          intent: null,
          trend: kw.trend || null,
          trendInterest: kw.interest ?? null,
          relatedQueries: kw.related_queries || [],
        });
      }

      // Rate limiting: 2s delay between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    return allResults;
  },
};

function runPython(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `Python process exited with code ${code}: ${stderr.slice(0, 500)}`
          )
        );
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}
