// ASS-195, ASS-355: a ticket waits for the tickets it depends on. In a
// project whose project.json says wait-for-dependencies: true (missing or
// anything else: off, so nothing changes until an operator sets it), a sprint
// variation whose ticket depends on a ticket that is not done is held at the
// step it is on, whatever that step (ASS-355; ASS-195 held at Committed
// alone): no agent is dispatched for it, at the top level or in a run under
// it, no step script, sub-engine run or move is started for it, and it holds
// no planning or in-progress slot and no agent seat (plan.js), its VM stopped
// as for one waiting for a slot (vm-lifecycle.js). Never held (neverHeld): a
// done step (at any level of its status), and a step where only a person acts
// — a human step at any level (human-action steps, Human Review, Blocked for
// Human, a payment gate), a gate waiting on a human once its work is done
// (waitsOnHuman), or a `none` step waiting on the board alone, as QA Testing
// does (waitsOnTicketSystem). An agent already running when the hold begins
// finishes its turn (nothing here stops a process); the hold applies from the
// next dispatch, and when it lifts the variation goes on at the same step: it
// never moved, so no step re-runs and no visit is spent.
//
// dependencyHold is the one predicate control, the planner, the VM job and
// the dashboard share, so what the Status cell says and what control does can
// never disagree; control wraps it in awaitsDependencies, shaped on
// vm-lifecycle.js's awaitsVm, and checks it wherever work starts (steps.js,
// dispatch.js — ASS-158: one predicate, every path), the planner and the VM
// job through holdOf.
//
// Where a dependency is found, in order (dependencyRows): the project's own
// sprint, its own backlog, another loaded project's sprint or backlog, and —
// a Jira ticket in neither, assigned to a teammate, say — the project's
// outside-tickets.json (the downloader's by-key read, ASS-355). A dependency
// is done when its ticket-system-status equals the status paired with an
// is-done step of the execution engine of the project it belongs to
// (doneStatuses: never a hard-coded "Done") — the dependent's own engine for
// an outside one, the other project's for one there — or, in a sprint, when
// any variation not soft-deleted sits at an is-done step of that engine. A
// backlog dependency's variations sit in the refinement engine, whose own
// done step means refined, not done, so only its status counts there. A key
// found nowhere cannot be judged and so holds nothing: it is ignored as
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
// A dependency in another project, or outside, cannot be raised: skipped
// silently.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDoneStep, statusIn, waitsOnHuman, waitsOnTicketSystem } from './engine.js';
import { rankSprint, rankBacklog } from './rank.js';

const PHASE = 'dependencies';
const RAISED = 'priority-raised-by';
const upper = key => String(key ?? '').toUpperCase();

// doneStatuses(engine) — the ticket-system statuses an execution engine's
// is-done steps pair with (paired-ticket-system-status), in its `steps`.
export const doneStatuses = engine => (engine?.steps ?? []).filter(s => s['is-done'] === true).map(s => s['paired-ticket-system-status']).filter(s => s != null);

// neverHeld(engine, variation, engines) — the variation stands where no
// dependency ever holds it (see the module comment): no status; a done step
// at any level; a human's (waitsOnHuman); or a step waiting on the board
// alone, its deepest (waitsOnTicketSystem).
export function neverHeld(engine, variation, engines = {}) {
  const status = statusIn(engine, variation, engines);
  if (!status.step) return true;
  if (status.chain.some(l => l.step?.['is-done'] === true)) return true;
  return waitsOnHuman(engine, variation, engines) || waitsOnTicketSystem(status.detailStep ?? status.step);
}

// isDone(engine, dependency, inSprint) — the dependency is done (see the module comment).
const isDone = (engine, dependency, inSprint) => doneStatuses(engine).includes(dependency['ticket-system-status'])
  || (inSprint && (dependency.variations ?? []).some(v => v['is-deleted'] !== true && isDoneStep(engine, v['harness-status']?.state)));

// dependencyRows({ engine, tickets, backlog, outside, elsewhere }, ticket) —
// each key the ticket depends on, in its order: { key (as the dependency
// spells it, else as the ticket does), where ('sprint' | 'backlog' |
// 'another project' | 'outside' | 'unknown'), project (another project's id),
// status (its ticket-system-status), assignee (its ticket-system-assignment),
// done (true / false; null when unknown) }. `elsewhere`: each other loaded
// project's { id, engine, tickets, backlog }; `outside`: the project's
// outside-tickets.json tickets. Pure.
export function dependencyRows({ engine, tickets = [], backlog = [], outside = [], elsewhere = [] }, ticket) {
  const find = (list, key) => (list ?? []).find(t => upper(t.key) === key);
  const row = (key, where, dependency, done, project) => ({ key: dependency?.key ?? key, where, ...(project != null ? { project } : {}),
    status: dependency?.['ticket-system-status'] ?? null, assignee: dependency?.['ticket-system-assignment'] ?? null, done });
  return (ticket?.dependencies ?? []).filter(key => upper(key) !== upper(ticket.key)).map(key => {
    const k = upper(key);
    const inSprint = find(tickets, k);
    if (inSprint) return row(key, 'sprint', inSprint, isDone(engine, inSprint, true));
    const inBacklog = find(backlog, k);
    if (inBacklog) return row(key, 'backlog', inBacklog, isDone(engine, inBacklog, false));
    for (const other of elsewhere) {
      const there = find(other.tickets, k), later = there ? null : find(other.backlog, k);
      if (there || later) return row(key, 'another project', there ?? later, isDone(other.engine, there ?? later, there != null), other.id);
    }
    const out = find(outside, k);
    if (out) return row(key, 'outside', out, isDone(engine, out, false));
    return row(key, 'unknown', null, null);
  });
}

// dependencyHold({ on (the project's wait-for-dependencies), engine (its
// execution engine), engines (those beneath it, by name), tickets (its
// sprint's, soft-deleted dropped), backlog (its backlog's not in the sprint,
// soft-deleted dropped), outside (its outside-tickets.json tickets),
// elsewhere (every other loaded project's { id, engine, tickets, backlog })
// }, ticket, variation) — { waits: the keys holding the variation, in the
// order the ticket depends on them; ignores: [{ key, why: 'unknown' }] };
// both empty unless the flag is on and the variation stands where a hold
// holds (neverHeld). Pure, and the only place the rule lives.
export function dependencyHold({ on, engine, engines = {}, ...found }, ticket, variation) {
  if (on !== true || !variation || variation['is-deleted'] === true || neverHeld(engine, variation, engines)) return { waits: [], ignores: [] };
  const rows = dependencyRows({ engine, ...found }, ticket);
  return { waits: rows.filter(r => r.done === false).map(r => r.key), ignores: rows.filter(r => r.where === 'unknown').map(r => ({ key: r.key, why: 'unknown' })) };
}

// Every loaded project other than this one, as dependencyRows takes it
// (ASS-9: each control works one project, but every project is loaded).
const elsewhereOf = (state, project) => (state.allProjects ?? state.projects ?? [])
  .filter(p => p.id !== project.id).map(p => ({ id: p.id, engine: p.engine, tickets: p.tickets ?? [], backlog: p.backlog ?? [] }));

// holdingOf(state, project) — what dependencyHold and dependencyRows take of a loaded project.
export const holdingOf = (state, project) => ({
  on: project.json?.['wait-for-dependencies'] === true,
  engine: project.engine,
  engines: project.engines ?? state.engines ?? {},
  tickets: project.tickets ?? [],
  backlog: project.backlog ?? [],
  outside: project.outside ?? [],
  elsewhere: elsewhereOf(state, project),
});

// holdOf(state, project, ticket, variation) — dependencyHold on a loaded project.
export const holdOf = (state, project, ticket, variation) => dependencyHold(holdingOf(state, project), ticket, variation);

// heldBy(state, project) — (ticket, variation) → whether dependencyHold holds
// it: what the planner and the VM job ask, the project's context built once.
export function heldBy(state, project) {
  if (project.json?.['wait-for-dependencies'] !== true) return () => false;
  const holding = holdingOf(state, project);
  return (ticket, variation) => dependencyHold(holding, ticket, variation).waits.length > 0;
}

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
// ended — the dependency done, its dependent at a step no hold holds, soft-deleted or
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
