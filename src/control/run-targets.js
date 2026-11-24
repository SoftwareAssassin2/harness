// ASS-540: run targets — where a machine-using step runs. Operator decisions, 2026-11-22 (after the ASS-532 spike:
// agent turns in Substrate sandboxes, Docker and test steps on full machines):
//
// - Eight run targets (RUN_TARGETS): `local-substrate`, `workstation-substrate`, `cloud-vm-substrate` (a Substrate
//   sandbox on the Mac, on a workstation or on a cloud VM — built in ASS-535; accepted here in lists and validation
//   only, and a project may list one only once it declares a cluster on that kind of host), `local-vm` (the ticket's
//   Lima VM), `workstation`, `cloud-vm` (a seat on one of the project's GCP workstations or cloud VMs), and the two on
//   the Mac itself: `local-worktree` (a git worktree for the ticket variation in the project's checkout, created on
//   first use) and `local-workspace` (the project's checkout itself, one ticket at a time per project).
//   ASS-553: two more, `workstation-worktree` and `cloud-vm-worktree` (ten in all) — see "Worktrees" below.
// - A step in a workflow.yaml may set `run-targets:` — one target or a list, in order of preference. Only a step
//   that uses a machine takes one (machine-steps.js usesMachine: an AI step, or a script step whose command works in
//   the ticket's machine); gates, human steps, waits and harness bookkeeping run with control on the Mac and must not
//   set it (validation: src/workflow/validate.js). An engine step sets it only where it cannot run on some target;
//   otherwise it leaves it unset and the project's list decides.
// - A project lists the targets it has and allows, in its default order: project.json's
//   `dev-environments.run-targets`. It replaces `dev-environments.mode`; unset, it is derived from the mode
//   (MODE_TARGETS: vm = [local-vm]; workstation = [workstation, cloud-vm]; vm+workstation = [workstation, cloud-vm,
//   local-vm]), so nothing changes until a project opts in. project:set-run-targets writes it,
//   project:migrate-run-targets writes it from each project's mode once and removes the mode.
// - Resolution (candidates): a step runs on its own list filtered to the project's, in the step's order (no list of
//   its own: the project's, in its order). Of those it takes the first with a free seat now (plan.js), and waits
//   only when none is free — no other fallback. A step whose list shares nothing with the project's is never
//   started (projectRunTargetErrors, logged once by control).
// - Two rules narrow every list, so a step is never sent where it cannot run: a script step whose command needs
//   Docker (machine-steps.js DOCKER_COMMANDS, or the project's own `dev-environments.substrate.needs-docker`) never
//   runs on a substrate target (no Docker in a sandbox: the ASS-532 spike); one whose command works only in a
//   machine (machine-steps.js MACHINE_ONLY: it reads the ticket's checkouts there) never runs on the Mac targets.
//   Listing such a target on the step itself is a validation error.
// - Seats: the substrate targets, local-vm, workstation and cloud-vm take a seat as before (ASS-527/528/529: the
//   substrate ones the seat of their host — a Mac seat, a workstation's or a cloud VM's); local-worktree and
//   local-workspace take none, their load measured on the Mac counting against its budget (seat-budget.js reads the
//   Mac's used memory and CPU, whatever uses it).
//
// Compatibility, while a project's list is derived from its mode (decisions where the ticket left room):
// - a planning step in a derived vm+workstation project runs on its local VM, as planning always did there (ASS-528);
// - a step with no `run-location: vm` (a host step) still runs on the host when its target is a machine target: its
//   target decides its seat, as before (run targets only move a step that could already run in the machine, or move
//   a step onto the Mac); on a Mac target any step runs on the Mac.
//
// Worktrees (ASS-553, operator decisions 2026-11-23):
// - `workstation-worktree` and `cloud-vm-worktree`: the ticket variation's own worktree on one of the project's
//   workstations / cloud VMs — a folder of its own there, `<home>/harness/worktrees/<KEY>[.<variation>]`, with its own
//   checkout of each repository (cloned once, the machine's shared checkout as a reference), the machine's toolchain,
//   no VM and no sandbox. It is ASS-529's slot machinery (workstation:claim --workstation <id> --worktree): the step
//   claims the machine as a `workstation` / `cloud-vm` step does, but its folder is the variation's alone and kept
//   between its steps (never handed to another ticket, as a numbered slot is) until the ticket is done
//   (workstation:remove-worktree, run-target-places.js removeDoneWorktrees). It takes a seat of its machine — the same
//   seat kind as `workstation` / `cloud-vm` (seatKindOf), so it counts against the machine's own measured limits
//   (remote-seats.js) beside its Substrate sandboxes and plain slots. A project lists one only with such a machine
//   (projectTargetErrors). Docker and machine-only commands run there (it is a full machine).
// - `local-worktree` (ASS-540) now makes its worktrees from the harness's own clone of the project's repository on
//   the Mac (data/projects/<p>/checkouts/<repo>, gitignored: code.bash harness_clone), never from the operator's
//   checkout; a worktree made before (in the checkout's .worktrees/) is kept and goes on working until it is removed.
// - WORKTREE_TARGETS (isWorktreeTarget) — the three: the interface ASS-554 (a step flag asking for a worktree) and
//   ASS-555 (Claude Code's sandbox for agents on one) build on; REMOTE_WORKTREE_TARGETS the two remote ones.
//
// Pool choice (ASS-553): which of a step's candidates a holder takes (plan.js choose):
// - `first`: the first with a free seat, in list order, as before ASS-553 — the default for a step none of whose
//   candidates is a worktree target, so nothing changes until chosen.
// - `most-room`: of those with a free seat (or, for the Mac targets, room), the one with the most headroom now —
//   pool-choice.js headroomOf: how many more tickets fit, by measured memory and CPU against the limits (a remote
//   machine's own, remote-seats.js; on the Mac the smaller of the Mac's budget and the project's allotment,
//   seat-budget.js); ties keep list order.
// - `remote-first` (operator, 2026-11-23): the project's remote machines (workstations, cloud VMs — their plain,
//   substrate and worktree targets alike) whenever one has a free seat, the one with the most headroom among them;
//   the Mac only when every eligible remote machine is full (then its targets in list order). A stopped or starting
//   machine counts as available (its seats are ASS-529's unmeasured ones: those given to the steps sent to it, at
//   least one, so it is never over-filled before it can be measured); control starts it and the step waits for it up
//   to harness.json's remote-boot-wait-seconds (BOOT_WAIT_SECONDS), after which the machine counts as lost until it is
//   up and the step falls back to the next remote machine or, last, the Mac (seats.js bootWaits, logged). An unusable
//   machine (its login expired, its setup failed, unreachable) is skipped at once, as before. The default for a step
//   whose candidates include a worktree target.
// Set per step (`pool-choice:` in a workflow.yaml step, only on a machine-using step) or per project
// (`dev-environments.pool-choice`, project:set-pool-choice); the step's wins, then the project's, then the default
// above. poolChoiceOf(step, project, candidates) reads it; ASS-556 (a work-mode step) and ASS-554 pass theirs the
// same way.
//
// Worktree steps (ASS-554, operator decisions 2026-11-23): a step that only reads code and writes text — planning,
// code and security review, risk assessment, documentation and explanation — runs in a worktree, not a sandbox or a
// VM, so the full machines are left for building and testing. The engine says so with a flag on the step,
// `worktree: true` (worktreeStep), never by an engine's or a project's name, so any engine (shipped, or a project's
// own) marks its own steps:
// - A flagged step runs only on the worktree targets (WORKTREE_TARGETS) its project lists, in the project's order,
//   by pool choice (its default remote-first: the remote machines' worktrees, the most headroom first, the Mac's
//   last). Its own `run-targets`, if it sets any, may name worktree targets only (stepRunTargetErrors).
// - A project that lists no worktree target leaves its flagged steps no target: projectRunTargetProblems names each
//   (engine and step) — control logs it, engine:validate <project> fails on it — so a project lists the worktree
//   targets it can use (project:set-run-targets). A project whose list is still derived from its mode keeps running
//   every step as before, flag or not (nothing changes until a project opts in, as above).
// - The worktree targets of a project that also lists machine targets (a sandbox, a VM, a workstation or cloud VM
//   slot) are its worktree steps': an unflagged step with no run-targets of its own takes the project's others, so a
//   build or test step never spills onto a worktree (on the Mac: unsandboxed, its load unseated) when the sandboxes
//   are full — it waits for one, as before the project listed worktrees. A step whose own run-targets name worktree
//   targets keeps them (ASS-553's Docker and machine-only steps), and so does one with nothing else left (a project
//   on worktree targets alone, or a Docker step on a project whose machines are sandboxes).
// - Moving between a worktree step and a sandbox or VM step hands the branch over (run-target-places.js readyTarget,
//   code:hand-over), as for any change of target.
import { commandOf, DOCKER_COMMANDS, MACHINE_ONLY, usesMachine } from './machine-steps.js';
import { clusterHosts } from './substrate-config.js';

export const RUN_TARGETS = ['local-substrate', 'workstation-substrate', 'cloud-vm-substrate', 'local-vm', 'workstation', 'cloud-vm', 'workstation-worktree', 'cloud-vm-worktree', 'local-worktree', 'local-workspace'];
export const SUBSTRATE_TARGETS = new Set(['local-substrate', 'workstation-substrate', 'cloud-vm-substrate']);
// MAC_TARGETS — the targets on the Mac's own checkout: no seat, no machine.
export const MAC_TARGETS = new Set(['local-worktree', 'local-workspace']);
export const isMacTarget = t => MAC_TARGETS.has(t);
export const isSubstrateTarget = t => SUBSTRATE_TARGETS.has(t);
// ASS-553: the worktree targets (see "Worktrees" above), and the two on remote machines.
export const WORKTREE_TARGETS = new Set(['local-worktree', 'workstation-worktree', 'cloud-vm-worktree']);
export const REMOTE_WORKTREE_TARGETS = new Set(['workstation-worktree', 'cloud-vm-worktree']);
export const isWorktreeTarget = t => WORKTREE_TARGETS.has(t);
export const isRemoteWorktree = t => REMOTE_WORKTREE_TARGETS.has(t);
// ASS-554: worktreeStep(step) — the step asks for a worktree (`worktree: true`; see "Worktree steps" above).
export const worktreeStep = step => step?.worktree === true;
// A machine target that is not a worktree: a sandbox, a VM, a workstation or cloud VM slot.
const plainMachine = t => seatKindOf(t) != null && !isWorktreeTarget(t);
// POOL_CHOICES — how a step picks among its candidates (see "Pool choice" above); the first is the default.
export const POOL_CHOICES = ['first', 'most-room', 'remote-first'];
// BOOT_WAIT_SECONDS — how long a step waits for a stopped or starting remote machine it was placed on (remote-first)
// before falling back, unless harness.json's remote-boot-wait-seconds says otherwise: a workstation's start (up to
// 300 s, workstation:connect's WORKSTATION_START_TIMEOUT; a cloud VM's start and IAP SSH wait alike) plus its first
// setup (tools, images, Substrate's host setup: several minutes).
export const BOOT_WAIT_SECONDS = 900;
// HOST_OF — the kind of host each target is on: local (the Mac), workstation or cloud-vm.
export const HOST_OF = { 'local-substrate': 'local', 'workstation-substrate': 'workstation', 'cloud-vm-substrate': 'cloud-vm', 'local-vm': 'local', workstation: 'workstation', 'cloud-vm': 'cloud-vm', 'workstation-worktree': 'workstation', 'cloud-vm-worktree': 'cloud-vm', 'local-worktree': 'local', 'local-workspace': 'local' };
// seatKindOf(target) — the seat a target takes (seat-kinds.js record kinds): 'vm' (a Mac seat), 'workstation' or
// 'cloud-vm' (a remote machine's), or null (the Mac targets take none).
export const seatKindOf = t => (isMacTarget(t) || !HOST_OF[t] ? null : HOST_OF[t] === 'local' ? 'vm' : HOST_OF[t]);
// targetOfSeat(record) — the target a seats.json record stands for: its own `target`, else by its kind (records
// written before ASS-540: a VM seat local-vm, a workstation's workstation, a cloud VM's cloud-vm).
export const targetOfSeat = s => (s?.target && RUN_TARGETS.includes(s.target) ? s.target : s?.kind === 'vm' ? 'local-vm' : s?.kind === 'workstation' ? 'workstation' : s?.kind === 'cloud-vm' ? 'cloud-vm' : null);

export const MODE_TARGETS = { vm: ['local-vm'], workstation: ['workstation', 'cloud-vm'], 'vm+workstation': ['workstation', 'cloud-vm', 'local-vm'] };

// asList(value) — a run-targets value (one name or a list) as a list; null when unset.
export const asList = value => (value === undefined || value === null ? null : Array.isArray(value) ? value : [value]);

// targetListErrors(value) — what is wrong with a run-targets value, each a reason: not a name or a list of names,
// empty, an unknown name (naming the eight), a name twice. [] when it is good.
export function targetListErrors(value) {
  const list = asList(value);
  if (list == null) return [];
  if (!list.length) return ['run-targets is empty'];
  const errors = [], seen = new Set();
  for (const t of list) {
    if (typeof t !== 'string') { errors.push(`run-targets has ${JSON.stringify(t)}, not a run target name`); continue; }
    if (!RUN_TARGETS.includes(t)) errors.push(`run-targets has an unknown run target "${t}" (the run targets are ${RUN_TARGETS.join(', ')})`);
    else if (seen.has(t)) errors.push(`run-targets lists "${t}" twice`);
    seen.add(t);
  }
  return errors;
}

// commandsOf(step) — the agent.sh / off-board.sh command names a step runs: its script's, and its exits' script-succeeds checks'.
function commandsOf(step) {
  const out = [];
  const add = c => { const p = commandOf(c); if (p) out.push(p); };
  if (step?.action?.type === 'script') add(step.action.command);
  const walk = c => { if (!c || typeof c !== 'object') return; for (const [k, v] of Object.entries(c)) { if (k === 'script-succeeds') add(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') walk(v); } };
  for (const e of step?.['exit-events'] ?? []) walk(e.condition);
  return out;
}
const named = (list, c) => list.has(c.name) || list.has(`${c.cli} ${c.name}`);

// needsDocker(step, projectDocker) — the step runs a command that needs Docker: DOCKER_COMMANDS, or one the project's
// sandbox declaration marks (`projectDocker`: a Set of "family:command" names, or "<cli> family:command").
export const needsDocker = (step, projectDocker = new Set()) => commandsOf(step).some(c => (c.cli === 'agent.sh' && DOCKER_COMMANDS.has(c.name)) || named(projectDocker, c));
// machineOnly(step) — the step runs a command that works only in the ticket's machine (MACHINE_ONLY).
export const machineOnly = step => commandsOf(step).some(c => c.cli === 'agent.sh' && MACHINE_ONLY.has(c.name));

// stepRunTargetErrors(step) — AC1, AC6: what is wrong with a step's own run-targets, each a reason (the caller names
// the file and step): a bad list (targetListErrors); set on a step that uses no machine; a substrate target on a
// step whose command needs Docker; a Mac target on a step whose command works only in a machine.
export function stepRunTargetErrors(step) {
  const value = step?.['run-targets'];
  // ASS-553: pool-choice, one of POOL_CHOICES, only on a machine-using step.
  const choice = step?.['pool-choice'], choiceErrors = [];
  if (choice !== undefined && !POOL_CHOICES.includes(choice)) choiceErrors.push(`pool-choice ${JSON.stringify(choice)} is not one of ${POOL_CHOICES.join(', ')}`);
  if (choice !== undefined && !usesMachine(step)) choiceErrors.push('pool-choice is set on a step that uses no machine (it takes no seat)');
  // ASS-554: worktree, true or false; true only on a step that uses a machine (switched off or not: an AI step, or a
  // script step that works on the ticket's code), and with no run-targets of its own but worktree targets.
  const flag = step?.worktree;
  if (flag !== undefined && typeof flag !== 'boolean') choiceErrors.push(`worktree ${JSON.stringify(flag)} is not true or false`);
  else if (flag === true && !usesMachine({ ...step, 'is-active': true })) choiceErrors.push('worktree is set on a step that uses no machine (gates, human steps, waits and harness bookkeeping run with control on the Mac)');
  else if (flag === true) for (const t of (asList(value) ?? []).filter(t => RUN_TARGETS.includes(t) && !isWorktreeTarget(t))) choiceErrors.push(`run-targets lists ${t}, but the step runs in a worktree (worktree: true): its run-targets may name only ${[...WORKTREE_TARGETS].join(', ')}`);
  if (value === undefined) return choiceErrors;
  const errors = targetListErrors(value);
  if (!usesMachine(step)) errors.push('run-targets is set on a step that uses no machine (gates, human steps, waits and harness bookkeeping run with control on the Mac)');
  const list = (asList(value) ?? []).filter(t => RUN_TARGETS.includes(t));
  if (needsDocker(step)) for (const t of list.filter(isSubstrateTarget)) errors.push(`run-targets lists ${t}, but its command needs Docker, which a Substrate sandbox does not have`);
  if (machineOnly(step)) for (const t of list.filter(isMacTarget)) errors.push(`run-targets lists ${t}, but its command works only in the ticket's machine`);
  return [...errors, ...choiceErrors];
}

// modeOf(targets) — the dev-environments mode a run-targets list amounts to, for what still reads one (seat-kinds.js,
// the bash commands): vm+workstation when it has both a Mac machine and a remote one, workstation for remote ones
// alone, else vm.
export function modeOf(targets) {
  const remote = targets.some(t => ['workstation', 'cloud-vm'].includes(HOST_OF[t]) && !isMacTarget(t));
  const local = targets.some(t => HOST_OF[t] === 'local' && !isMacTarget(t));
  return remote && local ? 'vm+workstation' : remote ? 'workstation' : 'vm';
}

// projectRunTargets(json) — a project.json's run targets: { targets (in its order), derived (true when taken from
// its mode), mode (modeOf, or its mode), docker (its sandbox declaration's needs-docker, a Set), poolChoice (ASS-553:
// its dev-environments.pool-choice, null when unset or wrong) }. A bad list is devEnvironmentsErrors' to report;
// read here as the mode's.
export function projectRunTargets(json) {
  const d = json?.['dev-environments'];
  const docker = new Set((Array.isArray(d?.substrate?.['needs-docker']) ? d.substrate['needs-docker'] : []).filter(c => typeof c === 'string'));
  const poolChoice = POOL_CHOICES.includes(d?.['pool-choice']) ? d['pool-choice'] : null;
  const own = asList(d?.['run-targets']);
  if (own && own.length && !targetListErrors(own).length) return { targets: own, derived: false, mode: modeOf(own), docker, poolChoice };
  const mode = MODE_TARGETS[d?.mode] ? d.mode : 'vm';
  return { targets: MODE_TARGETS[mode], derived: true, mode, docker, poolChoice };
}

// poolChoiceOf(step, project, list) — ASS-553: how the step picks among its candidates `list`: its own `pool-choice`,
// else the project's (projectRunTargets' poolChoice), else remote-first when a candidate is a worktree target, else
// first (see "Pool choice" above).
export const poolChoiceOf = (step, project, list = []) => (POOL_CHOICES.includes(step?.['pool-choice']) ? step['pool-choice'] : project?.poolChoice ?? (list.some(isWorktreeTarget) ? 'remote-first' : 'first'));

// candidates(step, project, pool) — AC3, AC6: the targets the step may run on, in order: its own list filtered to the
// project's (projectRunTargets), or the project's; less the substrate targets when it needs Docker (by machine-steps.js
// or the project's declaration), and the Mac targets when its command works only in a machine; in a derived
// vm+workstation project a planning step (`pool` 'planning') on local-vm alone (see the module comment). ASS-554: a
// worktree step (worktreeStep) only the worktree targets of those; a step with no flag and no list of its own not the
// project's worktree targets while a plain machine target is left for it (see "Worktree steps" above) — neither in a
// derived project. No step (`step` undefined: whether any step could take a seat) leaves the list whole. [] when none.
// ASS-556: `mode`, the ticket variation's work mode (work-mode.js workModeOf): in worktree mode a step of a project
// with its own list runs on that list's worktree targets when it has any — the build steps too — and keeps its list
// as it is when it has none; a step flagged `stack: required` is skipped in that mode (steps.js), never placed here.
// Full mode, or none recorded, changes nothing.
export function candidates(step, project = projectRunTargets({}), pool = null, mode = null) {
  const own = asList(step?.['run-targets']);
  let list = own ? own.filter(t => project.targets.includes(t)) : [...project.targets];
  if (needsDocker(step, project.docker)) list = list.filter(t => !isSubstrateTarget(t));
  if (machineOnly(step)) list = list.filter(t => !isMacTarget(t));
  if (project.derived && project.mode === 'vm+workstation' && pool === 'planning') list = list.filter(t => t === 'local-vm');
  if (!project.derived && step && mode === 'worktree' && step.stack !== 'required' && list.some(isWorktreeTarget)) return list.filter(isWorktreeTarget);
  if (!project.derived && worktreeStep(step)) list = list.filter(isWorktreeTarget);
  else if (!project.derived && step && !own && list.some(plainMachine)) list = list.filter(t => !isWorktreeTarget(t));
  return list;
}

// projectTargetErrors(json, devEnv) — AC2: what is wrong with a project's dev-environments.run-targets, each naming the
// field: a bad list; workstation (or workstation-substrate) with no workstation listed, cloud-vm (or
// cloud-vm-substrate) with no cloud VM; a substrate target with no cluster declared on that kind of host
// (ASS-533: dev-environments.substrate.clusters, a list of { machine }: mac is the Mac's, a workstation's or cloud VM's
// id its kind of host, gke none until approved — substrate-config.js clusterHosts); substrate.needs-docker not a list
// of names.
export function projectTargetErrors(json) {
  const d = json?.['dev-environments'];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  const at = 'dev-environments.run-targets', errors = [];
  const sub = d.substrate;
  if (sub !== undefined && (typeof sub !== 'object' || sub === null || Array.isArray(sub))) errors.push('dev-environments.substrate is not an object');
  const docker = sub?.['needs-docker'];
  if (d['pool-choice'] !== undefined && !POOL_CHOICES.includes(d['pool-choice'])) errors.push(`dev-environments.pool-choice ${JSON.stringify(d['pool-choice'])} is not one of ${POOL_CHOICES.join(', ')}`);
  if (docker !== undefined && !(Array.isArray(docker) && docker.every(c => typeof c === 'string' && c.trim() !== ''))) errors.push('dev-environments.substrate.needs-docker is not a list of command names');
  if (d['run-targets'] === undefined) return errors;
  errors.push(...targetListErrors(d['run-targets']).map(e => `${at}: ${e.replace(/^run-targets /, '')}`));
  const list = (asList(d['run-targets']) ?? []).filter(t => RUN_TARGETS.includes(t));
  const has = { workstation: Array.isArray(d.workstations) && d.workstations.length > 0, 'cloud-vm': Array.isArray(d['cloud-vms']) && d['cloud-vms'].length > 0 };
  for (const t of list) {
    const host = HOST_OF[t];
    if (host === 'workstation' && !has.workstation) errors.push(`${at} lists ${t}, but dev-environments.workstations lists no workstation`);
    if (host === 'cloud-vm' && !has['cloud-vm']) errors.push(`${at} lists ${t}, but dev-environments.cloud-vms lists no cloud VM`);
    if (isSubstrateTarget(t) && !clusterHosts(json).has(host)) errors.push(`${at} lists ${t}, but dev-environments.substrate.clusters declares no Substrate cluster on ${host === 'local' ? 'the Mac' : `a ${host === 'cloud-vm' ? 'cloud VM' : 'workstation'}`} (${host})`);
  }
  if (d.mode !== undefined && d['run-targets'] !== undefined && MODE_TARGETS[d.mode] && modeOf(list) !== d.mode) errors.push(`dev-environments.mode ${JSON.stringify(d.mode)} disagrees with ${at} (${modeOf(list)}): remove the mode (project:migrate-run-targets), run-targets replaces it`);
  return errors;
}

// engineSteps(engines, top) — every step of engine `top` and the engines its state-engine steps reach, each once, as
// [{ engine, step }]: the steps a project's tickets can be at.
export function reachableSteps(engines, top) {
  const out = [], seen = new Set(), todo = [top];
  while (todo.length) {
    const name = todo.shift();
    if (!name || seen.has(name) || !engines?.[name]) continue;
    seen.add(name);
    const e = engines[name];
    for (const [key, list] of Object.entries(e)) {
      if (!/(^|-)(steps|trigger)$/.test(key) || !Array.isArray(list)) continue;
      for (const step of list) {
        out.push({ engine: name, step });
        if (step?.action?.type === 'state-engine' && step.action.engine) todo.push(step.action.engine);
      }
    }
  }
  return out;
}

// projectRunTargetProblems(json, engines, top) — AC3, AC6: for a project (its project.json `json`, its engines and its
// execution engine `top`), each machine-using step its tickets can reach whose candidates are none, as { engine, step
// (its id), why }: its list and the project's share nothing, or what is left needs Docker on substrate targets alone,
// or works only in a machine on the Mac targets alone, or (ASS-554) it is a worktree step and the project lists no
// worktree target. Such a step is never started (plan.js). ASS-551: control logs
// them (projectRunTargetErrors) and engine:validate <project> fails on them (src/agent-cli/engine/validate.js), so a
// project's switch of run targets that strands a step is caught before a ticket waits there.
export function projectRunTargetProblems(json, engines, top) {
  const project = projectRunTargets(json), problems = [];
  for (const { engine, step } of reachableSteps(engines, top)) {
    if (!usesMachine(step) || candidates(step, project).length) continue;
    const own = asList(step['run-targets']);
    const listed = own ? own.filter(t => project.targets.includes(t)) : project.targets;
    const flagged = worktreeStep(step) && !project.derived, shared = flagged ? listed.filter(isWorktreeTarget) : listed;
    const why = flagged && listed.length && !shared.length ? `it runs in a worktree (worktree: true), and the project's run targets (${project.targets.join(', ')}) include no worktree target (${[...WORKTREE_TARGETS].join(', ')})`
      : !shared.length ? `its run-targets (${own.join(', ')}) and the project's (${project.targets.join(', ')}) share none`
      : needsDocker(step, project.docker) && shared.every(isSubstrateTarget) ? `its command needs Docker, and the run targets left (${shared.join(', ')}) are Substrate sandboxes`
      : `its command works only in the ticket's machine, and the run targets left (${shared.join(', ')}) are on the Mac`;
    problems.push({ engine, step: step.id, why });
  }
  return problems;
}

// projectRunTargetErrors(json, engines, top) — projectRunTargetProblems as control logs them, each naming the engine,
// the step and why.
export const projectRunTargetErrors = (json, engines, top) => projectRunTargetProblems(json, engines, top)
  .map(p => `engine ${p.engine} step "${p.step}" can run on none of the project's run targets: ${p.why}; it is never started`);
