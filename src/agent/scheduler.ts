import cron from 'node-cron';
import type { PipelineConfig } from './pipeline.js';
import { runPipeline } from './pipeline.js';

const scheduledJobs: Map<string, cron.ScheduledTask> = new Map();

export function startScheduler(
  pipelines: PipelineConfig[],
  reportsDir: string
): void {
  for (const pipeline of pipelines) {
    if (!pipeline.enabled) {
      console.log(`[scheduler] ${pipeline.name} — disabled, skipping`);
      continue;
    }

    if (!cron.validate(pipeline.schedule)) {
      console.error(`[scheduler] Invalid cron for ${pipeline.id}: ${pipeline.schedule}`);
      continue;
    }

    const job = cron.schedule(pipeline.schedule, async () => {
      console.log(`[scheduler] Running: ${pipeline.name}`);
      try {
        await runPipeline(pipeline, reportsDir);
      } catch (err) {
        console.error(`[scheduler] ${pipeline.name} error:`, (err as Error).message);
      }
    }, {
      timezone: 'Asia/Taipei',
    });

    scheduledJobs.set(pipeline.id, job);
    console.log(`[scheduler] ${pipeline.name} — scheduled: ${pipeline.schedule} (Asia/Taipei)`);
  }
}

export function stopScheduler(): void {
  for (const [id, job] of scheduledJobs) {
    job.stop();
    console.log(`[scheduler] Stopped: ${id}`);
  }
  scheduledJobs.clear();
}

export function getScheduledJobs(): { id: string; running: boolean }[] {
  return Array.from(scheduledJobs.entries()).map(([id]) => ({
    id,
    running: true,
  }));
}
