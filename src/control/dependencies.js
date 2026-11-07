// ASS-195: a ticket waits for the tickets it depends on. In a project whose
// project.json says wait-for-dependencies: true (missing or anything else:
// off, so nothing changes until an operator sets it), a sprint variation at
// the queue — Committed — whose ticket depends on a same-project ticket that
// is not Done does not leave it: no planning or in-progress slot, no agent.
// A variation already past Committed keeps going; only Committed holds.
// dependencyHold is the one predicate control and the dashboard share, so
// what the Status cell says and what control does can never disagree; control
// wraps it in awaitsDependencies, shaped on vm-lifecycle.js's awaitsVm, and
// checks it wherever work starts (steps.js, dispatch.js — ASS-158: one
// predicate, every path).
//
// A dependency is Done when its ticket-system-status is Done or, in the
// sprint, any variation not soft-deleted sits at an is-done step. A backlog
// dependency's variations sit in the refinement engine, whose own done step
// means refined, not Done, so only its status counts there. A key this
// project does not list cannot be judged and so holds nothing: it is ignored
// — as `another project`'s when another loaded project has it, else as
// `unknown` (a soft-deleted ticket reads as unknown, loadState having dropped
// it).
//
// While a ticket waits, raiseDependencies (a tick phase) brings each
// dependency holding it forward, so the wait is as short as it can be: a
// backlog one to the top of the backlog, where refinement reaches it next and
// the existing join (ASS-44) brings it into the sprint once it is ready; a
// sprint one to the dependent's own manual priority, which the command's
// make-room moves one down. Each raise goes through the priority command with
// its <for>, which records priority-raised-by { field, value, for } on the
// dependency in the same locked write, and is released through the same
// command once the hold ends — the field cleared only while it still holds
// the value the raise wrote, so an operator's own value is never taken away.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDoneStep } from './engine.js';
import { rankSprint, rankBacklog } from './rank.js';

const PHASE = 'dependencies';
// The queue a dev engine holds a committed ticket in, and where alone a hold holds.
const COMMITTED = 'committed';
const RAISED = 'priority-raised-by';
const upper = key => String(key ?? '').toUpperCase();

// dependencyHold({ on (the project's wait-for-dependencies), engine (its
// execution engine), tickets (its sprint's, soft-deleted dropped), backlog
// (its backlog's not in the sprint, soft-deleted dropped), elsewhere (the
// keys every other loaded project has) }, ticket, variation) — { waits: the
// keys holding the variation, in the order the ticket depends on them;
// ignores: [{ key, why: 'unknown' | 'another project' }] }; both empty unless
// the flag is on and the variation is at Committed. Pure, and the only place
// the rule lives.
export function dependencyHold({ on, engine, tickets = [], backlog = [], elsewhere = [] }, ticket, variation) {
  const waits = [], ignores = [];
  if (on !== true || variation?.['harness-status']?.state !== COMMITTED) return { waits, ignores };
  const find = (list, key) => list.find(t => upper(t.key) === key);
  for (const key of ticket.dependencies ?? []) {
    const inSprint = find(tickets, upper(key));
    const dependency = inSprint ?? find(backlog, upper(key));
    if (!dependency) ignores.push({ key, why: elsewhere.some(k => upper(k) === upper(key)) ? 'another project' : 'unknown' });
    else if (!isDone(engine, dependency, inSprint != null)) waits.push(dependency.key);
  }
  return { waits, ignores };
}

// isDone(engine, dependency, inSprint) — the dependency is done with: its
// ticket system says so, or — in the sprint alone — one of its live
// variations is at an is-done step of the execution engine.
const isDone = (engine, dependency, inSprint) => dependency['ticket-system-status'] === 'Done'
  || (inSprint && (dependency.variations ?? []).some(v => v['is-deleted'] !== true && isDoneStep(engine, v['harness-status']?.state)));

// The keys every loaded project other than this one has, in its sprint or its
// backlog: a dependency on one of them is another project's (ASS-9: each
// control works one project, but every project is loaded).
const elsewhereKeys = (state, project) => (state.allProjects ?? state.projects)
  .filter(p => p.id !== project.id).flatMap(p => [...p.tickets, ...p.backlog].map(t => t.key));

// holdOf(state, project, ticket, variation) — dependencyHold on a loaded project.
export const holdOf = (state, project, ticket, variation) => dependencyHold({
  on: project.json?.['wait-for-dependencies'] === true,
  engine: project.engine,
  tickets: project.tickets,
  backlog: project.backlog,
  elsewhere: elsewhereKeys(state, project),
}, ticket, variation);

// awaitsDependencies(ctx, state, project, ticket, variation, who) — whether
// the variation waits for the tickets it depends on, and so starts nothing:
// what it waits on is logged once per change of it (memory.dependencyWaits:
// project/key/variation → the keys), dropped once it waits on nothing, so
// every path may ask without saying it twice. Nothing to judge (a run with no
// ticket of its own) waits for nothing.
export function awaitsDependencies(ctx, state, project, ticket, variation, who) {
  if (!ticket || !variation) return false;
  const { waits } = holdOf(state, project, ticket, variation);
  const logged = (ctx.memory.dependencyWaits ??= new Map()), at = `${project.id}/${ticket.key}/${variation.name}`;
  if (!waits.length) { logged.delete(at); return false; }
  if (logged.get(at) !== waits.join(', ')) { logged.set(at, waits.join(', ')); ctx.log(PHASE, `${who}: waits on ${waits.join(', ')}`); }
  return true;
}

// raiseDependencies(ctx, state) — the tick phase that keeps every held
// ticket's dependencies ahead of it (see the module comment): each raise
// written once and released once the hold that made it ends. Release runs
// whatever the flag, so turning it off gives back every raise it made.
export async function raiseDependencies(ctx, state) {
  for (const project of state.projects) {
    if (!project.engine || !project.sprint) continue;
    // Who waits on what this tick: a dependency's key, upper case → the keys of the dependents it holds.
    const waiting = new Map();
    for (const ticket of project.tickets) for (const variation of ticket.variations ?? []) {
      if (variation['is-deleted'] === true) continue;
      for (const key of holdOf(state, project, ticket, variation).waits) waiting.set(upper(key), (waiting.get(upper(key)) ?? new Set()).add(ticket.key));
    }
    await raises(ctx, project, waiting);
    await releases(ctx, project, waiting);
  }
}

// Each holding dependency raised above its dependent, once: a backlog one to
// manual-backlog-priority 1, a sprint one to the dependent's manual priority
// — neither when it already ranks above (first in rankBacklog or already
// raised; before the dependent in rankSprint), nor a sprint one when the
// dependent has no manual priority to be put above. One raise per dependency
// a tick, so the next tick judges it as it now stands and writes nothing
// more: a raise that renumbered the backlog every tick, or slid the pair one
// rank down, would never settle.
async function raises(ctx, project, waiting) {
  const first = upper(rankBacklog(project.backlog)[0]?.key);
  const order = rankSprint(project.tickets, { engine: project.engine }).map(t => upper(t.key));
  for (const [key, dependents] of waiting) {
    const row = project.backlog.find(t => upper(t.key) === key);
    if (row) {
      if (row[RAISED] != null || first === key) continue;
      const dependent = [...dependents][0];
      await ctx.attempt(PHASE, row.key, async () => {
        await ctx.cli(['ticket:set-manual-backlog-priority', project.id, row.key, '1', dependent]);
        ctx.log(PHASE, `${row.key}: raised to the top of the backlog for ${dependent}, which waits on it`);
      });
      continue;
    }
    const dependency = project.tickets.find(t => upper(t.key) === key);
    if (!dependency) continue;
    for (const dependent of dependents) {
      const to = project.tickets.find(t => upper(t.key) === upper(dependent))?.['manual-priority'];
      if (to == null || order.indexOf(key) < order.indexOf(upper(dependent))) continue;
      await ctx.attempt(PHASE, dependency.key, async () => {
        await ctx.cli(['ticket:set-manual-priority', project.id, dependency.key, String(to), dependent]);
        ctx.log(PHASE, `${dependency.key}: raised to ${to}, above ${dependent}, which waits on it`);
      });
      break;
    }
  }
}

// Every raise this project recorded, released once the hold that made it has
// ended — the dependency Done, its dependent past Committed, soft-deleted or
// no longer depending on it, the flag off — through the command that wrote
// it, which clears the field only while it still holds the recorded value. A
// backlog raise goes too the moment its ticket has left the backlog for the
// sprint: the join keeps the backlog.json row (ASS-42) and loadState hides it
// from the backlog, so nothing else would ever give that raise back, its
// dependent waiting on it still — now as a sprint ticket, where the next
// tick's raise puts it above the dependent again.
async function releases(ctx, project, waiting) {
  const held = (key, record) => [...(waiting.get(upper(key)) ?? [])].some(dependent => upper(dependent) === upper(record.for));
  const release = (command, key, record) => ctx.attempt(PHASE, key, async () => {
    await ctx.cli([command, project.id, key, '', record.for]);
    ctx.log(PHASE, `${key}: its raise for ${record.for} given back`);
  });
  for (const ticket of project.tickets) {
    const record = ticket[RAISED];
    if (record?.field === 'manual-priority' && record.for && !held(ticket.key, record)) await release('ticket:set-manual-priority', ticket.key, record);
  }
  const inBacklog = new Set(project.backlog.map(t => upper(t.key)));
  for (const row of backlogRows(ctx, project)) {
    const record = row[RAISED];
    if (record?.field !== 'manual-backlog-priority' || !record.for) continue;
    if (!inBacklog.has(upper(row.key)) || !held(row.key, record)) await release('ticket:set-manual-backlog-priority', row.key, record);
  }
}

// backlogRows(ctx, project) — the project's backlog.json entries as they
// stand, those of tickets now in the sprint included: loadState's backlog
// hides them (state.js), and a raise recorded on one must still be given
// back. Read straight from the file, as vm-lifecycle.js reads vms.json; []
// when there is none, and when it cannot be read, said once a tick.
function backlogRows(ctx, project) {
  const file = join(ctx.paths.projects, project.id, 'backlog.json');
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')).tickets ?? []; }
  catch (error) { ctx.log(PHASE, `${project.id}: its backlog.json cannot be read: ${error.message}`); return []; }
}
