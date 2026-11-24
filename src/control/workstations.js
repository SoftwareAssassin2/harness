// Phase 3, beside the VMs: each project's GCP workstations' one SSH
// connection (ASS-433), kept up by control while anything on a workstation
// needs it and closed once nothing does. A connection is opened, checked and
// closed by the workstation:* commands (agent-cli/workstation.bash says how:
// the workstation started when it is stopped, one OpenSSH master through
// gcloud workstations ssh, the forwarder, Hindsight and zot reverse-forwarded
// to its loopback), and each writes the workstation's live data,
// data/projects/<p>/workstations.json (workstation-connection.js).
//
// AC3. A workstation is needed (workstationNeeds) while one of a ticket
// variation's steps runs on it or waits for it (ASS-468,
// workstation-steps.js: a step claims a workstation for its length), while
// it has a holder whose step is to be ended, while an agent of the variation
// recording it as its `workstation` is at work, while the operator holds it
// running (vm:hold, ASS-427), and — ASS-469 AC6, seats.js seatNeeds — while
// any of its seats is held by a variation in progress (between its steps
// too), or it has a free seat and a variation waits for an in-progress seat
// or sits in a VM seat to move into it, or its seats are lost and tickets in
// progress would take them (its connect tried again after the backoff). Only
// with no seat-holders and nobody waiting does it disconnect and stop itself
// (ASS-529 AC5: with several tickets on it, only once none of them needs it —
// no seat on it held, no holder's step to end).
// A stopped workstation with work for its seats is so connected — started —
// at once. While needed: connected
// (workstation:connect, which starts a stopped workstation and waits for
// it), its first connect logged with why it is needed; then checked every
// CHECK_EVERY (workstation:status --connection: the master up and a command
// run over it returning — gcloud's ssh sends no keepalives, so this is what
// notices a connection gone silent, and its traffic is activity the
// workstation's idle stop sees). One found dropped — the network, the Mac
// asleep, or the workstation stopped, which ends every SSH session — is
// connected again, logged: "its connection dropped; reconnected", and "the
// workstation had stopped; started it" when connect had to. A connect that
// fails is logged with the live data's last-error message and tried again
// after a failing step's backoff (backoff.js: 30 seconds doubling to 30
// minutes). ASS-502: one whose seats are lost because it could not be
// reached or started (seat-kinds.js unreachable) is tried again so even when
// nothing needs it (retryLost) — its holder taken out of its seat, nothing
// else would connect it and clear the last-error that keeps it lost — and
// logged as back once it connects. A workstation nothing needs has its connection closed
// (workstation:disconnect) once nothing has needed it for harness.json's
// workstation-idle-disconnect-seconds (300 by default: a connect by hand, a
// setup between steps, is not cut off at once), logged, so its own idle stop
// (30 minutes with no SSH session) can happen; control never stops a
// workstation itself. ASS-481 AC4: a cloud VM of the pool (its kind
// cloud-vm) is kept so alike — its connect starts or resumes it — and its
// own idle stop (60 minutes) replaces the workstation's 30; control
// never stops one either. ASS-533: its idle check counts load as busy, so a
// Substrate cluster on it has its node stopped (substrate:stop, its state
// kept) just before the idle disconnect; setup starts it at the next connect. Whenever control exits it closes the connections it
// owns, and at its start those a control no longer running left (ASS-470,
// below: disconnectWorkstations, disconnectAtExit, closeLeftovers): its
// agents are stopped with it, and a connection left open would keep the
// workstation running.
//
// AC4. A connect that fails because the workstation's gcloud login (its
// gcloud-config's CLOUDSDK_CONFIG) needs reauthentication — the live data's
// last-error kind expired, as login.js reads gcloud's output (ASS-429: a
// network failure is offline, never counted) — sets the project's
// gcloud-requires-reauthentication (project:set-gcloud-reauthentication, as
// for the Mac's gcloud login, triggers.js) and logs the login to run
// (workstation-connection.js loginCommand: CLOUDSDK_CONFIG=… gcloud auth
// login); the TUI shows that hint. It is tried again every EXPIRED_RETRY at
// most, so the operator's login is picked up soon; once a connect works the
// flag is cleared, unless the Mac's own gcloud check (check-for-expired-
// gcloud-auth) still finds that login expired. Nothing is dispatched to the
// workstation meanwhile (workstation-connection.js workstationUsable, which
// ASS-435's placement asks).
//
// ASS-434. A connected workstation is set up (workstation:setup: what an
// agent needs installed under its home, agent.sh pointed at the forwarder on
// its loopback) after every connect — a connect may follow a restart, which
// emptied all but /home; setup notices it by the boot id and does only what
// is missing, nothing at all when nothing is — and again whenever the setup's
// version (workstation:setup --version: a hash of its script and the
// project's golden-image tools), asked at each minute's check, differs from
// the one the live data records, all before anything is dispatched to it:
// workstationUsable wants the setup ok and checked since the connection
// opened. A setup that changed something is logged with what; one that fails
// (a tool that cannot be installed, Docker not usable) is logged with what
// failed, named, and tried again after a failing step's backoff, or at once
// when the version changes (a fixed tools list, a harness update); the TUI
// shows it (frame.js headerWarnings' workstation-setup chip, from the live
// data's setup.error). Nothing is dispatched to that workstation meanwhile;
// VMs, in vm+workstation mode, carry on.
//
// ASS-435, ASS-468. After the connections, each pass tends the steps of
// the project's variations on its workstations (workstation-steps.js
// tendSteps): a step that wants one placed by its variation's seat (ASS-469)
// — its seat's workstation claimed once free and usable (workstation:claim:
// its repositories on the variation's branches), or a VM-seat holder's sent
// to the variation's VM; a step that ended given
// back (workstation:release: a completed step's leftovers committed on its
// branch, an unfinished one's discarded, committed work pushed, master at
// GitLab's latest, AC3, AC9, AC10); a holder no step of this control holds
// — one from before a restart, or ASS-435's own-folder holder, the migration
// — released. The Health of a variation whose step waits for a workstation
// says why — held by another, starting (about 80 seconds), being set up, its
// setup failed, its login to renew — written when it changes and cleared
// once it is no longer waiting (WORKSTATION_HEALTH begins it, so only
// control's own is cleared).
//
// The work runs beside the tick, one job per project at a time (a start
// takes about 80 seconds), as vm-lifecycle.js's does; memory.workstations:
// id → { job, ws: workstation id → { up (this control connected it and last
// found it so), checkedAt, failures, until, idleSince, need, setupFailures,
// setupUntil } }; the steps' leases are memory.workstationSteps (workstation-steps.js).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { backoffDelay, held } from './backoff.js';
import { requiresReauthentication } from './state.js';
import { loadWorkstations, expiredLogins, setUp, holdersOf } from './workstation-connection.js';
import { tendSteps, workstationWants, WORKSTATION_HEALTH } from './workstation-steps.js';
import { seatNeeds } from './seats.js';
import { lostWhy, unreachable, isRemoteSeat } from './seat-kinds.js';
import { USAGE_EVERY } from './remote-seats.js';
import { entriesOf } from './substrate-config.js';

const PHASE = 'workstation';
export const KIND = 'workstation';
export const CHECK_EVERY = 60_000;
export const IDLE_DISCONNECT_SECONDS = 300;
export const EXPIRED_RETRY = 2 * 60_000;

// workstationNeeds(state, project, entries, wants, seats) — Map workstation id → why
// it is needed now (see the module comment); a workstation not in it is
// needed by nothing. `entries` the live data's (its holders), `wants` the
// steps' (workstation-steps.js workstationWants), `seats` its seats'
// (ASS-469: seats.js seatNeeds).
export function workstationNeeds(state, project, entries = {}, wants = new Map(), seats = new Map()) {
  const needs = new Map([...seats, ...wants]);
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    if (v['is-deleted']) continue;
    const remote = v.vm?.kind === KIND || v.vm?.kind === 'cloud-vm';   // ASS-481: a cloud VM's alike
    const on = v.workstation?.name ?? (remote ? v.vm.name : null);
    if (!on || needs.has(on)) continue;
    const working = v.workstation?.name && state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a.variation === v.name);
    if (working) needs.set(on, `${t.key} ${v.name}'s agent works on it`);
    else if (v['vm-hold'] && remote) needs.set(v.vm.name, `${t.key} ${v.name} held running for the operator`);
  }
  for (const w of project.devEnvironments?.workstations ?? []) {
    const hs = holdersOf(entries[w.id]);   // ASS-529: several tickets' steps on one machine
    if (hs.length && !needs.has(w.id)) needs.set(w.id, `${hs.map(h => `${h.ticket} ${h.variation}`).join(', ')}'s step${hs.length > 1 ? 's' : ''} to end`);
  }
  return needs;
}

// superviseWorkstations(ctx, state) — starts, for each project listing
// workstations (whatever its mode: one switched back to vm has its
// connections closed) with no job running, its job (keep).
export function superviseWorkstations(ctx, state) {
  const jobs = (ctx.memory.workstations ??= new Map());
  for (const project of state.projects) {
    const settings = project.devEnvironments;
    if (!settings?.workstations?.length) continue;
    const r = jobs.get(project.id) ?? { job: null, ws: new Map() };
    jobs.set(project.id, r);
    const entries = loadWorkstations(join(ctx.paths.projects, project.id));
    const needs = workstationNeeds(state, project, entries, workstationWants(ctx, state, project, entries), project.engine ? seatNeeds(state, project) : new Map());
    r.job ??= keep(ctx, state, project, settings, needs, r).catch(error => ctx.log('error', `${PHASE} ${project.id}: ${error.message}`)).finally(() => { r.job = null; });
  }
}

// One project's pass over its workstations.
async function keep(ctx, state, project, settings, needs, r) {
  const id = project.id, dir = join(ctx.paths.projects, id);
  const idle = (state.harness?.['workstation-idle-disconnect-seconds'] ?? IDLE_DISCONNECT_SECONDS) * 1000;
  for (const w of settings.workstations) {
    const now = ctx.now().getTime(), need = needs.get(w.id), what = `${id} ${w.id}`;
    const s = r.ws.get(w.id) ?? { up: false, checkedAt: 0, failures: 0, until: 0, idleSince: null, need: null, setupFailures: 0, setupUntil: 0 };
    r.ws.set(w.id, s);
    if (!need) {
      s.need = null;
      const entry = loadWorkstations(dir)[w.id];
      if (unreachable(entry)) { await retryLost(ctx, project, settings, w, dir, s, what, entry, now); continue; }   // ASS-502
      if (!entry?.connected) { s.up = false; s.idleSince = null; continue; }
      s.idleSince ??= now;
      if (now - s.idleSince < idle) continue;
      await ctx.attempt(PHASE, what, async () => {
        // ASS-533: a cloud VM's own idle check counts load as busy, and a Substrate cluster on it keeps its load up: its
        // node is stopped first (state kept; workstation:setup starts it at the next connect), else the VM never stops.
        if (w.kind === 'cloud-vm' && entriesOf(project).some(e => e.machine === w.id && e.kind === 'kind')) {
          try {
            const out = String(await ctx.cli(['substrate:stop', id, w.id])).trim().split('\n').pop();
            if (JSON.parse(out).did?.length) ctx.log(PHASE, `${what}: stopped its Substrate cluster's node (its state kept) so it can stop itself when idle`);
          } catch (error) { ctx.log('error', `${PHASE} ${what}: substrate:stop failed, so it may not stop itself while its cluster runs: ${error.message}`); }
        }
        await ctx.cli(['workstation:disconnect', id, w.id]);
        ctx.log(PHASE, `${what}: disconnected: nothing on it has needed it for ${held(idle)}; it stops itself once idle${w.kind === 'cloud-vm' ? ' (a cloud VM: after 60 idle minutes; control never stops it)' : ''}`);
      });
      Object.assign(s, { up: false, idleSince: null, failures: 0, until: 0 });
      continue;
    }
    s.idleSince = null;
    if (s.up && now - s.checkedAt < CHECK_EVERY) continue;
    let dropped = false;
    if (s.up) {
      s.checkedAt = now;
      let status;
      try { status = JSON.parse(await ctx.cli(['workstation:status', id, w.id, '--connection'])); } catch (error) { ctx.log('error', `${PHASE} ${what}: workstation:status failed: ${error.message}`); continue; }
      if (status.busy) continue;
      if (status.connected) { await setup(ctx, id, w.id, dir, s, what); await measure(ctx, state, project, w, dir, s, what); continue; }
      s.up = false;
      dropped = true;
    }
    if (now < s.until) {
      if (dropped) ctx.log(PHASE, `${what}: its connection dropped (${need}); reconnecting after the backoff`);
      continue;
    }
    const before = loadWorkstations(dir)[w.id], lost = unreachable(before) ? lostWhy(before) : null;   // ASS-502 AC2
    try {
      const out = JSON.parse(await ctx.cli(['workstation:connect', id, w.id]));
      const how = `${dropped ? 'its connection dropped; reconnected' : s.failures ? 'connected again' : 'connected'}${out.started ? ` (the ${w.kind === 'cloud-vm' ? 'cloud VM' : 'workstation'} had stopped; started it)` : ''}`;
      Object.assign(s, { up: true, checkedAt: ctx.now().getTime(), failures: 0, until: 0 });
      if (dropped || out.started || s.need !== need) ctx.log(PHASE, `${what}: ${how}, the forwarder, Hindsight and zot forwarded to its loopback (${need})`);
      s.need = need;
      if (lost) back(ctx, what, lost);
      await setup(ctx, id, w.id, dir, s, what);
      await measure(ctx, state, project, w, dir, s, what);
    } catch (error) {
      connectFailed(ctx, dir, w, s, what, now, error, dropped ? 'its connection dropped and ' : '');
    }
    await gcloudFlag(ctx, project, settings, dir);
  }
  await tend(ctx, state, project, settings, dir);
}

// measure(ctx, state, project, w, dir, s, what) — ASS-529 AC1: the connected machine's memory and CPU read over its
// connection (workstation:usage, recorded on its live data for remote-seats.js) — at most every USAGE_EVERY
// (harness.json's remote-usage-interval-seconds), never every tick, and only while a ticket of the project holds a
// seat on it or a step there (with none on it, it takes one ticket whatever it reads). A reading that fails is logged
// once per outage, and the machine takes no new ticket meanwhile (remote-seats.js); one with no connection is not.
async function measure(ctx, state, project, w, dir, s, what) {
  const every = (state.harness?.['remote-usage-interval-seconds'] ?? USAGE_EVERY / 1000) * 1000, now = ctx.now().getTime();
  const on = (project.seats ?? []).some(x => isRemoteSeat(x) && x.workstation === w.id) || holdersOf(loadWorkstations(dir)[w.id]).length > 0;
  if (!on || now - (s.measuredAt ?? 0) < every) return;
  s.measuredAt = now;
  try {
    await ctx.cli(['workstation:usage', project.id, w.id]);
    if (s.usageFailed) ctx.log(PHASE, `${what}: its memory and CPU read again: it takes tickets by them again`);
    s.usageFailed = false;
  } catch (error) {
    if (error.code === 255) return;   // no connection: not measured (not a failed reading)
    if (!s.usageFailed) ctx.log('error', `${PHASE} ${what}: its memory and CPU could not be read; no new ticket on it until they can (those it holds keep running): ${loadWorkstations(dir)[w.id]?.usage?.error?.message ?? error.message}`);
    s.usageFailed = true;
  }
}

// connectFailed(ctx, dir, w, s, what, now, error, prefix) — a failed workstation:connect logged with the live data's
// last-error message, and the next try held off (s.failures, s.until): a failing step's backoff, never past
// EXPIRED_RETRY for an expired login (AC4).
function connectFailed(ctx, dir, w, s, what, now, error, prefix = '') {
  const failure = loadWorkstations(dir)[w.id]?.['last-error'];
  const wait = failure?.kind === 'expired' ? Math.min(backoffDelay(++s.failures), EXPIRED_RETRY) : backoffDelay(++s.failures);
  s.until = now + wait;
  ctx.log('error', `${PHASE} ${what}: ${prefix}workstation:connect failed (${s.failures} in a row; next try in ${held(wait)}): ${failure?.message ?? error.message}`);
}

// back(ctx, what, why) — ASS-502 AC2: a machine whose seats were lost (`why`, lostWhy's) connected again, logged.
const back = (ctx, what, why) => ctx.log(PHASE, `${what}: back: it connected again, so its seats can be taken again (they were lost: ${why})`);

// retryLost(ctx, project, settings, w, dir, s, what, entry, now) — ASS-502 AC1: a machine nothing needs whose seats
// are lost because it could not be reached or started (seat-kinds.js unreachable) has its connect tried again after
// the same backoff as a needed one's (s.failures, s.until), so it comes back by itself once the cause is gone —
// otherwise, its holder taken out of its seat and nothing needing it, nothing would ever connect it, and its
// last-error, which keeps it lost, would never clear. Connected: logged as back (AC2), set up as after any connect,
// and left to the idle rule (AC3: disconnected after workstation-idle-disconnect-seconds unless something needs it
// by then — the next tick seats a waiting holder on it as on any free seat). An expired login and a failed setup
// are not retried here (AC4).
async function retryLost(ctx, project, settings, w, dir, s, what, entry, now) {
  s.up = false;
  if (now < s.until) return;
  try {
    const out = JSON.parse(await ctx.cli(['workstation:connect', project.id, w.id]));
    Object.assign(s, { up: true, checkedAt: ctx.now().getTime(), failures: 0, until: 0, idleSince: now });
    back(ctx, what, `${lostWhy(entry)}${out.started ? `; the ${w.kind === 'cloud-vm' ? 'cloud VM' : 'workstation'} had stopped, started it` : ''}`);
    await setup(ctx, project.id, w.id, dir, s, what);
  } catch (error) {
    connectFailed(ctx, dir, w, s, what, now, error, 'its seats are lost and nothing needs it now, but ');
  }
  await gcloudFlag(ctx, project, settings, dir);
}

export { WORKSTATION_HEALTH } from './workstation-steps.js';
// ASS-480 AC5: a step waiting for its VM — made for it, or starting (workstation-steps.js readyVm: a VM-seat holder's, or
// a planning step's, which never uses a workstation, ASS-469) — says so, VM_HEALTH, never "Waiting for its workstation".
export const VM_HEALTH = 'Waiting for its VM:';
const short = (prefix, why) => `${prefix} ${why.length > 90 ? `${why.slice(0, 87)}...` : why}`;
export const healthOf = (why, kind) => (kind === 'vm'
  ? { short: short(VM_HEALTH, why), long: `${VM_HEALTH} ${why}. Its step waits, and no agent or script of it starts, until its VM is up and its repositories on its branches; control is making or starting it. Nothing for you to do.` }
  : { short: short('Waiting for its workstation:', why), long: `${WORKSTATION_HEALTH} ${why}. Its step waits, and no agent or script of it starts, until a workstation is claimed for it; control keeps working on it (connecting, starting, setting up). Only a sign-in or a failed setup needs you.` });

// tend(ctx, state, project, settings, dir, r) — ASS-468 (see the module
// comment): the steps' claims and releases (workstation-steps.js tendSteps),
// and the Health of those waiting for a workstation written or cleared.
async function tend(ctx, state, project, settings, dir) {
  const healthy = await tendSteps(ctx, project, settings, dir, (t, v, why, kind) => health(ctx, project, t, v, why, new Set(), kind));
  // Cleared from those no longer waiting on a workstation or their VM (unless written over since).
  for (const t of ctx.load().projects.find(p => p.id === project.id)?.tickets ?? []) for (const v of t.variations ?? []) {
    const long = v['ai-feedback-long'];
    if (v['is-deleted'] || healthy.has(`${t.key} ${v.name}`) || !(long?.startsWith(WORKSTATION_HEALTH) || long?.startsWith(VM_HEALTH))) continue;
    await ctx.attempt(PHASE, `${t.key} ${v.name}`, () => ctx.cli(['ticket:clear-ai-feedback', project.id, t.key, v.name, v['ai-feedback-long']]));
  }
}

// health(ctx, project, t, v, why, healthy, kind) — the variation's Health says it waits on its workstation (or, kind
// 'vm', its VM: ASS-480 AC5), and why (AC7): written when it differs.
async function health(ctx, project, t, v, why, healthy, kind) {
  healthy.add(`${t.key} ${v.name}`);
  const h = healthOf(why, kind);
  if (v['ai-feedback-long'] === h.long) return;
  await ctx.attempt(PHASE, `${t.key} ${v.name}`, () => ctx.cli(['ticket:set-ai-feedback', project.id, t.key, v.name, h.short, h.long]));
}

// setup(ctx, id, ws, dir, s, what) — ASS-434: workstation:setup run on the
// connected workstation `ws` of project `id` unless its live data has it set
// up, for the version workstation:setup --version prints now, since its
// connection opened (setUp); a failed one not again before its backoff ends
// (s.setupUntil) unless the version changed. Logs what a setup changed, or
// why it failed.
async function setup(ctx, id, ws, dir, s, what) {
  let version;
  try { version = (await ctx.cli(['workstation:setup', id, ws, '--version'])).trim(); } catch (error) { ctx.log('error', `${PHASE} ${what}: workstation:setup --version failed: ${error.message}`); return; }
  const before = loadWorkstations(dir)[ws];
  if (setUp(before, version)) return;
  if (before?.setup?.ok === false && before.setup.version === version && ctx.now().getTime() < s.setupUntil) return;
  try {
    await ctx.cli(['workstation:setup', id, ws]);
    const done = loadWorkstations(dir)[ws]?.setup;
    if (done?.did?.length || s.setupFailures) ctx.log(PHASE, `${what}: set up${s.setupFailures ? ' again' : ''}${done?.did?.length ? `: ${done.did.join('; ')}` : ''}`);
    Object.assign(s, { setupFailures: 0, setupUntil: 0 });
  } catch (error) {
    const failure = loadWorkstations(dir)[ws]?.setup?.error;
    const wait = backoffDelay(++s.setupFailures);
    s.setupUntil = ctx.now().getTime() + wait;
    ctx.log('error', `${PHASE} ${what}: workstation:setup failed (${s.setupFailures} in a row; next try in ${held(wait)}); nothing is dispatched to it until it is set up: ${failure ?? error.message}`);
  }
}

// gcloudFlag(ctx, project, settings, dir) — AC4: the project's
// gcloud-requires-reauthentication set while a workstation's login has
// expired, logged with the login to run; cleared once none has — unless the
// Mac's own gcloud check (triggers.js loginCheck) is on and has not last
// found its login live, the flag then being its to clear.
async function gcloudFlag(ctx, project, settings, dir) {
  const logins = expiredLogins(settings, loadWorkstations(dir), ctx.env.HOME);
  const flag = requiresReauthentication(dir, 'gcloud');
  if (logins.length && !flag) {
    await ctx.attempt('gcloud', project.id, async () => {
      await ctx.cli(['project:set-gcloud-reauthentication', project.id, 'true']);
      ctx.log('gcloud', `${project.id}: the gcloud login of workstation ${logins.flatMap(l => l.ids).join(', ')} has expired; nothing is dispatched to it until it connects again; run ${logins.map(l => `'${l.command}'`).join(' and ')}`);
    });
  } else if (!logins.length && flag) {
    if (project.json?.['check-for-expired-gcloud-auth'] === true && ctx.memory.gcloud?.get(project.id)?.login !== 'live') return;
    await ctx.attempt('gcloud', project.id, async () => {
      await ctx.cli(['project:set-gcloud-reauthentication', project.id, 'false']);
      ctx.log('gcloud', `${project.id}: the workstations' gcloud login is live again`);
    });
  }
}

// ASS-470 — control closes the connections it owns whenever it exits, and at
// its start those a control that is gone left. A connection's owner is the
// live data's control-pid (agent-cli/workstation.bash says how it is
// recorded): control runs every agent.sh with HARNESS_CONTROL_PID, its pid, so
// a connection its phase opened and one a command it ran opened (vm:create's,
// a step's workstation:claim) are alike its own; one opened by hand is
// nobody's (null), and one a connect run by a control found owned by another
// running control stays that control's.

// controlPid(ctx) — this control's pid as its agent.sh calls carry it; null without (a test's context).
export const controlPid = ctx => Number(ctx.env.HARNESS_CONTROL_PID) || null;

// liveControl(pid) — whether `pid` is a running control (src/control/main.js), by ps.
export function liveControl(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return !ps.error && ps.stdout.includes(join('control', 'main.js'));
}

// connections(ctx) — [{ project, id, entry }] for every workstation of the
// live data of ctx's project (or, for a control of every project, of each
// project folder); a project whose live data cannot be read is logged and
// passed over, its ids in `unread`.
function connections(ctx, unread = []) {
  let projects = [ctx.project];
  if (!ctx.project) try { projects = readdirSync(ctx.paths.projects); } catch (error) { ctx.log('error', `${PHASE}: the projects folder could not be read: ${error.message}`); return []; }
  const found = [];
  for (const project of projects) {
    let entries;
    try { entries = loadWorkstations(join(ctx.paths.projects, project)); } catch (error) { ctx.log('error', `${PHASE} ${project}: its workstations.json could not be read: ${error.message}`); unread.push(project); continue; }
    for (const [id, entry] of Object.entries(entries ?? {})) found.push({ project, id, entry });
  }
  return found;
}

// owned(ctx) — the connections this control owns: the live data's, and,
// for a project whose live data could not be read, those its phase connected
// and last found up (memory.workstations), so an exit for unreadable data
// still closes them.
function owned(ctx) {
  const me = controlPid(ctx), unread = [];
  const mine = me ? connections(ctx, unread).filter(c => c.entry['control-pid'] === me) : [];
  for (const project of unread) for (const [id, s] of ctx.memory.workstations?.get(project)?.ws ?? []) if (s.up) mine.push({ project, id });
  return mine.filter(c => !ctx.memory.closing?.has(`${c.project} ${c.id}`));
}

// closing(ctx, project, id, stdio) — workstation:disconnect started in a
// session of its own (detached), so neither control's exit nor the
// supervisor's SIGKILL of control's process group stops it half way: one
// waiting on the workstation's lock (a connect under way) closes the
// connection once that connect ends. Returns the child.
function closing(ctx, project, id, stdio) {
  (ctx.memory.closing ??= new Set()).add(`${project} ${id}`);
  const child = spawn(join(ctx.root, 'agent.sh'), ['workstation:disconnect', project, id], { env: ctx.env, detached: true, stdio });
  child.on('error', () => {});
  child.unref();
  return child;
}

// disconnectWorkstations(ctx, waitMs) — control's shutdown: every connection
// this control owns closed (workstation:disconnect, see closing), each
// logged; those still closing after `waitMs` (one waiting for a connect's
// lock) are logged as closing after control exits, and left to it. Never
// waits for the workstation job: one mid-way through a step's claim or
// release could outlast the supervisor's patience (its 20 seconds), and its
// SIGKILL would then leave the connection open (ASS-470).
export async function disconnectWorkstations(ctx, waitMs = 10_000) {
  const runs = owned(ctx).map(({ project, id }) => new Promise(resolve => {
    const what = `${project} ${id}`, child = closing(ctx, project, id, ['ignore', 'ignore', 'pipe']);
    ctx.log('cli', `agent.sh workstation:disconnect ${project} ${id}`);
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.stderr?.destroy(); ctx.log(PHASE, `${what}: still closing its connection (it waits for a connect under way) as control exits; it closes once that ends`); resolve(); }, waitMs);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) ctx.log(PHASE, `${what}: disconnected as control exits`);
      else ctx.log('error', `${PHASE} ${what}: workstation:disconnect failed as control exits: ${stderr.trim().replace(/\n/g, ' | ') || `exit ${code}`}`);
      resolve();
    });
  }));
  await Promise.all(runs);
}

// disconnectAtExit(ctx) — the last resort, synchronous, for process 'exit'
// (an exit no shutdown ran before, or one that cut it short): each
// connection this control still owns has its workstation:disconnect started,
// detached, to carry on once control has gone.
export function disconnectAtExit(ctx) {
  for (const { project, id } of owned(ctx)) closing(ctx, project, id, 'ignore');
}

// closeLeftovers(ctx, isControl) — control's start, before its first tick
// decides which workstations it needs: each connection of its projects owned
// by a control that is not running (a crash's, a kill -9's: control-pid
// naming no live control) closed, logged. A hand-opened one (no
// control-pid), and one another running control owns, are left alone.
export async function closeLeftovers(ctx, isControl = liveControl) {
  const me = controlPid(ctx);
  for (const { project, id, entry } of connections(ctx)) {
    const owner = entry['control-pid'];
    if (owner == null || owner === me || isControl(owner)) continue;
    await ctx.attempt(PHASE, `${project} ${id}`, async () => {
      await ctx.cli(['workstation:disconnect', project, id]);
      ctx.log(PHASE, `${project} ${id}: closed the connection control ${owner} left (it is no longer running)`);
    });
  }
}
