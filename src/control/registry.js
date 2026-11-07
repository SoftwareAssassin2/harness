// Phase 2: each project's image registry (ASS-70), kept running by control —
// not launchd, which macOS keeps out of /Volumes/... without Full Disk Access.
// For every project with a `registry` in its project.json: a zot not answering
// on 127.0.0.1:<port>/v2/ gets registry:up, the idempotent one-shot that
// installs, configures and starts it; one that fails is tried again after a
// failing step's backoff (backoff.js: 30 seconds doubling to 30 minutes), each
// failure logged. On the first pass and every 30 minutes after,
// registry:refresh-credentials (the Mac's gcloud login, whose tokens last
// about an hour; nothing for a project with no upstream) and registry:sweep
// run; either failing — gcloud logged out, say — is logged, and the next half
// hour tries again. The work runs beside
// the tick, one job per project at a time, so registry:up's wait for zot (up
// to 30 seconds) never holds up the agents. Control leaves zot running when
// it exits: VMs, other controls and the next control use it as it is.
import { backoffDelay, held } from './backoff.js';
import { timerDue } from './triggers.js';

const PHASE = 'registry';
const MAINTAIN_SECONDS = 30 * 60;

// Whether something answers zot's API on the port, in 2 seconds.
const answers = port => fetch(`http://127.0.0.1:${port}/v2/`, { signal: AbortSignal.timeout(2000) }).then(res => res.ok, () => false);

// superviseRegistries(ctx, state) — starts, for each such project with no job
// running, its job (keep); memory.registry: id → { job, failures, until }.
export function superviseRegistries(ctx, state) {
  const registries = (ctx.memory.registry ??= new Map());
  for (const project of state.projects) {
    const port = project.json.registry?.port;
    if (port == null) continue;
    const r = registries.get(project.id) ?? { job: null, failures: 0, until: 0 };
    registries.set(project.id, r);
    r.job ??= keep(ctx, project.id, port, r).finally(() => { r.job = null; });
  }
}

// One project's pass: zot started when it does not answer (not while backed
// off), then the half-hourly maintenance when due.
async function keep(ctx, id, port, r) {
  const now = ctx.now().getTime();
  if (await answers(port)) r.failures = 0;
  else if (now >= r.until) {
    try {
      await ctx.cli(['registry:up', id]);
      ctx.log(PHASE, `${id}: zot was not answering on 127.0.0.1:${port}; started it (registry:up)`);
      r.failures = 0;
    } catch (error) {
      const wait = backoffDelay(++r.failures);
      r.until = now + wait;
      ctx.log('error', `${PHASE} ${id}: zot is not answering on 127.0.0.1:${port} and registry:up failed (${r.failures} in a row; next try in ${held(wait)}): ${error.message}`);
    }
  }
  if (!timerDue(ctx.memory, `${id}/registry-maintain`, MAINTAIN_SECONDS, now, 0)) return;
  for (const command of ['registry:refresh-credentials', 'registry:sweep']) await ctx.attempt(PHASE, `${id} ${command}`, () => ctx.cli([command, id]));
}
