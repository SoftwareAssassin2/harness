// Phase 2c: each project's memory backed up (ASS-148). For every project with
// a `hindsight` in its project.json, once a day: memory:backup, which exports
// its bank through Hindsight's transfer export into
// hindsight-backups/<project>/ and keeps the last 14 (memory/transfer.bash).
// The day is counted from the latest daily backup on disk — so a control
// that restarts keeps the rhythm, and a project with none is backed up at
// once — then by control's own timer (triggers.js timerDue). A project whose
// Hindsight is not answering is skipped and logged, as one whose backup
// fails is, each tried again at the next run, a day later. Each backup runs
// beside the tick, one per project at a time, as memory.js's work does.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { memoryPort, memoryAnswers } from '../agents/memory.js';
import { timerDue } from './triggers.js';

const PHASE = 'memory';
const DAY = 24 * 3600;
const DAILY = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.zip$/;

// The project's backups folder, as memory/transfer.bash places it.
const folder = (env, id) => join(env.HINDSIGHT_DIR ?? join(homedir(), 'Library', 'Application Support', 'harness'), 'hindsight-backups', id);

// The time of the project's latest daily backup (ms), from its name; 0 when it has none.
function latestBackup(env, id) {
  let names = [];
  try { names = readdirSync(folder(env, id)); } catch { /* none yet */ }
  return Math.max(0, ...names.map(n => DAILY.exec(n)).filter(Boolean).map(([, y, mo, d, h, mi, s]) => Date.UTC(y, mo - 1, d, h, mi, s)));
}

// backupMemory(ctx, state) — starts each such project's backup when due and
// none is running; memory.backups: id → its running job.
export function backupMemory(ctx, state) {
  const jobs = (ctx.memory.backups ??= new Map());
  for (const project of state.projects) {
    const port = memoryPort(project), key = `${project.id}/memory-backup`;
    if (port == null || jobs.has(project.id)) continue;
    const last = ctx.memory.timers.has(key) ? 0 : latestBackup(ctx.env, project.id);
    if (!timerDue(ctx.memory, key, DAY, ctx.now().getTime(), last)) continue;
    jobs.set(project.id, backup(ctx, project.id, port).finally(() => jobs.delete(project.id)));
  }
}

async function backup(ctx, id, port) {
  if (!(await memoryAnswers(port))) {
    ctx.log(PHASE, `${id}: Hindsight is not answering on 127.0.0.1:${port}; its daily memory backup is skipped, tried again in 24h`);
    return;
  }
  try {
    const { archive, removed } = JSON.parse(await ctx.cli(['memory:backup', id]));
    ctx.log(PHASE, `${id}: backed up its memory to ${archive}${removed.length ? `; removed ${removed.length} older backup${removed.length === 1 ? '' : 's'}` : ''}`);
  } catch (error) {
    ctx.log('error', `${PHASE} ${id}: the daily memory backup failed, tried again in 24h: ${error.message}`);
  }
}
