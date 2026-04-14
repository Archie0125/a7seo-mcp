import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { findClaudePath } from './claude-finder.js';

export interface PipelineConfig {
  id: string;
  name: string;
  schedule: string; // cron expression
  prompt: string;
  cwd: string;
  requiresApproval: boolean;
  enabled: boolean;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  reportPath?: string;
}

// Track pipeline state
const pipelineRuns: Map<string, PipelineRun[]> = new Map();

export function getDefaultPipelines(domain: string, cwd: string): PipelineConfig[] {
  return [
    {
      id: 'rank-check',
      name: '排名追蹤',
      schedule: '0 6 * * *',
      prompt: `你是 SEO 自動化 agent。查看 ${domain} 在 Google Search Console 的排名數據。找出：1) 排名上升超過 3 名的關鍵字 2) 排名下降超過 3 名的關鍵字 3) 新進入前 20 名的關鍵字。用 seo_publish_list 列出已發布文章做交叉比對。輸出簡潔的中文報告。`,
      cwd,
      requiresApproval: false,
      enabled: true,
    },
    {
      id: 'keyword-discovery',
      name: '關鍵字發現',
      schedule: '0 7 * * *',
      prompt: `你是 SEO 自動化 agent。用 seo_keywords_gaps 找出還沒有對應文章的關鍵字。如果 gaps 少於 5 個，用 seo_keywords_discover 搜尋「${domain} 相關主題」的新關鍵字。用 seo_keywords_cluster 將結果分群。輸出中文報告：最有潛力的 5 個關鍵字及其原因。`,
      cwd,
      requiresApproval: false,
      enabled: true,
    },
    {
      id: 'content-generation',
      name: '自動寫文章',
      schedule: '0 8 * * *',
      prompt: `你是 SEO 自動化 agent。用 seo_keywords_gaps 找出評分最高的未覆蓋關鍵字。用 seo_content_brief 生成大綱，再用 seo_content_generate 寫一篇完整文章。文章會自動存為 draft。不要發布。輸出中文報告：文章標題、目標關鍵字、字數、品質自評分(1-10)。`,
      cwd,
      requiresApproval: true,
      enabled: true,
    },
    {
      id: 'track-new-content',
      name: '新文章追蹤',
      schedule: '0 12 * * *',
      prompt: `你是 SEO 自動化 agent。用 seo_publish_list 找出過去 7 天發布的文章。查看這些文章在 GSC 的表現（是否已被索引、排名、點擊）。輸出中文報告。`,
      cwd,
      requiresApproval: false,
      enabled: true,
    },
    {
      id: 'optimize-old',
      name: '舊文優化',
      schedule: '0 18 * * *',
      prompt: `你是 SEO 自動化 agent。查看 GSC 數據，找出排名 11-20 的文章（即將進首頁的）。用 seo_content_optimize 分析這些文章，給出具體優化建議。如果只需改 title/meta，直接用 seo_publish_draft 更新。如果需要重寫內容，存為新 draft 等審核。輸出中文報告。`,
      cwd,
      requiresApproval: true,
      enabled: true,
    },
  ];
}

export async function runPipeline(
  pipeline: PipelineConfig,
  reportsDir: string
): Promise<PipelineRun> {
  const claudePath = findClaudePath();
  if (!claudePath) {
    throw new Error('Claude Code CLI not found');
  }

  const runId = `${pipeline.id}-${Date.now()}`;
  const run: PipelineRun = {
    id: runId,
    pipelineId: pipeline.id,
    status: 'running',
    startedAt: new Date().toISOString(),
  };

  // Track
  if (!pipelineRuns.has(pipeline.id)) {
    pipelineRuns.set(pipeline.id, []);
  }
  pipelineRuns.get(pipeline.id)!.unshift(run);

  const start = Date.now();

  try {
    const result = await executeClaudeTask(claudePath, pipeline.prompt, pipeline.cwd);

    run.status = 'completed';
    run.result = result;
    run.durationMs = Date.now() - start;
    run.completedAt = new Date().toISOString();

    // Save report
    if (!existsSync(reportsDir)) {
      mkdirSync(reportsDir, { recursive: true });
    }
    const date = new Date().toISOString().split('T')[0];
    const reportPath = join(reportsDir, `${date}-${pipeline.id}.md`);
    const report = `# ${pipeline.name}\n\n**時間**: ${run.completedAt}\n**耗時**: ${Math.round((run.durationMs || 0) / 1000)}s\n\n---\n\n${result}`;
    writeFileSync(reportPath, report, 'utf-8');
    run.reportPath = reportPath;

    console.log(`[autopilot] ${pipeline.name} completed (${Math.round((run.durationMs || 0) / 1000)}s)`);
  } catch (err) {
    run.status = 'failed';
    run.error = (err as Error).message;
    run.durationMs = Date.now() - start;
    run.completedAt = new Date().toISOString();
    console.error(`[autopilot] ${pipeline.name} failed:`, run.error);
  }

  return run;
}

export function getPipelineStatus(pipelineId: string): PipelineRun | null {
  const runs = pipelineRuns.get(pipelineId);
  return runs?.[0] || null;
}

export function getAllPipelineStatus(): Record<string, PipelineRun | null> {
  const result: Record<string, PipelineRun | null> = {};
  for (const [id, runs] of pipelineRuns) {
    result[id] = runs[0] || null;
  }
  return result;
}

export function getReports(reportsDir: string, limit = 20): string[] {
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);
}

export function getReportContent(reportsDir: string, filename: string): string | null {
  const filePath = join(reportsDir, filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

function executeClaudeTask(claudePath: string, prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'text', '--max-turns', '10'];

    const proc = spawn(claudePath, args, {
      cwd,
      shell: claudePath === 'claude',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 600000, // 10 min max per pipeline
    });

    proc.stdin!.end();

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Claude: ${err.message}`));
    });
  });
}
