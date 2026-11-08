// Fast-tracked tickets (ASS-83): a ticket the health check raises for the
// harness itself (ticket:create --fast-track, then ticket:join-sprint in the
// same step), and the fix ticket the grouped blocked flow raises for it
// (ASS-306: ticket:mark-fast-track, then ticket:join-sprint, both in the
// engine's Fast-Track the Fix step), carry fast-track: true into the sprint,
// where they rank above everything (rank.js rankSprint) and pre-empt running
// work for a seat.
//
// A seat is one of the three pools that can hold a ticket back, each capped
// by harness.json and the project's own project.json: a planning or an
// in-progress ticket slot (max-tickets-in-planning, -in-progress; ASS-126,
// plan.js), or an agent (max-agents). A fast-tracked variation waits for a
// slot when control would move it but none of the kind it needs is free — at
// the queue (committed) for a planning one, or a move into a step that takes
// a slot it does not hold (moves.js mayMove) — and for an agent when its
// step, or its run's (dispatch.js), would get one but max-agents is full.
// steps.js and dispatch.js record each wait in ctx.memory.seats as they meet
// it (waitsForSeat), afresh every tick. Before the next tick's steps,
// fastTrack pauses, for each such wait, exactly one running ticket holding a
// seat in that pool — a slot of that kind, or an agent (an assignment on its
// variation) — the lowest-ranked first (rankSprint's order, reversed), never a
// fast-tracked one; unless one is already paused for that ticket and pool
// (one seat per fast-tracked ticket and pool: N waiting free N seats). The
// pause is the ticket variation's is-paused, as anyone's, marked
// paused-for-fast-track: <its key> and preempted-seat: <the pool>
// (ticket:set-preempted) so it is told apart from the operator's: the plan
// then counts it in no slot, supervise.js shuts its agent down (an agent
// seat frees once it is gone), its VM stops (vm-lifecycle.js), and a freed
// slot is taken in the same tick's steps. A variation so paused is resumed
// (ticket:set-preempted … -) once its fast-tracked ticket no longer needs
// that pool: for a slot, it neither holds one of that kind nor waits for one;
// for an agent, it holds no seat in any pool nor waits for one (between
// steps it has no agent for a moment, but is still at work) — done, blocked,
// paused, gone. The seat then goes back by rank as any free seat does. A
// pause the operator takes over (ticket:set-paused clears the mark) is never
// resumed here. Only the project's own tickets are paused (each control its
// own project, ASS-9), and backlog grooming's agents never are; nor is a
// ticket worked by hand (ASS-166, isManual) ever paused or resumed here.
// Each pause and resume is logged, as is each fast-tracked ticket that joins
// the sprint while control runs, and each one in the backlog but not the
// sprint — its join failed — once while it stays there.
import { statusIn, isManual, isHeld } from './engine.js';
import { planFor, slotKind } from './plan.js';
import { rankSprint } from './rank.js';

const PHASE = 'fast-track';
const fast = t => t?.['fast-track'] === true;
const SEAT = { planning: 'a planning seat', progress: 'an in-progress seat', agents: 'an agent seat' };
const POOL = { planning: 'planning', progress: 'in-progress', agents: 'agent' };

// waitsForSeat(memory, project, ticket, variation, kind) — a fast-tracked
// variation could not move for want of a seat of `kind` ('planning' |
// 'progress' | 'agents'): remembered for this tick's fastTrack. Any other ticket's is not.
export function waitsForSeat(memory, project, ticket, variation, kind) {
  if (!fast(ticket) || kind == null) return;
  (memory.seats ??= []).push({ project: project.id, key: ticket.key, variation: variation.name, kind });
}

// preemptions({ tickets, engine, engines, holders, waiting }) — what to pause
// and resume (see the module comment), pure. `tickets` the sprint in rank
// order; `holders` { planning, progress }: the { key, variation } holding each
// pool's seats, in rank order — planning and progress as planDispatch gives
// them, agents the variations with an assignment; `waiting` the { key,
// variation, kind } fast-tracked variations that waited for a seat (kind the pool). Returns { pause:
// [{ key, variation, for, kind }], resume: [{ key, variation, for, kind }] }.
export function preemptions({ tickets, engine, engines, holders, waiting }) {
  const byKey = new Map(tickets.map(t => [t.key, t]));
  const needs = (key, kind) => holders[kind]?.some(h => h.key === key) || waiting.some(w => w.key === key && w.kind === kind);
  const wants = (key, kind) => (kind === 'agents' ? Object.keys(SEAT).some(k => needs(key, k)) : needs(key, kind));
  const preempted = tickets.flatMap(t => (t.variations ?? []).filter(v => !isManual(t) && !v['is-deleted'] && v['is-paused'] === true && v['paused-for-fast-track'] != null).map(v => {
    const status = statusIn(engine, v, engines);
    return { key: t.key, variation: v.name, for: v['paused-for-fast-track'], kind: v['preempted-seat'] ?? slotKind(status.step, status) };
  }));
  const resume = preempted.filter(p => !wants(p.for, p.kind));
  const kept = preempted.filter(p => !resume.includes(p));
  const pause = [];
  for (const w of waiting) {
    if ([...kept, ...pause].some(p => p.for === w.key && p.kind === w.kind)) continue;
    const victim = holders[w.kind]?.toReversed().find(h => !fast(byKey.get(h.key)) && !isManual(byKey.get(h.key)) && !pause.some(p => p.key === h.key && p.variation === h.variation));
    if (victim) pause.push({ ...victim, for: w.key, kind: w.kind });
  }
  return { pause, resume };
}

// fastTrack(ctx, state) — each project's fast-tracked tickets noted (logged)
// and its pre-emptions made: the seats waited for in the last tick's steps
// (ctx.memory.seats), then forgotten.
export async function fastTrack(ctx, state) {
  const waits = ctx.memory.seats ?? [];
  ctx.memory.seats = [];
  for (const project of state.projects) {
    note(ctx, project);
    if (!project.engine || !project.sprint) continue;
    const planned = planFor(state, project);
    const { pause, resume } = preemptions({
      tickets: rankSprint(project.tickets, { engine: project.engine }), engine: project.engine, engines: project.engines ?? state.engines,
      holders: { planning: planned.inPlanning, progress: planned.reserved, agents: working(state, project) }, waiting: waits.filter(w => w.project === project.id),
    });
    for (const r of resume) await ctx.attempt(PHASE, `${r.key} ${r.variation}`, async () => {
      await ctx.cli(['ticket:set-preempted', project.id, r.key, r.variation, '-']);
      ctx.log(PHASE, `resumed ${r.key} ${r.variation}: fast-tracked ${r.for} no longer needs its ${POOL[r.kind] ?? r.kind} seat`);
    });
    for (const p of pause) await ctx.attempt(PHASE, `${p.key} ${p.variation}`, async () => {
      await ctx.cli(['ticket:set-preempted', project.id, p.key, p.variation, p.for, p.kind]);
      ctx.log(PHASE, `paused ${p.key} to free a seat for fast-tracked ${p.for} (${p.key} ${p.variation} held ${SEAT[p.kind]})`);
    });
  }
}

// working(state, project) — the project's sprint variations, not held (isHeld), with
// an assignment on them (its work-item and its variation, or none named), in rank order.
function working(state, project) {
  const on = (key, name) => state.assignments.some(a => a.project === project.id && a['work-item'] === key && (a.variation == null || a.variation === name));
  return rankSprint(project.tickets, { engine: project.engine })
    .flatMap(t => (t.variations ?? []).filter(v => !v['is-deleted'] && !isHeld(t, v) && on(t.key, v.name)).map(v => ({ key: t.key, variation: v.name })));
}

// note(ctx, project) — logs a fast-tracked ticket new to the sprint since the
// last tick (none at control's first sight of the project: they joined
// before it ran), and one in the backlog but not the sprint when first seen there.
function note(ctx, project) {
  const seen = (ctx.memory.fastTracked ??= new Map());
  const sprint = new Set((project.tickets ?? []).filter(fast).map(t => t.key));
  const backlog = new Set((project.backlog ?? []).filter(fast).map(t => t.key));   // loadState's: none in the sprint
  const was = seen.get(project.id);
  for (const key of sprint) if (was && !was.sprint.has(key)) ctx.log(PHASE, `fast-tracked ${key} joined the sprint`);
  for (const key of backlog) if (!was?.backlog.has(key)) ctx.log(PHASE, `fast-tracked ${key} is in the backlog, not the sprint: its join failed; join it by hand, or its source tries again on its next run`);
  seen.set(project.id, { sprint, backlog });
}
