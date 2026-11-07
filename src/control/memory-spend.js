// Phase 2d: what each project's Hindsight memory spends on Claude (ASS-269).
// For every project with a `hindsight` in its project.json, at once and then
// every MEMORY_SPEND_EVERY: memory:record-spend, which reads its Hindsight's
// token counters (/metrics) and records what they moved by since, priced, in
// the project's memory-spend.json — counted against its API caps
// (supervise.js capHolds) and in its spend tiles, never a ticket's limit
// (spend.js spendRecords). A Hindsight not answering is skipped quietly —
// memory.js starts it — and read at the next turn. The first read (the
// baseline), a Hindsight restarted since the last and a model with no price
// (once) are logged; a failed read is logged as an error. Each read runs beside the
// tick, one per project at a time, as memory.js's work does.
import { memoryPort, memoryAnswers } from '../agents/memory.js';
import { timerDue } from './triggers.js';

const PHASE = 'memory';
const MEMORY_SPEND_EVERY = 5 * 60;   // seconds

// recordMemorySpend(ctx, state) — starts each such project's read when due and
// none is running; memory.memorySpend: id → its running job.
export function recordMemorySpend(ctx, state) {
  const jobs = (ctx.memory.memorySpend ??= new Map());
  for (const project of state.projects) {
    const port = memoryPort(project);
    if (port == null || jobs.has(project.id)) continue;
    if (!timerDue(ctx.memory, `${project.id}/memory-spend`, MEMORY_SPEND_EVERY, ctx.now().getTime(), 0)) continue;
    jobs.set(project.id, read(ctx, project.id, port).finally(() => jobs.delete(project.id)));
  }
}

async function read(ctx, id, port) {
  if (!(await memoryAnswers(port))) return;
  try {
    const { collection } = JSON.parse(await ctx.cli(['memory:record-spend', id]));
    if (!collection) return;   // provider none: no Claude to count
    if (collection.baseline) ctx.log(PHASE, `${id}: counting its Hindsight's Claude spend from now (memory:record-spend's first read)`);
    if (collection.restarted) ctx.log(PHASE, `${id}: its Hindsight restarted since last read; its Claude spend counted again from zero`);
    for (const model of collection.unpriced ?? []) {
      if (ctx.memory.warned.has(`memory-spend/${id}/${model}`)) continue;
      ctx.memory.warned.add(`memory-spend/${id}/${model}`);
      ctx.log(PHASE, `${id}: no model-prices in harness.json for ${model}; its Hindsight spend is recorded without a cost`);
    }
  } catch (error) {
    ctx.log('error', `${PHASE} ${id}: its Hindsight's Claude spend could not be read, tried again in ${MEMORY_SPEND_EVERY / 60}m: ${error.message}`);
  }
}
