// ticket:operator-needed (ASS-506): the dashboard's Operator Needed set for the
// CLI, so an operator's Claude session can walk the operator through it. The
// state is loaded as the dashboard loads it (src/tui/main.js: load.js's
// loadProjects, loadWorkflows and the transient engines, through app.js's
// initialState) and the set is neededTickets' own (detect.js), never the rules
// again, so the CLI and the dashboard cannot disagree. Read-only: nothing is
// written — the notifier's seen file (operator-needed-seen.json) is not touched.
import { initialState } from '../tui/app.js';
import { loadProjects, loadWorkflows, loadTransientEngines } from '../tui/load.js';
import { sprintTickets, CREDENTIALS_ITEM } from '../tui/screens/shared.js';
import { choiceCommand, gateWaits } from '../tui/ticket.js';
import { neededTickets, neededRow, blockingQuestions } from './detect.js';

// operatorNeededState({ projectsDir, assignmentsFile, enginesDir }) — the
// dashboard's state as its start builds it, the parts neededTickets reads.
// assignmentsFile null (no harness has run yet): no transient engines.
export const operatorNeededState = ({ projectsDir, assignmentsFile, enginesDir }) => initialState({
  projects: loadProjects(projectsDir),
  workflows: loadWorkflows(enginesDir, projectsDir),
  transientEngines: assignmentsFile ? loadTransientEngines(assignmentsFile) : [],
});

// choicesOf(projectId, row) — the choices the dashboard offers at the waiting
// row's gate (humanGate's, as sprintTickets put it on the row: a human step,
// Blocked for Human and Variation Selection among them, a leaving-gate's
// Approve, a pending requirements change's Keep current / Take new), in its
// order, each { decision, leadsTo, argv }: argv the agent.sh command the
// ticket screen runs for it (choiceCommand) — `./agent.sh <argv…>`. One that
// asks why (form 'reason') is marked needs-reason, the reason to go last; one
// with returnSteps also lists them, a step id to follow the reason. [] when
// the row waits at no gate (blocked, or on a question alone).
export const choicesOf = (projectId, row) => (gateWaits(row?.gate) ? row.gate.choices : []).map(choice => ({
  decision: choice.decision,
  leadsTo: choice.leadsTo ?? null,
  argv: choiceCommand(projectId, row, choice),
  ...(choice.form === 'reason' ? { 'needs-reason': true } : {}),
  ...(choice.returnSteps ? { 'return-steps': choice.returnSteps.map(([id]) => id) } : {}),
}));

// operatorNeededOf(state, only) — neededTickets(state), every project's or the
// one `only` names (an unknown one throws), each ticket as neededTickets gives
// it, but its reason's `questions` each { question, where, index }
// (blockingQuestions) instead of the text alone — `question:answer <project>
// <where> <index> <answer>` answers it — and with `choices` (choicesOf) the
// gate's commands, ready to run.
export function operatorNeededOf(state, only) {
  if (only && !state.projects.some(p => p.id === only)) throw new Error(`no project ${only}`);
  const needed = neededTickets(state);
  return Object.fromEntries(Object.entries(needed).filter(([id]) => !only || id === only).map(([id, list]) => {
    const i = state.projects.findIndex(p => p.id === id), project = state.projects[i];
    // The rows neededTickets picked from: sprintTickets on the project's live sprint, as it asks.
    const { tickets } = sprintTickets({ ...state, project: i, day: null });
    return [id, list.map(t => {
      if (t.key === CREDENTIALS_ITEM && t.project) return t;
      const reason = t.reason.questions ? { ...t.reason, questions: blockingQuestions(project, t.key) } : t.reason;
      return { ...t, reason, choices: choicesOf(id, neededRow(tickets, t.key)) };
    })];
  }));
}

// operatorNeededReport({ projectsDir, assignmentsFile, enginesDir, project }) — both at once.
export const operatorNeededReport = ({ project, ...paths }) => operatorNeededOf(operatorNeededState(paths), project);
