// A ticket variation's steps on its project's GCP workstations (ASS-468):
// a workstation is held only while one of a variation's steps runs on it, so
// one ticket waiting — Blocked, waiting for a slot, waiting on a fix —
// never keeps it from the others (operator decision, 2026-11-15; under
// ASS-435 a variation kept its workstation from Create VM until it was Done).
//
// In a project whose dev-environments mode is workstation or vm+workstation
// (ASS-431), a step whose work runs on the variation's machine (machineWork:
// a run-location vm step, an agent's or a script's such as ci-checks:verify,
// top-level or a sub-engine's, or a host script that works in the machine,
// vm:refresh-repositories) waits, before any agent or script of it starts
// (stepWaits: steps.js before a script runs, dispatch.js before an agent is
// dispatched), until its variation holds a machine for this step — its
// visit, the variation's state-changes so far: a step left and come back to
// is another — and goes on there: the workstation, its `workstation` naming
// it (machine.js machineOf), or, in vm+workstation mode, its own VM. The
// work around it runs beside the tick in the project's workstation job
// (workstations.js keep → tendSteps), a lease per variation in
// memory.workstationSteps (`${project}/${KEY}/${variation}` → { project,
// key, variation, state, ws, visit (the step it holds a machine for), want
// (the step that last asked), wantedAt, step (its name, for a safety-net
// commit's message), used, completed (AC9: the step's agent turn ended without
// error, or its script exited 0: stepCompleted, usingMachine), scripts (the
// step's scripts running there), dispatching, until, failures, why }):
//
// - wanted: where the step runs follows the variation's seat (ASS-469,
//   seats.js: machines follow seats). A workstation-seat holder's step claims
//   its seat's workstation — one seat per workstation (AC9), so it is that
//   variation's alone — once it is free (no holder) and usable now
//   (connected, its login live, set up since) (workstation:claim
//   --workstation: its holder and the variation's `workstation` set, the
//   shared repositories fetched and checked out on the variation's branches,
//   the ticket's copy, credentials and forwarder token written, AC2) → held;
//   logged with the workstation. A claim that fails is tried again after the
//   usual backoff, the workstation given back meanwhile and its seat kept;
//   one that fails for images the workstation lacks and could not pull
//   (workstation:claim's 5, ASS-473) says so on the Health, each image named
//   with its error, while it waits. Not yet: the step waits, its Health saying
//   why (held by another — a holder from before, or a planning step in
//   workstation mode — starting, about 80 seconds, being set
//   up, its setup failed, its login to renew; AC5) while control connects and
//   sets it up (workstationNeeds). A VM-seat holder's step runs on its VM
//   (vm-wanted) — ASS-468's "a workstation first, else the VM" is gone: the
//   workstation runs only its seat-holders' steps — except that, in
//   vm+workstation mode, while a workstation seat is free it waits (no
//   Health) for the next tick's seats, which move it there between its steps
//   (seats.js; ASS-468 ended one step and began the next in one pass, with no
//   tick between). A variation in progress with no seat yet (just in, or
//   taken out of a lost workstation's seat) waits for one, its Health seats.js'.
//   A step that holds no seat kind (planning: no seat kinds, ASS-469 AC2) runs
//   on the variation's VM in vm+workstation mode, and in workstation mode, with
//   no VM to go to, claims any free, usable workstation no seat-holder's step
//   waits for, as ASS-468 did.
// - vm-wanted: the variation's VM made by the existing VM path when it has
//   none (vm:create --vm, which records it, kept for its later steps), up
//   (the VM lifecycle starts it, vm-lifecycle.js), then its repositories
//   moved to the variation's branches (vm:step-start, as workstation:claim
//   does there) → vm.
// - held, vm: the step runs. Its machine is in use while an assignment is
//   on the variation (its agents, however many, share the claim), an agent
//   of it lives, one is being dispatched, or a script of the step runs there
//   (usingMachine). Once none is, and the step was used or another step
//   asks or nothing asked for CLAIM_GRACE, the step has ended, whatever its
//   outcome (an agent killed too): workstation:release (AC3, AC9, AC10:
//   with --completed <step> when the step completed, what it left
//   uncommitted committed on its branch and pushed — logged as a warning:
//   each step commits its own work — else discarded, each file logged;
//   committed work pushed, never forced; master never pushed, a local master
//   ahead of GitLab's reset to it, its commits named in the log and on the
//   Health (MASTER_HEALTH); master at the latest, the step's containers,
//   credentials, token and binding removed, the holder cleared), or
//   vm:step-end for one in its VM (the same, the VM kept). A push that
//   failed is logged and on the variation's Health (PUSH_HEALTH, cleared by
//   its next clean end) — ASS-478: only a push of its own branch (ownBranch),
//   never another ticket's; an end that fails (a tree not clean, the
//   connection gone) keeps the machine and is tried again after the usual
//   backoff. Released, a lease another step of the variation asks for is
//   wanted again; else forgotten.
//
// A holder this control holds no lease for — one from before it restarted
// (its agents and scripts ended with it), or ASS-435's, which kept its
// workstation between steps and records a folder of its own (AC7: the
// migration) — is released the same way once no assignment is on its
// variation (releaseStale): its committed work pushed, what it left
// uncommitted discarded (its step did not complete), its folder removed.
//
// ASS-480: a step's end always runs on the machine it ran on. A step that
// goes on in its VM is recorded as a pending end (step-ends.js, the
// project's step-ends.json: `vm` on its lease) until its vm:step-end has
// succeeded, so the VM lifecycle keeps that VM — starting it when stopped,
// never stopping, deleting or reclaiming it meanwhile (vm-lifecycle.js,
// vm.bash reconcile_vms) — and a control restarted meanwhile takes the end up
// again (a lease in vm made from the record). The end waits, uncounted, while
// its VM is not up; once the VM is gone (deleted, not stopped: limactl list
// has no such instance) it can never run: logged once as an error naming the
// step and the repositories and branches the variation's plan had — any
// commits that step had not pushed were lost with the VM — shown on the
// variation's Health (LOST_HEALTH, cleared by a later step's clean end) and
// dropped, never retried. A step's end pushes only the variation's own
// branch (ASS-478); another ticket's stray local branch found in the shared
// repositories that has parted from GitLab's (a push of it would be
// rejected), at a step's start or end, is set aside (step-trees.sh, kept
// under refs/harness/stray/…, never pushed) and reported — logged, and on the
// Health of the ticket the branch belongs to (STRAY_HEALTH), named from the
// branch (change/<KEY>-<id>, change/<KEY>.<variation>-<id>), never the
// releasing one's. A step waiting for its VM to be made or started says so on
// its Health as waiting for its VM (workstations.js VM_HEALTH), never its
// workstation: a planning step never uses one (ASS-469).
import { runsInVm } from './vm.js';
import { stepOf, engineSteps } from './engine.js';
import { enginesFor } from './state.js';
import { backoffDelay, held } from './backoff.js';
import { loadWorkstations, workstationUsable, loginExpired } from './workstation-connection.js';
import { loadSeats, seatOf, seatCapacity } from './seat-kinds.js';
import { slotKind } from './plan.js';
import { statusIn } from './engine.js';
import { loadEnds, pendEnd, endDone, vmGone, recover } from './step-ends.js';

const PHASE = 'workstation';
export const CLAIM_GRACE = 2 * 60_000;
// A host script that works in the variation's machine (its repositories): it needs one held for its step.
const MACHINE_SCRIPT = /(^|\s)(\.\/)?agent\.sh vm:(refresh-repositories|test-repos|run|demo)\b/;
// WORKSTATION_HEALTH, PUSH_HEALTH, MASTER_HEALTH — what every long Health written here begins with, so only its own is cleared.
export const WORKSTATION_HEALTH = 'Waiting for its workstation:';
export const PUSH_HEALTH = 'Could not push its committed work:';
export const MASTER_HEALTH = 'Commits on master were discarded:';
// ASS-480: LOST_HEALTH — a step's end that could not run, its VM gone; STRAY_HEALTH — a ticket's stray local branch set aside.
export const LOST_HEALTH = 'A step\'s end could not run, its VM gone:';
export const STRAY_HEALTH = 'Commits of a stray local branch were set aside:';

// usesWorkstations(project) — its tickets run on its workstations (workstation or vm+workstation mode, ASS-431).
export const usesWorkstations = project => ['workstation', 'vm+workstation'].includes(project?.devEnvironments?.mode) && (project.devEnvironments.workstations?.length ?? 0) > 0;

// machineWork(step) — the step's work runs on its variation's machine.
export const machineWork = step => runsInVm(step) || (step?.action?.type === 'script' && MACHINE_SCRIPT.test(step.action.command ?? ''));

const same = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
const keyOf = (projectId, key, name) => `${projectId}/${String(key).toUpperCase()}/${name}`;
const visitOf = variation => String((variation?.['state-changes'] ?? []).length);
export const leasesOf = ctx => (ctx.memory.workstationSteps ??= new Map());

// stepWaits(ctx, state, project, ticket, variation, step, who) — whether the
// step's work waits for its machine (see the module comment): false at once
// for a step that runs none, or a project not on workstations; else asks for
// one for this step, and is false once it holds it.
export function stepWaits(ctx, state, project, ticket, variation, step, who) {
  if (!usesWorkstations(project) || !ticket || !variation || variation['is-deleted'] || !machineWork(step)) return false;
  const leases = leasesOf(ctx), k = keyOf(project.id, ticket.key, variation.name), visit = visitOf(variation), now = ctx.now().getTime();
  let l = leases.get(k);
  if (!l) {
    l = { project: project.id, key: ticket.key, variation: variation.name, state: 'wanted', scripts: new Set(), dispatching: 0, failures: 0, until: 0 };
    leases.set(k, l);
  }
  if (l.want !== visit && !(l.visit === visit && l.state !== 'wanted')) ctx.log(PHASE, `${who}: its step wants a machine; ${l.state === 'held' || l.state === 'vm' ? 'its last step\'s is given back first' : 'one is readied for it by its seat'}`);
  Object.assign(l, { want: visit, wantedAt: now, who, step: step.name ?? step.id });
  if (l.visit !== visit) return true;
  if (l.state === 'held') return variation.workstation?.name !== l.ws;   // the claim recorded on the variation, as this tick reads it
  if (l.state === 'vm') return Boolean(variation.workstation);
  return true;
}

// dispatching(ctx, projectId, key, name) — an agent of the variation's step is being dispatched: its machine is in
// use until the returned function is called (its assignment is on the variation by then).
export function dispatching(ctx, projectId, key, name) {
  const l = leasesOf(ctx).get(keyOf(projectId, key, name));
  if (!l) return () => {};
  l.dispatching++; l.used = true; l.completed = false;
  return () => { l.dispatching--; };
}

// stepCompleted(ctx, record) — AC9: the step of the assignment `record` completed (finish.js: its turn ended
// without error), so at its end what it left uncommitted is committed on its branch, not discarded.
export function stepCompleted(ctx, record) {
  const l = record?.['work-item'] && leasesOf(ctx).get(keyOf(record.project, record['work-item'], record.variation));
  if (l) l.completed = true;
}

// usingMachine(ctx, projectId, key, name, step, running) — `running`, a script step's run, counted as using the
// variation's machine until it settles.
export function usingMachine(ctx, projectId, key, name, step, running) {
  const l = leasesOf(ctx).get(keyOf(projectId, key, name));
  if (!l || !machineWork(step)) return running;
  const token = Symbol('script');
  l.scripts.add(token); l.used = true; l.completed = false;
  return running.then(facts => { if (facts?.exitCode === 0) l.completed = true; return facts; }).finally(() => l.scripts.delete(token));
}

// inUse(ctx, state, l) — the lease's machine is in use (see the module comment): an agent of a step of the
// variation's that runs on it (a host agent of the variation — a gap's investigation, Blocked's on the host — uses
// none) assigned or alive, one being dispatched, or a script of its step running.
const onMachine = (state, a) => machineWork(stepOf(engineSteps(enginesFor(state, a.project), a['state-engine']), a.state));
const inUse = (ctx, state, l) => l.scripts.size > 0 || l.dispatching > 0
  || state.assignments.some(a => a.project === l.project && same(a['work-item'], l.key) && a.variation === l.variation && onMachine(state, a))
  || [...(ctx.agents?.values() ?? [])].some(a => a.project === l.project && same(a.record?.['work-item'], l.key) && a.record?.variation === l.variation && !a.exited && onMachine(state, a.record));

// stepOnMachine(ctx, state, projectId, key, name) — ASS-469: a step of the variation runs on its machine now (seats.js
// moves a variation between seats between its steps only): its lease holds a machine, is readying its VM or ending
// its step, or the machine is in use (inUse); without a lease, an agent of a step on its machine is assigned.
export function stepOnMachine(ctx, state, projectId, key, name) {
  const l = leasesOf(ctx).get(keyOf(projectId, key, name));
  if (l) return l.state !== 'wanted' || inUse(ctx, state, l);
  return state.assignments.some(a => a.project === projectId && same(a['work-item'], key) && a.variation === name && onMachine(state, a));
}

// placeOf(state, project, seats, l, v) — ASS-469: where the lease's step is to run, by the variation's seat (see the
// module comment): { ws: <id> } its seat's workstation; { any: true } any free one (workstation mode, a step with no
// seat kind); { vm: why } its VM; { wait: true } nowhere yet (no seat yet, or a workstation seat free to move into).
function placeOf(state, project, seats, l, v) {
  const seat = seatOf(seats, l.key, l.variation), mode = project.devEnvironments?.mode;
  if (seat?.kind === 'workstation') return { ws: seat.workstation };
  if (seat?.kind === 'vm') {
    if (mode === 'vm+workstation' && freeWorkstationSeat(project, seats)) return { wait: true };
    return { vm: 'it holds a VM seat' };
  }
  const status = v ? statusIn(project.engine, v, project.engines ?? state.engines) : null;
  if (status && slotKind(status.step, status) === 'progress') return { wait: true };
  return mode === 'vm+workstation' ? { vm: 'a planning step runs on its VM' } : { any: true };
}

// freeWorkstationSeat(project, seats) — a workstation of the project has a seat no one holds and is not lost.
const freeWorkstationSeat = (project, seats) => seatCapacity(project).workstations.some(w => !w.lost && seats.filter(s => s.kind === 'workstation' && s.workstation === w.id).length < w.seats);

// seatHolderWaits(ctx, project, seats, id) — the lease of workstation `id`'s seat-holder, waiting for it for a step, or
// undefined: a step with no seat kind (workstation mode's planning) leaves that workstation to it.
const seatHolderWaits = (ctx, project, seats, id) => [...leasesOf(ctx).values()]
  .find(x => x.project === project.id && x.state === 'wanted' && seatOf(seats, x.key, x.variation)?.kind === 'workstation' && seatOf(seats, x.key, x.variation).workstation === id);

// whyNot(settings, entries, home) — { why, busy, usable, transient }: why no workstation can take a step now (each
// named), whether one is held by another variation, and whether all that keeps one is its start or its setup.
function whyNot(settings, entries) {
  const why = [];
  let busy = false, transient = false;
  for (const w of settings.workstations) {
    const e = entries[w.id];
    if (e?.holder) { busy = true; why.push(`${w.id} is held by ${e.holder.ticket} ${e.holder.variation}`); continue; }
    if (loginExpired(e)) { why.push(`${w.id}'s gcloud login needs reauthentication`); continue; }
    if (e?.connected === true && e.setup?.ok === false) { why.push(`${w.id}'s setup failed: ${e.setup.error ?? 'see the control log'}`); continue; }
    transient = true;
    why.push(e?.connected === true ? `${w.id} is being set up` : `${w.id} is starting (about 80 seconds)${e?.['last-error']?.message ? `; its last connect failed: ${e['last-error'].message}` : ''}`);
  }
  return { why: why.join('; '), busy, transient };
}

// tendSteps(ctx, project, settings, dir, health) — one pass over the project's leases and holders (see the module
// comment), in its workstation job; `health(t, v, why)` writes a waiting variation's Health and returns.
export async function tendSteps(ctx, project, settings, dir, health) {
  const state = ctx.load(), now = ctx.now().getTime();
  const fresh = state.projects.find(p => p.id === project.id) ?? project;
  const leases = leasesOf(ctx), waiting = [];
  resume(ctx, fresh, dir, leases);
  for (const [k, l] of leases) {
    if (l.project !== project.id) continue;
    const t = fresh.tickets?.find(x => same(x.key, l.key)), v = t?.variations?.find(x => x.name === l.variation && !x['is-deleted']);
    const who = `${l.key} ${l.variation}`;
    if (inUse(ctx, state, l)) { l.used = true; continue; }
    if (now < l.until) { if (l.why && v) waiting.push([t, v, l.why, l.whyKind]); continue; }
    const ended = !v || l.used || l.want !== l.visit || now - (l.wantedAt ?? 0) > CLAIM_GRACE;
    if (l.state === 'held' || l.state === 'vm') {
      if (!ended) continue;
      const was = l.state;
      l.state = 'releasing';   // no step goes on it meanwhile (stepWaits)
      const done = await end(ctx, fresh, dir, l, who, t, v, was);
      if (done === LOST) { leases.delete(k); continue; }   // ASS-480 AC2: its VM gone, its end dropped
      if (!done) { l.state = was; continue; }
      if (v && l.want != null && l.want !== l.visit && now - (l.wantedAt ?? 0) <= CLAIM_GRACE) Object.assign(l, { state: 'wanted', visit: null, ws: null, used: false });
      else { leases.delete(k); continue; }
    }
    if (!v || now - (l.wantedAt ?? 0) > CLAIM_GRACE) { leases.delete(k); continue; }   // nothing asks for it any more
    if (l.state === 'wanted') await claim(ctx, state, fresh, settings, dir, l, who, t, v);
    if (l.state === 'vm-wanted') await readyVm(ctx, fresh, dir, l, who, v);
    if ((l.state === 'wanted' || l.state === 'vm-wanted') && l.why) waiting.push([t, v, l.why, l.whyKind]);
  }
  await releaseStale(ctx, project, settings, dir, state);
  for (const [t, v, why, kind] of waiting) await health(t, v, why, kind);
  return new Set(waiting.map(([t, v]) => `${t.key} ${v.name}`));
}

// resume(ctx, project, dir, leases) — ASS-480: each pending VM step end recorded in step-ends.json (step-ends.js; the
// migration's first, once) that no lease holds — its step ran under a control since restarted — taken up again as a
// lease in vm, its step used, so tendSteps ends it once nothing of the variation's uses the VM (or drops it, AC2).
function resume(ctx, project, dir, leases) {
  recover(ctx, project, dir);
  for (const rec of Object.values(loadEnds(dir).ends)) {
    const k = keyOf(project.id, rec.key, rec.variation);
    if (!rec?.vm || leases.has(k)) continue;
    leases.set(k, { project: project.id, key: rec.key, variation: rec.variation, state: 'vm', vm: rec.vm, step: rec.step ?? null, completed: Boolean(rec.completed), used: true, visit: null, want: null, wantedAt: 0, scripts: new Set(), dispatching: 0, failures: 0, until: 0 });
    ctx.log(PHASE, `${rec.key} ${rec.variation}: its step${rec.step ? ` "${rec.step}"` : ''}'s end is pending on its VM ${rec.vm} (since ${rec.since ?? '?'}): it runs there before anything else of it does`);
  }
}

// claim(…) — the lease's step placed by its variation's seat (placeOf, ASS-469): its workstation (or, with no seat
// kind in workstation mode, any free one no seat-holder waits for) claimed once free and usable; else sent to its VM, or why it waits.
// The seats are read from seats.json here, at the moment of choosing, so a move this tick made is seen at once.
async function claim(ctx, state, project, settings, dir, l, who, t, v) {
  const seats = loadSeats(dir), entries = loadWorkstations(dir), place = placeOf(state, project, seats, l, v);
  l.whyKind = null;   // a workstation's wait (ASS-480: a VM's is readyVm's, 'vm')
  if (place.wait) { l.why = null; return; }   // seats.js' to settle: a seat to be given, or a free workstation seat to move into
  if (place.vm) {
    Object.assign(l, { state: 'vm-wanted', why: null, whyKind: 'vm' });
    ctx.log(PHASE, `${l.who ?? who}: ${place.vm}: its step runs on its VM`);
    return;
  }
  const ids = place.ws ? [place.ws] : settings.workstations.map(w => w.id).filter(id => !seatHolderWaits(ctx, project, seats, id));
  const ready = ids.filter(id => !entries[id]?.holder && workstationUsable(entries[id]));
  if (ready.length) {
    try {
      const out = JSON.parse(await ctx.cli(['workstation:claim', project.id, t.key, v.name, '--workstation', ready[0]]));
      Object.assign(l, { state: 'held', ws: out.name, visit: l.want, used: false, completed: false, failures: 0, until: 0, why: null });
      const moved = (out.unclean?.length ? `; not checked out: ${out.unclean.map(u => `${u.repository} (${u.why})`).join(', ')}` : '') + (out.discarded?.length ? `; discarded what an unfinished step left uncommitted: ${out.discarded.map(d => `${d.repository} (${d.files.join(', ')})`).join('; ')}` : '');
      ctx.log(PHASE, `${project.id} ${out.name}: claimed for ${l.who ?? who}: its repositories on ${who}'s branches${moved}`);
      await setAside(ctx, project, out, who, `${project.id} ${out.name}'s claim for ${who}`);
      return;
    } catch (error) {
      if (error.code !== 4) {
        const wait = backoffDelay(++l.failures);
        l.until = ctx.now().getTime() + wait;
        ctx.log('error', `${PHASE} ${project.id}: workstation:claim for ${who} failed (${l.failures} in a row; next try in ${held(wait)}): ${error.message}`);
        // ASS-473 AC2: images it needs could not be pulled onto the workstation and are not there (claim's 5, its last
        // line naming each with its error): the variation's Health says so while it waits out the backoff (tendSteps
        // keeps a waiting lease's `why` on it), cleared once a claim succeeds. The workstation was given back, and
        // nothing here touches its seat: it is still usable (seat-kinds.js lostWhy), so the seat stays the ticket's.
        l.why = error.code === 5 ? missingWhy(error.message, ready[0], wait) : null;
        return;
      }
    }
  }
  const not = whyNot({ workstations: settings.workstations.filter(w => ids.includes(w.id)) }, loadWorkstations(dir));
  const why = place.ws
    ? `its seat's workstation ${place.ws} is not free for its step: ${not.why}`
    : `no workstation of ${project.id}'s is free for its step: ${not.why || 'each is waited for by its seat-holders\' steps'}`;
  if (l.why !== why) ctx.log(PHASE, `${l.who ?? who}: waits: ${why}`);
  l.why = why;
}

// missingWhy(message, id, wait) — ASS-473: a Health's why for a claim that failed for images missing on workstation
// `id`, from workstation:claim's last line ("…: images it needs could not be pulled and are not there: <image>
// (<error>); …; it is given back").
function missingWhy(message, id, wait) {
  const line = String(message).split('\n').at(-1);
  const what = /images it needs could not be pulled and are not there: (.*?)(; it is given back)?$/.exec(line)?.[1] ?? line;
  return `${id} lacks images its step needs, which could not be pulled: ${what}. Its claim is tried again in ${held(wait)}, the images pulled again`;
}

// readyVm(…) — vm+workstation: the step's VM (a VM-seat holder's, or a planning step's, ASS-469), made when the variation has none, up, its repositories moved to the variation's branches.
// ASS-480: its Health then says it waits for its VM (whyKind 'vm', AC5); once the step goes on there its end is recorded as pending on that VM.
async function readyVm(ctx, project, dir, l, who, v) {
  l.whyKind = 'vm';
  try {
    if (!v.vm?.name || (v.vm.kind ?? 'lima') !== 'lima') {
      l.why = 'it is being made for its step';
      ctx.log(PHASE, `${who}: has no VM: making one for its step (vm:create --vm)`);
      await ctx.cli(['vm:create', project.id, l.key, v.name, '--vm']);
      return;
    }
    if (!ctx.memory.vmsUp?.has(v.vm.name)) { l.why = `${v.vm.name} is starting`; return; }
    const out = await ctx.cli(['vm:step-start', project.id, l.key, v.name]);
    Object.assign(l, { state: 'vm', vm: v.vm.name, visit: l.want, used: false, completed: false, failures: 0, until: 0, why: null, ws: null });
    pendEnd(ctx, dir, { key: l.key, variation: l.variation, vm: v.vm.name, step: l.step, completed: false });
    ctx.log(PHASE, `${l.who ?? who}: runs on its VM ${v.vm.name}, its repositories moved to its branches`);
    let summary = null;
    try { summary = JSON.parse(out || 'null'); } catch { /* an older summary, or none: nothing set aside to report */ }
    if (summary) await setAside(ctx, project, summary, who, `${who}'s step start on its VM ${v.vm.name}`);
  } catch (error) {
    const wait = backoffDelay(++l.failures);
    l.until = ctx.now().getTime() + wait;
    ctx.log('error', `${PHASE} ${who}: readying its VM for its step failed (${l.failures} in a row; next try in ${held(wait)}): ${error.message}`);
  }
}

// end(…) — the step's end on its machine (AC3, AC9, AC10), logged; true once done, LOST once dropped (ASS-480 AC2:
// its VM gone). ASS-480 AC1: one in a VM is recorded pending (step-ends.js) until it has succeeded; while the VM is not
// up (the VM lifecycle starts it for this end) it waits, no failure counted.
const LOST = 'lost';
async function end(ctx, project, dir, l, who, t, v, was) {
  const onVm = was === 'vm', completed = l.completed ? ['--completed', l.step ?? 'its step'] : [];
  if (onVm) {
    l.vm ??= v?.vm?.name;
    if (l.vm) pendEnd(ctx, dir, { key: l.key, variation: l.variation, vm: l.vm, step: l.step, completed: l.completed });
    if (vmGone(ctx, l.vm)) { await lost(ctx, project, dir, l, who, t); return LOST; }
    if (l.vm && !ctx.memory.vmsUp?.has(l.vm)) {
      const said = `vm-end/${project.id}/${l.vm}`;
      if (!ctx.memory.warned.has(said)) { ctx.memory.warned.add(said); ctx.log(PHASE, `${who}: its step's end waits for its VM ${l.vm} to be up (the VM lifecycle starts it for the end)`); }
      return false;
    }
    ctx.memory.warned.delete(`vm-end/${project.id}/${l.vm}`);
  }
  try {
    const out = JSON.parse(await ctx.cli(onVm ? ['vm:step-end', project.id, l.key, l.variation, ...completed] : ['workstation:release', project.id, l.ws, '--force', ...completed]));
    l.failures = 0; l.until = 0;
    if (onVm) { endDone(ctx, dir, l.key, l.variation); l.vm = null; }
    await reported(ctx, project, out, onVm ? `${who}: its step${l.completed ? '' : ' (not completed)'} ended on its VM` : `${project.id} ${l.ws}: released by ${who}${l.completed ? '' : ' (its step not completed)'}`, who, t, v);
    return true;
  } catch (error) {
    if (onVm && vmGone(ctx, l.vm)) { await lost(ctx, project, dir, l, who, t); return LOST; }
    const wait = backoffDelay(++l.failures);
    l.until = ctx.now().getTime() + wait;
    ctx.log('error', `${PHASE} ${who}: ending its step on ${onVm ? 'its VM' : `workstation ${l.ws}`} failed (${l.failures} in a row; next try in ${held(wait)}): ${error.message}`);
    return false;
  }
}

// ownBranch(t, v, branch) — ASS-478: whether a branch is the variation's own: one its merge-request plan names, or
// one named for it (change/<KEY>-<id>; change/<KEY>.<variation>-<id> for a variation other than A).
export function ownBranch(t, v, branch) {
  if (!t || !v || !branch) return false;
  if ((v['merge-request'] ?? []).some(m => m?.branch === branch)) return true;
  const slug = v.name === 'A' ? t.key : `${t.key}.${v.name}`;
  return new RegExp(`^change/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`, 'i').test(branch);
}

// reported(ctx, project, out, head, who, t, v) — what a step's end did (workstation:release's or vm:step-end's
// summary), logged: what it pushed; a completed step's leftovers it committed, as a warning (AC9: each step
// commits its own work); what it discarded, per repository; and on the variation's Health a push of its own branch
// that failed (PUSH_HEALTH; ASS-478: another ticket's branch's is only logged, never on this one's Health) and
// commits on master it reset away (MASTER_HEALTH, AC10) — each cleared by a later end without.
export async function reported(ctx, project, out, head, who, t, v) {
  const pushed = out.pushed?.length ? `pushed ${out.pushed.map(p => `${p.repository} ${p.branch} (${p.commits})`).join(', ')}` : 'nothing to push';
  ctx.log(PHASE, `${head}: ${pushed}; its repositories back on master`);
  for (const c of out.committed ?? []) ctx.log(PHASE, `warning: ${who}: its step completed but left ${c.repository} uncommitted on ${c.branch}; committed and pushed by the harness (${c.files.join(', ')})`);
  for (const d of out.discarded ?? []) ctx.log(PHASE, `${who}: discarded what was not committed in ${d.repository} (on ${d.branch}): ${d.files.join(', ')}`);
  const failedAll = out['push-failed'] ?? [], reset = out['master-reset'] ?? [];
  const failed = failedAll.filter(f => ownBranch(t, v, f.branch)), others = failedAll.filter(f => !ownBranch(t, v, f.branch));
  const health = async (prefix, items, short, rest) => {
    if (!t || !v) return;
    if (items.length) {
      const what = items.join('; ');
      await ctx.attempt(PHASE, who, () => ctx.cli(['ticket:set-ai-feedback', project.id, t.key, v.name, `${short}: ${what}`.slice(0, 120), `${prefix} ${what}. ${rest}`]));
    } else if (v['ai-feedback-long']?.startsWith(prefix)) {
      await ctx.attempt(PHASE, who, () => ctx.cli(['ticket:clear-ai-feedback', project.id, t.key, v.name, v['ai-feedback-long']]));
    }
  };
  if (failed.length) ctx.log('error', `${PHASE} ${who}: could not push its committed work (${failed.map(f => `${f.repository} ${f.branch}: ${f.why}`).join('; ')}); the commits stay on the local branch for its next step`);
  if (others.length) ctx.log('error', `${PHASE} ${who}: its step's end could not push ${others.map(f => `${f.repository} ${f.branch}: ${f.why}`).join('; ')} — not its own branch${others.length > 1 ? 'es' : ''} (ASS-478), so not on its Health`);
  if (reset.length) ctx.log('error', `${PHASE} ${who}: commits on master are never kept (ASS-468); reset to GitLab's, discarding ${reset.map(r => `${r.repository} ${r.branch}: ${r.commits}`).join('; ')}`);
  await health(PUSH_HEALTH, failed.map(f => `${f.repository} ${f.branch}: ${f.why}`), 'Could not push', 'Its step\'s other work is kept: the commits stay on the local branch, pushed again at the end of its next step on the machine.');
  await health(MASTER_HEALTH, reset.map(r => `${r.repository} ${r.branch}: ${r.commits}`), 'Commits on master discarded', 'Nothing is ever committed on master: those commits were reset to GitLab\'s at the step\'s end. Commit on the ticket\'s branch (change/<KEY>-<id>) instead.');
  if (!failed.length) await health(LOST_HEALTH, [], '', '');   // ASS-480 AC2: a later step's clean end clears it
  await setAside(ctx, project, out, who, `${who}'s step end`);
}

// ownerOf(branch) — ASS-480: { key, variation } of the ticket variation a branch belongs to, from its name
// (change/<KEY>-<id>, change/<KEY>.<variation>-<id>), or null.
export function ownerOf(branch) {
  const m = /^change\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\.([A-Za-z0-9]+))?-\d+$/.exec(String(branch ?? ''));
  return m ? { key: m[1].toUpperCase(), variation: m[2] ?? 'A' } : null;
}

// setAside(ctx, project, out, who, where) — ASS-480 AC3, AC4: each stray local branch a step's start or end set aside
// (step-trees.sh's "set-aside": never pushed, kept under refs/harness/stray/…, its local branch deleted) logged as an
// error, and shown on the Health of the ticket variation the branch belongs to (STRAY_HEALTH) — not the one whose step
// found it, unless it is its own (a branch of its own that had parted from GitLab's).
async function setAside(ctx, project, out, who, where) {
  const items = out?.['set-aside'] ?? [];
  if (!items.length) return;
  const state = ctx.load(), fresh = state.projects.find(p => p.id === project.id) ?? project, byOwner = new Map();
  for (const a of items) {
    const owner = ownerOf(a.branch), whose = owner ? `${owner.key} ${owner.variation}'s` : 'no ticket\'s (its name is not change/<KEY>-<id>)';
    ctx.log('error', `${PHASE} ${where}: set aside ${a.repository} ${a.branch}, ${a.commits} commit(s) GitLab lacks, under ${a.ref} (${a.why}); never pushed, its local branch deleted so it is checked out fresh from GitLab; it is ${whose}`);
    if (!owner) continue;
    const k = `${owner.key} ${owner.variation}`;
    byOwner.set(k, [...(byOwner.get(k) ?? []), a]);
  }
  for (const [k, list] of byOwner) {
    const [key, name] = k.split(' ');
    const t = fresh.tickets?.find(x => same(x.key, key)), v = t?.variations?.find(x => x.name === name && !x['is-deleted']);
    if (!t || !v) continue;
    const what = list.map(a => `${a.repository} ${a.branch} (${a.commits} commit(s), kept under ${a.ref})`).join('; ');
    const on = same(who, k) ? 'its own step' : `${who}'s step`;
    const long = `${STRAY_HEALTH} ${what}, found by ${on} on the machine it ran on (${list[0].why}). They were never pushed, nor force-pushed; the local branch was deleted, so this ticket's next step takes the branch from GitLab. To keep them, look at the commits (git log <ref> in that repository on that machine) and cherry-pick what is wanted onto the branch.`;
    await ctx.attempt(PHASE, k, () => ctx.cli(['ticket:set-ai-feedback', project.id, t.key, v.name, `Stray commits set aside: ${what}`.slice(0, 120), long]));
  }
}

// lost(ctx, project, dir, l, who, t) — ASS-480 AC2: the step's end can never run, its VM gone: logged once as an error
// naming the step and the repositories and branches the variation's plan had (any commits that step had not pushed
// were lost with the VM), shown on the variation's Health (LOST_HEALTH, cleared by a later step's clean end), and the
// pending end dropped — never retried.
async function lost(ctx, project, dir, l, who, t) {
  const v = t?.variations?.find(x => x.name === l.variation);
  const repo = url => String(url).replace(/\.git$/, '').split('/').at(-1);
  const plan = (v?.['merge-request'] ?? []).filter(m => m.repository && m.branch && !['Merged', 'Closed'].includes(m.status)).map(m => `${repo(m.repository)} ${m.branch}`);
  const branches = plan.length ? plan.join(', ') : 'none planned';
  const step = l.step ? `"${l.step}"` : 'its last step';
  ctx.log('error', `${PHASE} ${who}: the end of its step ${step} could not run: its VM ${l.vm} is gone (deleted before the end ran); any commits that step had not pushed were lost with it (its plan's repositories and branches: ${branches}); the pending end is dropped`);
  endDone(ctx, dir, l.key, l.variation);
  ctx.memory.warned.delete(`vm-end/${project.id}/${l.vm}`);
  if (!t || !v || v['is-deleted']) return;
  const long = `${LOST_HEALTH} the end of its step ${step} (push its commits, clean up, back on master) never ran in its VM ${l.vm}, which was deleted first. Any commits that step made and had not pushed were lost with the VM (its plan's repositories and branches: ${branches}). Check those branches on GitLab against what the step was to do, and redo what is missing. Cleared once a later step of it ends cleanly.`;
  await ctx.attempt(PHASE, who, () => ctx.cli(['ticket:set-ai-feedback', project.id, t.key, v.name, `Step end lost with its VM ${l.vm}: ${step}'s unpushed commits lost`.slice(0, 120), long]));
}

// releaseStale(…) — a holder no lease here holds (see the module comment), with no assignment on its variation,
// released once its workstation's connection is open.
async function releaseStale(ctx, project, settings, dir, state) {
  const entries = loadWorkstations(dir), leases = [...leasesOf(ctx).values()];
  for (const w of settings.workstations) {
    const h = entries[w.id]?.holder;
    if (!h || !entries[w.id]?.connected) continue;
    if (leases.some(l => l.project === project.id && same(l.key, h.ticket) && l.variation === h.variation && l.ws === w.id)) continue;
    if (state.assignments.some(a => a.project === project.id && same(a['work-item'], h.ticket) && a.variation === h.variation && onMachine(state, a))) continue;
    const old = h.folder && !/\/harness$/.test(h.folder);
    await ctx.attempt(PHASE, `${project.id} ${w.id}`, async () => {
      const out = JSON.parse(await ctx.cli(['workstation:release', project.id, w.id, '--force']));
      const t = state.projects.find(p => p.id === project.id)?.tickets?.find(x => same(x.key, h.ticket)), v = t?.variations?.find(x => x.name === h.variation && !x['is-deleted']);
      await reported(ctx, project, out, `${project.id} ${w.id}: released: ${h.ticket} ${h.variation} held it with no step running (${old ? `a holder from before ASS-468: its folder ${h.folder} removed` : 'a claim from before control restarted'})`, `${h.ticket} ${h.variation}`, t, v);
    });
  }
}

// workstationWants(ctx, state, project, entries) — Map workstation id → why a step needs it now: the one a lease holds
// (or ends a step on); the one a waiting lease's seat is on (ASS-469: placeOf); and, for each lease with no seat kind
// waiting in workstation mode, the first of the list that is free (connected and set up for it by control:
// workstations.js workstationNeeds).
export function workstationWants(ctx, state, project, entries = {}) {
  const wants = new Map(), waiting = [], seats = project.seats ?? [];
  for (const l of leasesOf(ctx).values()) {
    if (l.project !== project.id) continue;
    if ((l.state === 'held' || l.state === 'releasing') && l.ws) { wants.set(l.ws, `${l.key} ${l.variation}'s step runs on it`); continue; }
    if (l.state !== 'wanted') continue;
    const v = project.tickets?.find(x => same(x.key, l.key))?.variations?.find(x => x.name === l.variation && !x['is-deleted']);
    const place = placeOf(state, project, seats, l, v);
    if (place.ws && !wants.has(place.ws)) wants.set(place.ws, `${l.who ?? `${l.key} ${l.variation}`} wants it for a step (its seat)`);
    else if (place.any) waiting.push(`${l.who ?? `${l.key} ${l.variation}`} wants it for a step`);
  }
  for (const w of project.devEnvironments?.workstations ?? []) {
    if (!waiting.length) break;
    if (wants.has(w.id) || entries[w.id]?.holder) continue;
    wants.set(w.id, waiting.shift());
  }
  return wants;
}
