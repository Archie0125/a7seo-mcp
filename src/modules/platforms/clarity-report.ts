/**
 * Clarity 摩擦點報表（按需，不進週報 —— 理由見 clarity.ts 檔頭的配額說明）。
 *
 * 想回答的問題只有一個：**AI 或搜尋把人帶進來之後，他們卡在哪一頁。**
 * 所以預設維度是 URL，而且結果依 registry 的 pageTypes 分群 —— 跟 GSC 表二、
 * Bing 頁型表同一組 pattern，三張表才對得起來。
 */
import {
  fetchClarityInsights,
  loadClarityToken,
  ClarityCredentialsError,
  CLARITY_MAX_DAYS,
  type ClarityDimension,
  type ClarityMetric,
} from './clarity.js';
import { matchPageType } from './gsc-report.js';
import { loadRegistry, resolveRegistryPath } from './portfolio.js';
import { formatTable, num } from './report-format.js';

const LIVE_STATUS = 'live';
const OTHER_TYPE = { id: '_other', label: '（未分類）' };

/** 這幾個是「使用者卡住了」的直接訊號，排前面。 */
const FRICTION_METRICS = ['DeadClickCount', 'RageClickCount', 'QuickbackClick', 'ErrorClickCount'];

export interface ClaritySiteReport {
  id: string;
  name: string;
  projectId?: string;
  error?: string;
  hint?: string;
  metrics?: ClarityMetric[];
  /** 摩擦訊號依頁型彙總：頁型 → metric → 次數。 */
  byPageType?: Array<{ id: string; label: string; counts: Record<string, number> }>;
  raw?: unknown;
}

export interface ClarityReport {
  registryPath: string;
  generatedAt: string;
  numOfDays: number;
  dimensions: ClarityDimension[];
  callsMade: number;
  sites: ClaritySiteReport[];
}

export interface ClarityReportOptions {
  /** 最多 3（官方硬限制）。 */
  numOfDays?: number;
  dimensions?: ClarityDimension[];
  onlySites?: string[];
  includeRaw?: boolean;
}

export async function runClarityReport(
  registryPathArg?: string,
  options: ClarityReportOptions = {}
): Promise<ClarityReport> {
  const {
    numOfDays = CLARITY_MAX_DAYS,
    dimensions = ['URL'],
    onlySites,
    includeRaw = false,
  } = options;

  const registryPath = resolveRegistryPath(registryPathArg);
  const only = onlySites && onlySites.length ? new Set(onlySites) : null;
  const targets = loadRegistry(registryPath).filter(
    (s) => s.status === LIVE_STATUS && (!only || only.has(s.id))
  );

  const report: ClarityReport = {
    registryPath,
    generatedAt: new Date().toISOString(),
    numOfDays,
    dimensions,
    callsMade: 0,
    sites: [],
  };

  for (const site of targets) {
    const sr: ClaritySiteReport = {
      id: site.id,
      name: site.name,
      projectId: site.analytics?.clarity,
    };
    try {
      const token = loadClarityToken(site.id);
      const { metrics, raw } = await fetchClarityInsights(token, dimensions, numOfDays);
      report.callsMade++;
      sr.metrics = metrics;
      if (includeRaw) sr.raw = raw;

      if (dimensions[0] === 'URL') {
        const buckets = new Map<string, { id: string; label: string; counts: Record<string, number> }>();
        for (const m of metrics) {
          if (!FRICTION_METRICS.includes(m.metricName)) continue;
          for (const row of m.rows) {
            if (!row.dimension) continue;
            let pathname = row.dimension;
            try {
              pathname = new URL(row.dimension, site.origin).pathname;
            } catch {
              /* 已經是路徑就直接用 */
            }
            const def = matchPageType(pathname, site.pageTypes ?? []) ?? OTHER_TYPE;
            const b = buckets.get(def.id) ?? { id: def.id, label: def.label, counts: {} };
            b.counts[m.metricName] = (b.counts[m.metricName] ?? 0) + row.value;
            buckets.set(def.id, b);
          }
        }
        sr.byPageType = [...buckets.values()].sort(
          (a, b) =>
            Object.values(b.counts).reduce((x, y) => x + y, 0) -
            Object.values(a.counts).reduce((x, y) => x + y, 0)
        );
      }
    } catch (err) {
      sr.error = (err as Error).message;
      if (err instanceof ClarityCredentialsError) sr.hint = err.hint;
    }
    report.sites.push(sr);
  }

  return report;
}

export function formatClarityReport(report: ClarityReport): string {
  const out: string[] = [];
  out.push(
    `Clarity 摩擦點 — 最近 ${report.numOfDays} 天，維度 ${report.dimensions.join(' / ')}（本次用掉 ${report.callsMade} 次配額，每站每天上限 10）`
  );
  out.push(`來源：${report.registryPath}`);
  out.push('');
  for (const s of report.sites) {
    out.push(`--- ${s.name}（${s.id}）  project ${s.projectId ?? '?'}`);
    if (s.error) {
      out.push(`    ✖ ${s.error}`);
      if (s.hint) out.push(`    → ${s.hint}`);
      out.push('');
      continue;
    }
    const unparsed = s.metrics?.filter((m) => m.unparsed).map((m) => m.metricName) ?? [];
    if (unparsed.length) {
      out.push(`    ⚠ 這些 metric 的數值欄認不出來（先跑 --json 看原始回應）：${unparsed.join('、')}`);
    }
    if (s.byPageType?.length) {
      const cols = FRICTION_METRICS.filter((m) => s.byPageType?.some((b) => b.counts[m]));
      out.push(
        ...formatTable(
          ['頁型', ...cols],
          s.byPageType.map((b) => [b.label, ...cols.map((c) => num(b.counts[c] ?? 0))]),
          [false, ...cols.map(() => true)]
        ).map((l) => `    ${l}`)
      );
    } else if (s.metrics?.length) {
      out.push(`    （拿到 ${s.metrics.length} 個 metric，但不是 URL 維度，沒有頁型分群）`);
    } else {
      out.push('    （沒有資料）');
    }
    out.push('');
  }
  out.push('這份**不進每週報表**：Clarity 每個 project 每天只有 10 次呼叫、單次最多 3 天，');
  out.push('視窗跟另外三層的 28 天對不起來。要看就按需跑，別排程。');
  return out.join('\n');
}
