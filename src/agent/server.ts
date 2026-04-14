#!/usr/bin/env node
/**
 * A7SEO Agent Server
 *
 * HTTP API that wraps Claude Code CLI (`claude -p`) for automated task processing.
 * Accepts POST requests with prompts, runs them through Claude Code with full
 * MCP server access, and returns results.
 *
 * Usage:
 *   npx a7seo serve                          # Start on default port 4000
 *   npx a7seo serve --port 8080              # Custom port
 *   PORT=4000 npx a7seo serve                # Via env var
 *
 * API:
 *   POST /task        — Run a prompt (sync, waits for result)
 *   POST /task/stream — Run a prompt (SSE streaming)
 *   GET  /health      — Health check
 *   GET  /history      — Recent task history
 */

import express from 'express';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { findClaudePath } from './claude-finder.js';
import {
  getDefaultPipelines,
  runPipeline,
  getAllPipelineStatus,
  getReports,
  getReportContent,
} from './pipeline.js';
import { startScheduler, stopScheduler, getScheduledJobs } from './scheduler.js';
import { resolve } from 'path';

const app = express();
app.use(express.json());

// ── Types ──────────────────────────────────────────────────

interface TaskRequest {
  prompt: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

interface TaskRecord {
  id: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

// ── State ──────────────────────────────────────────────────

const history: TaskRecord[] = [];
const MAX_HISTORY = 50;

function addHistory(record: TaskRecord) {
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.pop();
}

// ── Claude CLI detection ───────────────────────────────────

const claudeCmd = findClaudePath();

// ── Routes ─────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    claude: claudeCmd ? 'available' : 'not found',
    uptime: process.uptime(),
    tasksCompleted: history.filter((t) => t.status === 'completed').length,
    tasksRunning: history.filter((t) => t.status === 'running').length,
  });
});

app.get('/history', (_req, res) => {
  res.json({ tasks: history.slice(0, 20) });
});

// Sync task — waits for completion
app.post('/task', async (req, res) => {
  if (!claudeCmd) {
    res.status(503).json({
      error: 'Claude Code CLI not found',
      fix: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    });
    return;
  }

  const { prompt, cwd, tools, model, maxTurns } = req.body as TaskRequest;

  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt" field' });
    return;
  }

  const taskId = randomUUID().slice(0, 8);
  const record: TaskRecord = {
    id: taskId,
    prompt: prompt.slice(0, 200),
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  addHistory(record);

  const start = Date.now();

  try {
    const result = await runClaude({
      prompt,
      cwd: cwd || process.cwd(),
      tools,
      model,
      maxTurns,
    });

    record.status = 'completed';
    record.result = result;
    record.durationMs = Date.now() - start;
    record.completedAt = new Date().toISOString();

    res.json({
      id: taskId,
      status: 'completed',
      result,
      durationMs: record.durationMs,
    });
  } catch (err) {
    record.status = 'failed';
    record.error = (err as Error).message;
    record.durationMs = Date.now() - start;
    record.completedAt = new Date().toISOString();

    res.status(500).json({
      id: taskId,
      status: 'failed',
      error: (err as Error).message,
      durationMs: record.durationMs,
    });
  }
});

// Streaming task — SSE
app.post('/task/stream', (req, res) => {
  if (!claudeCmd) {
    res.status(503).json({ error: 'Claude Code CLI not found' });
    return;
  }

  const { prompt, cwd, tools, model, maxTurns } = req.body as TaskRequest;

  if (!prompt) {
    res.status(400).json({ error: 'Missing "prompt" field' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const taskId = randomUUID().slice(0, 8);
  const start = Date.now();

  const record: TaskRecord = {
    id: taskId,
    prompt: prompt.slice(0, 200),
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  addHistory(record);

  res.write(`data: ${JSON.stringify({ type: 'start', id: taskId })}\n\n`);

  const args = buildClaudeArgs({ prompt, cwd: cwd || process.cwd(), tools, model, maxTurns });
  args.push('--output-format', 'stream-json');

  const needsShell2 = claudeCmd === 'claude';
  const proc = spawn(claudeCmd!, args, {
    cwd: cwd || process.cwd(),
    shell: needsShell2,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdin!.end();

  let fullResult = '';

  proc.stdout!.on('data', (data: Buffer) => {
    const text = data.toString();
    fullResult += text;

    // Try to parse stream-json lines
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        res.write(`data: ${JSON.stringify({ type: 'chunk', data: json })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ type: 'text', content: line })}\n\n`);
      }
    }
  });

  proc.stderr!.on('data', (data: Buffer) => {
    res.write(`data: ${JSON.stringify({ type: 'stderr', content: data.toString() })}\n\n`);
  });

  proc.on('close', (code) => {
    record.status = code === 0 ? 'completed' : 'failed';
    record.result = fullResult.slice(0, 5000);
    record.durationMs = Date.now() - start;
    record.completedAt = new Date().toISOString();

    res.write(
      `data: ${JSON.stringify({
        type: 'complete',
        id: taskId,
        exitCode: code,
        durationMs: record.durationMs,
      })}\n\n`
    );
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    proc.kill();
  });
});

// ── Claude CLI runner ──────────────────────────────────────

interface RunOptions {
  prompt: string;
  cwd: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

function buildClaudeArgs(options: RunOptions): string[] {
  const args = ['-p', options.prompt, '--output-format', 'text'];

  if (options.tools && options.tools.length > 0) {
    args.push('--allowedTools', options.tools.join(','));
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }

  return args;
}

function runClaude(options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(options);

    const needsShell = claudeCmd === 'claude'; // Only if bare name
    const proc = spawn(claudeCmd!, args, {
      cwd: options.cwd,
      shell: needsShell,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 300000, // 5 min max
    });

    // Close stdin immediately so Claude doesn't wait for input
    proc.stdin!.end();

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

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

// ── Pipeline & Reports Routes ─────────────────────────────

let currentPipelines: ReturnType<typeof getDefaultPipelines> = [];
let reportsDir = '';

app.get('/pipeline/status', (_req, res) => {
  res.json({
    pipelines: currentPipelines.map(p => ({
      id: p.id,
      name: p.name,
      schedule: p.schedule,
      enabled: p.enabled,
      requiresApproval: p.requiresApproval,
      lastRun: getAllPipelineStatus()[p.id] || null,
    })),
    scheduledJobs: getScheduledJobs(),
  });
});

app.post('/pipeline/run', async (req, res) => {
  const { pipeline: pipelineId } = req.body as { pipeline: string };
  const pipeline = currentPipelines.find(p => p.id === pipelineId);

  if (!pipeline) {
    res.status(404).json({
      error: `Pipeline "${pipelineId}" not found`,
      available: currentPipelines.map(p => p.id),
    });
    return;
  }

  try {
    const run = await runPipeline(pipeline, reportsDir);
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/reports', (_req, res) => {
  const files = getReports(reportsDir);
  res.json({ reports: files });
});

app.get('/reports/:filename', (req, res) => {
  const content = getReportContent(reportsDir, req.params.filename);
  if (!content) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.type('text/markdown').send(content);
});

// ── Start ──────────────────────────────────────────────────

export function startServer(port?: number) {
  const p = port || parseInt(process.env.PORT || '4000', 10);

  app.listen(p, () => {
    console.log(`
╔══════════════════════════════════════════╗
║         A7SEO Agent Server v0.1          ║
╠══════════════════════════════════════════╣
║  http://localhost:${String(p).padEnd(25)}║
║                                          ║
║  POST /task           → Run task (sync)  ║
║  POST /task/stream    → Run task (SSE)   ║
║  GET  /health         → Health check     ║
║  GET  /history        → Recent tasks     ║
║  GET  /pipeline/status→ Pipeline status  ║
║  POST /pipeline/run   → Trigger pipeline ║
║  GET  /reports        → View reports     ║
║                                          ║
║  Claude CLI: ${(claudeCmd ? 'OK' : 'NOT FOUND').padEnd(27)}║
╚══════════════════════════════════════════╝
`);
  });
}

export function startAutopilot(options: {
  port?: number;
  domain: string;
  cwd: string;
  reportsPath: string;
}) {
  const p = options.port || parseInt(process.env.PORT || '4000', 10);
  reportsDir = resolve(options.reportsPath);
  currentPipelines = getDefaultPipelines(options.domain, options.cwd);

  // Start scheduler
  startScheduler(currentPipelines, reportsDir);

  app.listen(p, () => {
    console.log(`
╔══════════════════════════════════════════╗
║       A7SEO Autopilot v0.1               ║
╠══════════════════════════════════════════╣
║  http://localhost:${String(p).padEnd(25)}║
║  Domain: ${options.domain.padEnd(33)}║
║                                          ║
║  Pipelines:                              ║
${currentPipelines.map(p => `║    ${p.enabled ? '✓' : '✗'} ${(p.name + ' (' + p.schedule + ')').padEnd(36)}║`).join('\n')}
║                                          ║
║  POST /task           → Ad-hoc task      ║
║  GET  /pipeline/status→ Pipeline status  ║
║  POST /pipeline/run   → Trigger pipeline ║
║  GET  /reports        → View reports     ║
║                                          ║
║  Claude CLI: ${(claudeCmd ? 'OK' : 'NOT FOUND').padEnd(27)}║
╚══════════════════════════════════════════╝
`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    stopScheduler();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopScheduler();
    process.exit(0);
  });
}
