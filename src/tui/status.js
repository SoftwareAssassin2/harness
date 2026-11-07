// A variation's harness-status: { state, state-engine, sub-status }, the state
// a step id of the state engine named, and sub-status, when there is one, the
// same shape for where it stands in that step's own state engine — nested as
// deep as it goes. Read by control's statusOf (src/control/engine.js), which
// these wrap.
import { statusOf } from '../control/engine.js';

// The step id of the variation's harness-status: its top level.
export const stateOf = v => statusOf({}, undefined, v).state;

// The variation's harness-status and each sub-status beneath it, top level
// first, as statusOf's chain resolved in `engines` ({ [name]: its JSON },
// see enginesOf; none: no steps); [] without one.
export const statusChain = (v, engines = {}) => statusOf(engines, undefined, v).chain;

// enginesOf(workflows) — the dashboard's loaded engines (load.js
// loadWorkflows) as statusOf takes them: { [name]: { steps, ...lists } }.
export const enginesOf = workflows => Object.fromEntries(workflows.map(w => [w.name, { steps: w.steps, ...w.lists }]));

// refinementSteps(workflows, stateEngine) — the steps of the backlog
// refinement engine the execution engine `stateEngine` names (its
// backlog-refinement-steps', ASS-101): where a backlog ticket sits (ASS-144);
// none without one.
export function refinementSteps(workflows, stateEngine) {
  const execution = workflows.find(w => w.name === stateEngine);
  const named = (execution?.lists?.['backlog-refinement-steps'] ?? []).map(s => s.action?.engine).find(Boolean);
  return workflows.find(w => w.name === named)?.steps ?? [];
}

// A merge request's status (ASS-80): Not Created (planned by Write Execution
// Plan, no key, url or build status yet), Open, Merged or Closed; one
// recorded before ASS-80, with none, is Open.
export const mrStatus = m => m.status ?? 'Open';
export const isPlanned = m => mrStatus(m) === 'Not Created';
// One never opened, so without a key, link or build status: a planned one,
// or one merge-request:create marked Closed, its branch having no changes
// (ASS-81). How a short line names it: "planned" or "closed, not opened".
export const isUnopened = m => m.key == null;
export const unopenedAs = m => (isPlanned(m) ? 'planned' : `${mrStatus(m).toLowerCase()}, not opened`);
// What a short line shows after a created one's key: its build status while
// it is open, else its status.
export const mrShown = m => (mrStatus(m) === 'Open' ? m['build-status'] : mrStatus(m));

// A variation's state-changes, each { state-engine, from-state, to-state,
// sub-state-change, timestamp, agent-dispatch-log, work-is-done }: a change
// within a state (to-state its from-state) carries the change made beneath it
// as sub-state-change, the same shape without the timestamp, log and
// work-is-done, nested as deep as it goes.

// The state-changes seen at one level of the status: the changes made in the
// states `parents` names, top level first ([] for the top level), as { ...change,
// from-state, to-state } of that level. Each change made deeper is part of
// the visit before it, so its dispatches join that change's agent-dispatch-log;
// one before any change at the level is left out.
export function levelChanges(v, parents = []) {
  const level = [];
  for (const change of v['state-changes'] ?? []) {
    const path = [];
    for (let at = change; at; at = at['sub-state-change']) path.push(at);
    if (path.length <= parents.length || parents.some((state, i) => path[i]['to-state'] !== state)) continue;
    const { 'sub-state-change': _, ...made } = change;
    const at = path[parents.length];
    if (path.length === parents.length + 1) level.push({ ...made, 'state-engine': at['state-engine'], 'from-state': at['from-state'], 'to-state': at['to-state'], 'agent-dispatch-log': [...(made['agent-dispatch-log'] ?? [])] });
    else level.at(-1)?.['agent-dispatch-log'].push(...(made['agent-dispatch-log'] ?? []));
  }
  return level;
}
