// The backlog flow screen (B): the refinement engine's steps as stations (ASS-201: moved from app.js).
import { flowchart, NOTE_WIDTH } from '../flowchart.js';
import { floorNotes } from '../metrics.js';
import { scrollBox } from '../table.js';
import { link } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { backlogTickets, refinementOf, backlogPriority, chooseView, viewChoice, refinementSteps, projectWorkflows, projectAssignments } from './shared.js';
import { nestedFloor, subflowHint, scrollsFloor, floorScroll } from './nested.js';
import { isHeld } from '../../control/engine.js';

// The backlog flow screen (B): the steps of the project's refinement engine
// (refinementSteps, ASS-144) as stations, in sequence, each listing its
// tickets in backlog order (backlogTickets) with their priority as the backlog
// screen shows it, or — as S offers (backlogFlowView) — each step's run-time
// metrics from the backlog tickets' refinement histories (their variations'
// state-changes, ASS-42). Today's backlog, whatever the day; no exit marks, so
// no floor legend. A step running a sub-engine is a box of that engine's
// stations, as on S (nestedFloor, ASS-245): each ticket under its deepest
// step with a 🤖 per agent refining it and a 💻 while that step is a script
// and the ticket is not held.
function backlogFlowView(state, { columns = 0, rows = Infinity, now = 0 }) {
  const steps = refinementSteps(state);
  const station = s => ({ id: s.id, name: s.name ?? s.id, sequence: s.sequence, color: '#5f87af', 'is-active': s['is-active'], action: s.action, area: s.area });   // switched off: marked so (ASS-192)
  const [choice, hint, gap] = viewChoice(state.backlogFlowView, state.focus === 'backlogflow');
  const head = [choice, `${hint}   ${subflowHint(state.backlogFlowExpanded)}`, gap];
  const entries = backlogTickets(state).map(t => {
    const name = `${t.key}: ${t.title ?? ''}`;
    const status = refinementOf(state, t);
    return {
      path: status.chain.map(l => l.state),
      line: { name: t.url ? link(name, t.url) : name, stats: backlogPriority(t) },
      agents: projectAssignments(state).filter(a => a['work-item'] === t.key && a['transient-state-engine'] == null).length,
      script: status.detailStep?.action?.type === 'script' && !isHeld(t, t.variations?.find(v => !v['is-deleted'])),
    };
  });
  const boxHeight = Math.max(3, rows - headerLines(state, columns, now).length - below(state) - platform(state, columns, now).length - head.length);
  const notes = state.backlogFlowView === 'metrics' && floorNotes(backlogTickets(state).flatMap(t => (t.variations ?? []).filter(v => !v['is-deleted'])), NOTE_WIDTH);
  const floor = nestedFloor(steps, entries, { workflows: projectWorkflows(state), expanded: state.backlogFlowExpanded, notes, look: station });
  return { head, list: flowchart(floor.steps, { ...floor, columns: columns - 4, legend: false }), boxHeight, height: boxHeight - 2 };
}

export function view(state, size) {
  const { head, list, boxHeight } = backlogFlowView(state, size);
  return [...head, ...scrollBox(list, { width: size.columns, height: boxHeight, scroll: state.backlogFlowScroll })];
}

// Its keys: ←/→ choose what each station shows while that has the focus;
// ↑/↓, PgUp/PgDn, Home and End scroll the floor whatever has it (ASS-263:
// tab to the day or project took them away); g opens every sub-flow, or
// again only those with a ticket inside, the floor kept in its bounds.
export function onKey(state, key, size, { step, sideways }) {
  if ((key.sequence ?? key.name) === 'g' && !key.ctrl) return scrolled({ ...state, backlogFlowExpanded: !state.backlogFlowExpanded }, undefined, size);
  if (sideways && state.focus === 'backlogflow') return chooseView(state, 'backlogFlowView', step);
  if (scrollsFloor(key)) return scrolled(state, key.name, size);
}

// The state with the floor scrolled by key `name` (see floorScroll), itself when it does not move.
function scrolled(state, name, size) {
  const { list, boxHeight } = backlogFlowView(state, size);
  const backlogFlowScroll = floorScroll(state.backlogFlowScroll, name, list, { width: size.columns, height: boxHeight });
  return backlogFlowScroll === state.backlogFlowScroll ? state : { ...state, backlogFlowScroll };
}
