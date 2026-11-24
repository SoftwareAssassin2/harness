// ASS-540: getting a ticket variation's work to the run target its step runs on (run-targets.js), and away again.
//
// The planner picks each holder's target (plan.js `targets`) and seats.js records it (a seat's `target`, or seats.json's
// `local` list for the Mac targets) — seat-kinds.js targetOf reads it back. Before a step's agent or script starts
// (dispatch.js, steps.js), readyTarget hands the variation's branch over when the target is not the one it last ran
// on (its `run-target`, which code:hand-over records): agents commit at a step's end, the command pushes the branch
// from the last place and pulls it into the next — a worktree on the Mac created on first use, the project's checkout
// taken for the ticket, or the machine's checkout brought up to date. Between two machine targets it only records the
// target (their steps push and claim as before) — control does not even call it then — unless one of them is a
// Substrate sandbox (ASS-535): its branches then move through the Mac (relay.bash), which holds the forge logins. A failure throws: the step is held and tried again (backoff.js).
// ASS-585: the hand-over runs in the background, its step held till it has succeeded (see readyTarget below).
//
// runsOnMachine is where a step's work runs now: in the ticket's machine when the step is a run-location: vm step and
// its target is not a Mac target; on the Mac otherwise (a host step runs on the host whatever its target, as before).
//
// ASS-577: a hand-over that reads a ticket's branches out of its Lima VM (or brings them into it) finds that VM stopped
// — control stops it between steps (ASS-527) — so code:hand-over starts it, bundles or pushes, and stops it again.
// Control asks the memory hold first (handOverWaits: host-memory.js memoryShort, as a step starting a VM does): short
// of memory, the step waits, the hand-over not run, no failure counted. While the hand-over runs it counts as an
// in-machine script of the variation (machine-steps.js trackMachineWork), so the VM lifecycle does not stop the VM
// under it. Each start is logged once ("started its stopped Lima VM … ; stopped again"), and a VM found gone, the
// branches taken from the forge, with what was lost.
//
// A worktree local-worktree created is removed when the ticket is done (removeDoneWorktrees, a tick phase: only one
// the variation recorded as made for its run target, `build.worktree-by: run-target`) — or when it is deleted
// (ticket:delete removes every worktree of it, as before).
import { existsSync } from 'node:fs';
import { runsInVm } from './vm.js';
import { targetOf, onMacTarget } from './seat-kinds.js';
import { isMacTarget, isSubstrateTarget } from './run-targets.js';
import { isDoneStep } from './engine.js';
import { noteRunTarget, runTargetOf } from './machine.js';
import { trackMachineWork } from './machine-steps.js';
import { memoryShort } from './host-memory.js';

const PHASE = 'run-targets';

// runsOnMachine(project, key, variation, step) — the step's work runs in the variation's machine now (see above).
export const runsOnMachine = (project, key, variation, step) => runsInVm(step) && !(project && key != null && variation != null && onMacTarget(project, key, variation));

// handOverOf(project, ticket, variation) — { target, last, handOver }: the variation's target now, the one it last ran
// on, and whether readyTarget runs code:hand-over to get there; null when it holds no target.
function handOverOf(project, ticket, variation) {
  if (!project || !ticket || !variation) return null;
  const target = targetOf(project, ticket.key, variation.name);
  if (!target) return null;
  const recorded = runTargetOf(variation);
  const last = recorded?.target ?? null;
  // ASS-565: one handed over this tick (noted, not yet loaded) has its place ready: its worktree folder is in the file
  // code:hand-over wrote, not in this loaded variation.
  const placeReady = target !== 'local-worktree' || recorded !== (variation['run-target'] ?? null) || Boolean(variation.build?.['worktree-folder'] && existsSync(variation.build['worktree-folder']));
  if (last === target && placeReady) return { target, last, handOver: false };
  // Between machine targets nothing moves here (their steps push and claim as before), and nothing is recorded: only a
  // move onto or off the Mac needs a hand-over (code:hand-over treats a variation with no record but a machine as on it).
  // ASS-535: and a move onto or off a Substrate sandbox, which has no forge credentials of its own: code:hand-over moves
  // its branches through the Mac (relay.bash) — and records the target, so machine.js machineOf names the sandbox while
  // the variation is on it (noted in memory here too, for the rest of this tick: machine.js noteRunTarget, ASS-565).
  return { target, last, handOver: isMacTarget(target) || isMacTarget(last) || isSubstrateTarget(target) || isSubstrateTarget(last) };
}

// handOverVm(project, ticket, variation) — ASS-577: the Lima VM code:hand-over would read the branches out of, or bring
// them into, or null: the variation's VM (vm { name, kind lima or none }, no workstation claim) when it last ran on
// local-vm (or on nothing recorded: code:hand-over takes it as on its VM) or goes to local-vm.
export function handOverVm(project, ticket, variation) {
  const h = handOverOf(project, ticket, variation);
  if (!h?.handOver) return null;
  const vm = variation.vm?.name && (variation.vm.kind ?? 'lima') === 'lima' && !variation.workstation?.name ? variation.vm.name : null;
  return vm && (h.last === 'local-vm' || h.last == null || h.target === 'local-vm') ? vm : null;
}

// handOverWaits(ctx, state, project, ticket, variation, who) — ASS-577: whether the variation's step waits because its
// hand-over would start its stopped Lima VM (handOverVm; one control has seen up, memory.vmsUp, needs no start) while the
// Mac is short of memory for it (host-memory.js memoryShort: the hold put on or kept, the variation held with it, so it
// holds no seat meanwhile, as a step starting a VM does). Said once per hold; no failure counted; tried every tick.
export async function handOverWaits(ctx, state, project, ticket, variation, who) {
  const vm = handOverVm(project, ticket, variation), said = `hand-over-memory/${who}`;
  if (!vm || ctx.memory.vmsUp?.has(vm) || ctx.memory.handOvers?.has(handOverKey(project, ticket, variation))) return false;   // ASS-585: one in flight (or ended, unread) asked no more
  if (!await memoryShort(ctx, state, project, vm, { key: ticket.key, variation: variation.name, state: variation['harness-status']?.state })) {
    ctx.memory.warned?.delete(said);
    return false;
  }
  if (!ctx.memory.warned?.has(said)) {
    ctx.memory.warned?.add(said);
    ctx.log(PHASE, `${who}: waits: its hand-over must start its stopped Lima VM ${vm}, and the Mac is out of memory (no failure counted)`);
  }
  return true;
}

// ASS-585: a hand-over runs in the background, as a script step's command does (ASS-494, steps.js startScript): relaying
// branches through the Mac or starting a stopped Lima VM (ASS-577) can take minutes, and awaited in line it held the
// whole tick of its project — every other ticket's steps and dispatches with it (`slow tick … cli code:hand-over 25472ms`).
// readyTarget starts it (untimed: the tick's timings never include it), keeps it in ctx.memory.handOvers under the
// variation (`<project>/<KEY>/<var>`), and waits HAND_OVER_WAIT at most (ctx.handOverWait in tests) in the tick that
// started it, so a quick one — nothing to move, a branch already on the forge — still lets its step go on in that tick.
// Past that the step is held, `waiting for its hand-over` (said once), and every later call reads it without waiting:
// - while it runs, HANDING_OVER: the caller starts nothing (steps.js handedOver, dispatch.js) and asks again next tick —
//   no failure counted, the visit not spent;
// - once it has succeeded, as an awaited one: the target noted (noteRunTarget, onto the variation it was started for
//   and the one loaded now), the target returned, and the step starts — only then (ASS-565, ASS-567: only where it is
//   placed, after its hand-over succeeded);
// - once it has failed, its error thrown, once: the caller holds the step with backoff (backoff.js) and tries again.
// One per variation at a time: a variation with a hand-over in flight never starts another, even to another target; one
// finished for a target the variation has left is forgotten, and the hand-over its target needs now started. Its
// duration is logged as it ends (`handed over … in Ns`, or `hand-over to … failed after Ns`).
// A control stopped while one runs leaves it to finish (its command is not a step's script, so not in ctx.scripts):
// as before, when the forced shutdown (main.js STOP_GRACE_MS) ended a tick blocked in it.
export const HANDING_OVER = Symbol('handing over');
const HAND_OVER_WAIT = 2_000;
const handOverKey = (project, ticket, variation) => `${project.id}/${ticket.key}/${variation.name}`;

// readyTarget(ctx, project, ticket, variation) — the variation's branch handed over to its target when it moved
// (see above); the target, or null when it holds none (Blocked's runs, a step without a seat: as before), or
// HANDING_OVER while its hand-over runs in the background (ASS-585). A failed hand-over throws.
export async function readyTarget(ctx, project, ticket, variation) {
  const h = handOverOf(project, ticket, variation);
  if (!h) return null;
  const { target } = h;
  const handOvers = ((ctx.memory ??= {}).handOvers ??= new Map()), key = handOverKey(project, ticket, variation), who = `${ticket.key} ${variation.name}`;
  let entry = handOvers.get(key);
  if (entry?.ended) {
    handOvers.delete(key);
    if (entry.target === target) {
      if (entry.error) throw entry.error;
      noteRunTarget(variation, entry.record);
      return target;
    }
    entry = undefined;   // finished for a target the variation has since left: forgotten
  }
  if (!entry) {
    if (!h.handOver) return target;
    entry = startHandOver(ctx, project, ticket, variation, h, who);
    handOvers.set(key, entry);
    const wait = ctx.handOverWait ?? HAND_OVER_WAIT;
    let timer;
    await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
    if (entry.ended) return readyTarget(ctx, project, ticket, variation);
  }
  const said = `hand-over/${key}/${entry.started}/${target}`;
  if (!ctx.memory.warned?.has(said)) {
    ctx.memory.warned?.add(said);
    ctx.log(PHASE, `${who}: waiting for its hand-over to ${entry.target}${entry.target === target ? '' : ` to end before handing over to ${target}`}; its step starts once it has succeeded`);
  }
  return HANDING_OVER;
}

// startHandOver(ctx, project, ticket, variation, h, who) — ASS-585: code:hand-over started in the background (untimed),
// as an entry { target, started, done, ended, record | error }; its outcome logged as it ends (ASS-577's VM lines, the
// move, and how long it took).
function startHandOver(ctx, project, ticket, variation, { target, last }, who) {
  const started = Date.now(), entry = { target, started: ctx.now().toISOString(), ended: false };
  const took = () => `${Math.round((Date.now() - started) / 1000)}s`;
  // ASS-577: its Lima VM, which the hand-over may start, counted as worked in till it ends (the VM lifecycle stops it not).
  const vm = handOverVm(project, ticket, variation);
  const handOver = () => ctx.cli(['code:hand-over', project.id, ticket.key, variation.name, target]);
  const untimed = ctx.untimed ?? (fn => fn());
  const running = untimed(() => (vm ? trackMachineWork(ctx, project.id, ticket.key, variation.name, Promise.resolve().then(handOver)) : Promise.resolve().then(handOver)));   // counted before it starts
  entry.done = running.then(out => {
    const said = (() => { try { return JSON.parse(String(out).trim().split('\n').pop()); } catch { return {}; } })();
    if (said?.['started-vm']) ctx.log(PHASE, `${who}: started its stopped Lima VM ${said['started-vm']} to hand its branches over; ${said['stopped-again'] === false ? 'it would not stop again (the VM lifecycle stops it)' : 'stopped again'}`);
    if (said?.['missing-vm']) ctx.log(PHASE, `${who}: its Lima VM ${said['missing-vm']} no longer exists; its branches were taken from the forge instead. Lost: ${said.lost ?? 'nothing known'}`);
    // ASS-565: noted beside the loaded variation, never written onto it (a deep-frozen parse, read.js deepFreeze).
    // ASS-567: with the worktree folder it made or reused (local-worktree), which the loaded variation does not hold yet:
    // dispatch.js agentFolder starts the agent there, never in the project's workspace.
    entry.record = { target, at: ctx.now().toISOString(), ...(target === 'local-worktree' && said?.folder ? { folder: said.folder } : {}) };
    noteRunTarget(variation, entry.record);
    ctx.log(PHASE, `${who}: handed over ${last && last !== target ? `from ${last} ` : ''}to ${target}${said?.branch ? ` (${said.branch}${said.folder ? ` in ${said.folder}` : ''})` : ''} in ${took()}`);
  }, error => {
    entry.error = error;
    ctx.log(PHASE, `${who}: hand-over to ${target} failed after ${took()}`);
  }).finally(() => { entry.ended = true; });
  return entry;
}

// heldElsewhere(project, key, name, planned) — ASS-565, ASS-567: whether the variation's current step must wait a tick
// because it is not placed where the planner puts it. A step starts only where the planner places it (plan.js
// `targets`: its own run targets and work mode resolved), and everything that starts it reads that place from its seat
// record (seat-kinds.js targetOf: readyTarget, vmFor, stepWaits, sandboxWaits) — or, with none, from what the variation
// last ran on (machine.js machineOf: its run-target's sandbox, else its VM or workstation claim). Seats are placed for
// the step a variation is at when the seats phase runs (seats.js), so a move made later in the tick (a script's exit or
// a host step's, steps.js), or in an earlier tick that left it with no record (a step that uses no machine between:
// Setup's done), leaves its record — or its lack of one — out of step until the next tick's placement. It waits:
// - with a record, while that record names a target the step cannot run on (not one of its candidates in this tick's
//   plan): ASS-565, a worktree-only review dispatched into the sandbox its build step had used;
// - with none, unless the plan puts the step on a plain VM, workstation or cloud VM target and it last ran on that one
//   (or was never handed over anywhere: a project derived from its mode, whose moves between machines record nothing):
//   then its machine is the one the record would name, and nothing is handed over, as before. Every other case would
//   start on the wrong place: ASS-567, a worktree step after Setup in
//   the sandbox dispatched into that (hibernated) sandbox; a VM step after a sandbox one read its machine from the
//   sandbox's run-target; a Mac worktree or a remote worktree step has no record to say so, and no branch handed over.
// A step left waiting here has not started: the next tick places it and runs it. One the plan does not place (no seat
// taken: Blocked's runs, a backlog's) goes on as before.
const PLAIN = new Set(['local-vm', 'workstation', 'cloud-vm']);
export function heldElsewhere(project, key, name, planned) {
  const plan = planned?.targets?.find(t => t.key === key && t.variation === name);
  if (!project || !plan) return false;
  const held = targetOf(project, key, name);
  if (held == null) {
    const last = runTargetOf(project.tickets?.find(t => t.key === key)?.variations?.find(v => v.name === name))?.target ?? null;
    return !(PLAIN.has(plan.target) && (last == null || last === plan.target));
  }
  return Array.isArray(plan.candidates) && plan.candidates.length > 0 && !plan.candidates.includes(held);
}

// removeDoneWorktrees(ctx, state) — each done variation's worktree that local-worktree made (build.worktree-by
// run-target) removed (code:remove-worktree), logged once. ASS-553: and its worktrees on remote machines (its
// `remote-worktrees`, made by workstation:claim --worktree for workstation-worktree / cloud-vm-worktree) removed by
// workstation:remove-worktree, each once its machine is connected (none is started for this) and no step holds it.
export async function removeDoneWorktrees(ctx, state) {
  for (const project of state.projects) {
    if (!project.engine) continue;
    for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
      const remote = (v['remote-worktrees'] ?? []).filter(w => project.workstations?.[w.name]?.connected === true || !(project.devEnvironments?.workstations ?? []).some(x => x.id === w.name));
      if (remote.length && isDoneStep(project.engine, v['harness-status']?.state)) {
        await ctx.attempt(PHASE, `${t.key} ${v.name}`, async () => {
          const out = JSON.parse(await ctx.cli(['workstation:remove-worktree', project.id, t.key, v.name]));
          for (const r of out.removed ?? []) ctx.log(PHASE, `${t.key} ${v.name}: done; its worktree ${r.folder} on ${r.name} (made for ${project.devEnvironments?.workstations?.find(x => x.id === r.name)?.kind === 'cloud-vm' ? 'cloud-vm-worktree' : 'workstation-worktree'}) removed`);
        });
      }
      const folder = v.build?.['worktree-folder'];
      if (v.build?.['worktree-by'] !== 'run-target' || !folder || !isDoneStep(project.engine, v['harness-status']?.state)) continue;
      await ctx.attempt(PHASE, `${t.key} ${v.name}`, async () => {
        await ctx.cli(['code:remove-worktree', project.id, t.key, v.name]);
        ctx.log(PHASE, `${t.key} ${v.name}: done; its worktree ${folder} (made for local-worktree) removed`);
      });
    }
  }
}
