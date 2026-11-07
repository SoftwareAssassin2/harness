// Phase 2b: each project's Hindsight memory (ASS-62), kept running by control
// as each registry is (registry.js), and for the same reason not launchd. For
// every project with a `hindsight` in its project.json: a Hindsight not
// answering /health on 127.0.0.1:<port> gets memory:up, the idempotent
// one-shot that installs, starts and health-checks it and makes the project's
// bank; logged with the LLM provider it runs on — none when the project.json
// has no key. One that fails is tried again after a failing step's backoff
// (backoff.js), each failure logged; the project's agents run all the while,
// without memory (dispatch.js memoryFor). The work runs beside the tick, one
// job per project at a time, so memory:up's wait (minutes on a first start,
// which downloads Hindsight's models) never holds up the agents. Control
// leaves Hindsight running when it exits.
import { backoffDelay, held } from './backoff.js';
import { memoryPort, memoryAnswers } from '../agents/memory.js';

const PHASE = 'memory';

// superviseMemory(ctx, state) — starts, for each such project with no job
// running, its job (keep); memory.hindsight: id → { job, failures, until }.
export function superviseMemory(ctx, state) {
  const servers = (ctx.memory.hindsight ??= new Map());
  for (const project of state.projects) {
    const port = memoryPort(project);
    if (port == null) continue;
    const r = servers.get(project.id) ?? { job: null, failures: 0, until: 0 };
    servers.set(project.id, r);
    r.job ??= keep(ctx, project.id, port, r).finally(() => { r.job = null; });
  }
}

// One project's pass: Hindsight started when it does not answer (not while backed off).
async function keep(ctx, id, port, r) {
  const now = ctx.now().getTime();
  if (await memoryAnswers(port)) { r.failures = 0; return; }
  if (now < r.until) return;
  try {
    const { provider } = JSON.parse(await ctx.cli(['memory:up', id]));
    const how = provider === 'none' ? `provider none — no llm-api-key in ${id}'s project.json hindsight: retain and recall only, no reflect` : `provider ${provider}`;
    ctx.log(PHASE, `${id}: Hindsight was not answering on 127.0.0.1:${port}; started it (memory:up, ${how})`);
    r.failures = 0;
  } catch (error) {
    const wait = backoffDelay(++r.failures);
    r.until = now + wait;
    ctx.log('error', `${PHASE} ${id}: Hindsight is not answering on 127.0.0.1:${port} and memory:up failed (${r.failures} in a row; next try in ${held(wait)}): ${error.message}`);
  }
}
