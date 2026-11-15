// ASS-420: a seat only when the ticket's VM fits in the Mac's memory. Before
// control gives a variation a planning or an in-progress seat (plan.js) whose
// next steps need a VM that is not running — its top-level step's `vm` (or
// the deepest level's, vm-lifecycle.js vmUse) is `running` and its VM is
// neither up nor seen running — it checks the VM fits, by the memory hold's
// own rule (ASS-422: host-memory.js memoryVerdict, over the same reading, so
// the two never disagree): under normal pressure free memory at least the
// need (host-memory.js vmNeed, the true footprint, ASS-419), under warn the
// memory macOS can reclaim without swapping at least the need and no swap-out
// since the previous reading, under critical never — the need on top of the
// VMs already starting for seats given so (memory.seatMemory.starting, each
// one's need held back till it is up). One that does not fit does not take
// the seat: it waits, as for a slot, with no move, no ticket-system status
// change and no visit spent, and its Health (ticket:set-ai-feedback) says
// "Waiting for memory for its VM (need X GB, Y GB free)" — under warn
// "(need X GB, Y GB reclaimable)", or why none counts (ASS-422) — cleared once
// it gets its seat.
//
// Seats are given two ways, and both ask:
// - A move into a seat-taking step (moves.js mayMove: committed into Setup or
//   Plan, a finished plan on to Build): memoryShortForSeat, synchronously,
//   over the figures this tick's seatMemory read. Control moves the sprint
//   highest-ranked first, so a ticket that does not fit is passed over and a
//   lower-ranked one that does (its VM up, say) moves.
// - A variation already at a seat-taking step that newly holds a seat as
//   the seats come round (one ahead left, the hold lifted): seatMemory, a
//   phase each tick before the VM lifecycle, walks each project's seat holders
//   in rank order and checks each newly seated one (not seated last tick, its
//   VM not already starting); one that does not fit is refused — listed in the
//   project's memory-wait.json `waiting` (plan.js memoryWaitIn: no seat) — and
//   the seats planned again, so the next in rank order may take it. Refused
//   ones are weighed afresh every tick, so a seat is given once memory frees.
//
// A variation whose VM is already running, or whose next steps need none,
// takes its seat as before. The memory hold (ASS-398/404, host-memory.js)
// stays the safety net on VM starts; ASS-404's rule that a freed seat went
// only to a variation whose VM is up is replaced by this check. Without a
// reading of the Mac's memory (none, or HOST_MEMORY_DISABLED) nothing is refused.
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFor, slotKind } from './plan.js';
import { vmNeed, gib, freeBytes, memoryVerdict, reading as hostReading } from './host-memory.js';
import { vmUse, vmUpCeilingMs } from './vm-lifecycle.js';
import { rankSprint } from './rank.js';
import { statusIn, stepOf } from './engine.js';
import { needsMacMemory } from './workstation-machines.js';

const PHASE = 'seats';

// MEMORY_HEALTH — what every long Health this module writes begins with, so it knows its own to clear.
export const MEMORY_HEALTH = 'Waiting for memory for its VM:';

const waitFile = (ctx, id) => join(ctx.paths.projects, id, 'memory-wait.json');
const keyOf = (id, key, variation) => `${id} ${key} ${variation}`;
const GB = bytes => `${gib(Math.max(0, bytes))} GB`;

// WARN_SHORT, WARN_LONG — ASS-422: what the Health says under warn pressure, by the rule that refused it.
const WARN_SHORT = { 'warn-swapping': 'macOS swapping', 'warn-swap-unknown': 'swap-outs not known yet', 'warn-unread': 'reclaimable memory not read' };
const WARN_LONG = {
  'warn-swapping': 'macOS has swapped memory out since its last reading, so none is counted as reclaimable',
  'warn-swap-unknown': 'whether macOS is swapping is not known yet (no earlier reading to compare)',
  'warn-unread': 'the memory macOS can reclaim could not be read',
};

// memoryHealth(need, verdict) — the Health a refused variation shows, { short,
// long }, by the verdict (memoryVerdict) that refused it: its free memory, or
// under warn its reclaimable memory (ASS-422), once the VMs already starting are counted.
export const memoryHealth = (need, verdict) => {
  const room = GB(verdict.room ?? 0), pressure = verdict.rule === 'critical' ? 'critical' : verdict.figure === 'reclaimable' ? 'warn' : null;
  if (pressure !== 'warn') return {
    short: `Waiting for memory for its VM (need ${GB(need.bytes)}, ${room} free)`,
    long: `${MEMORY_HEALTH} its next steps need a VM that is not running, and it does not fit in the Mac's memory${pressure ? ` (macOS memory pressure ${pressure})` : ''}: a VM needs ${GB(need.bytes)} (${need.why}), and ${room} is free once the VMs already starting are counted. It holds no seat meanwhile and takes one once there is room. Nothing for you to do.`,
  };
  const why = WARN_LONG[verdict.rule] ?? `${room} is reclaimable (free, inactive, speculative and purgeable memory) once the VMs already starting are counted`;
  return {
    short: `Waiting for memory for its VM (need ${GB(need.bytes)}, ${verdict.room == null ? '' : `${room} reclaimable, `}${WARN_SHORT[verdict.rule] ?? 'pressure warn'})`,
    long: `${MEMORY_HEALTH} its next steps need a VM that is not running, and it does not fit in the Mac's memory (macOS memory pressure warn): a VM needs ${GB(need.bytes)} (${need.why}), and ${why}. It holds no seat meanwhile and takes one once there is room. Nothing for you to do.`,
  };
};

// state(ctx) — memory.seatMemory: { reading, needs (project id → vmNeed's),
// starting (key → { project, key, variation, vm, bytes, since }), seated (the keys seated last tick, or null at first),
// health (key → { need, free, rule }: the Health written), moveWaits (key → { project, key, variation, need, free, verdict }: mayMove's refusals since the last pass) }.
const stateOf = ctx => (ctx.memory.seatMemory ??= { reading: null, needs: new Map(), starting: new Map(), seated: null, health: new Map(), moveWaits: new Map() });

// vmRunning(ctx, reading, variation) — its VM is up (control reached it), or seen running (limactl list, or its VM process measured).
function vmRunning(ctx, reading, variation) {
  const name = variation.vm?.name;
  return Boolean(name && (ctx.memory.vmsUp?.has(name) || ctx.memory.vmStatus?.get(name) === 'Running' || reading?.vms?.has?.(name)));
}

// needsVm(state, project, variation) — its next steps need its VM running:
// its top-level step's `vm`, or the deepest level's that sets it, is `running`.
function needsVm(state, project, variation) {
  const status = statusIn(project.engine, variation, project.engines ?? state.engines);
  return status.step?.vm === 'running' || vmUse(project.engines ?? state.engines, project.engineName, variation) === 'running';
}

// startingBytes(m) — the memory the VMs already starting for seats given hold back.
const startingBytes = m => [...m.starting.values()].reduce((sum, s) => sum + s.bytes, 0);

// fits(m, reading, need) — the memory hold's verdict (ASS-422: host-memory.js
// memoryVerdict, the one rule) with the VMs starting counted: { fits, free
// (the free or reclaimable memory it compared), verdict }.
function fits(m, reading, need) {
  const verdict = memoryVerdict(reading, need, startingBytes(m));
  return { fits: !verdict.short, free: verdict.room ?? 0, verdict };
}

// memoryShortForSeat(ctx, state, project, variation, to) — moves.js mayMove's
// question (see the module comment): null when the move to top-level step `to`
// may take its seat — it takes none it does not hold, its next steps need no
// VM, its VM runs, the memory is not read, or the VM fits (then held back as
// starting) — else { need, free, verdict }, the refusal remembered for this tick's Health.
export function memoryShortForSeat(ctx, state, project, variation, to) {
  const m = ctx.memory.seatMemory, step = stepOf(project.engine, to), kind = slotKind(step);
  if (!m?.reading || kind == null || step?.vm !== 'running') return null;
  const status = statusIn(project.engine, variation, project.engines ?? state.engines);
  if (slotKind(status.step, status) === kind || vmRunning(ctx, m.reading, variation)) return null;
  if (!needsMacMemory(ctx, state, project, variation)) return null;   // ASS-435: its machine is (or will be) a workstation's
  const need = m.needs.get(project.id);
  if (!need) return null;
  const ticket = project.tickets.find(t => t.variations?.includes(variation)), k = keyOf(project.id, ticket?.key, variation.name);
  if (m.starting.has(k)) return null;
  const verdict = fits(m, m.reading, need);
  if (verdict.fits) {
    m.starting.set(k, { project: project.id, key: ticket?.key, variation: variation.name, vm: variation.vm?.name ?? null, bytes: need.bytes, since: ctx.now().getTime() });
    m.moveWaits.delete(k);
    return null;
  }
  if (ticket) m.moveWaits.set(k, { project: project.id, key: ticket.key, variation: variation.name, need, free: verdict.free, verdict: verdict.verdict });
  return { need, free: verdict.free, verdict: verdict.verdict };
}

// seatMemory(ctx, state) — the tick's phase (see the module comment): the
// Mac's memory and each project's need read; the VMs started since let go of;
// each project's newly seated weighed in rank order, those that do not fit
// refused (memory-wait.json, the seats planned again); the refused ones'
// Health written, and cleared from those no longer refused.
export async function seatMemory(ctx, state) {
  const m = stateOf(ctx);
  m.reading = null;
  if (ctx.hostMemory) {
    for (const project of state.projects) if (project.engine) m.needs.set(project.id, await vmNeed(ctx, state, project));
    m.reading = await hostReading(ctx);   // ASS-422: the reading the hold judges by
  }
  const reading = m.reading, now = ctx.now().getTime(), ceiling = vmUpCeilingMs(state);
  // The VMs started since (or gone, or past the VM-up ceiling) no longer held back.
  for (const [k, s] of m.starting) {
    const project = state.projects.find(p => p.id === s.project), v = project?.tickets.find(t => t.key === s.key)?.variations?.find(x => x.name === s.variation);
    if (!project || !v || v['is-deleted'] || vmRunning(ctx, reading, v) || now - s.since >= ceiling) m.starting.delete(k);
  }
  const seated = new Set(), waiters = [];
  const holdersOf = (project, plan) => new Set([...plan.reserved, ...plan.inPlanning].map(s => keyOf(project.id, s.key, s.variation)));
  for (const project of state.projects) {
    if (!project.engine) continue;
    // Seated last tick; at control's first tick, those seated as loaded (last tick's refusals standing).
    const before = m.seated ?? holdersOf(project, planFor(state, project)), was = k => before.has(k);
    const waiting = [];
    project.memoryWait = null;
    const need = m.needs.get(project.id);
    for (let refused = true; refused;) {
      refused = false;
      const plan = planFor(state, project), holders = holdersOf(project, plan);
      if (reading && need) {
        walk: for (const t of rankSprint(project.tickets, { engine: project.engine })) for (const v of t.variations ?? []) {
          const k = keyOf(project.id, t.key, v.name);
          if (!holders.has(k) || was(k) || m.starting.has(k) || !needsVm(state, project, v) || vmRunning(ctx, reading, v) || !needsMacMemory(ctx, state, project, v)) continue;   // ASS-435: none for a workstation
          const verdict = fits(m, reading, need);
          if (verdict.fits) {
            m.starting.set(k, { project: project.id, key: t.key, variation: v.name, vm: v.vm?.name ?? null, bytes: need.bytes, since: now });
            continue;
          }
          const starting = startingBytes(m);
          waiting.push({ key: t.key, variation: v.name, state: v['harness-status']?.state, 'need-bytes': need.bytes, 'need-why': need.why, 'free-bytes': Math.max(0, (reading.freeBytes ?? freeBytes(reading)) - starting), 'reclaimable-bytes': reading.reclaimableBytes == null ? null : Math.max(0, reading.reclaimableBytes - starting), pressure: reading.pressure, rule: verdict.verdict.rule, why: verdict.verdict.why });   // ASS-422: the reclaimable figure, and the rule that refused it
          waiters.push({ project: project.id, key: t.key, variation: v.name, need, free: verdict.free, verdict: verdict.verdict });
          project.memoryWait = { waiting };
          refused = true;
          break walk;   // its seat freed: planned again, the next in rank order may take it
        }
      }
      if (!refused) for (const k of holders) seated.add(k);
    }
    record(ctx, project.id, project.memoryWait);
  }
  for (const k of m.starting.keys()) if (!seated.has(k)) m.starting.delete(k);   // not seated (a move given room but held at a gate, say): nothing starting for it
  m.seated = seated;
  await health(ctx, state, m, [...waiters, ...m.moveWaits.values()]);
  m.moveWaits.clear();
}

// record(ctx, id, wait) — the project's memory-wait.json: written when it
// differs, removed with none waiting.
function record(ctx, id, wait) {
  const file = waitFile(ctx, id);
  if (!wait?.waiting?.length) { if (existsSync(file)) rmSync(file, { force: true }); return; }
  const body = `${JSON.stringify(wait, null, 2)}\n`, tmp = `${file}.tmp`;
  try { writeFileSync(tmp, body); renameSync(tmp, file); } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
}

// seatWords({ need, free, verdict }) — a refusal in words for the logs: ASS-420's
// "need X GB, Y GB free[, pressure critical]", or under warn (ASS-422) the
// rule that refused it ("need X GB; pressure warn, swapping …: held").
export function seatWords({ need, free, verdict }) {
  if (verdict.figure === 'reclaimable') return `need ${GB(need.bytes)}; ${verdict.brief}`;
  return `need ${GB(need.bytes)}, ${GB(free)} free${verdict.rule === 'critical' ? ', pressure critical' : ''}`;
}

// health(ctx, state, m, waiters) — each refused variation's Health written
// (once, then again only when its need changes or its free memory moves by
// half a GiB or more, so the figures do not churn the sprint file), logged
// once per wait; and cleared from a variation no longer refused, unless
// something else was written since.
async function health(ctx, state, m, waiters) {
  const now = new Set();
  for (const w of waiters) {
    const k = keyOf(w.project, w.key, w.variation);
    if (now.has(k)) continue;
    now.add(k);
    const v = state.projects.find(p => p.id === w.project)?.tickets.find(t => t.key === w.key)?.variations?.find(x => x.name === w.variation);
    if (!v) continue;
    const was = m.health.get(k);
    if (was && v['ai-feedback-long']?.startsWith(MEMORY_HEALTH) && was.need === w.need.bytes && was.rule === w.verdict.rule && Math.abs(was.free - w.free) < 2 ** 29) continue;
    const h = memoryHealth(w.need, w.verdict);
    try {
      await ctx.cli(['ticket:set-ai-feedback', w.project, w.key, w.variation, h.short, h.long]);
      if (!was) ctx.log(PHASE, `${w.key} ${w.variation}: waits for memory for its VM, holding no seat (${seatWords(w)})`);
      m.health.set(k, { need: w.need.bytes, free: w.free, rule: w.verdict.rule });
    } catch (error) { ctx.log('error', `${PHASE} ${w.key} ${w.variation}: ticket:set-ai-feedback failed: ${error.message}`); }
  }
  for (const project of state.projects) for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    const k = keyOf(project.id, t.key, v.name);
    if (now.has(k)) continue;
    if (m.health.delete(k)) ctx.log(PHASE, `${t.key} ${v.name}: no longer waits for memory for its VM`);
    if (!v['ai-feedback-long']?.startsWith(MEMORY_HEALTH)) continue;
    try { await ctx.cli(['ticket:clear-ai-feedback', project.id, t.key, v.name, v['ai-feedback-long']]); } catch (error) { ctx.log('error', `${PHASE} ${t.key} ${v.name}: ticket:clear-ai-feedback failed: ${error.message}`); }
  }
}
