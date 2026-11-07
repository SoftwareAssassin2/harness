// The sub-flows screen (f): a box per engine the project's engine reaches (ASS-201: moved from app.js).
import { column } from '../flowchart.js';
import { thumb } from '../table.js';
import { visible, clip, pad } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { agentLine, clamp, projectWorkflows } from './shared.js';

// engineBoxes(state, { height, columns, now }) — the selected project's
// transient state engines side by side, each in a box titled with its state
// engine's name: its uptime, then its engine as a column of stations (see
// column) with the station it is at marked, and inside each station the
// agents assigned to the engine (transient-state-engine naming its id) whose
// state is that step, as the Agents column shows them. Every box is `height`
// lines inside, what does not fit cut from the bottom, and the row is cut to
// `columns`; none without an engine.
// connectedEngines(state) — every engine the selected project's execution
// engine reaches (ASS-7): the state-engine steps of its steps and of each of
// its *-steps lists, then of those engines' in turn, each once, in the order
// reached; then in the order the active sprint's connected-flows counts their
// runs, most first, ties by name.
function connectedEngines(state) {
  const project = state.projects[state.project];
  const byName = name => state.workflows.find(w => w.name === name);
  const reached = [], seen = new Set([project?.stateEngine]);
  for (let queue = [project?.stateEngine]; queue.length;) {
    const w = byName(queue.shift());
    if (!w) continue;
    for (const s of [...w.steps, ...Object.values(w.lists ?? {}).flat()]) {
      const next = s.action?.type === 'state-engine' && s.action.engine;
      if (next && !seen.has(next)) { seen.add(next); reached.push(next); queue.push(next); }
    }
  }
  const runs = Object.fromEntries((project?.sprint?.['connected-flows'] ?? []).map(f => [f.name, f['run-count'] ?? 0]));
  return reached.toSorted((a, b) => (runs[b] ?? 0) - (runs[a] ?? 0) || a.localeCompare(b));
}

// subflowView(state, size) — the sub-flowcharts screen: one box per connected
// engine, its steps stacked top down (column), every run of it for the
// selected project marking its step ◀ now, the agents on each run listed on
// its step; the boxes from subflowStart that fit across, each body scrolled
// by subflowScroll, and under them a scrollbar while some are out of sight.
function subflowView(state, { columns = 0, rows = Infinity, now = 0 } = {}) {
  const project = state.projects[state.project];
  const height = Math.max(1, rows - headerLines(state, columns, now).length - below(state) - platform(state, columns, now).length - 4);
  const bodies = connectedEngines(state).map(name => {
    const steps = projectWorkflows(state).find(w => w.name === name)?.steps ?? [];
    const runs = state.transientEngines.filter(e => e.project === project?.id && e['state-engine'] === name);
    const crew = Object.groupBy(state.assignments.filter(a => runs.some(r => r.id === a['transient-state-engine'])), a => a.state);
    const agents = Object.fromEntries(Object.entries(crew).map(([id, list]) => [id, list.map(agentLine)]));
    return { name, body: [runs.length ? `${runs.length} running` : 'idle', '', ...column(steps, { current: runs.map(r => r.state), agents })] };
  });
  const tallest = Math.max(0, ...bodies.map(b => b.body.length));
  const widthOf = b => Math.max(ENGINE_WIDTH, ...b.body.map(visible)) + 4;
  const start = Math.min(state.subflowStart ?? 0, Math.max(0, bodies.length - 1));
  let used = 0, shown = 0;
  for (const b of bodies.slice(start)) { const w = widthOf(b) + (shown ? 4 : 0); if (shown && used + w > columns) break; used += w; shown++; }
  const last = Math.max(0, tallest - height);
  const scroll = Math.min(state.subflowScroll ?? 0, last);
  // The vertical scrollbar, while the tallest box does not fit: one thumb, on every box's right border.
  const [thumbTop, thumbSize] = last ? thumb(height, tallest, scroll, last) : [0, 0];
  const boxes = bodies.slice(start, start + shown).map(b => {
    const width = widthOf(b) - 2;
    const right = i => (i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
    return [
      `┌─ ${b.name} ${'─'.repeat(Math.max(0, width - visible(b.name) - 3))}┐`,
      ...Array.from({ length: height }, (_, i) => `│ ${pad(b.body[scroll + i] ?? '', width - 2)} ${right(i)}`),
      `└${'─'.repeat(width)}┘`,
    ];
  });
  const lines = boxes.length ? boxes[0].map((_, i) => clip(boxes.map(box => box[i]).join('    '), columns)) : ['No sub-flows: this project\'s engine runs no other engine'];
  // The horizontal scrollbar: the boxes in sight as a thumb on a track as wide as the screen.
  const track = Math.max(1, columns - 4);
  const bar = bodies.length > shown
    ? [`◀ ${Array.from({ length: track }, (_, i) => (i >= Math.floor(track * start / bodies.length) && i < Math.ceil(track * (start + shown) / bodies.length) ? '█' : '─')).join('')} ▶`]
    : [];
  return { lines: [...lines, ...bar], boxes: bodies.length, shown, height, tallest };
}
const ENGINE_WIDTH = 32;   // a station's width, the least a box holds

export function view(state, size) {
  return subflowView(state, size).lines;
}

// Its keys: ←/→ the first box shown, ↑/↓ every box's lines together.
export function onKey(state, key, size, { step, sideways }) {
  if (step && state.focus === 'subflows') {
    const view = subflowView(state, size);
    if (sideways) {
      const subflowStart = clamp(state.subflowStart + step, 0, Math.max(0, view.boxes - view.shown));
      return subflowStart === state.subflowStart ? state : { ...state, subflowStart };
    }
    const subflowScroll = clamp(state.subflowScroll + step, 0, Math.max(0, view.tallest - view.height));
    return subflowScroll === state.subflowScroll ? state : { ...state, subflowScroll };
  }
}
