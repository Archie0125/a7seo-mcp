/**
 * Portfolio 跨站監控：讀 a7-sites 的 registry/sites.json，對每個站跑
 * runSeoHealthCheck（純 HTTP、免憑證），彙整成「一次看所有網址」的總表。
 *
 * 這是 a7seo-mcp 從「per-project」擴到「portfolio-wide」的第一步——
 * 立即可用的那層。四平台流量指標（GA4/GSC/Clarity/Bing）之後再 chain。
 */
import { readFileSync } from 'node:fs';
import { runSeoHealthCheck, type HealthCheckResult } from './health-check.js';

export interface RegistrySite {
  id: string;
  name: string;
  origin: string;
  domain?: string;
  status?: string;
  analytics?: Record<string, string>;
}

export interface PortfolioSiteReport {
  id: string;
  name: string;
  origin: string;
  status?: string;
  analytics?: Record<string, string>;
  health: HealthCheckResult | null;
  error?: string;
  /** true = 沒跑 health check（非 live 站），不是檢測失敗。 */
  skipped?: boolean;
  skipReason?: string;
}

export interface PortfolioReport {
  registryPath: string;
  /** registry 內的站總數（含被跳過的）。 */
  count: number;
  /** 實際跑了 health check 的站數。 */
  checked: number;
  /** 因非 live 而跳過的站數。 */
  skipped: number;
  sites: PortfolioSiteReport[];
  totals: { green: number; yellow: number; red: number };
}

export interface PortfolioOptions {
  /** 連未上線（status !== 'live'）的站一起檢測。預設 false。 */
  includeNonLive?: boolean;
}

/** registry 裡代表「這站已上線、該被監控」的 status。 */
const LIVE_STATUS = 'live';

/** 解析 registry 路徑：明確參數 > 環境變數 A7_REGISTRY_PATH > 已知預設。 */
export function resolveRegistryPath(explicit?: string): string {
  return (
    explicit ||
    process.env.A7_REGISTRY_PATH ||
    'C:\\Users\\A7\\Desktop\\a7-sites\\registry\\sites.json'
  );
}

export function loadRegistry(registryPath: string): RegistrySite[] {
  const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as { sites?: RegistrySite[] };
  return raw.sites ?? [];
}

/**
 * 對 registry 的站跑 health check。
 *
 * 只跑 status === 'live' 的站：未上線的站（網域還沒指過來）每次都必然噴 error，
 * 那不是「發現問題」而是常態雜訊，會淹掉真的紅燈。非 live 的站明確標成
 * skipped 而不是 error——跳過的事實留在報表上，不會被靜靜吃掉。
 */
export async function runPortfolioHealth(
  registryPathArg?: string,
  options: PortfolioOptions = {}
): Promise<PortfolioReport> {
  const registryPath = resolveRegistryPath(registryPathArg);
  const sites = loadRegistry(registryPath);

  const reports: PortfolioSiteReport[] = await Promise.all(
    sites.map(async (s): Promise<PortfolioSiteReport> => {
      const base = {
        id: s.id,
        name: s.name,
        origin: s.origin,
        status: s.status,
        analytics: s.analytics,
      };

      if (!options.includeNonLive && s.status !== LIVE_STATUS) {
        return {
          ...base,
          health: null,
          skipped: true,
          skipReason: `status=${s.status ?? 'unknown'} (not ${LIVE_STATUS}) — not monitored yet`,
        };
      }

      try {
        const health = await runSeoHealthCheck(s.origin);
        return { ...base, health };
      } catch (err) {
        return { ...base, health: null, error: (err as Error).message };
      }
    })
  );

  const totals = reports.reduce(
    (acc, r) => {
      if (r.health) {
        acc.green += r.health.summary.green;
        acc.yellow += r.health.summary.yellow;
        acc.red += r.health.summary.red;
      }
      return acc;
    },
    { green: 0, yellow: 0, red: 0 }
  );

  return {
    registryPath,
    count: sites.length,
    checked: reports.filter((r) => !r.skipped).length,
    skipped: reports.filter((r) => r.skipped).length,
    sites: reports,
    totals,
  };
}

/** 給 CLI 用的可讀總表。 */
export function formatPortfolioTable(report: PortfolioReport): string {
  const lines: string[] = [];
  lines.push(
    `Portfolio 健康總表（檢測 ${report.checked} 站` +
      (report.skipped > 0 ? `，跳過 ${report.skipped} 站` : '') +
      `）  來源：${report.registryPath}`
  );
  lines.push('='.repeat(60));
  for (const s of report.sites) {
    if (s.skipped) {
      lines.push(`⏭ ${s.name}（${s.status ?? '?'}）  略過：${s.skipReason ?? '非 live'}  ${s.origin}`);
      continue;
    }
    if (!s.health) {
      lines.push(`✖ ${s.name}（${s.status ?? '?'}）  無法檢測：${s.error ?? 'unknown'}  ${s.origin}`);
      continue;
    }
    const { green, yellow, red } = s.health.summary;
    lines.push(`${s.name}（${s.status ?? '?'}）  🟢${green} 🟡${yellow} 🔴${red}   ${s.origin}`);
    for (const f of s.health.findings) {
      if (f.level === 'red') lines.push(`    🔴 ${f.label}：${f.detail}`);
    }
    for (const f of s.health.findings) {
      if (f.level === 'yellow') lines.push(`    🟡 ${f.label}：${f.detail}`);
    }
  }
  lines.push('-'.repeat(60));
  lines.push(`合計  🟢${report.totals.green} 🟡${report.totals.yellow} 🔴${report.totals.red}`);
  return lines.join('\n');
}
