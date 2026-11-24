// Phase 3: each project's VMs by state (ASS-75). Once per loop, every VM a
// project knows — recorded on a variation of its sprint (ticket:set-vm), or
// in its inventory, data/projects/<p>/vms.json (vm.bash) — is made to match where
// its variation stands, however it got there (control, or a human in the
// TUI): running where its step says `vm: running` — the deepest level of the
// variation's status that sets `vm` deciding (statusOf: Setup through Review
// and Self Healing, and a step beneath that runs in it) — unless the
// variation is held (isHeld: it or its ticket paused, or the ticket worked by
// hand, ASS-166) or its project is (ASS-297: a human pause, its own or "all",
// moves.js humanPause — an AI pause or self-healing, brief holds, never
// stop a VM, nor does a rate limit as a pause; ASS-400 below stops one for it; one with an assignment on its variation is left as
// it is, neither stopped under its agent nor started, until it ends) or it was set aside
// (is-deleted) or waits for a slot (ASS-233: in motion but holding none,
// plan.js planFor's `waiting`; a finished plan waiting for a build
// seat, ASS-362, planFor's `ready`, holds none, so its queue costs no RAM) or
// holds no seat because its current step does not use its machine (ASS-527,
// replacing ASS-203's rule that a seat holder at a gate or a human step kept
// its seat and so its VM: plan.js slotKind — a gate, a human step, a wait, a
// host-only script; `idle` below — stopped once no assignment or in-machine
// script runs on it, machine-steps.js machineScriptRunning, and never waited
// for: awaitsVm passes it, its step judged with its VM stopped; the vm-hold,
// ASS-427, still keeps it running; Blocked and the other detours, which take
// no seat by position, follow their steps' `vm` as before) or for a ticket it depends on
// (ASS-355: dependencies.js heldBy, the predicate control holds it with —
// stopped as one waiting for a slot is, its agent at work let finish first,
// and started again once the hold lifts) or holds a workstation seat
// (ASS-469, seats.js: its steps run on that workstation; started again if it
// moves back to a VM seat); stopped anywhere else (Release,
// Done, Blocked, Blocked for Human, a sprint that ended). A VM that should run is started (vm:start),
// or, when it is gone — deleted to make room (vm:create's make_room) —
// recreated (vm:create, which the variation records); one that should not is
// stopped (vm:stop) — but, Running with an assignment on its variation (its
// agent at work in it), whatever the reason, left running till that ends,
// logged once ("to stop (…); waits until its agent finishes", ASS-349: an
// agent killed mid-step, exit 255, lost the step an attempt) — and stays
// stopped until room is needed — one stopped for a
// project's pause logged with it ("…; <p> is paused"), and started again,
// once released, as its step says. One whose variation is at a step that
// says `vm: released` (ASS-325: QA, which needs none — VM disk being what
// holds new tickets back) is deleted at once, its disk back to the project's
// VM disk budget: stopped when running (vm:stop), then deleted (vm:delete:
// limactl delete and its vms.json row, as make_room deletes one, under the
// project's VM lock), logged "deleted (<KEY> <variation> at <step>:
// released)" — but left as it is, neither stopped nor deleted, while an
// assignment is on its variation, until it ends; and only stopped, as
// anywhere else, while the variation is held, its project paused or it set
// aside. Back at a step that runs it, it is recreated as any deleted VM is
// (vm:create). One Running and due to
// run whose credential kind (vms.json credential-kind, recorded by vm:start)
// is not the one its project declares now (~/.harness/vm-credentials.json;
// a project declaring neither is never compared) is refreshed (vm:start,
// which takes a running VM as it runs and re-does its credentials, forwarder
// token and agent.sh, ASS-215) — once idle: no assignment on its variation,
// and already reached (probed, not merely seen Running by limactl list), so
// a VM control has not reached yet waits for the probe instead. It is
// dropped from vmsUp for the refresh, as a stopping VM is, so no dispatch
// lands in it mid-refresh (ASS-159); a refresh whose vm:start prints another
// kind fails, and is backed off. So too, by the same rules (idle, reached,
// its wait logged once), one whose keychain items were saved again since it
// got its credentials (ASS-350: a rotated key, which no kind change shows,
// left agents in older VMs failing "Invalid API key"): vm:credentials records
// each injected item's keychain modification time on the VM's vms.json row
// (credential-stamps { "<kind>": "<mdat>" }: never a value), and an item whose
// stamp now (vm:credential-stamps, read only when a VM due the comparison
// records stamps, and at most once per harness.json's
// credential-stamp-interval-seconds, 300 by default — ASS-356: read every pass,
// every tick, it was thousands of keychain lookups a day — the stamps cached
// in control memory meanwhile, and a failed read tried again only after the
// interval) is later than the recorded one refreshes it, logged "credentials
// refreshed (…; <kind> key changed)" — later, not merely different, so stamps
// cached before a start or refresh, older than those it recorded, never
// refresh that VM again. A VM
// recording no stamps (started before ASS-350), or an item either side does not
// stamp, is not compared — unknown, not changed — until its next start records
// them. The work runs beside
// the tick, one job per project at a time, so a slow start (7–30 s) holds up
// nothing; each start, stop or recreation is logged, and one that fails is
// logged and tried again after a failing step's backoff (backoff.js: 30
// seconds doubling to 30 minutes). While the disk hold is on (ASS-288,
// disk.js) no VM is recreated or started — said once per VM — stops and
// credential refreshes going on. Nor, while the Mac is short of memory
// (ASS-398, host-memory.js), is one recreated or started: its variation waits
// as for a slot (awaitsVm), no failure counted, said once per VM; the hold is
// read again every tick and lifts by itself. ASS-404: short means macOS
// reports warn or critical pressure, or less free than a VM of the project
// really uses (its running VMs' resident size, plus a margin, floored and
// capped); the held variation holds no seat while it waits (plan.js), and
// takes one again once its VM can start.
//
// Nor does a VM run while its project's Claude kind is rate limited with no
// API fallback for its variation's next agent (ASS-400: idle VMs held the
// Mac's memory, and the memory hold kept other projects' VMs from starting):
// a variation, free to run its VM, whose deepest step is an active prompt
// step — it needs an agent next — and whose agent dispatch would not pay for
// now (rateLimitStop: state.js payWith, the rule dispatch.js paymentFor
// uses: the kind it runs on held — the claude kind with no .claude-api for a
// host step, or a VM not holding both credentials — or, with both, the
// claude kind held and the API key limited too or an API cap holding it). Its
// VM is stopped as one waiting for a slot is — an assignment on it left till
// it ends (ASS-349) — logged with why ("…; rate-limited until <time>, no API
// fallback"), and its variation waits as for a slot (awaitsVm: its steps not
// judged, no VM_WAIT, so dispatch's VM ceiling never sends it to Blocked).
// It is dropped from the memory hold's VMs (host-memory.js), never started,
// so it counts towards no memory hold. Its health (ticket:set-ai-feedback)
// says it waits on the rate limit — never Operator Needed, it being at no
// blocked step — written when it changes, and cleared
// (ticket:clear-ai-feedback, only while still that one) once the wait is
// over. A script step (in the VM or not) and a human step follow their `vm`
// setting. Once the limit resets, or a fallback is there (a .claude-api, a
// cap lifted), it runs again as its step says: started by the lifecycle, its
// step neither re-run nor a visit spent.
//
// ASS-427 AC7: a variation the operator holds (vm:hold <project> <ticket>
// <variation> on: its vm-hold, { by, since, note }) has its VM kept running
// whatever else would stop it — Blocked for Human, a pause, working by hand,
// a wait for a slot, its dependencies or a rate limit — as one an assignment
// is on is, and started (or recreated) when it is not running, by the same
// disk and memory rules as any start, so the operator, or Claude acting for
// them, can work in it by hand; logged once as the hold begins and once as it
// is released (vm:hold off), when its step's rules apply again — stopped,
// where they say so. The TUI shows the hold on the ticket.
//
// ASS-480 AC1: a step's end always runs on the machine it ran on. A VM a
// step's end is pending on (step-ends.js pendingVmEnds: a lease in vm or
// releasing, or a step that ran there whose vm:step-end has not succeeded,
// recorded in step-ends.json) is to run whatever its step, a pause, a wait or
// a rate limit says — started when stopped, so the end can run there, never
// stopped or deleted (a `vm: released` step's delete waits for the end) —
// logged once, when its rules would have stopped or deleted it; nor is it
// recreated when gone: its end can never run (workstation-steps.js drops it,
// AC2), and a fresh clone would only let it "succeed" on nothing. Once the
// end has succeeded its step's rules apply again. vm.bash reconcile_vms keeps
// it from make_room's and reclaim-all's deletes too.
//
// A step judged while its VM is still starting reads it as down (ASS-133:
// Check Setup Complete sent a set-up ticket on to Create VM), so a variation
// at a step that runs its VM, whose recorded VM control has not seen Running
// and reached — a start or recreation it made, or limactl list plus a probe
// (ASS-169) — is not judged (steps.js, awaitsVm) until it is, for at most
// VM_WAIT; then it is, as it stands — unless it waits for a slot, when it is
// not judged until it holds one and its VM is up, or its start is still queued
// or under way (ASS-387: VM jobs run one at a time per project, so a start can
// wait minutes behind a vm:delete) — or failed and to be tried again after its
// backoff (ASS-464: a start that failed 84 s in, on a slow disk, was taken for
// none, so a ticket Resolved onto Build had its step judged at VM_WAIT and
// sent back to Blocked) — when it is not judged until the VM is up, or the
// variation goes to Blocked once it has waited vmUpCeilingMs (neverUp, as
// dispatch's ceiling does), its health naming the last failed start. VM_WAIT
// then only bounds the wait for a VM nobody is starting (notStarting: the
// disk hold on, or the lifecycle not wanting it running); the log says which
// ("waits for its VM <vm>'s start, queued/under way N s" or "not running after
// 2m and not starting (<why>): judged as it stands"). A finished plan (ASS-362)
// needs no VM to move on to Build: its step is judged with its VM stopped,
// and the move, once a seat is free, starts it. Nor, under the same wait, is an agent
// dispatched into it (dispatch.js vmDown, ASS-159) — nor after it, until the
// VM is up, or the variation goes to Blocked once it has waited past a
// ceiling (ASS-348: 30 minutes, harness.json's vm-up-ceiling-seconds); limactl list is read in
// the tick to drop VMs no longer Running; the project's match job probes
// each Running VM not yet in vmsUp before using it.
import { existsSync } from 'node:fs';
import { readJson } from './read.js';
import { join } from 'node:path';
import { statusOf, isHeld, isActive, stepOf, isManual } from './engine.js';
import { heldKinds, payWith } from './state.js';
import { planFor, poolOf, slotKind } from './plan.js';
import { machineScriptRunning } from './machine-steps.js';
import { holdOf, heldBy } from './dependencies.js';
import { backoffDelay, held } from './backoff.js';
import { runsInVm } from './vm.js';
import { onMacTarget, onSubstrateTarget } from './seat-kinds.js';
import { listsLocalVm } from './run-targets.js';
// ticketKeyOf(project, variation) — the key of the ticket the variation is of.
const ticketKeyOf = (project, variation) => project.tickets?.find(t => t.variations?.includes(variation))?.key;
import { machineStatuses, runInMachine, machineOf, onWorkstation, runTargetOf } from './machine.js';
import { entriesOf, onWorkstationVariation, onWorkstationSeat } from './workstation-machines.js';
import { holdersOf } from './workstation-connection.js';
import { diskHeld } from './disk.js';
import { memoryShort, memoryHeldVm, liftMemoryHolds, unhold } from './host-memory.js';
import { humanPause, moveTicket } from './moves.js';
import { declaredCredentials } from './vm-credentials.js';
import { pendingVmEnds } from './step-ends.js';

const PHASE = 'vm';

// vmUse(engines, engineName, variation) — `vm` of the deepest step of the
// variation's status that sets it ('running', 'stopped' or 'released', ASS-325), or undefined. (Exported for seat-memory.js, ASS-420.)
export const vmUse = (engines, engineName, variation) => statusOf(engines, engineName, variation).chain.findLast(l => l.step?.vm)?.step.vm;

// waitsForSlot(plan, ticket, variation) — the variation is in motion but holds no slot (planFor's `waiting`, ASS-233;
// its `memoryWaiting`, ASS-420: refused a seat for want of memory for its VM, which so stays stopped),
// or its plan is finished and it waits for a build seat (`ready`, ASS-362).
const waitsForSlot = (plan, ticket, variation) => [...plan.waiting, ...plan.ready, ...(plan.memoryWaiting ?? [])].some(w => w.key === ticket?.key && w.variation === variation.name);

// idleAt(engines, engineName, variation) — ASS-527: the variation, in the work (its position in a pool of seats:
// plan.js poolOf), is at a step that does not use its machine (slotKind none: a gate, a human step, a wait, a
// host-only script), so it holds no seat and its VM is stopped. (Exported for the tests.)
export const idleAt = (engines, engineName, variation) => {
  const status = statusOf(engines, engineName, variation);
  return poolOf(status.step, status) != null && slotKind(status.step, status, variation) == null;
};

// rateLimitStop(ctx, state, project, variation) — ASS-400: why the
// variation's VM is stopped for a rate limit (see the module comment), as {
// kind (the kind holding it), until (when it can next pay: the earliest reset
// that frees it), why (why there is no API fallback) }; null when its next
// step needs no agent, or its agent could pay now. A host step's one kind is
// the one dispatch.js hostKind last read (memory.hostKinds), else claude.
export function rateLimitStop(ctx, state, project, variation) {
  const held = heldKinds(project, ctx.now().getTime());
  if (!held.length) return null;
  const step = statusOf(project.engines ?? state.engines, project.engineName, variation).detailStep;
  if (step?.action?.type !== 'prompt' || !isActive(step)) return null;
  const inVm = runsInVm(step) && !onMacTarget(project, ticketKeyOf(project, variation), variation.name), recorded = inVm ? credentialKindOf(ctx, project.id, machineOf(variation)) : null;
  const both = inVm ? recorded === 'both' : existsSync(join(ctx.paths.projects, project.id, '.claude-api'));
  const kind = both ? null : inVm ? recorded : ctx.memory.hostKinds?.get(project.id)?.kind ?? 'claude';
  const capHold = project.json?.['api-cap-hold'] ?? null;
  if (payWith({ held, both, kind, capHold })) return null;
  const at = k => project.rateLimit?.[k]?.['resets-at'];
  const first = (...ks) => ks.filter(k => held.includes(k)).map(at).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  const last = ks => ks.map(at).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  if (both) {
    const why = capHold ? `the API ${capHold.cap ?? 'spend'} cap holds it` : `the API key is rate limited too, until ${at('anthropic')}`;
    return { kind: 'claude', until: capHold ? at('claude') : first('claude', 'anthropic'), why };
  }
  if (!kind) return { kind: held.toSorted().join(', '), until: last(held), why: 'its VM records no credential kind' };
  const why = kind === 'anthropic' ? 'the limited runs were on the API key already' : inVm ? 'its VM holds no API key' : 'the project has no API key fallback (no .claude-api folder)';
  return { kind, until: at(kind), why };
}

// rateHealth(ctx, key, limit) — the health a variation stopped for a rate
// limit shows (ASS-400), { short, long }: waiting on the rate limit, nothing
// for the operator to do. RATE_HEALTH begins every long one, so control knows
// its own to clear.
const RATE_HEALTH = 'Waiting on the rate limit:';
const utc = at => new Date(at).toISOString().replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC');
const rateHealth = (id, key, limit) => ({
  short: `Waiting for the rate limit to reset at ${utc(limit.until)} (no API fallback)`,
  long: `${RATE_HEALTH} ${key}'s next step needs an agent, and ${id}'s Claude ${limit.kind === 'claude' ? 'subscription' : limit.kind === 'anthropic' ? 'API key' : `credentials (${limit.kind})`} ${limit.kind.includes(',') ? 'are' : 'is'} rate limited until ${utc(limit.until)} with no API fallback: ${limit.why}. Its VM is stopped meanwhile, so it holds none of the Mac's memory; it starts again once the limit resets or a fallback is available. Nothing for you to do.`,
});

// awaitsVm(ctx, state, project, variation, who) — whether the variation's
// step waits this tick for its VM (see the module comment); its wait, and its
// end at VM_WAIT, logged once each. ASS-387: past VM_WAIT, a VM whose start is
// still pending (startPending) is waited for on — said once — and, once the
// wait reaches vmUpCeilingMs, NEVER_UP is returned (truthy: still not
// judged), for the caller to send the variation to Blocked (neverUp);
// ASS-464: pending includes a failed start to be tried again (notStarting).
// memory.vmsUp: the names control has
// reached — seen Running by limactl list and reached by a probe (ASS-169),
// or that it started or recreated itself; memory.vmWaits: name → { since, over,
// pending (ASS-387: its wait past VM_WAIT on a pending start logged — ASS-464:
// as the failed tries it counted then, logged again as another fails),
// dispatching (dispatch.js vmDown's own wait past VM_WAIT logged, ASS-348) },
// dropped once the VM is up or should not run.
//
// ASS-435, ASS-468: a variation whose steps run on its project's GCP
// workstations (its vm { kind: workstation }), or that has no machine yet,
// or (ASS-469) that holds a workstation seat, never waits here: a step of it that runs on its machine waits until a
// workstation is claimed for it (workstation-steps.js stepWaits, asked by
// steps.js and dispatch.js where its script or agent would start), and no
// other step needs one.
export const VM_WAIT = 2 * 60_000;
export const NEVER_UP = 'never-up';
export function awaitsVm(ctx, state, project, variation, who) {
  if (onWorkstationVariation(variation) || !variation?.vm?.name) return false;
  if (onWorkstationSeat(project, variation)) return false;   // ASS-469: its steps run on its seat's workstation
  if (!listsLocalVm(project)) return false;   // ASS-581: no Lima VM runs for it (vmsOf); its step waits for a seat on the project's targets instead
  const k = ticketKeyOf(project, variation);
  if (k != null && onSubstrateTarget(project, k, variation.name)) return false;   // ASS-535: its step runs in its sandbox (sandboxes.js sandboxWaits)
  const name = variation?.vm?.name;
  if (!name || (ctx.memory.vmsUp ??= new Set()).has(name) || vmUse(project.engines ?? state.engines, project.engineName, variation) !== 'running') return false;
  const ticket = project.tickets.find(t => t.variations?.includes(variation));
  if (ticket && heldBy(state, project)(ticket, variation)) return true;   // its VM stopped while its dependencies hold it (ASS-355)
  if (statusOf(project.engines ?? state.engines, project.engineName, variation).planned) return false;   // ASS-362: moves on to Build without it
  if (idleAt(project.engines ?? state.engines, project.engineName, variation)) return false;   // ASS-527: its step uses no machine — judged with its VM stopped
  if (rateLimitStop(ctx, state, project, variation)) return true;   // ASS-400: its VM stopped while a rate limit with no API fallback holds its next agent
  if (waitsForSlot(planFor(state, project), ticket, variation)) return true;   // its VM stopped till it holds one
  if (memoryHeldVm(ctx, project, name)) return true;   // ASS-398: not started for want of memory — waits as for a slot
  const waits = (ctx.memory.vmWaits ??= new Map()), now = ctx.now().getTime();
  let w = waits.get(name);
  if (!w) { waits.set(name, w = { since: now, over: false }); ctx.log(PHASE, `${who}: waits for its VM ${name} to be running`); }
  if (now - w.since < VM_WAIT) return true;
  const why = notStarting(ctx, state, project, name);
  if (!why) {   // ASS-387, ASS-464: its start queued, under way or to be tried again — waited for, up to the ceiling
    const ceiling = vmUpCeilingMs(state);
    if (now - w.since >= ceiling) return NEVER_UP;
    const failures = ctx.memory.vms.get(project.id).held.get(name)?.failures ?? 0;
    if (w.pending !== failures) {   // said once, and again each time a try fails meanwhile
      w.pending = failures;
      const tries = failures ? `; ${failures} tr${failures > 1 ? 'ies' : 'y'} failed so far, tried again after its backoff` : '';
      ctx.log(PHASE, `${who}: waits for its VM ${name}'s start, queued/under way ${Math.round((now - w.since) / 1000)}s${tries}; not judged until it is up, at most ${held(ceiling)}`);
    }
    return true;
  }
  if (!w.over) { w.over = true; ctx.log(PHASE, `${who}: its VM ${name} is not running after ${held(VM_WAIT)} and not starting (${why}): judged as it stands`); }
  return false;
}

// notStarting(ctx, state, project, name) — why nobody is starting the VM
// (awaitsVm's checks passed: its step wants it running), or null while its
// start is pending: the lifecycle wants it running this tick (superviseVms'
// `wants`: vmsOf's run) — its start queued behind the project's other VM
// jobs (ASS-387), under way, Running but not yet reached, or failed and to be
// tried again after its backoff (ASS-464: a start that failed once — 84 s in,
// on a slow disk — was taken for none, the step judged at VM_WAIT, its script
// failing "not running", the ticket Blocked). Not starting: the disk hold is
// on (no VM started, ASS-288), or the lifecycle does not want it running (a
// project it has not supervised yet, or one it holds stopped) — judged at
// VM_WAIT as it stands (ASS-133).
function notStarting(ctx, state, project, name) {
  if (diskHeld(state)) return 'the disk is nearly full, so no VM is started';
  if (!ctx.memory.vms?.get(project.id)?.wants?.has(name)) return 'control is not starting it';
  return null;
}

// vmUpCeilingMs(state) — how long a VM may take to come up before its
// variation goes to Blocked (dispatch.js vmDown, ASS-348; awaitsVm, ASS-387), in ms: harness.json's
// vm-up-ceiling-seconds, else VM_UP_CEILING — far longer than any normal
// start (62–150 s seen, more queued behind the project's other VM jobs). Read
// through state.harness, which is the raw file, so the default applies with
// the key absent.
export const VM_UP_CEILING = 30 * 60_000;
export const vmUpCeilingMs = state => (state.harness['vm-up-ceiling-seconds'] != null ? state.harness['vm-up-ceiling-seconds'] * 1000 : VM_UP_CEILING);

// neverUp(ctx, phase, at, name, ceiling) — the variation (`at`, found's) whose VM
// `name` did not come up within `ceiling` goes to Blocked — Blocked for Human
// when at Blocked already, as blockFailing sends a failing step inside it —
// when its engine has that step, it is a sprint ticket's and not worked by
// hand; its health (ai-feedback, short and long, set after the move, which
// clears it) naming the VM and that it never came up. Its wait is dropped, so
// a step there that runs in the VM waits afresh. Otherwise it waits on.
// ASS-387: moved here from dispatch.js, so the step path (steps.js) Blocks so too; logged under `phase`.
export async function neverUp(ctx, phase, at, name, ceiling) {
  const { project, ticket, variation, engine, backlog } = at;
  const from = variation['harness-status']?.state, to = from === 'blocked' ? 'blocked-for-human' : 'blocked';
  if (backlog || isManual(ticket) || from === 'blocked-for-human' || !stepOf(engine, to)) return;
  const why = `its VM ${name} never came up`;
  const short = `VM ${name} never came up: not running and reachable after ${held(ceiling)}`;
  const failed = ctx.memory.vms?.get(project.id)?.held.get(name);
  const last = failed?.failures ? ` Its start failed ${failed.failures} time${failed.failures > 1 ? 's' : ''} in a row, the last: ${failed.error}.` : '';
  const long = `${short}. Control dispatches no agent into a VM until it has seen it running and reached it (ASS-348), nor judges a step that needs it running while its start is queued, under way or to be tried again (ASS-387, ASS-464), so no agent was sent and no step run against it.${last} Look at the VM's starts in the control log (vm:start failing, or still starting) and its ha.stderr.log.`;
  await ctx.attempt(phase, `${ticket.key} ${variation.name}`, async () => {
    if (!await moveTicket(ctx, phase, project, ticket, variation, to, why)) return;
    ctx.memory.vmWaits?.delete(name);
    await ctx.cli(['ticket:set-ai-feedback', project.id, ticket.key, variation.name, short, long]);
  });
}

// The project's inventory, data/projects/<p>/vms.json: name → its row.
const inventoryOf = (ctx, projectId) => {
  const file = join(ctx.paths.projects, projectId, 'vms.json');
  return existsSync(file) ? readJson(file) : {};   // ASS-457: read again if caught half-written; one that never parses skips the tick (read.js)
};

// credentialKindOf(ctx, projectId, name) — the credential kind the VM's
// vms.json row records (ASS-215: 'claude' or 'anthropic'; 'both', ASS-217,
// for a VM holding both, whose agents control pays per dispatch), or null.
// `name` is the variation's machine (machine.js machineOf): a workstation's
// (ASS-435) is its live data holder's, as vm:start recorded it — ASS-529: the holder of the machine's folder (its
// slot), several tickets' steps sharing one machine.
export const credentialKindOf = (ctx, projectId, name) => {
  const ws = onWorkstation(name);
  if (ws) {
    const hs = holdersOf(entriesOf(ctx, projectId)[ws.id]);
    return (hs.find(h => h.folder === ws.folder) ?? hs[0])?.['credential-kind'] || null;
  }
  return (name && inventoryOf(ctx, projectId)[name]?.['credential-kind']) || null;
};

// declaredVmKind(ctx, id) — the kind the project's VMs are to run on, as
// ~/.harness/vm-credentials.json declares it now: 'both' (ASS-217: a VM holds
// both, and switching between them per dispatch never refreshes it),
// 'anthropic', 'claude', or null when it declares neither, or the file cannot be read.
function declaredVmKind(ctx, id) {
  const d = declaredCredentials(ctx.env, id);
  return d?.anthropic && d?.claude ? 'both' : d?.anthropic ? 'anthropic' : d?.claude ? 'claude' : null;
}

// The project's VMs: name → { ticket, variation, state (its variation's top-level step, in the sprint), run (whether it should), waits (for a slot), ready (ASS-362: that wait a finished plan's, for a build seat),
// dependsOn (ASS-355: the keys of the tickets it waits on, holdOf's, when they hold it),
// kind (its recorded credential kind), stamps (its recorded credential-stamps, ASS-350, or null), busy (an assignment on its variation, its agent started or not; for an inventory-only VM,
// its row's ticket and variation, ASS-349), unlinked (ASS-234: only the
// inventory knows it, yet its variation is in the sprint — a vm:create that failed before linking it — logged so when it is stopped),
// paused (ASS-297: the scope of the human pause holding the project, when only that keeps it from running), keep (paused and busy:
// left as it is till its assignment ends), release (ASS-325: at a `vm: released` step, not held, set aside or paused: to delete),
// rateLimited (ASS-400: rateLimitStop's, when only that keeps it from running), idle (ASS-527: idleAt, its step using no machine, when only that keeps it from running; busy also counts an in-machine script of it running), health (its variation's ai-feedback-long),
// hold (ASS-427 AC7: its variation's vm-hold, vm:hold's { by, since, note }, or null — held, it is to run, whatever else says not) }.
function vmsOf(ctx, state, project) {
  const vms = new Map();
  const pause = humanPause(state, project.id);
  let plan;
  for (const [name, e] of Object.entries(inventoryOf(ctx, project.id))) {
    const unlinked = project.tickets.some(t => t.key.toLowerCase() === e.ticket?.toLowerCase() && t.variations?.some(v => v.name === e.variation && !v['is-deleted']));
    const busy = state.assignments.some(a => a.project === project.id && a['work-item']?.toLowerCase() === e.ticket?.toLowerCase() && a.variation === e.variation);   // ASS-349
    vms.set(name, { ticket: e.ticket, variation: e.variation, run: false, kind: e['credential-kind'] ?? null, stamps: e['credential-stamps'] ?? null, unlinked, busy });
  }
  const localVm = listsLocalVm(project);   // ASS-581
  for (const t of project.tickets) for (const v of t.variations ?? []) {
    if (!v.vm?.name || onWorkstationVariation(v)) continue;   // ASS-435: a workstation's machine is workstations.js's
    // ASS-581: a project whose run targets leave out local-vm runs no Lima VM: a `vm` record left from before run
    // targets (ASS-540) is not a placement — its VM is never made, re-created or started (a vm-hold neither), only
    // stopped (once idle) or, at a `vm: released` step, deleted; the step waits for a seat on the project's own
    // targets. Said once per variation, when its step would have run the VM.
    if (!localVm) {
      const use = vmUse(project.engines ?? state.engines, project.engineName, v), free = !v['is-deleted'] && !isHeld(t, v);
      const busy = state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a.variation === v.name)
        || machineScriptRunning(ctx, project.id, t.key, v.name);
      if (free && (use === 'running' || v['vm-hold']) && !ctx.memory.warned.has(`old-vm/${project.id}/${t.key}/${v.name}`)) {
        ctx.memory.warned.add(`old-vm/${project.id}/${t.key}/${v.name}`);
        ctx.log(PHASE, `${t.key} ${v.name}: its old Lima VM record ignored — ${project.id} doesn't run on local-vm (its run targets: ${(project.runTargets?.targets ?? []).join(', ') || 'none'}); its step waits for a seat on them`);
      }
      vms.set(v.vm.name, { ...vms.get(v.vm.name), ticket: t.key, variation: v.name, state: v['harness-status']?.state, health: v['ai-feedback-long'] ?? null, hold: null,
        run: false, waits: false, ready: false, dependsOn: [], busy, paused: undefined, keep: false, release: free && !pause && use === 'released', rateLimited: null, offVm: true });
      continue;
    }
    const use = vmUse(project.engines ?? state.engines, project.engineName, v), free = !v['is-deleted'] && !isHeld(t, v);
    const wants = free && use === 'running', release = free && !pause && use === 'released';
    const busy = state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a.variation === v.name)
      || machineScriptRunning(ctx, project.id, t.key, v.name);   // ASS-527 AC2: an in-machine script of it running there holds a stop as an agent does
    const dependsOn = wants && !pause ? holdOf(state, project, t, v).waits : [];   // ASS-355: held by what it depends on, stopped as one waiting for a slot
    const waits = wants && !pause && !dependsOn.length && waitsForSlot(plan ??= planFor(state, project), t, v);
    const rateLimited = wants && !pause && !dependsOn.length && !waits ? rateLimitStop(ctx, state, project, v) : null;   // ASS-400
    const seated = wants && !pause && !dependsOn.length && !waits && !rateLimited && onWorkstationSeat(project, v);   // ASS-469: machines follow seats — its steps on its seat's workstation, its VM stopped
    const idle = wants && !pause && !dependsOn.length && !waits && !rateLimited && !seated && (idleAt(project.engines ?? state.engines, project.engineName, v)   // ASS-527: no seat, its step using no machine
      || onMacTarget(project, t.key, v.name)   // ASS-540: its step runs on a Mac run target (local-worktree, local-workspace), not in its VM
      // ASS-535: its step runs in its Substrate sandbox, not in its VM — once its branches have moved there (its recorded
      // run-target a substrate one: code:hand-over reads them out of this VM first).
      || (onSubstrateTarget(project, t.key, v.name) && /-substrate$/.test(runTargetOf(v)?.target ?? '')));
    const run = wants && !waits && !dependsOn.length && !pause && !rateLimited && !seated && !idle;
    const ready = waits && plan.ready.some(r => r.key === t.key && r.variation === v.name);   // ASS-362: a finished plan, said so
    const paused = wants && pause ? pause : undefined, keep = !!pause && busy;   // ASS-297: paused, stopped once idle, never started
    const hold = !v['is-deleted'] && v['vm-hold'] ? v['vm-hold'] : null;   // ASS-427 AC7: held running for the operator — whatever its step, pause or wait says
    vms.set(v.vm.name, { ...vms.get(v.vm.name), ticket: t.key, variation: v.name, state: v['harness-status']?.state, health: v['ai-feedback-long'] ?? null, hold,
      ...(hold ? { run: true, waits: false, ready: false, dependsOn: [], busy, paused: undefined, keep: false, release: false, rateLimited: null }
        : { run, waits, ready, dependsOn, busy, paused, keep, release, rateLimited, seated, idle }) });
  }
  // ASS-480 AC1: a step's end pending on it keeps it running (started when stopped), never stopped, deleted or recreated.
  for (const [name, end] of pendingVmEnds(ctx, project.id)) {
    const vm = vms.get(name);
    if (!vm) continue;
    vms.set(name, { ...vm, pendingEnd: end, overridden: !vm.run || vm.release, run: true, release: false, keep: false });
  }
  return vms;
}

// Each machine's status, by name (the machine layer, machine.js, ASS-432: each Lima instance's).
const statuses = ctx => machineStatuses({ env: ctx.env }).catch(error => { throw new Error(`limactl list: ${error.message}`); });

// superviseVms(ctx, state) — reads, in the tick, which of the projects' VMs
// are up (memory.vmsUp), so a VM gone down since the last tick — an outage,
// the Mac asleep — is waited for (awaitsVm) before this tick's steps or
// dispatch use it (ASS-159: ASS-158's agents were sent into a VM control
// still took for up); then starts, for each project with a VM and no job
// running, its job (match); memory.vms: id → { job, held: name → { failures,
// until, error (the last failure, ASS-464) }, wants (ASS-464: the VMs vmsOf
// says run, read again every tick — awaitsVm's notStarting) }.
export async function superviseVms(ctx, state) {
  const jobs = (ctx.memory.vms ??= new Map());
  // ASS-398: a memory hold lifts by itself once there is room; ASS-404: the state loaded again when its record went or its held variations changed, so the seats (plan.js) follow at once.
  if (await liftMemoryHolds(ctx, state)) state = ctx.load();
  const projects = state.projects.map(project => [project, vmsOf(ctx, state, project)]).filter(([, vms]) => vms.size);
  if (!projects.length) return;
  let status;
  try { status = await statuses(ctx); } catch (error) { ctx.log('error', `${PHASE}: ${error.message}`); return; }
  ctx.memory.vmStatus = status;   // ASS-420: what seat-memory.js reads as running
  for (const [, vms] of projects) for (const [name, vm] of vms) {
    if (status.get(name) !== 'Running') ctx.memory.vmsUp?.delete(name);
    if (!vm.run) ctx.memory.vmWaits?.delete(name);
  }
  const stampEvery = (state.harness?.['credential-stamp-interval-seconds'] ?? CREDENTIAL_STAMP_INTERVAL) * 1000;   // ASS-356
  for (const [project, vms] of projects) {
    const r = jobs.get(project.id) ?? { job: null, held: new Map() };
    jobs.set(project.id, r);
    r.wants = new Set([...vms].filter(([, vm]) => vm.run).map(([name]) => name));   // ASS-464: the VMs it is to start or keep running (awaitsVm's notStarting)
    r.job ??= match(ctx, project.id, vms, r, status, diskHeld(state), stampEvery, (name, vm) => memoryShort(ctx, state, project, name, vm.ticket && vm.variation ? { key: vm.ticket, variation: vm.variation, state: vm.state } : null)).catch(error => ctx.log('error', `${PHASE} ${project.id}: ${error.message}`)).finally(() => { r.job = null; });
  }
}

// isUp(ctx, name) — the VM seen up: its wait over.
const isUp = (ctx, name) => { (ctx.memory.vmsUp ??= new Set()).add(name); ctx.memory.vmWaits?.delete(name); };

// probe(ctx, name) — whether `name`'s sshd accepts connections yet.
const probe = (ctx, name) => runInMachine(name, ['true'], { env: ctx.env, timeout: 5000 }).then(() => {});

// changedKeys(recorded, now) — the credential kinds both stamp whose keychain
// stamp now is later than the recorded one (ASS-350; ASS-356: later, not merely
// different — mdat is a fixed-width YYYYMMDDhhmmssZ, so it sorts by time — so
// stamps cached before a VM's start or refresh, older than those it recorded,
// are never a change); none when either is unknown.
export const changedKeys = (recorded, now) => (recorded && now ? Object.keys(now).filter(k => recorded[k] && now[k] && now[k] > recorded[k]) : []);

// stampsOf(ctx, id, every) — the project's keychain item stamps (ASS-356):
// memory.vmStamps' id → { at, stamps } when read less than `every` ms ago,
// else read again (vm:credential-stamps) and cached with the time; stamps
// null when the read failed — logged once till a read succeeds, and not tried
// again till `every` has passed.
export const CREDENTIAL_STAMP_INTERVAL = 300;
export async function stampsOf(ctx, id, every) {
  const cache = (ctx.memory.vmStamps ??= new Map()), now = ctx.now().getTime();
  const c = cache.get(id);
  if (c && now - c.at < every) return c.stamps;
  const unread = `vm-stamps/${id}`;
  let stamps;
  try {
    stamps = JSON.parse((await ctx.cli(['vm:credential-stamps', id])) || '{}');
    ctx.memory.warned.delete(unread);
  } catch (error) {
    stamps = null;
    if (!ctx.memory.warned.has(unread)) { ctx.memory.warned.add(unread); ctx.log('error', `${PHASE} ${id}: vm:credential-stamps ${id} failed; no VM's credentials compared with the keychain till it reads: ${error.message}`); }
  }
  cache.set(id, { at: now, stamps });
  return stamps;
}

// rateLimitHealth(ctx, id, name, vm, s) — ASS-400: a VM stopped for a rate
// limit (vm.rateLimited) is dropped from the memory hold's VMs, and, once no
// assignment is on its variation, its health says it waits on the rate limit
// (written when it changes; one not running already logged so, once — a
// running one's stop says it); once that wait is over, the health control
// wrote is cleared, unless something else has been written since.
async function rateLimitHealth(ctx, id, name, vm, s) {
  if (!vm.ticket || !vm.variation || vm.state == null) return;
  if (vm.rateLimited) {
    unhold(ctx, id, name, vm.ticket, vm.variation);   // ASS-404: its variation's seat no longer freed for memory
    if (vm.busy) return;
    const h = rateHealth(id, vm.ticket, vm.rateLimited);
    if (vm.health === h.long) return;
    try {
      await ctx.cli(['ticket:set-ai-feedback', id, vm.ticket, vm.variation, h.short, h.long]);
      if (s !== 'Running') ctx.log(PHASE, `${id} ${name}: stays stopped (${vm.ticket} ${vm.variation} at ${vm.state}; rate-limited until ${vm.rateLimited.until}, no API fallback)`);
    } catch (error) { ctx.log('error', `${PHASE} ${id} ${name}: ticket:set-ai-feedback failed: ${error.message}`); }
  } else if (vm.health?.startsWith(RATE_HEALTH)) {
    try { await ctx.cli(['ticket:clear-ai-feedback', id, vm.ticket, vm.variation, vm.health]); } catch (error) { ctx.log('error', `${PHASE} ${id} ${name}: ticket:clear-ai-feedback failed: ${error.message}`); }
  }
}

// holdLog(ctx, id, name, vm) — ASS-427 AC7: a VM held running for the
// operator (vm:hold) logged once as its hold begins — control keeps it
// running, as it keeps one an agent works in, and starts it when stopped —
// and once as it ends (vm:hold off), its step's rules applying again;
// memory.vmHolds: the names held when last seen.
const holdText = h => `vm:hold by ${h.by ?? 'the operator'} since ${h.since ?? '?'}${h.note ? `: ${h.note}` : ''}`;
function holdLog(ctx, id, name, vm) {
  const held = (ctx.memory.vmHolds ??= new Set());
  if (vm.hold && !held.has(name)) { held.add(name); ctx.log(PHASE, `${id} ${name}: held running for the operator (${vm.ticket} ${vm.variation} at ${vm.state}; ${holdText(vm.hold)}): not stopped, and started when stopped, until vm:hold ${id} ${vm.ticket} ${vm.variation} off`); }
  else if (!vm.hold && held.has(name)) { held.delete(name); ctx.log(PHASE, `${id} ${name}: its operator hold released (vm:hold off); its step's rules apply again`); }
}

// pendingLog(ctx, id, name, vm, s) — ASS-480 AC1: a VM its step's rules would stop or delete, kept (and started) for
// a step's end pending on it, logged once per pending end; memory.warned `vm-end-keep/<name>/<since>`.
function pendingLog(ctx, id, name, vm, s) {
  const end = vm.pendingEnd;
  if (!end || !vm.overridden || s == null) return;
  const said = `vm-end-keep/${name}/${end.since ?? end.step ?? ''}`;
  if (ctx.memory.warned.has(said)) return;
  ctx.memory.warned.add(said);
  ctx.log(PHASE, `${id} ${name}: kept${s === 'Running' ? '' : ' and started'} for ${end.key} ${end.variation}'s step end${end.step ? ` ("${end.step}")` : ''}, pending on it: not stopped or deleted until it has run there (${vm.ticket} ${vm.variation} at ${vm.state ?? '?'})`);
}

// One project's pass, by `status` (limactl list's, read this tick): each VM
// not yet reached but Running is probed (ASS-169: a VM is `Running` a few
// seconds before its sshd accepts connections) — silently, so a VM not yet
// reachable is simply tried again next job, same as one still starting; then
// each VM started, recreated, stopped, refreshed or deleted (ASS-325) as it should be (not while backed off).
async function match(ctx, id, vms, r, status, diskHold = false, stampEvery = CREDENTIAL_STAMP_INTERVAL * 1000, memoryShortFor = async () => false) {
  const up = (ctx.memory.vmsUp ??= new Set());
  const declared = declaredVmKind(ctx, id);
  // ASS-350 AC4, ASS-356: the keychain items' stamps now — read only when a VM is due the comparison, and at most once per `stampEvery` ms (stampsOf's cache); null when unreadable.
  let stampsNow;
  const currentStamps = async () => (stampsNow = await stampsOf(ctx, id, stampEvery));
  for (const [name, vm] of vms) {
    if (vm.keep) continue;   // ASS-297: its project paused, an assignment on it: left as it is till that ends
    if (vm.release && vm.busy) continue;   // ASS-325: released, an assignment on it: left as it is till that ends
    const now = ctx.now().getTime(), s = status.get(name);
    holdLog(ctx, id, name, vm);   // ASS-427 AC7
    await rateLimitHealth(ctx, id, name, vm, s);   // ASS-400
    const holding = `vm-stop/${name}`;   // ASS-349: a stop held for an agent at work in it, logged once per hold
    if (vm.run || !vm.busy || s !== 'Running') ctx.memory.warned.delete(holding);
    if (vm.run && s === 'Running') unhold(ctx, id, name, vm.ticket, vm.variation);   // ASS-404: running after all (started by hand): not held
    if (vm.run && s === 'Running' && !up.has(name)) {
      try { await probe(ctx, name); isUp(ctx, name); } catch { /* not yet reachable; probed again next job */ }
    }
    let args, did, refreshing = false, first = null, changed = [];
    pendingLog(ctx, id, name, vm, s);   // ASS-480 AC1
    if (vm.pendingEnd && s == null) continue;   // ASS-480: gone with its step's end pending — never recreated for it (workstation-steps.js drops the end, AC2)
    if (vm.release && s == null) continue;   // ASS-325: deleted already
    if (vm.release) [first, args, did] = [s === 'Running' ? ['vm:stop', id, name] : null, ['vm:delete', id, name], `deleted (${vm.ticket} ${vm.variation} at ${vm.state}: released)`];
    else if (vm.run && s == null) [args, did] = [['vm:create', id, vm.ticket, vm.variation], `recreated (${vm.ticket} ${vm.variation} at ${vm.state}; it had been deleted)`];
    else if (vm.run && s != null && s !== 'Running') [args, did] = [['vm:start', id, vm.ticket, vm.variation], `started (${vm.ticket} ${vm.variation} at ${vm.state}${vm.hold ? '; held for the operator' : ''}${vm.pendingEnd && vm.overridden ? `; for its step's end, pending on it` : ''})`];
    else if (!vm.run && s === 'Running') {
      const why = `${vm.ticket} ${vm.variation} ${vm.state ? `at ${vm.state}` : vm.unlinked ? 'not linked to its variation' : 'is not in the sprint'}${vm.waits ? (vm.ready ? '; planned, waits for a build seat' : '; waits for a slot') : ''}${vm.dependsOn?.length ? `; waits on ${vm.dependsOn.join(', ')}` : ''}${vm.paused ? `; ${vm.paused === 'all' ? 'all projects are' : `${id} is`} paused` : ''}${vm.rateLimited ? `; rate-limited until ${vm.rateLimited.until}, no API fallback` : ''}${vm.seated ? '; it holds a workstation seat, its steps run there' : ''}${vm.idle ? '; its step does not use its machine, so it holds no seat' : ''}${vm.offVm ? `; ${id} doesn't run on local-vm` : ''}`;
      if (vm.busy) {   // ASS-349: an assignment on its variation — its agent at work in it — holds the stop till it ends (ASS-527: or an in-machine script)
        if (!ctx.memory.warned.has(holding)) { ctx.memory.warned.add(holding); ctx.log(PHASE, `${id} ${name}: to stop (${why}); waits until its agent finishes`); }
        continue;
      }
      [args, did] = [['vm:stop', id, name], `stopped (${why})`];
    }
    else if (vm.run && s === 'Running' && up.has(name) && declared && vm.kind !== declared) {
      const waiting = `vm-refresh/${name}/${declared}`;
      if (vm.busy) {
        if (!ctx.memory.warned.has(waiting)) { ctx.memory.warned.add(waiting); ctx.log(PHASE, `${id} ${name}: credentials to refresh (${vm.kind ?? 'no recorded kind'} → ${declared}); waits until it is idle`); }
        continue;
      }
      ctx.memory.warned.delete(waiting);
      refreshing = true;
      [args, did] = [['vm:start', id, vm.ticket, vm.variation], `credentials refreshed (${vm.ticket} ${vm.variation} at ${vm.state}; ${vm.kind ?? 'no recorded kind'} → ${declared})`];
    }
    else if (vm.run && s === 'Running' && up.has(name) && Object.keys(vm.stamps ?? {}).length && (changed = changedKeys(vm.stamps, await currentStamps())).length) {
      // ASS-350: a keychain item saved again since the VM got its credentials (a rotated key) — refreshed as a kind change is, once idle.
      const items = `${changed.join(', ')} key${changed.length > 1 ? 's' : ''} changed`;
      const waiting = `vm-refresh/${name}/stamps/${changed.map(k => `${k}@${stampsNow[k]}`).join(',')}`;
      if (vm.busy) {
        if (!ctx.memory.warned.has(waiting)) { ctx.memory.warned.add(waiting); ctx.log(PHASE, `${id} ${name}: credentials to refresh (${items}); waits until it is idle`); }
        continue;
      }
      ctx.memory.warned.delete(waiting);
      refreshing = true;
      [args, did] = [['vm:start', id, vm.ticket, vm.variation], `credentials refreshed (${vm.ticket} ${vm.variation} at ${vm.state}; ${items})`];
    }
    else continue;
    // The disk nearly full (ASS-288, disk.js): no VM recreated (a clone) or started; stops and refreshes go on.
    if (diskHold && (args[0] === 'vm:create' || (args[0] === 'vm:start' && !refreshing))) {
      if (!ctx.memory.warned.has(`disk/${name}`)) { ctx.memory.warned.add(`disk/${name}`); ctx.log(PHASE, `${id} ${name}: not ${args[0] === 'vm:create' ? 'recreated' : 'started'}: the disk is nearly full`); }
      continue;
    }
    ctx.memory.warned.delete(`disk/${name}`);
    const h = r.held.get(name) ?? { failures: 0, until: 0 };
    if (now < h.until) continue;
    // ASS-398: the Mac short of memory (host-memory.js): not started or recreated, no failure counted; its variation waits as for a slot.
    if ((args[0] === 'vm:create' || (args[0] === 'vm:start' && !refreshing)) && await memoryShortFor(name, vm)) {
      if (!ctx.memory.warned.has(`memory/${name}`)) { ctx.memory.warned.add(`memory/${name}`); ctx.log(PHASE, `${id} ${name}: not ${args[0] === 'vm:create' ? 'recreated' : 'started'}: out of memory; waits as for a slot`); }
      continue;
    }
    ctx.memory.warned.delete(`memory/${name}`);
    unhold(ctx, id, name, vm.ticket, vm.variation);   // ASS-404: and its variation, which takes a seat again
    let doing = first ?? args;
    try {
      if (!vm.run || refreshing) up.delete(name);   // a stopping or refreshing VM is not up until it is reached again
      if (first) { await ctx.cli(first); doing = args; }   // ASS-325: a released VM running stopped, then deleted
      const out = await ctx.cli(args);
      if (args[0] === 'vm:start' && s === 'Running') {
        const kind = JSON.parse(out || '{}')['credential-kind'] ?? null;
        if (kind !== declared) throw new Error(`it printed credential kind ${kind ?? 'none'}, not ${declared}`);
      }
      if (vm.run) isUp(ctx, name);
      r.held.delete(name);
      ctx.log(PHASE, `${id} ${name}: ${did}`);
    } catch (error) {
      const wait = backoffDelay(++h.failures);
      h.until = now + wait;
      h.error = `${doing.join(' ')}: ${error.message}`;   // ASS-464: named in the health of a variation it never came up for (neverUp)
      r.held.set(name, h);
      ctx.log('error', `${PHASE} ${id} ${name}: ${doing.join(' ')} failed (${h.failures} in a row; next try in ${held(wait)}): ${error.message}`);
    }
  }
}
