// The sprint flow screen (S): the project's state engine as a factory floor (ASS-201: moved from app.js).
import { flowchart, NOTE_WIDTH } from '../flowchart.js';
import { stateMetrics, metricLines } from '../metrics.js';
import { scrollBox } from '../table.js';
import { link } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { chooseView, viewChoice, sprintTickets, stateStats, projectWorkflows, liveAssignments } from './shared.js';
import { nestedFloor, subflowHint, scrollsFloor, floorScroll } from './nested.js';
import { isHeld } from '../../control/engine.js';

// The flowchart screen: its choice of what each station shows with the keys'
// hint, and the project's state engine drawn as a factory floor (see
// flowchart) — the tickets at each station on the day on show, or its
// run-time metrics so far this sprint — to scroll in a box `boxHeight` lines
// tall, all the space above the legend (no platform boxes here, ASS-187); `height`, the lines it shows.
// Without a state engine, no floor: the head says so. A step running a
// sub-engine is a box of that engine's stations, to any depth (nestedFloor,
// ASS-245), each ticket under its deepest step with its 🤖 — a live
// assignment's, on its variation or the ticket's first row when it names
// none — and a 💻 while its deepest step is a script, as the progress bar
// counts them (sprint.js): not at its gate, held, or on a past day.
function flowchartView(state, { columns = 0, rows = Infinity }) {
  const steps = projectWorkflows(state).find(w => w.name === state.projects[state.project]?.stateEngine)?.steps ?? [];
  const [choice, hint, gap] = viewChoice(state.flowchartView, state.focus === 'flowchart');
  const head = [choice, `${hint}   ${subflowHint(state.flowchartExpanded)}`, gap];
  if (!steps.length) return { head: [...head, 'No state engine for this project'] };
  const { tickets } = sprintTickets(state);
  const agents = liveAssignments(state).map(a => tickets.find(t => t.key === a['work-item'] && (a.variation == null || a.variation === t.variation.name)));
  const entries = tickets.map(t => {
    const name = `${t.shownKey}: ${t.title}`;
    return {
      path: t.status.chain.map(l => l.state),
      line: { name: t.url ? link(name, t.url) : name, stats: stateStats(t.variation, undefined, [], steps, t.step) ?? '' },
      agents: agents.filter(a => a === t).length,
      script: !state.day && t.status.detailStep?.action?.type === 'script' && t.gate == null && !isHeld(t, t.variation),
    };
  });
  const metrics = state.flowchartView === 'metrics' && stateMetrics(tickets.map(t => t.variation), steps);
  const notes = metrics && Object.fromEntries(steps.map(s => [s.id, metricLines(metrics[s.id], s.action?.type === 'prompt', NOTE_WIDTH)]));
  const floor = nestedFloor(steps, entries, { workflows: projectWorkflows(state), expanded: state.flowchartExpanded, notes });
  const boxHeight = Math.max(3, rows - headerLines(state, columns, 0).length - below(state) - platform(state, columns, 0).length - head.length);
  return { head, list: flowchart(steps, { ...floor, columns: columns - 4 }), boxHeight, height: boxHeight - 2 };
}

export function view(state, size) {
  const { head, list, boxHeight } = flowchartView(state, size);
  return list ? [...head, ...scrollBox(list, { width: size.columns, height: boxHeight, scroll: state.flowchartScroll })] : head;
}

// Its keys: ←/→ choose what each station shows while that has the focus;
// ↑/↓, PgUp/PgDn, Home and End scroll the floor whatever has it (ASS-263:
// they waited for tab, which S never gave on opening); g opens every
// sub-flow, or again only those with a ticket inside, the floor kept in its
// bounds.
export function onKey(state, key, size, { step, sideways }) {
  if ((key.sequence ?? key.name) === 'g' && !key.ctrl) return scrolled({ ...state, flowchartExpanded: !state.flowchartExpanded }, undefined, size);
  if (sideways && state.focus === 'flowchart') return chooseView(state, 'flowchartView', step);
  if (scrollsFloor(key)) return scrolled(state, key.name, size);
}

// The state with the floor scrolled by key `name` (see floorScroll), itself when it does not move.
function scrolled(state, name, size) {
  const { list, boxHeight } = flowchartView(state, size);
  const flowchartScroll = list ? floorScroll(state.flowchartScroll, name, list, { width: size.columns, height: boxHeight }) : state.flowchartScroll;
  return flowchartScroll === state.flowchartScroll ? state : { ...state, flowchartScroll };
}
