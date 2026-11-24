// ASS-576: a ticket-system transition acli failed to make (it can exit 0 on
// one: `✗ Failure: … unauthorized`) is left on the sprint ticket as
// pending-ticket-system-status { status, from, at, error } by
// ticket:set-ticket-system-status, which never sets the status it could not.
// Control tries it again here: once a minute per project (CHECK_EVERY_MS), as
// a background job (background-checks.js, commit-refresh.js's pattern), it
// runs ticket:set-ticket-system-status <project> <KEY> <status> for each
// ticket with one pending; the command clears it once acli succeeds. A retry
// that fails is logged and tried again the next minute. ticket:sync drops a
// pending transition once upstream moves off its `from`, so a retry never
// undoes a later move. Off with ctx.transitionRetries false
// (TRANSITION_RETRIES_DISABLED=1, tick.js createContext).
import { backgroundCheck, settled } from './background-checks.js';

export const CHECK_EVERY_MS = 60_000;
const PHASE = 'transitions';

// retryTransitions(ctx, state) — the control phase: starts each project's job when its minute is up, returns at once
// with a promise of the jobs it started (the tick leaves it; tests await it).
export function retryTransitions(ctx, state) {
  if (!ctx.transitionRetries) return settled([]);
  const memory = (ctx.memory.transitionRetry ??= new Map());
  const now = ctx.now().getTime(), jobs = [];
  for (const project of state.projects) {
    if (ctx.project && ctx.project !== project.id) continue;
    const pending = (project.tickets ?? []).filter(t => t['pending-ticket-system-status']?.status);
    if (!pending.length) continue;
    if (now - (memory.get(project.id) ?? -Infinity) < CHECK_EVERY_MS) continue;
    const job = backgroundCheck(ctx, `retryTransitions/${project.id}`, async job => {
      for (const t of pending) {
        if (job.checkSignal?.aborted) return;
        const status = t['pending-ticket-system-status'].status;
        await job.attempt(PHASE, `${project.id} ${t.key} → ${status}`, async () => {
          await job.cli(['ticket:set-ticket-system-status', project.id, t.key, status]);
          job.log(PHASE, `${t.key} ticket system status → ${status} (retried)`);
        });
      }
    });
    if (!job) continue;
    memory.set(project.id, now);
    jobs.push(job);
  }
  return settled(jobs);
}
