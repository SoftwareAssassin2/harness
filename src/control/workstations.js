// Phase 3, beside the VMs: each project's GCP workstations' one SSH
// connection (ASS-433), kept up by control while anything on a workstation
// needs it and closed once nothing does. A connection is opened, checked and
// closed by the workstation:* commands (agent-cli/workstation.bash says how:
// the workstation started when it is stopped, one OpenSSH master through
// gcloud workstations ssh, the forwarder, Hindsight and zot reverse-forwarded
// to its loopback), and each writes the workstation's live data,
// data/projects/<p>/workstations.json (workstation-connection.js).
//
// AC3. A workstation is needed (workstationNeeds) while an agent of a ticket
// variation that holds it — its `vm` { kind: workstation, name: <id> }, as
// ASS-435 records a placement — is at work (an assignment on the variation),
// or that variation is at a step that runs its machine (`vm: running`,
// vm-lifecycle.js vmUse) and not held (paused, worked by hand), or the
// operator holds it running (vm:hold, ASS-427). While needed: connected
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
// minutes). A workstation nothing needs has its connection closed
// (workstation:disconnect) once nothing has needed it for harness.json's
// workstation-idle-disconnect-seconds (300 by default: a connect by hand, a
// setup between steps, is not cut off at once), logged, so its own idle stop
// (30 minutes with no SSH session) can happen; control never stops a
// workstation itself. Control's shutdown closes the connections it opened
// (disconnectWorkstations): its agents are stopped with it, and a connection
// left open would keep the workstation running.
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
// ASS-435. A workstation is needed, too, while a variation of the project
// with no machine yet is at a step that runs one (and not held), for the
// first workstation free for it — so it is connected and set up before
// vm:create places the variation (vm+workstation: workstations first) — and
// while its holder gives it up, so its folder can be removed. After the
// connections, each pass tends the variations on the project's workstations
// (tend): a holder that gives its workstation up (Done, set aside, gone from
// the sprint, at a `vm: released` step: workstation-machines.js givesUp) and
// has no assignment on it is released (workstation:release: its folder,
// containers, ticket copy and credentials removed, the workstation free for
// the next, AC6), logged; a variation that needs its machine running, on a
// usable workstation that is free or its own, whose machine is not up —
// its folder released (it came back from QA), or the workstation restarted
// since vm:start readied it, which emptied the runtime folder — is readied
// again (vm:create: claimed, its folder made again when it is gone, vm:start),
// logged, never while it is at its own Create VM step (that step does it);
// and one up and idle whose credentials changed — another kind declared, or
// a keychain item saved again since (credential-kind and credential-stamps
// on its holder, as a VM's vms.json row has them: ASS-215, ASS-350) — has
// them refreshed (vm:start), logged; each failure backed off as a VM's is.
// The Health of a variation that waits on its workstation (AC7) says why —
// not connected, its login to renew (with the command), its setup failed,
// held by another, being readied — written when it changes and cleared once
// it is up; that of an unplaced variation of a project in workstation mode
// with none free says so (WORKSTATION_HEALTH begins both, so only control's
// own is cleared).
//
// The work runs beside the tick, one job per project at a time (a start
// takes about 80 seconds), as vm-lifecycle.js's does; memory.workstations:
// id → { job, ws: workstation id → { up (this control connected it and last
// found it so), checkedAt, failures, until, idleSince, need, setupFailures,
// setupUntil, readyFailures, readyUntil } }.
import { join } from 'node:path';
import { isHeld } from './engine.js';
import { vmUse } from './vm-lifecycle.js';
import { backoffDelay, held } from './backoff.js';
import { requiresReauthentication } from './state.js';
import { loadWorkstations, expiredLogins, setUp, workstationUsable } from './workstation-connection.js';
import { stampsOf, changedKeys, CREDENTIAL_STAMP_INTERVAL, makesMachine } from './vm-lifecycle.js';
import { statusOf } from './engine.js';
import { declaredCredentials } from './vm-credentials.js';
import { busy, givesUp, inFlight, holds, machineUp, whyDown, placementWait } from './workstation-machines.js';

const PHASE = 'workstation';
export const KIND = 'workstation';
export const CHECK_EVERY = 60_000;
export const IDLE_DISCONNECT_SECONDS = 300;
export const EXPIRED_RETRY = 2 * 60_000;

// workstationNeeds(state, project, entries) — Map workstation id → why it is needed
// now (see the module comment); a workstation not in it is needed by nothing.
// `entries` the live data's (ASS-435: holders giving theirs up, and the
// workstations free for a variation still to be placed).
export function workstationNeeds(state, project, entries = {}) {
  const needs = new Map(), unplaced = [];
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    if (v['is-deleted']) continue;
    const at = v['harness-status']?.state;
    if (!v.vm?.name) {
      if (project.devEnvironments?.mode !== 'vm' && !isHeld(t, v) && vmUse(project.engines ?? state.engines, project.engineName, v) === 'running') unplaced.push(`${t.key} ${v.name} at ${at} waits to be placed`);
      continue;
    }
    if (v.vm?.kind !== KIND) continue;
    const working = state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a.variation === v.name);
    if (working) needs.set(v.vm.name, `${t.key} ${v.name}'s agent works on it`);
    else if (v['vm-hold']) needs.set(v.vm.name, `${t.key} ${v.name} held running for the operator`);
    else if (!isHeld(t, v) && vmUse(project.engines ?? state.engines, project.engineName, v) === 'running') needs.set(v.vm.name, `${t.key} ${v.name} at ${at}`);
  }
  for (const w of project.devEnvironments?.workstations ?? []) {
    const h = entries[w.id]?.holder;
    if (h && !needs.has(w.id) && givesUp(state, project, h.ticket, h.variation)) needs.set(w.id, `${h.ticket} ${h.variation}'s folder to remove`);
  }
  for (const w of project.devEnvironments?.workstations ?? []) {
    if (!unplaced.length) break;
    const h = entries[w.id]?.holder;
    if (needs.has(w.id) || (h && inFlight(state, project, h.ticket, h.variation))) continue;
    needs.set(w.id, unplaced.shift());
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
    const needs = workstationNeeds(state, project, loadWorkstations(join(ctx.paths.projects, project.id)));
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
      if (!loadWorkstations(dir)[w.id]?.connected) { s.up = false; s.idleSince = null; continue; }
      s.idleSince ??= now;
      if (now - s.idleSince < idle) continue;
      await ctx.attempt(PHASE, what, async () => {
        await ctx.cli(['workstation:disconnect', id, w.id]);
        ctx.log(PHASE, `${what}: disconnected: nothing on it has needed it for ${held(idle)}; it stops itself once idle`);
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
      if (status.connected) { await setup(ctx, id, w.id, dir, s, what); continue; }
      s.up = false;
      dropped = true;
    }
    if (now < s.until) {
      if (dropped) ctx.log(PHASE, `${what}: its connection dropped (${need}); reconnecting after the backoff`);
      continue;
    }
    try {
      const out = JSON.parse(await ctx.cli(['workstation:connect', id, w.id]));
      const how = `${dropped ? 'its connection dropped; reconnected' : s.failures ? 'connected again' : 'connected'}${out.started ? ' (the workstation had stopped; started it)' : ''}`;
      Object.assign(s, { up: true, checkedAt: ctx.now().getTime(), failures: 0, until: 0 });
      if (dropped || out.started || s.need !== need) ctx.log(PHASE, `${what}: ${how}, the forwarder, Hindsight and zot forwarded to its loopback (${need})`);
      s.need = need;
      await setup(ctx, id, w.id, dir, s, what);
    } catch (error) {
      const failure = loadWorkstations(dir)[w.id]?.['last-error'];
      const wait = failure?.kind === 'expired' ? Math.min(backoffDelay(++s.failures), EXPIRED_RETRY) : backoffDelay(++s.failures);
      s.until = now + wait;
      ctx.log('error', `${PHASE} ${what}: ${dropped ? 'its connection dropped and ' : ''}workstation:connect failed (${s.failures} in a row; next try in ${held(wait)}): ${failure?.message ?? error.message}`);
    }
    await gcloudFlag(ctx, project, settings, dir);
  }
  await tend(ctx, state, project, settings, dir, r);
}

// WORKSTATION_HEALTH — what every long Health tend writes begins with, so it knows its own to clear.
export const WORKSTATION_HEALTH = 'Waiting for its workstation:';
const healthOf = why => ({ short: `Waiting for its workstation: ${why.length > 90 ? `${why.slice(0, 87)}...` : why}`, long: `${WORKSTATION_HEALTH} ${why}. Its steps that need it wait, and no agent is sent to it, until it is up again; control keeps working on it (connecting, setting up, readying its folder). Only a sign-in or a failed setup needs you.` });

// tend(ctx, state, project, settings, dir, r) — ASS-435 (see the module
// comment): holders released, machines readied again or refreshed, and the
// Health of those waiting on a workstation written or cleared.
async function tend(ctx, state, project, settings, dir, r) {
  const id = project.id;
  let entries = loadWorkstations(dir);
  for (const w of settings.workstations) {
    const h = entries[w.id]?.holder, why = h && givesUp(state, project, h.ticket, h.variation);
    if (!why || !entries[w.id]?.connected) continue;
    await ctx.attempt(PHASE, `${id} ${w.id}`, async () => {
      await ctx.cli(['workstation:release', id, w.id]);
      ctx.log(PHASE, `${id} ${w.id}: released (${h.ticket} ${h.variation} ${why}): its folder removed; free for the next variation`);
    });
  }
  entries = loadWorkstations(dir);
  const healthy = new Set();
  const declared = declaredCredentials(ctx.env, id), kindNow = declared?.anthropic && declared?.claude ? 'both' : declared?.anthropic ? 'anthropic' : declared?.claude ? 'claude' : null;
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    if (v['is-deleted']) continue;
    const who = `${t.key} ${v.name}`, use = vmUse(project.engines ?? state.engines, project.engineName, v);
    if (!v.vm?.name) {
      const wait = placementWait(ctx, state, project, v);
      if (wait) await health(ctx, project, t, v, wait, healthy);
      continue;
    }
    if (v.vm.kind !== KIND || isHeld(t, v) || use !== 'running') continue;
    const ws = v.vm.name, e = entries[ws], s = r.ws.get(ws);
    if (!e || !workstationUsable(e) || (e.holder && !holds(e, t.key, v.name) && inFlight(state, project, e.holder.ticket, e.holder.variation))) {
      await health(ctx, project, t, v, whyDown(settings, ws, e, t.key, v.name, ctx.env.HOME), healthy);
      continue;
    }
    const at = statusOf(project.engines ?? state.engines, project.engineName, v);
    const working = busy(state, id, t.key, v.name), now = ctx.now().getTime();
    let args = null, did;
    if (!machineUp(e, t.key, v.name)) {
      if (!makesMachine(at.detailStep)) [args, did] = [['vm:create', id, t.key, v.name], `readied again (${who} at ${at.detail}; ${whyDown(settings, ws, e, t.key, v.name, ctx.env.HOME)})`];
    } else if (!working && kindNow && e.holder['credential-kind'] !== kindNow) {
      [args, did] = [['vm:start', id, t.key, v.name], `credentials refreshed (${who} at ${at.detail}; ${e.holder['credential-kind'] ?? 'no recorded kind'} → ${kindNow})`];
    } else if (!working && Object.keys(e.holder['credential-stamps'] ?? {}).length) {
      const changed = changedKeys(e.holder['credential-stamps'], await stampsOf(ctx, id, (state.harness?.['credential-stamp-interval-seconds'] ?? CREDENTIAL_STAMP_INTERVAL) * 1000));
      if (changed.length) [args, did] = [['vm:start', id, t.key, v.name], `credentials refreshed (${who} at ${at.detail}; ${changed.join(', ')} key${changed.length > 1 ? 's' : ''} changed)`];
    }
    if (!machineUp(e, t.key, v.name) && !makesMachine(at.detailStep)) await health(ctx, project, t, v, whyDown(settings, ws, e, t.key, v.name, ctx.env.HOME), healthy);
    if (!args || !s || now < (s.readyUntil ?? 0)) continue;
    try {
      await ctx.cli(args);
      Object.assign(s, { readyFailures: 0, readyUntil: 0 });
      ctx.log(PHASE, `${id} ${ws}: ${did}`);
      healthy.delete(`${t.key} ${v.name}`);
    } catch (error) {
      s.readyFailures = (s.readyFailures ?? 0) + 1;
      const wait = backoffDelay(s.readyFailures);
      s.readyUntil = now + wait;
      ctx.log('error', `${PHASE} ${id} ${ws}: ${args.join(' ')} failed (${s.readyFailures} in a row; next try in ${held(wait)}): ${error.message}`);
    }
  }
  // Cleared from those no longer waiting on a workstation (unless written over since).
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    if (v['is-deleted'] || healthy.has(`${t.key} ${v.name}`) || !v['ai-feedback-long']?.startsWith(WORKSTATION_HEALTH)) continue;
    await ctx.attempt(PHASE, `${t.key} ${v.name}`, () => ctx.cli(['ticket:clear-ai-feedback', id, t.key, v.name, v['ai-feedback-long']]));
  }
}

// health(ctx, project, t, v, why, healthy) — the variation's Health says it waits on its workstation, and why (AC7): written when it differs.
async function health(ctx, project, t, v, why, healthy) {
  healthy.add(`${t.key} ${v.name}`);
  const h = healthOf(why);
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

// disconnectWorkstations(ctx) — control's shutdown: each connection this
// control opened and last found up closed (workstation:disconnect), logged;
// a running job's connect waited for first.
export async function disconnectWorkstations(ctx) {
  for (const [id, r] of ctx.memory.workstations ?? []) {
    await r.job;
    for (const [ws, s] of r.ws) {
      if (!s.up) continue;
      await ctx.attempt(PHASE, `${id} ${ws}`, async () => {
        await ctx.cli(['workstation:disconnect', id, ws]);
        s.up = false;
        ctx.log(PHASE, `${id} ${ws}: disconnected as control exits`);
      });
    }
  }
}
