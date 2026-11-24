// Validates an engines/<workflow>/workflow.yaml (ASS-524: a state-engine.json
// before; validateEngineFile reads one, naming the line a malformed file fails
// at, engine-file.js). Returns a list of
// human-readable errors; empty = valid. Engine-wide settings consumed where
// they are read (e.g. check-health-interval-seconds, triggers.js); ASS-450:
// keys the harness no longer reads (obsolete.js) are ignored, never an error,
// so an engine still declaring them validates as it would without; ASS-44's
// ready-tickets-join-sprint-at is checked here against the engine's own step
// ids — the only engine-level setting whose value is a step id.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryName, EACH } from '../control/repositories.js';
import { stepOf } from '../control/engine.js';
import { dataDir } from '../data-folder.js';
import { withoutObsolete } from './obsolete.js';
import { commandOf, unknownScriptCommand } from '../control/machine-steps.js';
import { engineFileIn, readEngine as readEngineFile } from './engine-file.js';
import { stepRunTargetErrors } from '../control/run-targets.js';
import { stepWorkModeErrors } from '../control/work-mode.js';

// readEngine(file) — engine-file.js's, kept while the file is unchanged (its
// mtime and size): validation reads the same sub-engines again and again
// (stepsOf, reaches, refinementEngine), and YAML parses slower than JSON did.
const parsedEngines = new Map();
function readEngine(file) {
  const { mtimeMs, size } = statSync(file);
  const kept = parsedEngines.get(file);
  if (kept?.mtimeMs === mtimeMs && kept.size === size) return kept.engine;
  const engine = readEngineFile(file);
  parsedEngines.set(file, { mtimeMs, size, engine });
  return engine;
}

const ACTION_TYPES = new Set(['script', 'prompt', 'state-engine', 'human', 'none']);
const LEGACY_ACTION_FIELDS = ['script-to-execute', 'prompt-to-execute', 'workflow-to-execute', 'prompt-mode', 'prompt-timer-minutes'];
const LEAVES = new Set([
  'always', 'agent-needs-work', 'turn-complete', 'file-updated', 'structured-output', 'script-output',
  'script-succeeds', 'exit-code', 'ticket-system-status', 'human-review', 'variation-selected', 'has-variations', 'workflow-ended',
  'is-done', 'structured-ticket-variation-array-check', 'sub-engine-ended-at', 'open-questions', 'all-questions-accepted', 'fast-tracked',
]);
// Leaves that report a check which can fail; a step that waits on one must also handle the failure.
const CHECKED_LEAVES = ['exit-code', 'script-succeeds', 'file-updated'];
// The placeholders control fills in a script command: the ticket, its
// project and variation, and what a transient run's structured output
// carries (see the self-healing engine; merge-request-ids, ASS-365: grouped-merge's set;
// fix-merge-request, ASS-390: grouped-blocked's Repair Project's).
const PLACEHOLDERS = new Set(['ticket', 'work-item', 'project', 'variation', 'summary', 'ticket-url', 'pause-tickets', 'human-action', 'missing-repository', 'failing-repository', 'failing-job', 'no-ticket-reason', 'no-ticket-why', 'merge-request-ids', 'fix-merge-request', 'run']);

// Where each list's run starts: its lowest-sequence step (moves.js firstStepId), which may not be switched off.
const firstsOf = engine => new Set(Object.entries(engine).filter(([key]) => /(^|-)(steps|trigger)$/.test(key)).map(([, list]) => list.toSorted((a, b) => a.sequence - b.sequence)[0]?.id));

// switchOffErrors(step, firsts) — why the step cannot be switched off (ASS-192): it has no exit to pass it by, or is its list's first step (`firsts`) or a done step.
function switchOffErrors(s, firsts) {
  const at = `step "${s.id}"`, errors = [];
  if (!s['exit-events']?.[0]?.['move-to-state']) errors.push(`${at} is switched off but has no exit event with a move-to-state first, to pass it by`);
  if (firsts.has(s.id)) errors.push(`${at} is switched off but is the first step`);
  if (s['is-done'] === true) errors.push(`${at} is switched off but is a done step`);
  return errors;
}

// switchedOffStepErrors(entry, engines) — what is wrong with one entry of a project.json's switched-off-steps
// (ASS-209: "<engine>/<step-id>", that step switched off for the project alone): it names no engine of `engines`
// ({ [name]: its JSON }), no step of it, or one ASS-192's rules keep on (switchOffErrors); [] when none.
export function switchedOffStepErrors(entry, engines) {
  const at = `switched-off step "${entry}"`;
  const [name, id, extra] = typeof entry === 'string' ? entry.split('/') : [];
  if (!name || !id || extra !== undefined) return [`${at} is not "<engine>/<step-id>"`];
  const engine = engines[name];
  if (!engine) return [`${at} names no engine "${name}"`];
  const s = stepOf(engine, id);
  if (!s) return [`${at}: engine "${name}" has no step "${id}"`];
  return switchOffErrors(s, firstsOf(engine)).map(e => `${at}: ${e}`);
}

// engineFile(root, name, own) — engine `name`'s workflow.yaml: in `own`,
// a project's own engines folder (data/projects/<project>/engines, ASS-276),
// over engines/'s of the same name, as control's loadState reads them.
const engineFile = (root, name, own) => (own && existsSync(engineFileIn(own, name))
  ? engineFileIn(own, name) : engineFileIn(join(root ?? '', 'engines'), name));

// validateEngineFile(file, root, name, own) — validateStateEngine of the engine
// in `file` (a workflow.yaml); a file that does not read is one error,
// "<file>:<line>:<column>: <reason>" (ASS-524 AC4: engine-file.js parseEngine),
// as a bad state-engine.json's JSON.parse error named it before.
export function validateEngineFile(file, root, name, own) {
  let engine;
  try { engine = readEngine(file); } catch (error) { return [error.message]; }
  return validateStateEngine(engine, root, name, own);
}

// validateStateEngine(engine, root, name, own) — `name` the engine's folder
// under engines/ (or `own`), which says whose repositories its steps may name
// (checkRepository); `own`, when given, the engines folder of the project the
// engine is its own of (ASS-277): the engines its steps run are found there
// before engines/, as control finds them for that project's work.
export function validateStateEngine(engine, root, name, own) {
  engine = withoutObsolete(engine);
  const errors = [];
  const steps = engine.steps ?? [];
  // steps, plus every side list of them: top-level arrays named *-steps or *-trigger.
  const all = Object.entries(engine).filter(([key]) => /(^|-)(steps|trigger)$/.test(key)).flatMap(([, list]) => list);

  const byId = new Map();
  const subSteps = new Map();   // sub-engine name → its steps, each engine read once (stepsOf)
  for (const s of all) {
    if (!s.id) errors.push(`step "${s.name}" has no id`);
    else if (byId.has(s.id)) errors.push(`duplicate id "${s.id}"`);
    else byId.set(s.id, s);
  }
  const sequence = new Map(steps.map(s => [s.id, s.sequence]));
  const firsts = firstsOf(engine);
  // A backlog refinement engine's first step is groomed only once the ticket is due (ASS-144: dispatch.js, plan.js refinementDue): a loop back to it waits on a change.
  const restart = refinementEngine(root, name, own) ? steps.toSorted((a, b) => a.sequence - b.sequence)[0]?.id : undefined;

  // ready-tickets-join-sprint-at (ASS-44): names the step a ready backlog ticket joins the sprint at; must be a string naming a known step id.
  const joinAt = engine['ready-tickets-join-sprint-at'];
  if (joinAt !== undefined && (typeof joinAt !== 'string' || !byId.has(joinAt)))
    errors.push(`ready-tickets-join-sprint-at points at unknown step "${joinAt}"`);
  // removed-steps-move-to (ASS-552): a removed step's id → the step a ticket still at it goes on to; the removed one no step, the other a known one.
  const removed = engine['removed-steps-move-to'];
  if (removed !== undefined && (removed === null || typeof removed !== 'object' || Array.isArray(removed))) errors.push('removed-steps-move-to is not a map of <removed step>: <step>');
  else for (const [gone, to] of Object.entries(removed ?? {})) {
    if (byId.has(gone)) errors.push(`removed-steps-move-to names "${gone}", which is still a step`);
    if (typeof to !== 'string' || !byId.has(to)) errors.push(`removed-steps-move-to moves "${gone}" to unknown step "${to}"`);
  }

  for (const s of all) {
    const at = `step "${s.id}"`;
    const action = s.action;
    checkAction(s, at, root, errors, own);

    if (s['max-visits'] && !s['on-max-visits']) errors.push(`${at} has max-visits without on-max-visits`);
    if (s['on-max-visits'] && !byId.has(s['on-max-visits'])) errors.push(`${at} on-max-visits points at unknown step "${s['on-max-visits']}"`);

    // area "quarantine" sets the step apart from the conveyor on the dashboard's flowchart.
    if (s.area !== undefined && s.area !== 'quarantine') errors.push(`${at} area "${s.area}" is not "quarantine"`);
    // run-location (ASS-74): host (also when missing) or vm, the variation's VM; a vm step calls only what the forwarder allows (checkVmStep).
    if (s['run-location'] !== undefined && s['run-location'] !== 'host' && s['run-location'] !== 'vm') errors.push(`${at} run-location "${s['run-location']}" is not host or vm`);
    if (s['run-location'] === 'vm') checkVmStep(s, at, root, errors);
    if (s['run-in-repository'] !== undefined) checkRepository(s, at, root, name, errors);
    // run-targets (ASS-540, run-targets.js): one run target or a list, only on a machine-using step; never a substrate
    // target for a command that needs Docker, nor a Mac target for one that works only in a machine. Each error names
    // the engine's file, the step and the reason.
    for (const e of stepRunTargetErrors(s)) errors.push(`${name ? `${engineFile(root, name, own).replace(`${root ?? ''}/`, '')}: ` : ''}${at} ${e}`);
    // stack (ASS-556, work-mode.js): required, on a step needing the running app stack — skipped in worktree mode; never on a worktree step.
    for (const e of stepWorkModeErrors(s)) errors.push(`${name ? `${engineFile(root, name, own).replace(`${root ?? ''}/`, '')}: ` : ''}${at} ${e}`);
    // vm (ASS-75): the variation's VM runs at the step, or is kept there stopped; missing, it is not needed (src/control/vm-lifecycle.js, vm.bash);
    // released (ASS-325), it is deleted there at once, its disk back to the project's VM disk budget.
    if (s.vm !== undefined && s.vm !== 'running' && s.vm !== 'stopped' && s.vm !== 'released') errors.push(`${at} vm "${s.vm}" is not running, stopped or released`);
    // is-active (ASS-192): false switches the step off — passed at once by its first exit's move-to-state (steps.js);
    // absent is on. A run's first step and a done step, where nothing passes on, cannot be.
    if (s['is-active'] !== undefined && typeof s['is-active'] !== 'boolean') errors.push(`${at} is-active "${s['is-active']}" is not true or false`);
    if (s['is-active'] === false) errors.push(...switchOffErrors(s, firsts));
    // restarts-visit-count (ASS-264): a move out of the step counts every step's visits afresh (engine.js sinceResolution) —
    // a person's choice there, so on a human step alone, never one an agent's output could loop through.
    if (s['restarts-visit-count'] !== undefined && typeof s['restarts-visit-count'] !== 'boolean') errors.push(`${at} restarts-visit-count "${s['restarts-visit-count']}" is not true or false`);
    else if (s['restarts-visit-count'] === true && action?.type !== 'human') errors.push(`${at} has restarts-visit-count but is no human step`);
    // shows-merge-train (ASS-363): a variation whose status chain is at the step gets the sprint grid's
    // "↳ AWAITING MERGE" Ticket-cell line (sprint.js mergeTrains) — the flag says so, never the step's id or name.
    // Any step may have it; it must be true or false.
    if (s['shows-merge-train'] !== undefined && typeof s['shows-merge-train'] !== 'boolean') errors.push(`${at} shows-merge-train "${s['shows-merge-train']}" is not true or false`);
    // is-qa (ASS-401): a variation whose status chain is at the step is in QA — the sprint grid's purple
    // "in progress ↓ · ↑ in QA" line (sprint.js boundaries) goes under its rows. Any step; true or false.
    if (s['is-qa'] !== undefined && typeof s['is-qa'] !== 'boolean') errors.push(`${at} is-qa "${s['is-qa']}" is not true or false`);
    // merges-awaited (ASS-365): while a variation's status chain is at the step, control has Build's Await Sequential
    // Merge merge the merge requests it waits on (engine.js mergesAwaited) — the flag says so, never the step's id or name.
    // It must be true or false. Set on a state-engine step whose sub-engine can end at blocked-for-human (grouped-build,
    // when an awaited merge request's approval wait expires), the step must read that end: else the ended run matches
    // its bare is-done exit and the ticket moves on, unmerged, as if Build had passed.
    if (s['merges-awaited'] !== undefined && typeof s['merges-awaited'] !== 'boolean') errors.push(`${at} merges-awaited "${s['merges-awaited']}" is not true or false`);
    else if (s['merges-awaited'] === true && action?.type === 'state-engine' && stepsOf(action.engine, root, subSteps, own)?.some(x => x.id === 'blocked-for-human' && x['is-done'] === true)
      && !(s['exit-events'] ?? []).some(e => leavesOf(e.condition).some(l => l.key === 'sub-engine-ended-at' && l.value === 'blocked-for-human')))
      errors.push(`${at} has merges-awaited but no exit for sub-engine-ended-at "blocked-for-human", where "${action.engine}" ends when an awaited merge request's approval wait expires`);
    // pass-output (ASS-365): the fields of the step's own run's structured-output the sub-engine run it starts begins with
    // (steps.js passedOutput: grouped-build's Merge the Awaited hands grouped-merge its merge-request-ids) — a list of
    // field names, on a state-engine step alone.
    if (s['pass-output'] !== undefined) {
      if (!Array.isArray(s['pass-output']) || !s['pass-output'].every(f => typeof f === 'string' && f !== '')) errors.push(`${at} pass-output is not a list of field names`);
      else if (action?.type !== 'state-engine') errors.push(`${at} has pass-output but is no state-engine step`);
    }
    // color paints the step on the dashboard: its progress-bar run and status square.
    if (s.color !== undefined && !/^#[0-9a-f]{6}$/i.test(s.color)) errors.push(`${at} color "${s.color}" is not #rrggbb`);

    if (s['return-to-state'] && !byId.has(s['return-to-state'])) errors.push(`${at} return-to-state points at unknown step "${s['return-to-state']}"`);
    // A step that hands back with follow-return-to-state (e.g. blocked) needs to know where each sender wants the ticket
    // returned — unless the sender hands back itself (blocked forwarding to blocked-for-human passes the original target on).
    const targets = [s['on-max-visits'], ...(s['exit-events'] ?? []).map(e => e['move-to-state'])];
    for (const t of new Set(targets))
      if (byId.get(t)?.['exit-events']?.some(e => e['follow-return-to-state']) && !s['return-to-state'] && !s['follow-return-to-state']) errors.push(`${at} can move to "${t}" but has no return-to-state`);

    const positive = [], negated = [];
    for (const exit of s['exit-events'] ?? []) {
      if (!checkCondition(exit.condition, at, root, errors)) continue;
      collectLeaves(exit.condition, positive, negated);
      checkStartAt(exit, byId, at, root, subSteps, errors, own);

      // cause (ASS-315: merge-gate-red) is recorded on the move the exit makes as given (steps.js), and
      // read by value to restart the visit window (engine.js sinceResolution), so it must be a string:
      // anything else would match no cause control looks for, and nothing would say so.
      if (exit.cause !== undefined && typeof exit.cause !== 'string') errors.push(`${at} exit cause "${exit.cause}" is no string`);

      const target = exit['move-to-state'];
      if (target === undefined) continue;
      if (!byId.has(target)) { errors.push(`${at} moves to unknown step "${target}"`); continue; }

      const from = sequence.get(s.id), to = sequence.get(target);
      if (from === undefined || to === undefined) continue;
      // A loop through a human step waits on a person, so it can't run away — into one, or out of one by the
      // person's choice (ASS-252: Reject at Awaiting Split Decision, back to Split); a quarantine step (Blocked) is off
      // the conveyor, not a step back along it, and caps itself (ASS-107: by failed fix attempts); anything else needs a cap.
      const off = byId.get(target).action?.type === 'human' || action?.type === 'human' || byId.get(target).area === 'quarantine' || target === restart;
      if (to <= from && !off && !byId.get(target)['max-visits']) errors.push(`${at} loops back to "${target}", which has no max-visits`);

      const approved = leavesOf(exit.condition).find(l => l.key === 'structured-output')?.value['is-approved'];
      if (approved === true && to <= from) errors.push(`${at} approval moves back to "${target}"`);
      // …unless the engine ends there: a sub-engine's verdict is carried to its parent step, which decides.
      if (approved === false && to > from && !byId.get(target)['is-done']) errors.push(`${at} rejection moves forward to "${target}"`);
    }

    // A waiting exit code (ASS-253) keeps the step where it is, so no exit may take it: neither one naming it nor a not-exit-code.
    const waits = action?.['waiting-exit-code'];
    if (Number.isInteger(waits) && (positive.some(l => l.key === 'exit-code' && l.value === waits) || negated.some(l => l.key === 'exit-code' && l.value !== waits)))
      errors.push(`${at}: an exit takes its waiting-exit-code ${waits}`);

    // Timer steps rerun on the next tick when no exit matches, so an unhandled failure retries itself.
    if (action?.mode !== 'timer') {
      for (const key of CHECKED_LEAVES) {
        const checks = positive.filter(l => l.key === key);
        // Any negated exit-code exit catches every code no other exit names, so codes may be routed before it.
        const covered = c => negated.some(n => n.key === key && (key === 'exit-code' || same(n.value, c.value)));
        if (checks.some(c => !covered(c)))
          errors.push(`${at} has no exit for when ${key} fails`);
      }
    }

    // sub-engine-ended-at (ASS-68): the done step of this step's own sub-engine its run ended at.
    for (const leaf of positive.concat(negated).filter(l => l.key === 'sub-engine-ended-at')) {
      if (action?.type !== 'state-engine') { errors.push(`${at} reads sub-engine-ended-at but its action is "${action?.type}"`); continue; }
      const done = stepsOf(action.engine, root, subSteps, own)?.find(x => x.id === leaf.value)?.['is-done'] === true;
      if (!done) errors.push(`${at} reads sub-engine-ended-at "${leaf.value}", which is not a done step of "${action.engine}"`);
    }

    if (action && action.type !== 'script' && positive.concat(negated).some(l => l.key === 'script-output'))
      errors.push(`${at} reads script-output but its action is "${action.type}"`);

    if (action?.type === 'prompt') {
      const fields = positive.concat(negated).filter(l => l.key === 'structured-output').flatMap(l => Object.keys(l.value));
      for (const exit of s['exit-events'] ?? []) if (exit['move-to-state-from-structured-output']) fields.push(exit['move-to-state-from-structured-output']);
      if (fields.length) checkOutputSchema(action.prompt, fields, at, root, errors);
    }
  }
  return errors;
}

function checkAction(s, at, root, errors, own) {
  for (const f of LEGACY_ACTION_FIELDS) if (f in s) errors.push(`${at} uses legacy field "${f}"; use "action"`);
  const a = s.action;
  if (!a) return errors.push(`${at} has no action`);
  if (!ACTION_TYPES.has(a.type)) return errors.push(`${at} has unknown action type "${a.type}"`);
  if (a.mode === 'timer' && !(a['timer-minutes'] > 0)) errors.push(`${at} timer action needs timer-minutes`);
  // waiting-exit-code (ASS-253): a timer script's "not yet", polled again with no failure counted (steps.js scriptExited).
  if ('waiting-exit-code' in a) {
    if (a.type !== 'script' || a.mode !== 'timer') errors.push(`${at} waiting-exit-code needs a timer script action`);
    else if (!Number.isInteger(a['waiting-exit-code']) || a['waiting-exit-code'] === 0) errors.push(`${at} waiting-exit-code must be a non-zero exit code`);
  }
  // model (ASS-399, ASS-452): the model a prompt step's agents run on (dispatch.js modelFor) — one of
  // harness.json's claude models, which its prompt's prompt.json supported-models, when it lists any,
  // must name; or "stronger", harness.json's stronger-model, else its first Claude model. Missing,
  // assignments:create's round robin.
  if ('model' in a) {
    const models = claudeModels(root);
    if (a.type !== 'prompt') errors.push(`${at} model needs a prompt action`);
    else if (a.model !== 'stronger' && !models.includes(a.model))
      errors.push(`${at} model "${a.model}" is not "stronger" or one of harness.json's claude models (${models.join(', ') || 'none'})`);
    else if (a.model !== 'stronger') {
      const supported = supportedModels(root, a.prompt);
      if (supported.length && !supported.includes(a.model)) errors.push(`${at} model "${a.model}" is not in prompt "${a.prompt}"'s supported-models (${supported.join(', ')})`);
    }
  }
  if (a.type === 'script') {
    checkCommand(a.command, at, root, errors);
    // ASS-527 AC4: whether a script step uses the ticket's machine (and so holds a seat) is declared once, in
    // src/control/machine-steps.js SCRIPT_COMMANDS; a command it does not list is an error, so a new one is declared, not guessed.
    const unknown = commandOf(a.command) && unknownScriptCommand(a.command);
    if (unknown) errors.push(`${at} runs ${unknown}, which src/control/machine-steps.js SCRIPT_COMMANDS does not declare as in-machine or host`);
  }
  if (a.type === 'state-engine') {
    if (typeof a.engine !== 'string') errors.push(`${at} state-engine action has no engine`);
    else if (!(own && existsSync(join(own, a.engine))) && !existsSync(join(root, 'engines', a.engine))) errors.push(`${at} has unknown state engine "${a.engine}"`);
  }
}

// claudeModels(root) — harness.json's claude models (data/harness.json under
// root), the ones a prompt step's action.model may name (ASS-452); [] without it.
function claudeModels(root) {
  const file = join(dataDir(root ?? ''), 'harness.json');
  const harness = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return (harness['agentic-command-line-interfaces'] ?? []).find(c => c.name === 'claude')?.models ?? [];
}

// supportedModels(root, prompt) — the prompt's prompt.json supported-models; [] when it has none.
function supportedModels(root, prompt) {
  const file = join(root ?? '', 'prompts', prompt ?? '', 'prompt.json');
  const list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))['supported-models'] : undefined;
  return Array.isArray(list) ? list : [];
}

// start-sub-engine-at (ASS-66): an exit entering a state-engine step names
// the step its sub-engine starts at — so only beside a move-to-state into a
// state-engine step, and naming one of that engine's `steps` (read from
// engines/<engine>/workflow.yaml, or `own`'s, once per engine through `subSteps`).
function checkStartAt(exit, byId, at, root, subSteps, errors, own) {
  const start = exit['start-sub-engine-at'];
  if (start === undefined) return;
  const target = exit['move-to-state'];
  if (target === undefined) return errors.push(`${at} start-sub-engine-at needs a move-to-state`);
  if (!byId.has(target)) return;   // reported as an unknown step
  const action = byId.get(target).action;
  if (action?.type !== 'state-engine' || typeof action.engine !== 'string') return errors.push(`${at} start-sub-engine-at needs "${target}" to be a state-engine step`);
  const ids = stepsOf(action.engine, root, subSteps, own);
  if (ids && !ids.some(s => s.id === start)) errors.push(`${at} starts sub-engine "${action.engine}" at unknown step "${start}"`);   // no engine: reported as unknown
}

// stepsOf(name, root, cache, own) — engine `name`'s `steps` (engineFile), read once per engine through `cache`; null when there is no such engine.
// refinementEngine(root, name, own) — whether some engine's, engines/'s or `own`'s, backlog-refinement-steps runs engine `name` (ASS-144).
function refinementEngine(root, name, own) {
  if (!name) return false;
  return [join(root ?? '', 'engines'), ...(own ? [own] : [])].filter(dir => existsSync(dir)).some(dir => readdirSync(dir).some(d => {
    const file = engineFileIn(dir, d);
    return existsSync(file) && (readEngine(file)['backlog-refinement-steps'] ?? []).some(x => x.action?.engine === name);
  }));
}

function stepsOf(name, root, cache, own) {
  if (!cache.has(name)) {
    const file = engineFile(root, name, own);
    cache.set(name, existsSync(file) ? readEngine(file).steps ?? [] : null);
  }
  return cache.get(name);
}

// "./agent.sh family:command {ticket}" → src/agent-cli/family/command.sh must exist.
function checkCommand(command, at, root, errors) {
  const m = /^\.\/(agent|off-board)\.sh ([\w-]+)(?::([\w-]+))?/.exec(command ?? '');
  if (!m) return errors.push(`${at} has an unrecognized command "${command}"`);
  const [token, cli, family, name] = m;
  const script = name ? join(root, 'src', `${cli}-cli`, family, `${name}.sh`) : join(root, 'src', `${cli}-cli`, `${family}.sh`);
  if (!existsSync(script)) errors.push(`${at} has no script for "${token}"`);
  else if (statSync(script).size === 0) errors.push(`${at} has an empty script for "${token}"`);
  for (const [, p] of command.matchAll(/\{([^}]+)\}/g)) if (!PLACEHOLDERS.has(p)) errors.push(`${at} uses unknown placeholder {${p}}`);
}

// checkVmStep — a step run in the variation's VM reaches the Mac only through
// the forwarder (src/control/forwarder.js), so its script's command and every
// `{agent-sh} <command>` its prompt (prompt.txt and its persona) names must be
// on the forwarder's allowlist; and its prompt never uses {harness-folder} or
// {project-folder}: neither is mounted in a VM. The commands the dispatch
// templates fill in ({status-update-command}, {approve-command}, the reply and
// send-message commands) are on the allowlist always.
function checkVmStep(s, at, root, errors) {
  const file = join(root, 'src', 'control', 'forwarder-allowlist.json');
  const allowed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const ok = command => Object.hasOwn(allowed, command) && !command.startsWith('_');
  const a = s.action ?? {};
  if (a.type === 'script') {
    const command = /^\.\/agent\.sh (\S+)/.exec(a.command ?? '')?.[1];
    if (command && !ok(command)) errors.push(`${at} runs in the VM but calls ${command}, which the forwarder does not allow`);
  }
  if (a.type !== 'prompt') return;
  const read = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const json = join(root, 'prompts', a.prompt ?? '', 'prompt.json');
  const persona = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')).persona : undefined;
  const text = read(join(root, 'prompts', a.prompt ?? '', 'prompt.txt')) + (persona ? read(join(root, 'personas', `${persona}.md`)) : '');
  for (const command of new Set([...text.matchAll(/\{agent-sh\} (\S+)/g)].map(m => m[1])))
    if (!ok(command)) errors.push(`${at} runs in the VM but its prompt calls ${command}, which the forwarder does not allow`);
  for (const p of ['harness-folder', 'project-folder'])
    if (text.includes(`{${p}}`)) errors.push(`${at} runs in the VM but its prompt uses {${p}}, which is not mounted there`);
}

// checkRepository — run-in-repository (ASS-119) is "each" or names a
// repository of a project that runs the engine: one whose
// execution-state-engine is `name` or reaches it through state-engine
// actions; when none does (or no name is given), any project's. Only a prompt
// step has it: its agent is what starts in the repository.
function checkRepository(s, at, root, name, errors) {
  const repo = s['run-in-repository'];
  if (typeof repo !== 'string' || !repo) return errors.push(`${at} run-in-repository must name a repository or be "each"`);
  if (s.action?.type !== 'prompt') return errors.push(`${at} has run-in-repository, but only a prompt step runs in a repository`);
  if (repo === EACH) return;
  const dir = join(dataDir(root), 'projects');
  const projects = (existsSync(dir) ? readdirSync(dir) : []).map(id => ({ id, file: join(dir, id, 'project.json') })).filter(p => existsSync(p.file))
    .map(p => ({ ...p, json: JSON.parse(readFileSync(p.file, 'utf8')) }));
  const running = name ? projects.filter(p => reaches(p.json['execution-state-engine'], name, root, join(dir, p.id, 'engines'))) : [];
  const own = running.length ? running : projects;
  const names = p => (p.json.repositories ?? []).map(r => repositoryName(r.url));
  if (own.some(p => names(p).includes(repo))) return;
  errors.push(`${at} runs in repository "${repo}", which no project${running.length ? ` running engine "${name}"` : ''} declares (${own.map(p => `${p.id}: ${names(p).join(', ')}`).join('; ')})`);
}

// reaches(from, name, root, own) — engine `from` is `name`, or one of its steps' state-engine actions, in any of its lists, runs an engine that reaches it;
// `own` the project's own engines folder, read before engines/ (engineFile).
function reaches(from, name, root, own, seen = new Set()) {
  if (typeof from !== 'string' || seen.has(from)) return false;
  if (from === name) return true;
  seen.add(from);
  const file = engineFile(root, from, own);
  if (!existsSync(file)) return false;
  const lists = Object.entries(withoutObsolete(readEngine(file))).filter(([key, list]) => /(^|-)(steps|trigger)$/.test(key) && Array.isArray(list)).flatMap(([, list]) => list);
  return lists.some(s => s.action?.type === 'state-engine' && reaches(s.action.engine, name, root, own, seen));
}

function checkCondition(c, at, root, errors) {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return !errors.push(`${at} condition must be an object, got ${JSON.stringify(c)}`);
  const keys = Object.keys(c);
  if (keys.length !== 1) return !errors.push(`${at} condition must have exactly one key, got ${JSON.stringify(keys)}`);
  const [key] = keys;
  if (key === 'all') {
    if (!Array.isArray(c.all) || !c.all.length) return !errors.push(`${at} "all" needs a non-empty array`);
    return c.all.map(x => checkCondition(x, at, root, errors)).every(Boolean);
  }
  if (key === 'not') return checkCondition(c.not, at, root, errors);
  if (!LEAVES.has(key)) return !errors.push(`${at} has unknown condition "${key}"`);
  if (key === 'script-succeeds') {
    checkCommand(c[key], at, root, errors);
    const unknown = commandOf(c[key]) && unknownScriptCommand(c[key]);   // ASS-527 AC4: a check's command is declared too
    if (unknown) errors.push(`${at} checks ${unknown}, which src/control/machine-steps.js SCRIPT_COMMANDS does not declare as in-machine or host`);
  }
  if (key === 'structured-ticket-variation-array-check') return checkArrayCheck(c[key], at, errors);
  return true;
}

// { "member-name": "acceptance-criteria", "min-length": 1 } — the variation's array <member-name> has at least <min-length> items.
function checkArrayCheck(v, at, errors) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return !errors.push(`${at} structured-ticket-variation-array-check must be an object, got ${JSON.stringify(v)}`);
  if (typeof v['member-name'] !== 'string') errors.push(`${at} structured-ticket-variation-array-check needs a string member-name`);
  if (!Number.isInteger(v['min-length']) || v['min-length'] < 0) errors.push(`${at} structured-ticket-variation-array-check needs an integer min-length of 0 or more`);
  return true;
}

// Splits a condition's leaves into those that must hold and those under a "not".
function collectLeaves(c, positive, negated, inNot = false) {
  const [key] = Object.keys(c);
  if (key === 'all') return c.all.forEach(x => collectLeaves(x, positive, negated, inNot));
  if (key === 'not') return collectLeaves(c.not, positive, negated, !inNot);
  (inNot ? negated : positive).push({ key, value: c[key] });
}

function leavesOf(c) {
  const positive = [];
  collectLeaves(c, positive, []);
  return positive;
}

function checkOutputSchema(prompt, fields, at, root, errors) {
  const file = join(root, 'prompts', prompt ?? '', 'prompt.json');
  const properties = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).output?.properties : undefined;
  if (!properties) return errors.push(`${at} prompt "${prompt}" has no output schema`);
  for (const f of new Set(fields)) if (!(f in properties)) errors.push(`${at} "${f}" is not in the output schema of prompt "${prompt}"`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// promptWriteErrors(root) — ASS-182: the harness's data changes only through
// agent.sh, which validates and locks every write (a confined host agent may
// write only temp, a VM's /mnt/ticket is read-only), so every
// prompts/*/prompt.txt and personas/*.md under root is scanned for an
// instruction — a sentence — to write, append, save or create a file under
// {ticket-folder}, {project-folder} or data/ that names no {agent-sh} command;
// a folder in parentheses straight after "(" is a reference, not the target.
// FLAT_PROMPTS, the flat reference engines' own (harness-development,
// a project's own flat engine and their test sub-engine), are never changed and run
// on the host: left out. One error per such instruction, "<file>:<line> …"; [] when none.
const FLAT_PROMPTS = new Set(['enrich-ac', 'take-screenshots']);
const DIRECT_WRITE = /\b(?:write|writes|writing|append|appends|save|saves|create|creates)\b.*?(?<!\()(?:\{ticket-folder\}|\{project-folder\}|(?<![\w./-])data\/)/i;
export function promptWriteErrors(root) {
  const list = dir => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).toSorted() : []);
  const files = [...list('personas').filter(f => f.endsWith('.md')).map(f => join('personas', f)),
    ...list('prompts').filter(p => !FLAT_PROMPTS.has(p)).map(p => join('prompts', p, 'prompt.txt')).filter(f => existsSync(join(root, f)))];
  return files.flatMap(file => readFileSync(join(root, file), 'utf8').split('\n').flatMap((line, i) => line.split(/(?<=[.!?;])\s+/)
    .filter(s => DIRECT_WRITE.test(s) && !s.includes('{agent-sh}'))
    .map(s => `${file}:${i + 1} writes the harness's data directly — name the {agent-sh} command that writes it: "${s.trim()}"`)));
}
