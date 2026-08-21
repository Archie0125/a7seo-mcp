/**
 * GA4 週報：AI 搜尋 referral 量測。
 *
 * 這一層回答的問題跟 GSC 那層不同。GSC 問「傳統 SERP 上有沒有人搜、搜哪個頁型」，
 * 答案已經量出來了：五站 28 天 68,350 曝光、CTR 2.1%、car 排序 6.6 卻只有 1.5%
 * CTR —— 因為搜店名的人要的是那家店本身（Google Business Profile、地圖、電話），
 * 目錄站只能撿殘渣。這一層問的是另一件事：**同一批內容餵給 AI 搜尋時，價值結構
 * 是不是不一樣。**
 *
 * 三張表，重點在第三張：
 *   表一 五站 × 工作階段／使用者／AI 佔比          ← 分母，看得到規模
 *   表二 AI 來源 × 站                                ← 哪個引擎在引用我們
 *   表三 **AI 落點頁型**                             ← AI 在引用我們的哪一種頁
 *
 * 表三才是會改變決策的那張。總量小的時候「ChatGPT 帶了 12 個 session」什麼都證明
 * 不了，但「那 12 個全部落在 /cal 與 /additive」會告訴我們 AI 要的是結構化事實頁，
 * 而不是我們印了幾萬頁的店家目錄 —— 那正是下一輪該押哪一邊的依據。
 */
import {
  getGa4AccessToken,
  mapMeasurementIdsToProperties,
  runGa4Report,
  runGa4ReportWithLandingPage,
  type Ga4PropertySummary,
  type Ga4Row,
} from './ga4.js';
import { GoogleCredentialsError, loadServiceAccount } from './google-auth.js';
import { matchPageType } from './gsc-report.js';
import { loadRegistry, resolveRegistryPath, type RegistrySite } from './portfolio.js';
import { formatTable, num, pct } from './report-format.js';
import {
  AI_ENGINE_ORDER,
  classifySource,
  type SourceGroup,
} from './traffic-source.js';

const LIVE_STATUS = 'live';

const SESSION_METRICS = ['sessions', 'totalUsers', 'engagedSessions', 'userEngagementDuration'];

/** 未命中任何宣告 pattern 的落點頁都落在這裡。 */
const OTHER_TYPE = { id: '_other', label: '（未分類）' };

export interface Ga4Totals {
  sessions: number;
  users: number;
  engagedSessions: number;
  engagementSeconds: number;
}

export interface Ga4EngineStat {
  engine: string;
  sessions: number;
  users: number;
  engagedSessions: number;
}

export interface Ga4LandingTypeStat {
  id: string;
  label: string;
  sessions: number;
  /** 該頁型底下工作階段最多的幾條落點路徑（AI 到底引用了哪幾頁）。 */
  topPages: Array<{ path: string; sessions: number; engines: string[] }>;
}

export interface Ga4SuspiciousSource {
  source: string;
  medium: string;
  sessions: number;
  reason: string;
}

export interface Ga4SiteReport {
  id: string;
  name: string;
  origin: string;
  measurementId?: string;
  propertyId?: string;
  /** property id 從哪來的：registry 明寫，還是靠 Admin API 對 measurement id 找出來的。 */
  propertyResolvedBy?: 'registry' | 'discovery';
  error?: string;
  hint?: string;
  totals?: Ga4Totals;
  byGroup?: Record<SourceGroup, { sessions: number; users: number }>;
  ai?: { totals: Ga4Totals; byEngine: Ga4EngineStat[] };
  aiLanding?: Ga4LandingTypeStat[];
  aiLandingSkipReason?: string;
  landingDimension?: string;
  suspicious?: Ga4SuspiciousSource[];
}

export interface Ga4Report {
  registryPath: string;
  generatedAt: string;
  range: { startDate: string; endDate: string; days: number };
  credentials: { configured: boolean; clientEmail?: string; error?: string; hint?: string };
  /** 這次靠 Admin API 找出來的 measurement id → property id，貼回 registry 就不用再找。 */
  discovered?: Array<{ measurementId: string; propertyId: string; displayName: string }>;
  sites: Ga4SiteReport[];
  totals: Ga4Totals;
  aiTotals: Ga4Totals;
}

export interface Ga4ReportOptions {
  days?: number;
  /** 往回推幾天當結束日。GA4 當日資料會變動，預設 1。 */
  lagDays?: number;
  credentialsPath?: string;
  onlySites?: string[];
  /** 每個頁型列幾條落點頁，預設 3。 */
  topPagesPerType?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function resolveGa4Range(days: number, lagDays: number): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - lagDays * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: ymd(start), endDate: ymd(end) };
}

function emptyTotals(): Ga4Totals {
  return { sessions: 0, users: 0, engagedSessions: 0, engagementSeconds: 0 };
}

function addRow(t: Ga4Totals, m: Record<string, number>): void {
  t.sessions += m.sessions ?? 0;
  t.users += m.totalUsers ?? 0;
  t.engagedSessions += m.engagedSessions ?? 0;
  t.engagementSeconds += m.userEngagementDuration ?? 0;
}

function emptyGroups(): Record<SourceGroup, { sessions: number; users: number }> {
  return {
    ai: { sessions: 0, users: 0 },
    search: { sessions: 0, users: 0 },
    social: { sessions: 0, users: 0 },
    direct: { sessions: 0, users: 0 },
    referral: { sessions: 0, users: 0 },
    unset: { sessions: 0, users: 0 },
  };
}

/**
 * registry 站 → GA4 property id。
 *
 * registry 記的是網頁上貼的 measurement id（G-XXXX），Data API 只認純數字 property id，
 * 兩者沒有字面關係。所以：registry 明寫 `analytics.ga4Property` 就直接用（快、少兩次
 * API），沒寫就靠 Admin API 對照 —— 對照結果會印在報表尾巴，貼回 registry 一次就好。
 */
export function declaredPropertyId(site: RegistrySite): string | undefined {
  const raw = site.analytics?.ga4Property;
  return raw && /^\d+$/.test(raw.trim()) ? raw.trim() : undefined;
}

/** 用 sessions 排序後取前 n 條，同分時用路徑排序保證輸出穩定（週與週之間可比）。 */
function topN<T extends { sessions: number; path: string }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path)).slice(0, n);
}

export async function runGa4WeeklyReport(
  registryPathArg?: string,
  options: Ga4ReportOptions = {}
): Promise<Ga4Report> {
  const { days = 28, lagDays = 1, credentialsPath, onlySites, topPagesPerType = 3 } = options;

  const registryPath = resolveRegistryPath(registryPathArg);
  const allSites = loadRegistry(registryPath);
  const range = resolveGa4Range(days, lagDays);
  const only = onlySites && onlySites.length ? new Set(onlySites) : null;
  const targets = allSites.filter((s) => s.status === LIVE_STATUS && (!only || only.has(s.id)));

  const report: Ga4Report = {
    registryPath,
    generatedAt: new Date().toISOString(),
    range: { ...range, days },
    credentials: { configured: false },
    sites: [],
    totals: emptyTotals(),
    aiTotals: emptyTotals(),
  };

  // 憑證拿不到不是「壞了」是「還沒設定」：印指引、exit 0，別讓每週報表為此紅一次。
  let token: string;
  try {
    const sa = loadServiceAccount(credentialsPath);
    report.credentials.clientEmail = sa.client_email;
    token = await getGa4AccessToken(sa);
    report.credentials.configured = true;
  } catch (err) {
    if (err instanceof GoogleCredentialsError) {
      report.credentials.error = err.message;
      report.credentials.hint = err.hint;
    } else {
      report.credentials.error = (err as Error).message;
      report.credentials.hint =
        '憑證看起來有效，但換 GA4 token 失敗。GCP 專案要另外啟用 Google Analytics Data API 與 Google Analytics Admin API，見 docs/gsc-setup.md 的 GA4 那節。';
    }
    report.sites = targets.map((s) => ({
      id: s.id,
      name: s.name,
      origin: s.origin,
      measurementId: s.analytics?.ga4,
      propertyId: declaredPropertyId(s),
      error: '沒有 GA4 憑證',
    }));
    return report;
  }

  // --- property id：registry 明寫的直接用，其餘一次批次對照
  const needDiscovery = new Map<string, RegistrySite>();
  for (const site of targets) {
    if (declaredPropertyId(site)) continue;
    const mid = site.analytics?.ga4?.trim();
    if (mid) needDiscovery.set(mid, site);
  }
  let discovered = new Map<string, Ga4PropertySummary>();
  let discoveryError: string | undefined;
  if (needDiscovery.size > 0) {
    try {
      discovered = await mapMeasurementIdsToProperties(token, new Set(needDiscovery.keys()));
      report.discovered = [...discovered.entries()].map(([measurementId, p]) => ({
        measurementId,
        propertyId: p.propertyId,
        displayName: p.displayName,
      }));
    } catch (err) {
      discoveryError = (err as Error).message;
    }
  }

  for (const site of targets) {
    const measurementId = site.analytics?.ga4?.trim();
    const fromRegistry = declaredPropertyId(site);
    const fromDiscovery = measurementId ? discovered.get(measurementId)?.propertyId : undefined;
    const propertyId = fromRegistry ?? fromDiscovery;

    const sr: Ga4SiteReport = {
      id: site.id,
      name: site.name,
      origin: site.origin,
      measurementId,
      propertyId,
      propertyResolvedBy: fromRegistry ? 'registry' : fromDiscovery ? 'discovery' : undefined,
    };

    if (!propertyId) {
      sr.error = discoveryError
        ? `找不到 property id（Admin API 對照失敗：${discoveryError}）`
        : `找不到 measurement id ${measurementId ?? '(registry 沒寫)'} 對應的 GA4 property`;
      sr.hint =
        'service account 要被加進 GA4 的「資源存取管理」（角色：檢視者），而且 GCP 專案要啟用 Google Analytics Admin API。也可以直接在 registry 的 analytics 加 "ga4Property": "<純數字 property id>" 跳過對照。';
      report.sites.push(sr);
      continue;
    }

    const selfHosts = [site.domain, site.origin].filter((s): s is string => Boolean(s));

    try {
      const bySource = await runGa4Report(token, propertyId, {
        ...range,
        dimensions: ['sessionSource', 'sessionMedium'],
        metrics: SESSION_METRICS,
        limit: 5_000,
      });

      const totals = emptyTotals();
      const aiTotals = emptyTotals();
      const groups = emptyGroups();
      const engines = new Map<string, Ga4EngineStat>();
      const suspicious: Ga4SuspiciousSource[] = [];
      const aiSources = new Set<string>();

      for (const row of bySource.rows) {
        const source = row.dimensions.sessionSource ?? '';
        const medium = row.dimensions.sessionMedium ?? '';
        const c = classifySource(source, medium, selfHosts);
        addRow(totals, row.metrics);
        groups[c.group].sessions += row.metrics.sessions ?? 0;
        groups[c.group].users += row.metrics.totalUsers ?? 0;
        if (c.suspicious) {
          suspicious.push({
            source,
            medium,
            sessions: row.metrics.sessions ?? 0,
            reason: c.suspicious,
          });
          continue;
        }
        if (c.group === 'ai' && c.engine) {
          aiSources.add(source.toLowerCase());
          addRow(aiTotals, row.metrics);
          const e = engines.get(c.engine) ?? {
            engine: c.engine,
            sessions: 0,
            users: 0,
            engagedSessions: 0,
          };
          e.sessions += row.metrics.sessions ?? 0;
          e.users += row.metrics.totalUsers ?? 0;
          e.engagedSessions += row.metrics.engagedSessions ?? 0;
          engines.set(c.engine, e);
        }
      }

      sr.totals = totals;
      sr.byGroup = groups;
      sr.ai = {
        totals: aiTotals,
        byEngine: [...engines.values()].sort(
          (a, b) => b.sessions - a.sessions || a.engine.localeCompare(b.engine)
        ),
      };
      sr.suspicious = suspicious.sort((a, b) => b.sessions - a.sessions);

      // --- 落點頁：只在真的有 AI 工作階段時才問。0 的時候問等於白花一次 API 配額，
      //     而且會產出一張全是 0 的表，看起來像「查過了沒東西」而不是「根本沒得查」。
      if (aiTotals.sessions === 0) {
        sr.aiLandingSkipReason = 'AI 工作階段為 0，沒有落點可看（不是查失敗）';
      } else {
        const landing = await runGa4ReportWithLandingPage(token, propertyId, {
          ...range,
          extraDimensions: ['sessionSource'],
          metrics: ['sessions'],
          limit: 10_000,
        });
        sr.landingDimension = landing.landingDimension;
        const buckets = new Map<string, Ga4LandingTypeStat>();
        const pathAgg = new Map<string, { path: string; sessions: number; engines: Set<string> }>();

        for (const row of landing.rows as Ga4Row[]) {
          const source = row.dimensions.sessionSource ?? '';
          if (!aiSources.has(source.toLowerCase())) continue;
          const engine = classifySource(source, undefined, selfHosts).engine;
          const rawPath = row.dimensions[landing.landingDimension] ?? '';
          const path = rawPath.replace(/[?#].*$/, '') || '/';
          const sessions = row.metrics.sessions ?? 0;

          const def = matchPageType(path, site.pageTypes ?? []) ?? OTHER_TYPE;
          const bucket = buckets.get(def.id) ?? { id: def.id, label: def.label, sessions: 0, topPages: [] };
          bucket.sessions += sessions;
          buckets.set(def.id, bucket);

          const key = `${def.id} ${path}`;
          const agg = pathAgg.get(key) ?? { path, sessions: 0, engines: new Set<string>() };
          agg.sessions += sessions;
          if (engine) agg.engines.add(engine);
          pathAgg.set(key, agg);
        }

        for (const [key, agg] of pathAgg) {
          const typeId = key.split(' ')[0] as string;
          const bucket = buckets.get(typeId);
          if (bucket) {
            bucket.topPages.push({
              path: agg.path,
              sessions: agg.sessions,
              engines: [...agg.engines].sort(),
            });
          }
        }
        for (const bucket of buckets.values()) {
          bucket.topPages = topN(bucket.topPages, topPagesPerType);
        }
        sr.aiLanding = [...buckets.values()].sort((a, b) => b.sessions - a.sessions);
      }
    } catch (err) {
      sr.error = (err as Error).message;
      if (/403/.test(sr.error)) {
        sr.hint = `service account ${report.credentials.clientEmail} 沒有這個 property 的存取權。GA4 → 管理 → 資源存取管理 → 新增使用者 → 角色「檢視者」。`;
      }
    }

    report.sites.push(sr);
  }

  for (const s of report.sites) {
    if (s.totals) {
      report.totals.sessions += s.totals.sessions;
      report.totals.users += s.totals.users;
      report.totals.engagedSessions += s.totals.engagedSessions;
      report.totals.engagementSeconds += s.totals.engagementSeconds;
    }
    if (s.ai) {
      report.aiTotals.sessions += s.ai.totals.sessions;
      report.aiTotals.users += s.ai.totals.users;
      report.aiTotals.engagedSessions += s.ai.totals.engagedSessions;
      report.aiTotals.engagementSeconds += s.ai.totals.engagementSeconds;
    }
  }

  return report;
}

// ---------------------------------------------------------------- 輸出

export function formatGa4Report(report: Ga4Report): string {
  const out: string[] = [];
  const { startDate, endDate, days } = report.range;
  out.push(`GA4 週報（AI 搜尋 referral）— ${days} 天（${startDate} ~ ${endDate}）`);
  out.push(`來源：${report.registryPath}`);
  out.push('');

  if (!report.credentials.configured) {
    out.push('=== GA4 憑證未就緒 ===');
    out.push(`原因：${report.credentials.error ?? '未知'}`);
    if (report.credentials.hint) out.push(`怎麼辦：${report.credentials.hint}`);
    out.push('');
    out.push('GA4 這層沒有「免憑證也看得到的一半」——GSC 那層還有 sitemap 可以掃，');
    out.push('AI referral 只存在於 GA4 裡。憑證沒設好＝這一層是空白，不是 0。');
    return out.join('\n');
  }

  out.push(`憑證：${report.credentials.clientEmail}`);
  if (report.discovered?.length) {
    out.push('');
    out.push('這次靠 Admin API 對照出來的 property id（貼回 registry 的 analytics.ga4Property');
    out.push('就不用每週再對照一次，每站省兩次 API）：');
    for (const d of report.discovered) {
      out.push(`  ${d.measurementId} → ${d.propertyId}（${d.displayName}）`);
    }
  }
  out.push('');

  // ---- 表一
  out.push('【表一】五站總覽 —— AI 搜尋佔了多少');
  const t1 = report.sites.map((s) => {
    const t = s.totals;
    const ai = s.ai?.totals;
    return [
      s.name,
      s.id,
      s.propertyId ?? '—',
      t ? num(t.sessions) : '—',
      t ? num(t.users) : '—',
      ai ? num(ai.sessions) : '—',
      ai && t && t.sessions > 0 ? pct(ai.sessions / t.sessions) : '—',
      ai ? num(ai.users) : '—',
      ai && ai.sessions > 0 ? pct(ai.engagedSessions / ai.sessions) : '—',
    ];
  });
  t1.push([
    '合計',
    '',
    '',
    num(report.totals.sessions),
    num(report.totals.users),
    num(report.aiTotals.sessions),
    report.totals.sessions > 0 ? pct(report.aiTotals.sessions / report.totals.sessions) : '—',
    num(report.aiTotals.users),
    report.aiTotals.sessions > 0
      ? pct(report.aiTotals.engagedSessions / report.aiTotals.sessions)
      : '—',
  ]);
  out.push(
    ...formatTable(
      ['站', 'id', 'property', '工作階段', '使用者', 'AI 階段', 'AI 佔比', 'AI 使用者', 'AI 參與率'],
      t1,
      [false, false, false, true, true, true, true, true, true]
    )
  );
  for (const s of report.sites) {
    if (s.error) out.push(`  ✖ ${s.name}：${s.error}`);
    if (s.hint) out.push(`     → ${s.hint}`);
  }
  out.push('');

  // ---- 表二
  out.push('【表二】AI 來源 × 站（工作階段）');
  const engineCols = AI_ENGINE_ORDER.filter((e) =>
    report.sites.some((s) => s.ai?.byEngine.some((x) => x.engine === e && x.sessions > 0))
  );
  if (engineCols.length === 0) {
    out.push('  這 28 天五站沒有任何一個 AI 來源帶進工作階段。');
    out.push('  這是「量過了、真的是 0」，不是「還沒量」——分母在表一，追蹤碼在 portfolio 那層驗過。');
  } else {
    const t2 = report.sites.map((s) => [
      s.name,
      ...engineCols.map((e) => {
        const hit = s.ai?.byEngine.find((x) => x.engine === e);
        return hit ? num(hit.sessions) : s.ai ? '0' : '—';
      }),
      s.ai ? num(s.ai.totals.sessions) : '—',
    ]);
    out.push(
      ...formatTable(
        ['站', ...engineCols, '小計'],
        t2,
        [false, ...engineCols.map(() => true), true]
      )
    );
  }
  out.push('');

  // ---- 表三
  out.push('【表三】AI 落點頁型 —— AI 在引用我們的哪一種頁');
  for (const s of report.sites) {
    if (!s.ai) continue;
    out.push('');
    out.push(`--- ${s.name}（${s.id}）`);
    if (s.aiLandingSkipReason) {
      out.push(`    ${s.aiLandingSkipReason}`);
      continue;
    }
    if (!s.aiLanding?.length) {
      out.push('    有 AI 工作階段但抓不到落點頁（GA4 的落點頁維度回空值）。');
      continue;
    }
    const rows: string[][] = [];
    for (const t of s.aiLanding) {
      rows.push([t.label, num(t.sessions), '', '']);
      for (const p of t.topPages) {
        rows.push(['', '', p.path, `${num(p.sessions)}（${p.engines.join('、') || '?'}）`]);
      }
    }
    out.push(
      ...formatTable(['頁型', '工作階段', '落點頁', '該頁'], rows, [false, true, false, true]).map(
        (l) => `    ${l}`
      )
    );
    if (s.landingDimension) out.push(`    （落點頁維度：${s.landingDimension}）`);
  }
  out.push('');

  // ---- 可疑來源
  const suspicious = report.sites.flatMap((s) => (s.suspicious ?? []).map((x) => ({ site: s.name, ...x })));
  if (suspicious.length) {
    out.push('【可疑來源】仍計入該站的全站工作階段，但**不計入 AI** —— 這些 source 值的形狀不像流量來源');
    out.push(
      ...formatTable(
        ['站', 'source', 'medium', '工作階段', '為什麼可疑'],
        suspicious.map((x) => [x.site, x.source, x.medium, num(x.sessions), x.reason]),
        [false, false, false, true, false]
      )
    );
    out.push('');
    out.push('GA4 的 source / medium / campaign 是保留參數名：自訂事件送同名參數會覆蓋');
    out.push('sessionSource，於是報表上冒出根本不是來源的值。修的地方是送事件的那段程式，');
    out.push('或 GA4 後台的推薦連結排除 / 內部流量篩選器，不是這份報表。');
    out.push('');
  }

  out.push('AI 佔比小不等於不值得做：這五站的 AI referral 分母是「有多少 AI 回答引用了我們」，');
  out.push('而引用發生在 AI 端、只有被點進來才會出現在這裡。所以這個數字是**下限**，');
  out.push('趨勢比絕對值有意義。表三的落點頁型才是能改變決策的那半張。');
  return out.join('\n');
}
