// ASS-558: control keeps each sprint ticket variation's commit list
// (work/<KEY>/commits-<variation>.json, ticket-commits.js) fresh for the ticket
// screen's Commits tab, by running `agent.sh ticket:refresh-commits` for the
// variations due:
// - after a step that commits: the variation moved since the list was last
//   refreshed, out of a step that can commit — one that uses its machine
//   (machine-steps.js usesMachine: an agent's turn, an in-machine script) or a
//   merge-request:* or code:* script (a merge, a branch made or handed over) —
//   or into a done step; a step not found in its engine counts as one that can;
// - periodically: its list older than harness.json's commits-refresh-minutes
//   (COMMITS_REFRESH_MINUTES, 15, by default), until its ticket is done — a done
//   variation's list is refreshed once after the move into done, then left;
// - and once, with no list yet, as soon as the variation has any work: a merge
//   request, a branch, or an agent dispatched on it.
// Gathering reads only the forge and the Mac's clones (ticket-commits.js): no
// machine is started or connected to for it (AC3).
//
// Like the other periodic checks that call out (background-checks.js, ASS-497)
// it runs as a background job the tick does not await, at most one per project,
// looked at once a minute (CHECK_EVERY_MS); a job refreshes at most
// MAX_PER_CHECK variations, in rank order of staleness (never refreshed first,
// then the oldest), the rest the next minute. A refresh that fails is logged
// and tried again at the next due time.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundCheck, settled } from './background-checks.js';
import { usesMachine, commandOf } from './machine-steps.js';
import { stepOf, isDoneStep } from './engine.js';
import { COMMITS_FILE } from './ticket-commits.js';

export const COMMITS_REFRESH_MINUTES = 15;
export const CHECK_EVERY_MS = 60_000;
export const MAX_PER_CHECK = 10;
const PHASE = 'commits';

// The deepest change of a move (its sub-state-changes followed down): the step it left, in its own engine.
const deepest = change => { let c = change; while (c['sub-state-change']) c = { ...c['sub-state-change'], 'state-engine': c['sub-state-change']['state-engine'] ?? c['state-engine'] }; return c; };

// commits(step) — whether leaving `step` can have left commits behind (see above); an unknown step can.
export function commits(step) {
  if (!step) return true;
  if (usesMachine(step)) return true;
  const c = step.action?.type === 'script' ? commandOf(step.action.command) : null;
  return Boolean(c && /^(merge-request|code):/.test(c.name));
}

// worked(v) — the variation has anything commits could be found for: a merge request, a branch, an agent dispatched.
const worked = v => (v['merge-request'] ?? []).length > 0 || Boolean(v.build?.branch)
  || (v['state-changes'] ?? []).some(c => (c['agent-dispatch-log'] ?? []).length > 0);

// commitsDue(v, list, { engines, engineName, now, everyMs }) — whether variation `v`'s list (its commits file's JSON,
// or null for none) is due a refresh (see the module comment). Returns the reason, or null.
export function commitsDue(v, list, { engines = {}, engineName, now, everyMs = COMMITS_REFRESH_MINUTES * 60e3 }) {
  if (!worked(v)) return null;
  const refreshed = Date.parse(list?.['refreshed-at'] ?? '');
  if (!Number.isFinite(refreshed)) return 'no list yet';
  const top = engines[engineName];
  const done = isDoneStep(top, v['harness-status']?.state);
  const since = (v['state-changes'] ?? []).filter(c => Date.parse(c.timestamp) > refreshed);
  for (const change of since.toReversed()) {
    if (isDoneStep(top, change['to-state'])) return 'moved into done';
    const d = deepest(change);
    if (commits(stepOf(engines[d['state-engine']] ?? top, d['from-state']))) return `left ${d['from-state']}`;
  }
  if (done) return null;
  return now - refreshed >= everyMs ? 'periodic' : null;
}

const readList = file => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

// refreshCommitLists(ctx, state) — the control phase (nothing without ctx.commitLists: tick.js createContext); starts each project's job when its minute is up, returns at
// once with a promise of the jobs it started (the tick leaves it; tests await it).
export function refreshCommitLists(ctx, state) {
  if (!ctx.commitLists) return settled([]);
  const memory = (ctx.memory.commitRefresh ??= new Map());
  const now = ctx.now().getTime(), jobs = [];
  const minutes = Number(state.harness?.['commits-refresh-minutes']);
  const everyMs = (minutes > 0 ? minutes : COMMITS_REFRESH_MINUTES) * 60e3;
  for (const project of state.projects) {
    if (ctx.project && ctx.project !== project.id) continue;
    if (!project.tickets?.length) continue;
    if (now - (memory.get(project.id) ?? -Infinity) < CHECK_EVERY_MS) continue;
    const job = backgroundCheck(ctx, `refreshCommitLists/${project.id}`, job => refreshProject(job, project, now, everyMs));
    if (!job) continue;
    memory.set(project.id, now);
    jobs.push(job);
  }
  return settled(jobs);
}

// refreshProject(ctx, project, now, everyMs) — one project's due variations refreshed, in the background.
async function refreshProject(ctx, project, now, everyMs) {
  const dir = join(ctx.paths.projects, project.id);
  const due = [];
  for (const t of project.tickets) {
    for (const v of (t.variations ?? []).filter(x => x['is-deleted'] !== true && x.name)) {
      const list = readList(join(dir, 'work', t.key, COMMITS_FILE(v.name)));
      const why = commitsDue(v, list, { engines: project.engines, engineName: project.engineName, now, everyMs });
      if (why) due.push({ key: t.key, variation: v.name, why, at: Date.parse(list?.['refreshed-at'] ?? '') || 0 });
    }
  }
  for (const d of due.toSorted((a, b) => a.at - b.at).slice(0, MAX_PER_CHECK)) {
    if (ctx.checkSignal?.aborted) return;
    await ctx.attempt(PHASE, `${project.id} ${d.key} ${d.variation} (${d.why})`, () => ctx.cli(['ticket:refresh-commits', project.id, d.key, d.variation]));
  }
}
