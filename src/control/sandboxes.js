// ASS-535: control's side of Substrate sandboxes (the machine kind: machine-substrate.js). A ticket variation whose
// step runs on a substrate run target (run-targets.js: local-substrate, workstation-substrate, cloud-vm-substrate —
// planned and seated as any target, plan.js and seat-kinds.js: a Mac seat for local-substrate, a seat of the
// workstation or cloud VM for the others) runs it in its own sandbox on the cluster of its seat's machine: the Mac's
// cluster for local-substrate, the seat's workstation's or cloud VM's for the others (sandboxHost).
//
// - Made before its step starts (sandboxWaits, asked by steps.js and dispatch.js where its script or agent would
//   start, beside workstation-steps.js stepWaits): a step whose work runs on its machine (machineWork) waits until
//   its sandbox is up on that machine — the variation's `sandbox` recorded there and running, and seen up by this
//   control (a restarted control brings each up once more: substrate:sandbox-up is idempotent and quick for one that
//   runs). Meanwhile its bring-up runs beside the tick, one per variation (substrate:sandbox-up <host>), logged; one
//   that fails is logged and tried again after a failing step's backoff (backoff.js), the step waiting meanwhile —
//   ASS-537 AC4: counted as a failure of the step itself (its backoff key, `held`, from the caller), so a sandbox that
//   cannot be made or resumed BLOCK_AFTER times in a row sends its ticket to Blocked (steps.js blockFailing), as any
//   step failing that often does. A
//   variation whose sandbox is on another machine (its seat moved: a remote machine lost, a workstation seat for a
//   cloud VM's) has its work moved out first (substrate:sandbox-delete --keep-work: its branches pushed through the
//   Mac), then a sandbox made on the new one (which brings them in).
// - ASS-542: right after it is up, the project's app stack in it (substrate:stack-up: every declared service and
//   init job in dependency order, the host map, the local CA, the app at its real URL, the seeded user signed in;
//   a resumed sandbox kept its processes, so then only the app and the session are checked), told what sandbox-up
//   did (made, resumed) and how long it took, which stack-up records as the ticket's time to first start and to
//   resume. A stack that fails (stack-up exits 3: a service or job, its log in the ticket's folder) sends the ticket
//   to Blocked — Blocked for Human when at Blocked already — its health naming the service and its log, once; the
//   sandbox itself counts as up meanwhile, so Blocked's troubleshooting runs in it, and the stack is tried again once
//   the ticket has left Blocked. A project with no stack declared: stack-up does nothing.
// - Before each agent or in-machine script there, the ticket folder's read-only copy, /mnt/ticket, is brought up to
//   date (syncSandboxTicket: substrate:sandbox-sync-ticket), as a workstation's is (ASS-435).
// - Its branch moves with it (run-target-places.js readyTarget: code:hand-over moves the variation's branches between
//   a sandbox and any other target, through the Mac — relay.bash — as a sandbox has no forge credentials).
// - superviseSandboxes (a tick phase, its work beside the tick, one job per project): a sandbox whose variation no
//   longer runs on a substrate target — it holds another seat, or none (a gate, a human step, a wait: ASS-527) — is
//   stopped (hibernated: suspended, its files and processes kept, no memory, CPU or seat) once no agent or in-machine
//   script of it runs; one whose ticket is done, or whose variation is set aside, is deleted. Each logged once; a
//   failure logged and tried again after the backoff.
// - ASS-539 AC2: the variations whose sandbox could not be made or resumed, written each tick (recordSandboxFailures,
//   at the end of superviseSandboxes) to data/projects/<p>/sandbox-failures.json for the dashboard's header warning
//   "Sandbox <actor> setup failed" (src/tui/screens/frame.js), which runs apart from control and only reads files:
//   { failures: [{ key, variation, sandbox, machine, what ('made' | 'resumed'), failures, error, since,
//   next-try-at }] } — only those still waiting for it (on a substrate target, not set aside); removed when none, and
//   a variation's entry gone at its next bring-up that works. Written atomically, only when it changes (seat-queue.js's
//   way).
// - ASS-568: a crashed sandbox is replaced, not counted. After Docker Desktop restarts on the Mac (or a remote machine's
//   cluster node restarts), every sandbox that was on that cluster comes back crashed (Substrate's ACTOR_STATE_CRASHED:
//   its worker restarted or went away; a hibernated one whose snapshot was lost crashes the same way), and no resume
//   can bring it back. substrate:sandbox-up says so with exit 4 (or a "has crashed (…)" from the machine layer); then,
//   in the same job (replaceCrashed): (1) its work saved as far as it can be, never blocking the rest —
//   substrate:sandbox-delete --salvage pushes its branches through the Mac only while its command server still
//   answers; (2) it deleted, its forwarder token revoked and its record removed (the same command); (3) nothing more
//   now: the step's next try (the next tick) finds no sandbox and makes a fresh one from the branches on the forge,
//   its app stack brought up as for any new sandbox; (4) the operator told: logged once per sandbox ("sandbox <KEY>
//   <var>: its sandbox on <machine> had crashed (<state>); replaced. Lost: <what>", lostWork: from the variation's
//   commits record, ASS-558, and its step), an entry in its change log (work:append change-log.md) and a notice on
//   the ticket screen's Health (ticket:add-ai-notice, source "sandbox"); (5) not counted against Blocked: no failure
//   of the step is counted for it, so a ticket two failed resumes into its 3 is not sent to Blocked by a crash. If the
//   new sandbox cannot be made, those failures count as usual (BLOCK_AFTER in a row, Blocked). One guard against a
//   loop: a sandbox that crashes again before any bring-up worked since its last replacement is replaced again, and
//   that time counted. A sandbox recorded running whose cluster's check (substrate.json's sandbox-use, measured after
//   it was last seen up) finds it crashed is not taken as up (sandboxUp), so the next step that needs it goes the same
//   way. After a cluster or node restart every crashed sandbox there is handled so, each when its ticket next needs it.
//
// ASS-537: hibernation when a ticket gives up its seat, and resumption when it gets one. Operator decisions (ASS-532's
// spike, 2026-11-22):
// - Never mid-turn. Suspending resets every connection in the sandbox: an agent's model call in flight would be wasted
//   and paid again, a forwarder (agent.sh) call in flight cut half-done. So a sandbox is hibernated only once no agent
//   and no in-machine script of its variation runs (variationBusy) — an agent whose seat went (a gate reached in its turn's
//   last move) finishes its turn first; nothing is cut off.
// - Hibernated, not deleted: its files, processes (an app stack it started, ASS-542) and memory are kept in its
//   snapshot; its forwarder token's binding and its egress rule sets stay (only substrate:sandbox-delete revokes and
//   removes them, ASS-536); its record says state stopped.
// - Resumed before its step starts, where it is: when the variation is seated again at a step that works on its
//   machine, sandboxWaits brings it up (substrate:sandbox-up resumes it: Substrate restores it as it was, ~1 s on the
//   Mac) before the step's agent or script starts — the step waits meanwhile, as for a sandbox being made. Nothing is
//   moved: no step is re-run and no visit spent (the variation stays at the step it was seated at; only its start
//   waits). A resume that fails is a failure of that step (above): logged, tried again with backoff, Blocked after
//   BLOCK_AFTER in a row.
// - Kept hibernated: a sandbox something resumed meanwhile (the machine layer resumes a sandbox it runs a command in:
//   a branch handed over, a step's end) while its variation holds no substrate seat is seen running by its cluster's
//   check (substrate.json's sandbox-use, measured after its record was written) and hibernated again, once nothing of
//   it runs.
// - The budget (seat-budget.js, remote-seats.js): a hibernated sandbox uses no memory or CPU; the warm workers'
//   memory requests and the snapshots' disk are counted (substrate-config.js warmPool, snapshotDisk).
// - Its seat: the host's, as for any target (AC3): the Mac's budget (seat-budget.js counts a sandbox's measured use,
//   substrate-config.js), a remote machine's own limits (remote-seats.js). A hibernated sandbox holds none.
import { runsInVm } from './vm.js';
import { claimsWorkstation, machineScriptRunning, scriptPlace } from './machine-steps.js';
import { seatOf, targetOf, onSubstrateTarget } from './seat-kinds.js';
import { isDoneStep, isManual, stepOf } from './engine.js';
import { moveTicket } from './moves.js';
import { sandboxUse, SANDBOX_FAILURES_FILE } from './substrate-config.js';
import { sandboxActor } from './machine-substrate.js';
import { runTargetOf } from './machine.js';
import { backoffDelay, held as heldFor, failed, BLOCK_AFTER } from './backoff.js';
import { COMMITS_FILE } from './ticket-commits.js';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PHASE = 'sandbox';
const keyOf = (projectId, key, name) => `${projectId}/${String(key).toUpperCase()}/${name}`;
const memoryOf = ctx => (ctx.memory.sandboxes ??= new Map());

// machineWork(step) — the step's work runs on its variation's machine (workstation-steps.js's rule), or (ASS-551) it is a
// script step whose command works there from the host (machine-steps.js scriptPlace 'machine': through the machine
// layer, as Setup's Create VM and Mark Setup Complete and Blocked's Add the Missing Repository do). Those need the
// sandbox there too: a new ticket's first machine step on a substrate target is Setup's, and code:hand-over (run before
// any script, run-target-places.js readyTarget) fails onto a substrate target with no sandbox yet.
export const machineWork = step => runsInVm(step) || claimsWorkstation(step) || (step?.action?.type === 'script' && scriptPlace(step.action.command) === 'machine');

// sandboxHost(project, key, variation) — the machine whose cluster the variation's sandbox is to be on now: 'mac' for
// local-substrate, its seat's workstation or cloud VM for the others; null when it holds no substrate target.
export function sandboxHost(project, key, variation) {
  const target = targetOf(project, key, variation);
  if (target === 'local-substrate') return 'mac';
  if (target === 'workstation-substrate' || target === 'cloud-vm-substrate') return seatOf(project?.seats ?? [], key, variation)?.workstation ?? null;
  return null;
}

// sandboxUp(ctx, project, ticket, variation) — its sandbox is up where its seat is (see the module comment).
export function sandboxUp(ctx, project, ticket, variation) {
  const host = sandboxHost(project, ticket.key, variation.name), s = variation.sandbox;
  const r = memoryOf(ctx).get(keyOf(project.id, ticket.key, variation.name));
  // ASS-567: never while superviseSandboxes is stopping (or deleting) it: a step started then finds it suspended.
  if (r?.stopping) return false;
  // ASS-542: a stack that failed is tried again once the ticket has left Blocked (its fix may have landed).
  if (r?.stackFailed && !BLOCKED.includes(variation['harness-status']?.state)) return false;
  // ASS-568: crashed under it since this control saw it up (a Docker or node restart): brought up again, so replaced.
  if (r?.up === host && crashedSince(project, s, r.upAt ?? 0)) return false;
  return Boolean(host && s?.machine === host && s.state === 'running' && r?.up === host);
}

// crashedSince(project, s, at) — ASS-568: its cluster's check, taken after `at` (ms), measured the sandbox (`s` its
// record) crashed.
function crashedSince(project, s, at) {
  const live = project.substrate?.[s?.machine];
  return Date.parse(live?.['checked-at'] ?? '') > at && sandboxUse(live).some(u => u.actor === s.name && u.state === 'crashed');
}

// isCrash(error) — ASS-568: substrate:sandbox-up's exit 4, or the machine layer's word that the actor has crashed
// (on-machine substrate.sh's "has crashed (…)", Substrate's ACTOR_STATE_CRASHED / "is CRASHED").
export const isCrash = error => error?.code === 4 || /ACTOR_STATE_CRASHED|\bis CRASHED\b|has crashed \(/.test(String(error?.message ?? ''));

// crashState(message) — what it crashed as: "crashed", or "crashed: <Substrate's reason>" when the message says it.
function crashState(message) {
  const m = /has crashed \((crashed[^)]*)\)/.exec(String(message ?? ''));
  return m ? m[1] : 'crashed';
}

// lostWork(ctx, project, ticket, variation, deleted) — ASS-568: what the crashed sandbox's replacement lost, in words —
// nothing when --salvage pushed its branches (`deleted`, substrate:sandbox-delete's JSON); else judged from the
// variation's commits record (ASS-558, read from its work folder: the Mac's clones and the forge, never the machine):
// its commits not on the forge (local only), and whatever it had committed after its last commit on the forge, or
// left uncommitted, in its step.
export function lostWork(ctx, project, ticket, variation, deleted) {
  const step = variation['harness-status']?.state;
  if (deleted?.salvaged) {
    const b = (deleted.branches ?? []).map(x => `${x.repo} on ${x.branch}`).join(', ');
    return `nothing: its branches were pushed through the Mac first${b ? ` (${b})` : ''}`;
  }
  let list = null;
  try {
    if (ctx.paths?.projects) list = JSON.parse(readFileSync(join(ctx.paths.projects, project.id, 'work', String(ticket.key).toUpperCase(), COMMITS_FILE(variation.name)), 'utf8'));
  } catch { list = null; }
  const commits = Array.isArray(list?.commits) ? list.commits : null;
  const short = c => c.short ?? String(c.sha ?? '').slice(0, 8);
  const parts = [];
  const local = (commits ?? []).filter(c => c.state === 'local');
  if (local.length) parts.push(`${local.length} commit${local.length === 1 ? '' : 's'} not on the forge (${local.slice(0, 5).map(c => `${short(c)} ${c.subject ?? ''}`.trim()).join('; ')}${local.length > 5 ? '; …' : ''})`);
  const forge = (commits ?? []).filter(c => c.state && c.state !== 'local').sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''));
  const inStep = step ? ` in ${step}` : '';
  if (!commits) parts.push(`not known (no commits record yet): whatever it had committed and not pushed, or left uncommitted${inStep}`);
  else if (forge.length) parts.push(`whatever it had committed after ${short(forge[0])} "${forge[0].subject ?? ''}" (${String(forge[0].date ?? '?').replace('T', ' ').slice(0, 16)} UTC), the variation's last commit on the forge, or left uncommitted${inStep}`);
  else parts.push(`whatever it had committed (none of the variation's commits is on the forge yet), or left uncommitted${inStep}`);
  return `${parts.join('; ')}${deleted?.salvage ? ` — ${deleted.salvage}` : ''}`;
}

// replaceCrashed(ctx, project, ticket, variation, r, error) — ASS-568 (see the module comment): the crashed sandbox
// saved as far as it can be and deleted, the operator told; its next bring-up (the step's next try) makes a new one.
// Throws (a failure of the step, counted as usual) when it cannot be deleted, or when it crashed again before any
// bring-up worked since its last replacement.
async function replaceCrashed(ctx, project, ticket, variation, r, error) {
  const s = variation.sandbox ?? {}, name = s.name ?? sandboxActor(ticket.key, variation.name);
  const machine = s.machine ?? sandboxHost(project, ticket.key, variation.name) ?? '?';
  const where = machine === 'mac' ? 'the Mac' : machine, state = crashState(error.message), again = r.replaced;
  let deleted;
  try {
    deleted = JSON.parse(String(await ctx.cli(['substrate:sandbox-delete', project.id, ticket.key, variation.name, '--salvage'])).trim().split('\n').pop() || 'null');
  } catch (e) {
    throw new Error(`its sandbox ${name} on ${where} had crashed (${state}) and could not be deleted to be replaced: ${e.message}`);
  }
  r.up = null; r.until = 0; r.trouble = null; r.replaced = true;
  const lost = lostWork(ctx, project, ticket, variation, deleted);
  const once = `${machine}/${name}/${s['created-at'] ?? s.at ?? ''}`;
  if (r.crashSaid !== once) {
    r.crashSaid = once;
    ctx.log(PHASE, `${ticket.key} ${variation.name}: its sandbox on ${where} had crashed (${state}); replaced. Lost: ${lost}`);
    const long = `Its Substrate sandbox ${name} on ${where} had crashed (${state}) — a Docker or cluster node restart, or a lost snapshot — and could not be resumed. Control deleted it (its forwarder token revoked) and makes a new one at the step's next try, from the variation's branches on the forge, its app stack brought up as for any new sandbox; the crash is not counted against Blocked. Lost: ${lost}.`;
    const at = ctx.now().toISOString().replace(/\.\d+Z$/, 'Z');
    const dir = mkdtempSync(join(tmpdir(), 'harness-sandbox-crash-')), file = join(dir, 'entry.md');
    try {
      writeFileSync(file, `### ${at} Sandbox replaced\n${long}\n`);
      await ctx.cli(['work:append', project.id, ticket.key, variation.name, 'change-log.md', file]);
    } catch (e) { ctx.log('error', `${PHASE} ${ticket.key} ${variation.name}: the replacement could not be written to its change log: ${e.message}`); }
    finally { rmSync(dir, { recursive: true, force: true }); }
    try {
      await ctx.cli(['ticket:add-ai-notice', project.id, ticket.key, variation.name, 'sandbox', `Its sandbox had crashed (${state}); replaced`.slice(0, 120), long]);
    } catch (e) { ctx.log('error', `${PHASE} ${ticket.key} ${variation.name}: the replacement could not be noted on the ticket: ${e.message}`); }
  }
  if (again) throw new Error(`its sandbox ${name} crashed again before any bring-up worked since it was last replaced (${state}); it was replaced again, and this time the failure counts`);
}
const BLOCKED = ['blocked', 'blocked-for-human'];

// stackFailed(ctx, project, ticket, variation, error) — ASS-542: the variation's app stack failed in its sandbox
// (substrate:stack-up's exit 3, its reason on stderr): the ticket to Blocked, or Blocked for Human when at Blocked
// already, as vm-lifecycle.js neverUp sends one whose VM never came up — not a backlog's, nor one worked by hand —
// its health the reason (the service or job and its log in the ticket's folder).
async function stackFailed(ctx, project, ticket, variation, error) {
  const text = String(error.message).split('\n')[0], cut = text.lastIndexOf('substrate:stack-up: ');
  const why = cut >= 0 ? text.slice(cut + 'substrate:stack-up: '.length) : text;
  const from = variation['harness-status']?.state, to = from === 'blocked' ? 'blocked-for-human' : 'blocked';
  ctx.log('error', `${PHASE} ${ticket.key} ${variation.name}: ${why}`);
  if (!project.engine || isManual(ticket) || from === 'blocked-for-human' || !stepOf(project.engine, to)) return;
  const short = why.slice(0, 400);
  const long = `${short}. Control brings a ticket's Substrate sandbox up before a step runs there, and then the project's whole app stack in it (substrate:stack-up, ASS-542): each declared service and init job (data/projects/${project.id}/sandbox/services.yaml) in dependency order. One failed, so the ticket's work cannot run against it. Every service's and job's log is in the ticket's folder, sandbox-stack-${variation.name}/logs, with stack.json; the stack is tried again once the ticket has left Blocked.`;
  await ctx.attempt(PHASE, `${ticket.key} ${variation.name}`, async () => {
    if (!await moveTicket(ctx, PHASE, project, ticket, variation, to, 'its app stack failed in its sandbox')) return;
    await ctx.cli(['ticket:set-ai-feedback', project.id, ticket.key, variation.name, short, long]);
  });
}

// sandboxWaits(ctx, state, project, ticket, variation, step, who, held) — whether the step's work waits for its sandbox
// (see the module comment): false at once for a step on no substrate target, or one that works on no machine.
// `held` — the step's backoff key (backoff.js ticketKey, runKey): a bring-up that fails is counted on it (ASS-537 AC4);
// without one, on this module's own backoff alone.
export function sandboxWaits(ctx, state, project, ticket, variation, step, who, held) {
  if (!ticket || !variation || variation['is-deleted'] || !machineWork(step) || !onSubstrateTarget(project, ticket.key, variation.name)) return false;
  if (sandboxUp(ctx, project, ticket, variation)) return false;
  const host = sandboxHost(project, ticket.key, variation.name), k = keyOf(project.id, ticket.key, variation.name), now = ctx.now().getTime();
  const m = memoryOf(ctx);
  let r = m.get(k);
  if (!r) m.set(k, r = { failures: 0, until: 0, job: null, up: null, said: null });
  if (!host) return true;   // a remote target with no seat record yet: the next tick's seats
  if (r.stopping) return true;   // ASS-567: its stop (superviseSandboxes) still running: brought up once it has ended
  if (r.said !== host) { r.said = host; ctx.log(PHASE, `${who}: waits for its Substrate sandbox on ${host === 'mac' ? 'the Mac' : host}`); }
  if (r.job || now < r.until) return true;
  const hibernated = variation.sandbox?.machine === host && variation.sandbox?.state === 'stopped';
  r.job = (async () => {
    const was = variation.sandbox?.machine;
    let out;
    try {
      if (was && was !== host) {
        await ctx.cli(['substrate:sandbox-delete', project.id, ticket.key, variation.name, '--keep-work']);
        ctx.log(PHASE, `${ticket.key} ${variation.name}: its sandbox on ${was} deleted, its work pushed through the Mac: its seat is on ${host} now`);
      }
      out = JSON.parse(String(await ctx.cli(['substrate:sandbox-up', project.id, ticket.key, variation.name, host])).trim().split('\n').pop());
    } catch (error) {
      // ASS-568: crashed — replaced, not counted (see the module comment).
      if (!isCrash(error)) throw error;
      await replaceCrashed(ctx, project, ticket, variation, r, error);
      return;
    }
    const branches = out.branches?.length ? `, ${out.branches.map(b => `${b.repo} on ${b.branch}`).join(', ')} brought in` : '';
    const how = out.created ? ` (made from ${out.template})` : hibernated ? ' (resumed from hibernation: its files and processes as they were)' : '';
    ctx.log(PHASE, `${ticket.key} ${variation.name}: its sandbox ${out.name} is up on ${host === 'mac' ? 'the Mac' : host}${how}${branches}`);
    // ASS-542: its app stack.
    const after = out.created ? 'created' : (out.resumed || hibernated) ? 'resumed' : 'started';
    let stack;
    try {
      stack = JSON.parse(String(await ctx.cli(['substrate:stack-up', project.id, ticket.key, variation.name, '--after', after, String(out.seconds ?? 0)])).trim().split('\n').pop());
    } catch (error) {
      if (error.code !== 3) throw error;
      r.up = host; r.upAt = ctx.now().getTime(); r.replaced = false; r.failures = 0; r.until = 0; r.trouble = null; r.stackFailed = true;
      await stackFailed(ctx, project, ticket, variation, error);
      return;
    }
    r.up = host; r.upAt = ctx.now().getTime(); r.replaced = false; r.failures = 0; r.until = 0; r.trouble = null; r.stackFailed = false;
    if (stack?.stack) ctx.log(PHASE, `${ticket.key} ${variation.name}: its app stack is up in ${out.name} (${stack.seconds}s${stack.app ? `, ${stack.app.url} answers ${stack.app.status}` : ''}${stack.login ? `, signed in as the seeded user${stack['session-kept'] ? ', its session kept' : ''}` : ''})`);
  })().catch(error => {
    const what = hibernated ? 'resumed' : 'brought up';
    // ASS-537 AC4: a failure of the step itself, when the caller named it — its backoff, and Blocked at BLOCK_AFTER.
    const step = held ? failed(ctx.memory, held, ctx.now().getTime(), `its sandbox could not be ${what}: ${error.message}`) : null;
    r.failures++;
    const n = step?.failures ?? r.failures;
    r.until = step?.until ?? ctx.now().getTime() + backoffDelay(r.failures);
    const next = step && n >= BLOCK_AFTER ? `; to Blocked: its step failed ${BLOCK_AFTER} times in a row` : `; next try in ${heldFor(r.until - ctx.now().getTime())}`;
    ctx.log('error', `${PHASE} ${ticket.key} ${variation.name}: its sandbox on ${host} could not be ${what} (${n} in a row${next}): ${error.message}`);
    // ASS-539 AC2: kept for sandbox-failures.json (recordSandboxFailures), the header's warning.
    const since = r.trouble?.since ?? ctx.now().toISOString();
    r.trouble = { project: project.id, key: ticket.key, variation: variation.name, machine: host, what: hibernated ? 'resumed' : 'made', failures: n, error: String(error.message ?? error).split('\n').find(l => l.trim()) ?? '', since, until: r.until };
  }).finally(() => { r.job = null; });
  return true;
}

// syncSandboxTicket(ctx, project, ticket, variation, machine) — /mnt/ticket brought up to date in the variation's
// sandbox before an agent or in-machine script starts there (`machine` a sandbox's: machine.js onSandbox); throws
// when it fails, so the step is held and tried again as a failing dispatch is.
// ASS-567: only into a running sandbox. A copy made while superviseSandboxes was stopping it was lost (and the agent
// started after it resumed the sandbox found /mnt/ticket empty, and asked the operator for the ticket): while a stop
// of it runs, this throws (the step held, tried again). One that is not up for the step (sandboxUp: a step that holds
// no substrate seat but runs in it all the same, as Blocked's runs do; or hibernated) is resumed first
// (substrate:sandbox-up, which copies the ticket folder itself as it resumes) rather than copied into while suspended.
// A copy that leaves /mnt/ticket empty or short (the command's exit 4) is a harness fault, logged as one; the step is
// held and tried again, never given to an agent so.
export const TICKET_FOLDER_EMPTY = 4;
export async function syncSandboxTicket(ctx, project, ticket, variation, machine) {
  if (!machine?.startsWith?.('substrate:') || !ticket || !variation) return;
  const r = memoryOf(ctx).get(keyOf(project.id, ticket.key, variation.name));
  if (r?.stopping) throw new Error(`its sandbox ${variation.sandbox?.name ?? machine} is being stopped: nothing is copied into it or started in it until that has ended`);
  try {
    if (sandboxUp(ctx, project, ticket, variation)) await ctx.cli(['substrate:sandbox-sync-ticket', project.id, ticket.key, variation.name]);
    else {
      const host = variation.sandbox?.machine;
      if (!host) throw new Error(`${ticket.key} ${variation.name} records no sandbox to run in`);
      await ctx.cli(['substrate:sandbox-up', project.id, ticket.key, variation.name, host]);
      ctx.log(PHASE, `${ticket.key} ${variation.name}: its sandbox ${variation.sandbox.name} brought up on ${host === 'mac' ? 'the Mac' : host} before a step that holds no substrate seat runs in it, its ticket folder copied in`);
    }
  } catch (error) {
    if (error.code === TICKET_FOLDER_EMPTY || /ticket folder empty/.test(String(error.message))) ctx.log('error', `${PHASE} ${ticket.key} ${variation.name}: harness fault: sandbox ticket folder empty — /mnt/ticket in ${variation.sandbox?.name ?? machine} lacks the ticket's files after the copy; no agent or script starts there until a copy holds them`);
    throw error;
  }
}

// resumedMeanwhile(project, s) — ASS-537: the sandbox recorded hibernated (`s` its record) was measured running by its
// cluster's check after its record was written (something ran a command in it, which resumed it).
function resumedMeanwhile(project, s) {
  const live = project.substrate?.[s.machine], at = Date.parse(live?.['checked-at'] ?? '');
  return s.state === 'stopped' && at > Date.parse(s.at ?? '') && sandboxUse(live).some(u => u.actor === s.name && ['running', 'resuming'].includes(u.state));
}

// variationBusy(ctx, state, projectId, key, name) — an agent or an in-machine script of the variation runs now (ASS-570:
// also what makes a sandbox's reading a working sample for the seat budget, ticket-estimate.js).
export const variationBusy = (ctx, state, projectId, key, name) => (state.assignments ?? []).some(a => a.project === projectId && String(a['work-item']).toUpperCase() === String(key).toUpperCase() && a.variation === name)
  || machineScriptRunning(ctx, projectId, key, name);

// superviseSandboxes(ctx, state) — the tick's phase (see the module comment).
export function superviseSandboxes(ctx, state) {
  const jobs = (ctx.memory.sandboxJobs ??= new Map()), m = memoryOf(ctx), now = ctx.now().getTime();
  for (const project of state.projects) {
    if (!project.engine || jobs.get(project.id)) continue;
    const todo = [];
    for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
      const s = v.sandbox;
      if (!s?.name) continue;
      const k = keyOf(project.id, t.key, v.name), r = m.get(k) ?? { failures: 0, until: 0, job: null, up: null };
      m.set(k, r);
      if (r.job || now < r.until) continue;
      if (v['is-deleted'] || isDoneStep(project.engine, v['harness-status']?.state)) {
        if (!variationBusy(ctx, state, project.id, t.key, v.name)) todo.push({ t, v, r, action: 'delete', why: v['is-deleted'] ? 'its variation was set aside' : 'its ticket is done' });
      } else if (!onSubstrateTarget(project, t.key, v.name) && (s.state === 'running' || resumedMeanwhile(project, s)) && !variationBusy(ctx, state, project.id, t.key, v.name)
        // On another target: once its branches have moved off the sandbox (code:hand-over records the target it went to).
        && (!targetOf(project, t.key, v.name) || !/-substrate$/.test(runTargetOf(v)?.target ?? ''))) {
        todo.push({ t, v, r, action: 'stop', why: `${targetOf(project, t.key, v.name) ? `its step runs on ${targetOf(project, t.key, v.name)} now` : 'it holds no seat now (its step uses no machine, or waits for one)'}${s.state === 'stopped' ? '; it had been resumed meanwhile' : ''}` });
      }
    }
    if (!todo.length) continue;
    for (const { r } of todo) r.stopping = true;   // ASS-567: sandboxUp false, no bring-up or ticket copy, till each has ended
    jobs.set(project.id, (async () => {
      for (const { t, v, r, action, why } of todo) {
        try {
          await ctx.cli(action === 'delete' ? ['substrate:sandbox-delete', project.id, t.key, v.name] : ['substrate:sandbox-stop', project.id, t.key, v.name]);
          r.up = null; r.failures = 0;
          ctx.log(PHASE, `${t.key} ${v.name}: its sandbox ${v.sandbox.name} on ${v.sandbox.machine} ${action === 'delete' ? 'deleted' : 'stopped (hibernated: its files and processes kept, no seat)'}: ${why}`);
        } catch (error) {
          const wait = backoffDelay(++r.failures);
          r.until = ctx.now().getTime() + wait;
          ctx.log('error', `${PHASE} ${t.key} ${v.name}: its sandbox could not be ${action === 'delete' ? 'deleted' : 'stopped'} (next try in ${heldFor(wait)}): ${error.message}`);
        } finally { r.stopping = false; }
      }
    })().finally(() => jobs.delete(project.id)));
  }
  recordSandboxFailures(ctx, state);
}

// sandboxFailures(ctx, project) — ASS-539 AC2: the project's variations whose sandbox could not be made or resumed and
// that still wait for it (on a substrate target, not set aside), each { key, variation, sandbox, machine, what,
// failures, error, since, next-try-at }, in the sprint's order.
export function sandboxFailures(ctx, project) {
  const m = memoryOf(ctx), out = [];
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    const r = m.get(keyOf(project.id, t.key, v.name))?.trouble;
    if (!r || v['is-deleted'] || !onSubstrateTarget(project, t.key, v.name)) continue;
    out.push({ key: t.key, variation: v.name, sandbox: sandboxActor(t.key, v.name), machine: r.machine, what: r.what, failures: r.failures, error: r.error, since: r.since, 'next-try-at': r.until ? new Date(r.until).toISOString() : null });
  }
  return out;
}

// recordSandboxFailures(ctx, state) — ASS-539 AC2: each project's sandboxFailures written to its sandbox-failures.json
// when they differ from those last written (a temporary file renamed over it), the file removed when there are none.
// Nothing without a projects folder (a test's context).
export function recordSandboxFailures(ctx, state) {
  if (!ctx.paths?.projects) return;
  const last = (ctx.memory.sandboxFailures ??= new Map());
  for (const project of state.projects) {
    const file = join(ctx.paths.projects, project.id, SANDBOX_FAILURES_FILE);
    const failures = sandboxFailures(ctx, project), text = `${JSON.stringify({ failures }, null, 2)}\n`;
    if (last.get(project.id) === text) continue;
    try {
      if (!failures.length) rmSync(file, { force: true });
      else if (existsSync(join(ctx.paths.projects, project.id))) { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); }
      last.set(project.id, text);
    } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
  }
}
