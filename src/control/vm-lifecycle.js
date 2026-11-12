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
// plan.js planFor's `waiting`; a seat holder at a gate or a human step,
// ASS-203, keeps its seat and so its VM; a finished plan waiting for a build
// seat, ASS-362, planFor's `ready`, holds none, so its queue costs no RAM) or for a ticket it depends on
// (ASS-355: dependencies.js heldBy, the predicate control holds it with —
// stopped as one waiting for a slot is, its agent at work let finish first,
// and started again once the hold lifts); stopped anywhere else (Release,
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
// read again every tick and lifts by itself.
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
// A step judged while its VM is still starting reads it as down (ASS-133:
// Check Setup Complete sent a set-up ticket on to Create VM), so a variation
// at a step that runs its VM, whose recorded VM control has not seen Running
// and reached — a start or recreation it made, or limactl list plus a probe
// (ASS-169) — is not judged (steps.js, awaitsVm) until it is, for at most
// VM_WAIT; then it is, as it stands — unless it waits for a slot, when it is
// not judged until it holds one and its VM is up. A finished plan (ASS-362)
// needs no VM to move on to Build: its step is judged with its VM stopped,
// and the move, once a seat is free, starts it. Nor, under the same wait, is an agent
// dispatched into it (dispatch.js vmDown, ASS-159) — nor after it, until the
// VM is up, or the variation goes to Blocked once it has waited past a
// ceiling (ASS-348: 30 minutes, harness.json's vm-up-ceiling-seconds); limactl list is read in
// the tick to drop VMs no longer Running; the project's match job probes
// each Running VM not yet in vmsUp before using it.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusOf, isHeld, isActive } from './engine.js';
import { heldKinds, payWith } from './state.js';
import { planFor } from './plan.js';
import { holdOf, heldBy } from './dependencies.js';
import { backoffDelay, held } from './backoff.js';
import { limaEnv, runsInVm } from './vm.js';
import { diskHeld } from './disk.js';
import { memoryShort, memoryHeldVm, liftMemoryHolds } from './host-memory.js';
import { humanPause } from './moves.js';
import { declaredCredentials } from './vm-credentials.js';

const PHASE = 'vm';

// vmUse(engines, engineName, variation) — `vm` of the deepest step of the
// variation's status that sets it ('running', 'stopped' or 'released', ASS-325), or undefined.
const vmUse = (engines, engineName, variation) => statusOf(engines, engineName, variation).chain.findLast(l => l.step?.vm)?.step.vm;

// waitsForSlot(plan, ticket, variation) — the variation is in motion but holds no slot (planFor's `waiting`, ASS-233),
// or its plan is finished and it waits for a build seat (`ready`, ASS-362).
const waitsForSlot = (plan, ticket, variation) => [...plan.waiting, ...plan.ready].some(w => w.key === ticket?.key && w.variation === variation.name);

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
  const inVm = runsInVm(step), recorded = inVm ? credentialKindOf(ctx, project.id, variation?.vm?.name) : null;
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
// end at VM_WAIT, logged once each. memory.vmsUp: the names control has
// reached — seen Running by limactl list and reached by a probe (ASS-169),
// or that it started or recreated itself; memory.vmWaits: name → { since, over,
// dispatching (dispatch.js vmDown's own wait past VM_WAIT logged, ASS-348) },
// dropped once the VM is up or should not run.
export const VM_WAIT = 2 * 60_000;
export function awaitsVm(ctx, state, project, variation, who) {
  const name = variation?.vm?.name;
  if (!name || (ctx.memory.vmsUp ??= new Set()).has(name) || vmUse(project.engines ?? state.engines, project.engineName, variation) !== 'running') return false;
  const ticket = project.tickets.find(t => t.variations?.includes(variation));
  if (ticket && heldBy(state, project)(ticket, variation)) return true;   // its VM stopped while its dependencies hold it (ASS-355)
  if (statusOf(project.engines ?? state.engines, project.engineName, variation).planned) return false;   // ASS-362: moves on to Build without it
  if (rateLimitStop(ctx, state, project, variation)) return true;   // ASS-400: its VM stopped while a rate limit with no API fallback holds its next agent
  if (waitsForSlot(planFor(state, project), ticket, variation)) return true;   // its VM stopped till it holds one
  if (memoryHeldVm(ctx, project, name)) return true;   // ASS-398: not started for want of memory — waits as for a slot
  const waits = (ctx.memory.vmWaits ??= new Map()), now = ctx.now().getTime();
  let w = waits.get(name);
  if (!w) { waits.set(name, w = { since: now, over: false }); ctx.log(PHASE, `${who}: waits for its VM ${name} to be running`); }
  if (now - w.since < VM_WAIT) return true;
  if (!w.over) { w.over = true; ctx.log(PHASE, `${who}: its VM ${name} is not running after ${held(VM_WAIT)}; judged as it stands`); }
  return false;
}

// The project's inventory, data/projects/<p>/vms.json: name → its row.
const inventoryOf = (ctx, projectId) => {
  const file = join(ctx.paths.projects, projectId, 'vms.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

// credentialKindOf(ctx, projectId, name) — the credential kind the VM's
// vms.json row records (ASS-215: 'claude' or 'anthropic'; 'both', ASS-217,
// for a VM holding both, whose agents control pays per dispatch), or null.
export const credentialKindOf = (ctx, projectId, name) => (name && inventoryOf(ctx, projectId)[name]?.['credential-kind']) || null;

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
// rateLimited (ASS-400: rateLimitStop's, when only that keeps it from running), health (its variation's ai-feedback-long) }.
function vmsOf(ctx, state, project) {
  const vms = new Map();
  const pause = humanPause(state, project.id);
  let plan;
  for (const [name, e] of Object.entries(inventoryOf(ctx, project.id))) {
    const unlinked = project.tickets.some(t => t.key.toLowerCase() === e.ticket?.toLowerCase() && t.variations?.some(v => v.name === e.variation && !v['is-deleted']));
    const busy = state.assignments.some(a => a.project === project.id && a['work-item']?.toLowerCase() === e.ticket?.toLowerCase() && a.variation === e.variation);   // ASS-349
    vms.set(name, { ticket: e.ticket, variation: e.variation, run: false, kind: e['credential-kind'] ?? null, stamps: e['credential-stamps'] ?? null, unlinked, busy });
  }
  for (const t of project.tickets) for (const v of t.variations ?? []) {
    if (!v.vm?.name) continue;
    const use = vmUse(project.engines ?? state.engines, project.engineName, v), free = !v['is-deleted'] && !isHeld(t, v);
    const wants = free && use === 'running', release = free && !pause && use === 'released';
    const busy = state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a.variation === v.name);
    const dependsOn = wants && !pause ? holdOf(state, project, t, v).waits : [];   // ASS-355: held by what it depends on, stopped as one waiting for a slot
    const waits = wants && !pause && !dependsOn.length && waitsForSlot(plan ??= planFor(state, project), t, v);
    const rateLimited = wants && !pause && !dependsOn.length && !waits ? rateLimitStop(ctx, state, project, v) : null;   // ASS-400
    const run = wants && !waits && !dependsOn.length && !pause && !rateLimited;
    const ready = waits && plan.ready.some(r => r.key === t.key && r.variation === v.name);   // ASS-362: a finished plan, said so
    const paused = wants && pause ? pause : undefined, keep = !!pause && busy;   // ASS-297: paused, stopped once idle, never started
    vms.set(v.vm.name, { ...vms.get(v.vm.name), ticket: t.key, variation: v.name, state: v['harness-status']?.state, run, waits, ready, dependsOn, busy, paused, keep, release, rateLimited, health: v['ai-feedback-long'] ?? null });
  }
  return vms;
}

// Each Lima instance's status, by name.
const statuses = ctx => new Promise((resolve, reject) => execFile('limactl', ['list', '--format', '{{.Name}}\t{{.Status}}'], { env: limaEnv(ctx.env) }, (error, stdout) => {
  if (error) reject(new Error(`limactl list: ${error.message}`));
  else resolve(new Map(stdout.split('\n').filter(Boolean).map(line => line.split('\t'))));
}));

// superviseVms(ctx, state) — reads, in the tick, which of the projects' VMs
// are up (memory.vmsUp), so a VM gone down since the last tick — an outage,
// the Mac asleep — is waited for (awaitsVm) before this tick's steps or
// dispatch use it (ASS-159: ASS-158's agents were sent into a VM control
// still took for up); then starts, for each project with a VM and no job
// running, its job (match); memory.vms: id → { job, held: name → { failures, until } }.
export async function superviseVms(ctx, state) {
  const jobs = (ctx.memory.vms ??= new Map());
  await liftMemoryHolds(ctx, state);   // ASS-398: a memory hold lifts by itself once there is enough
  const projects = state.projects.map(project => [project, vmsOf(ctx, state, project)]).filter(([, vms]) => vms.size);
  if (!projects.length) return;
  let status;
  try { status = await statuses(ctx); } catch (error) { ctx.log('error', `${PHASE}: ${error.message}`); return; }
  for (const [, vms] of projects) for (const [name, vm] of vms) {
    if (status.get(name) !== 'Running') ctx.memory.vmsUp?.delete(name);
    if (!vm.run) ctx.memory.vmWaits?.delete(name);
  }
  const stampEvery = (state.harness?.['credential-stamp-interval-seconds'] ?? CREDENTIAL_STAMP_INTERVAL) * 1000;   // ASS-356
  for (const [project, vms] of projects) {
    const r = jobs.get(project.id) ?? { job: null, held: new Map() };
    jobs.set(project.id, r);
    r.job ??= match(ctx, project.id, vms, r, status, diskHeld(state), stampEvery, name => memoryShort(ctx, state, project, name)).catch(error => ctx.log('error', `${PHASE} ${project.id}: ${error.message}`)).finally(() => { r.job = null; });
  }
}

// isUp(ctx, name) — the VM seen up: its wait over.
const isUp = (ctx, name) => { (ctx.memory.vmsUp ??= new Set()).add(name); ctx.memory.vmWaits?.delete(name); };

// probe(ctx, name) — whether `name`'s sshd accepts connections yet.
const probe = (ctx, name) => new Promise((resolve, reject) => execFile('limactl', ['shell', name, '--', 'true'], { env: limaEnv(ctx.env), timeout: 5000 }, error => error ? reject(error) : resolve()));

// changedKeys(recorded, now) — the credential kinds both stamp whose keychain
// stamp now is later than the recorded one (ASS-350; ASS-356: later, not merely
// different — mdat is a fixed-width YYYYMMDDhhmmssZ, so it sorts by time — so
// stamps cached before a VM's start or refresh, older than those it recorded,
// are never a change); none when either is unknown.
const changedKeys = (recorded, now) => (recorded && now ? Object.keys(now).filter(k => recorded[k] && now[k] && now[k] > recorded[k]) : []);

// stampsOf(ctx, id, every) — the project's keychain item stamps (ASS-356):
// memory.vmStamps' id → { at, stamps } when read less than `every` ms ago,
// else read again (vm:credential-stamps) and cached with the time; stamps
// null when the read failed — logged once till a read succeeds, and not tried
// again till `every` has passed.
export const CREDENTIAL_STAMP_INTERVAL = 300;
async function stampsOf(ctx, id, every) {
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
    ctx.memory.memoryHolds?.get(id)?.vms.delete(name);
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
    await rateLimitHealth(ctx, id, name, vm, s);   // ASS-400
    const holding = `vm-stop/${name}`;   // ASS-349: a stop held for an agent at work in it, logged once per hold
    if (vm.run || !vm.busy || s !== 'Running') ctx.memory.warned.delete(holding);
    if (vm.run && s === 'Running' && !up.has(name)) {
      try { await probe(ctx, name); isUp(ctx, name); } catch { /* not yet reachable; probed again next job */ }
    }
    let args, did, refreshing = false, first = null, changed = [];
    if (vm.release && s == null) continue;   // ASS-325: deleted already
    if (vm.release) [first, args, did] = [s === 'Running' ? ['vm:stop', id, name] : null, ['vm:delete', id, name], `deleted (${vm.ticket} ${vm.variation} at ${vm.state}: released)`];
    else if (vm.run && s == null) [args, did] = [['vm:create', id, vm.ticket, vm.variation], `recreated (${vm.ticket} ${vm.variation} at ${vm.state}; it had been deleted)`];
    else if (vm.run && s != null && s !== 'Running') [args, did] = [['vm:start', id, vm.ticket, vm.variation], `started (${vm.ticket} ${vm.variation} at ${vm.state})`];
    else if (!vm.run && s === 'Running') {
      const why = `${vm.ticket} ${vm.variation} ${vm.state ? `at ${vm.state}` : vm.unlinked ? 'not linked to its variation' : 'is not in the sprint'}${vm.waits ? (vm.ready ? '; planned, waits for a build seat' : '; waits for a slot') : ''}${vm.dependsOn?.length ? `; waits on ${vm.dependsOn.join(', ')}` : ''}${vm.paused ? `; ${vm.paused === 'all' ? 'all projects are' : `${id} is`} paused` : ''}${vm.rateLimited ? `; rate-limited until ${vm.rateLimited.until}, no API fallback` : ''}`;
      if (vm.busy) {   // ASS-349: an assignment on its variation — its agent at work in it — holds the stop till it ends
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
    if ((args[0] === 'vm:create' || (args[0] === 'vm:start' && !refreshing)) && await memoryShortFor(name)) {
      if (!ctx.memory.warned.has(`memory/${name}`)) { ctx.memory.warned.add(`memory/${name}`); ctx.log(PHASE, `${id} ${name}: not ${args[0] === 'vm:create' ? 'recreated' : 'started'}: out of memory; waits as for a slot`); }
      continue;
    }
    ctx.memory.warned.delete(`memory/${name}`);
    ctx.memory.memoryHolds?.get(id)?.vms.delete(name);
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
      r.held.set(name, h);
      ctx.log('error', `${PHASE} ${id} ${name}: ${doing.join(' ')} failed (${h.failures} in a row; next try in ${held(wait)}): ${error.message}`);
    }
  }
}
