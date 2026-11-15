// Phase 2, beside the registries: each project's golden image follow-up
// (ASS-427 AC2/AC3/AC6). Blocked's Repair the VM fixes a ticket's VM in place
// and writes the same fix into its source; a definition change written while
// a golden build ran waits in data/projects/<p>/golden-queue/ (vm:golden-write),
// and the tickets whose fix needs a rebuild wait in golden-followup.json
// (vm:golden-followup, run by Rebuild the Source in the Background). Neither
// holds a ticket: control carries them on. For every project with a file
// queued or an entry followed, once a minute, vm:golden-followup <p> runs: once
// no build runs it writes the queue into the definition, starts the rebuild
// (one build per project at a time), and logs each ended build's result on the
// tickets it fixed. What it did is logged; a failure is logged and tried
// again a minute later. The work runs beside the tick, one job per project
// at a time.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timerDue } from './triggers.js';

const PHASE = 'golden';
const EVERY_SECONDS = 60;

// followed(dir) — whether the project folder has a golden-queue file or a golden-followup.json entry.
const queued = dir => { try { return readdirSync(join(dir, 'golden-queue'), { recursive: true, withFileTypes: true }).some(e => e.isFile() && !e.name.startsWith('.')); } catch { return false; } };
const followed = dir => queued(dir) || (() => { try { return (JSON.parse(readFileSync(join(dir, 'golden-followup.json'), 'utf8')).entries ?? []).length > 0; } catch { return false; } })();

// followGolden(ctx, state) — for each project that needs it, its job (follow), at most once per EVERY_SECONDS;
// memory.golden: id → { job }.
export function followGolden(ctx, state) {
  const jobs = (ctx.memory.golden ??= new Map());
  for (const project of state.projects) {
    if (!project.json?.['golden-image']) continue;
    const dir = join(ctx.paths.projects, project.id);
    if (!existsSync(dir) || !followed(dir)) continue;
    const r = jobs.get(project.id) ?? { job: null };
    jobs.set(project.id, r);
    if (r.job || !timerDue(ctx.memory, `${project.id}/golden-followup`, EVERY_SECONDS, ctx.now().getTime(), 0)) continue;
    r.job = follow(ctx, project.id).finally(() => { r.job = null; });
  }
}

async function follow(ctx, id) {
  let out;
  try { out = JSON.parse(await ctx.cli(['vm:golden-followup', id]) || '{}'); } catch (error) {
    ctx.log('error', `${PHASE} ${id}: vm:golden-followup failed (tried again in a minute): ${error.message}`);
    return;
  }
  const did = [
    out.applied?.length && `queued ${out.applied.join(', ')} written into golden-${id}'s definition`,
    out.started && `golden-${id}'s rebuild started`,
    ...(out.reported ?? []).map(r => `${r.ticket} ${r.variation}: its fix's rebuild ${r.result}`),
  ].filter(Boolean);
  if (did.length) ctx.log(PHASE, `${id}: ${did.join('; ')}`);
}
