// ASS-527: which steps use the ticket's machine — the one place that says so.
//
// A variation holds a seat (plan.js slotKind) only while its current step uses
// its machine; at any other step — a host-only script, a wait, a gate, a human
// step — it holds none, and its VM is stopped (vm-lifecycle.js), so tickets
// waiting at gates, on dependencies, on fixes, on CI or on the operator cost
// no memory or CPU. A step uses its machine (usesMachine) when it is:
// - an AI step: an active prompt step, wherever its agent runs;
// - a script step whose command SCRIPT_COMMANDS declares 'machine' (its work
//   runs in the ticket's machine through code.bash in_project / machine.bash
//   machine_run, or in the ticket's own working copy), or a script step with
//   run-location vm (it runs there through limactl, whatever its command);
// - any step whose exits check a command declared 'machine' (script-succeeds:
//   Setup's Check Setup Complete asks vm:setup-complete in the VM).
// Everything else does not. A state-engine step whose run has not started
// yet uses none: its run starts at once and its first step decides.
//
// SCRIPT_COMMANDS lists every command an engine's script step (or an exit's
// script-succeeds check) may run, by
// its CLI ('agent.sh', 'off-board.sh') and name, as 'machine' or 'host'; a
// new in-machine script is declared here, once, not guessed. Engine
// validation (src/workflow/validate.js) fails a script step whose command is
// not listed (unknownScriptCommand), so a new command is declared before an
// engine can run it. Each was read (2026-11-22) for where its work runs:
// - machine: automated-tests:verify-success and :verify-exist-and-runnable,
//   ci-checks:verify (ASS-552: no shipped engine runs it any more, the
//   project's CI runs its checks on the merge request; kept for a hand run
//   and an engine of a project's own), ticket:catch-up-base, ticket:own-branch-fix,
//   merge-request:check-numbered-files and :conflicting-tickets (in_project
//   or machine_run in the variation's VM); vm:refresh-repositories,
//   vm:setup-complete, vm:mark-setup-complete, vm:test-repos, vm:run, vm:demo (machine_run);
//   vm:create and project:add-repository (which runs it: they make and boot
//   the ticket's VM, or on a substrate target make or resume its sandbox).
// - host: the rest. merge-request:create only pushes the ticket's branch and
//   asks the forge; merge-request:merge-in-turn runs its gate's tests in a
//   scratch worktree of the shared workspace, not the ticket's machine.
//   ASS-540: code:create-branch, code:create-worktree and code:update-workspace
//   are host too — ASS-527 had declared them 'machine', but each runs with
//   control on the Mac's own checkout of the project (a branch made, a worktree
//   added, the workspace fast-forwarded), never in the ticket's machine, so
//   they hold no seat and take no run-targets; merge-request:create pushes from
//   that checkout (its worktree) on the Mac alike.
//
// ASS-540 (run targets, run-targets.js): DOCKER_COMMANDS are the in-machine
// commands that need Docker, so never run on a Substrate sandbox (no Docker
// there, the ASS-532 spike): the CI checks and test repositories, whose jobs
// run containers. A project marks
// more for itself in its sandbox declaration (dev-environments.substrate
// .needs-docker: its e2e tests, say). MACHINE_ONLY are the in-machine commands
// that read the ticket's checkouts in its machine and fail without one (no host
// fallback: vm_of empty), so never run on the Mac targets (local-worktree,
// local-workspace); automated-tests:verify-* fall back to the Mac's worktree or
// workspace, so may run there.
// ASS-551: vm:create and project:add-repository are no longer DOCKER_COMMANDS.
// They were listed because they make and boot a VM, but on a substrate target
// "the machine" is the variation's sandbox: vm:create makes or resumes it
// (substrate:sandbox-up) and clones into it what its image lacks, through the
// Mac (relay.bash relay_clone), and project:add-repository downloads through
// that vm:create. Kept, a project whose run targets are substrate ones alone
// had no target for Setup's Create VM, so every new ticket waited there for ever
// (found by ASS-543).
//
// WORKSTATION_CLAIMS: of the host-run 'machine' scripts, those that claim a
// workstation lease for their step in a workstation project
// (workstation-steps.js machineWork, ASS-468) — kept as narrow as before.
import { runsInVm } from './vm.js';

const MACHINE = 'machine', HOST = 'host';
const declare = (place, names) => Object.fromEntries(names.map(n => [n, place]));

export const SCRIPT_COMMANDS = {
  'agent.sh': {
    ...declare(MACHINE, [
      'automated-tests:verify-success', 'automated-tests:verify-exist-and-runnable', 'ci-checks:verify',
      'ticket:catch-up-base', 'ticket:own-branch-fix', 'project:add-repository',
      'merge-request:check-numbered-files', 'merge-request:conflicting-tickets',
      'vm:refresh-repositories', 'vm:create', 'vm:mark-setup-complete', 'vm:setup-complete', 'vm:test-repos', 'vm:run', 'vm:demo',
    ]),
    ...declare(HOST, [
      'code:create-branch', 'code:create-worktree', 'code:take-out-of-draft-mode', 'code:update-workspace',
      'harness:check-disk-space', 'harness:request-restart', 'harness:restarted',
      'merge-request:await-dependencies', 'merge-request:check', 'merge-request:check-details', 'merge-request:create',
      'merge-request:ensure-auto-merge', 'merge-request:feedback-round', 'merge-request:merge', 'merge-request:merge-in-turn',
      'merge-request:reviewed-at-head',
      'plan:ask-about-objections', 'plan:record-objections',
      'project:check-credentials', 'project:check-on-master', 'project:credentials-status',
      'self-healing:hand-to-human', 'self-healing:start', 'self-healing:stop', 'self-healing:take-on',
      'ticket:accept-ticket-system-status', 'ticket:adopt-run-folder', 'ticket:apply-split', 'ticket:await-rate-limit',
      'ticket:choose-work-mode', 'ticket:credentials-unseen', 'ticket:dependency-wait', 'ticket:fast-track', 'ticket:fix-attempts', 'ticket:fix-landed',
      'ticket:fix-resume-step', 'ticket:has-points', 'ticket:kept-whole', 'ticket:note-too-large', 'ticket:plan-obstacle-fix',
      'ticket:questions-answered', 'ticket:recheck-block', 'ticket:requirements-change-verdict', 'ticket:set-paused',
      'ticket:split-proposed', 'ticket:wait-on',
      'vm:golden-followup', 'vm:golden-ready', 'vm:golden-wait', 'vm:image-recheck', 'vm:raise-golden-rebuilds',
    ]),
  },
  'off-board.sh': declare(HOST, ['ticket:keep-whole']),
};

export const DOCKER_COMMANDS = new Set(['ci-checks:verify', 'vm:test-repos']);
export const MACHINE_ONLY = new Set([
  'ci-checks:verify', 'ticket:catch-up-base', 'ticket:own-branch-fix', 'merge-request:check-numbered-files', 'project:add-repository',
  'vm:refresh-repositories', 'vm:create', 'vm:mark-setup-complete', 'vm:setup-complete', 'vm:test-repos', 'vm:run', 'vm:demo',
]);

export const WORKSTATION_CLAIMS = new Set(['vm:refresh-repositories', 'vm:test-repos', 'vm:run', 'vm:demo']);

// commandOf(command) — a script step's command line parsed: { cli ('agent.sh' or 'off-board.sh'), name
// ('family:command') }, or null when it names neither CLI.
export function commandOf(command) {
  const m = /^(?:\.\/)?(agent|off-board)\.sh ([\w-]+(?::[\w-]+)?)/.exec(String(command ?? '').trim());
  return m ? { cli: `${m[1]}.sh`, name: m[2] } : null;
}

// scriptPlace(command) — where a script step's command does its work: 'machine', 'host', or undefined when
// SCRIPT_COMMANDS does not declare it (control reads that as host; validation fails it).
export function scriptPlace(command) {
  const c = commandOf(command);
  return c ? SCRIPT_COMMANDS[c.cli]?.[c.name] : undefined;
}

// unknownScriptCommand(command) — the command's name when SCRIPT_COMMANDS does not declare it, else null.
export function unknownScriptCommand(command) {
  const c = commandOf(command);
  if (!c) return String(command ?? '');
  return SCRIPT_COMMANDS[c.cli]?.[c.name] ? null : `${c.cli} ${c.name}`;
}

// usesMachine(step) — the step uses its ticket's machine (see the module comment). A switched-off step is passed at once and uses none.
export function usesMachine(step) {
  if (!step || step['is-active'] === false) return false;
  const type = step.action?.type;
  if (type === 'prompt') return true;
  if (type === 'script' && (runsInVm(step) || scriptPlace(step.action.command) === MACHINE)) return true;
  return (step['exit-events'] ?? []).some(e => checks(e.condition).some(c => scriptPlace(c) === MACHINE));
}

// checks(condition) — the script-succeeds commands an exit's condition runs, under all / any / not.
function checks(condition) {
  if (!condition || typeof condition !== 'object') return [];
  return Object.entries(condition).flatMap(([k, v]) => (k === 'script-succeeds' ? [v] : Array.isArray(v) ? v.flatMap(checks) : typeof v === 'object' ? checks(v) : []));
}

// claimsWorkstation(step) — a host-run script step that claims a workstation lease for its step (WORKSTATION_CLAIMS).
export function claimsWorkstation(step) {
  if (step?.action?.type !== 'script') return false;
  const c = commandOf(step.action.command);
  return Boolean(c && c.cli === 'agent.sh' && WORKSTATION_CLAIMS.has(c.name));
}

// machineScripts(ctx) — ASS-527 AC2: the in-machine scripts running now, per variation
// (`${project}/${KEY}/${variation}` → how many), so its machine is not stopped under one.
const machineScripts = ctx => (ctx.memory.machineScripts ??= new Map());
const scriptKey = (project, key, variation) => `${project}/${String(key).toUpperCase()}/${variation}`;

// trackMachineScript(ctx, project, key, variation, step, running) — `running` (a script step's run), counted as
// running on the variation's machine until it settles, when the step uses its machine; returned as it is.
export function trackMachineScript(ctx, project, key, variation, step, running) {
  if (!usesMachine(step)) return running;
  return trackMachineWork(ctx, project, key, variation, running);
}

// trackMachineWork(ctx, project, key, variation, running) — `running` counted as an in-machine script of the variation
// until it settles, whatever its step (ASS-577: code:hand-over reading branches out of a Lima VM it started, so the VM
// lifecycle does not stop that VM under it); returned as it is.
export function trackMachineWork(ctx, project, key, variation, running) {
  if (key == null || variation == null) return running;
  const k = scriptKey(project, key, variation), m = machineScripts(ctx);
  m.set(k, (m.get(k) ?? 0) + 1);
  const done = () => { const n = (m.get(k) ?? 1) - 1; if (n > 0) m.set(k, n); else m.delete(k); };
  return Promise.resolve(running).finally(done);
}

// machineScriptRunning(ctx, project, key, variation) — an in-machine script of the variation runs now.
export const machineScriptRunning = (ctx, project, key, variation) => (ctx.memory?.machineScripts?.get(scriptKey(project, key, variation)) ?? 0) > 0;

// ASS-529 AC3: the steps that run a ticket's automated tests or CI checks in its machine — those a project whose
// tests are not opted into running side by side on a shared remote machine (dev-environments ticket-isolation 'one-at-a-time', the default) runs one
// at a time per machine (workstation-steps.js claim). TEST_COMMANDS are the shared engines' test and CI scripts; any
// other step (an AI step that runs the tests, say) is one when its engine marks it `runs-tests: true`.
export const TEST_COMMANDS = new Set(['automated-tests:verify-success', 'automated-tests:verify-exist-and-runnable', 'ci-checks:verify', 'vm:test-repos']);

// runsTests(step) — the step runs tests or CI checks in its machine (see TEST_COMMANDS).
export function runsTests(step) {
  if (!step || step['is-active'] === false) return false;
  if (step['runs-tests'] === true) return true;
  const tests = command => { const c = commandOf(command); return Boolean(c && c.cli === 'agent.sh' && TEST_COMMANDS.has(c.name)); };
  if (step.action?.type === 'script' && tests(step.action.command)) return true;
  return (step['exit-events'] ?? []).some(e => checks(e.condition).some(tests));
}
