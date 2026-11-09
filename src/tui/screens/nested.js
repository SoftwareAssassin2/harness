// The S and B floors' sub-flows (ASS-245): what flowchart draws for a floor
// of steps whose steps run sub-engines, nested to any depth; and the keys
// that scroll those floors (ASS-263).
import { scrollLast } from '../table.js';

// nestedFloor(steps, entries, { workflows, expanded, notes }) — flowchart's
// options for a floor of `steps`, its steps among them. entries are the
// tickets on it, each { path, line, agents, script }: path, the step ids of
// its status chain top first; line, its ticket line ({ name, stats }); agents,
// its live assignments; script, whether it counts a 💻. A ticket is listed
// under the deepest step of its path drawn here — a sub-engine's done exits,
// where its run ends, are not — and counted in the top border of every step
// above it. A step running a sub-engine (action state-engine, one of
// `workflows`, not already running above it) opens into that engine's floor
// when a ticket is inside it, or every one `expanded`. Each station shows a 🤖
// per live assignment of the tickets listed under it, then a 💻 per one that
// counts. notes, when given, makes each floor's notes, at every depth, as
// notes(steps, parents) — parents, the step ids above the floor, top first —
// listed beneath its stations in place of their tickets (ASS-331: a
// sub-flow's too). look, when given, is how each step is drawn, at every depth.
export function nestedFloor(steps, entries, { workflows, expanded = false, notes, look = s => s, running = [], parents = [] }) {
  const tickets = {}, counts = {}, inside = {}, subflows = {};
  for (const step of steps) {
    const mine = entries.filter(e => e.path[0] === step.id);
    const name = step.action?.type === 'state-engine' && !running.includes(step.action.engine) && step.action.engine;
    const subSteps = (name && workflows.find(w => w.name === name)?.steps || []).filter(s => !s['is-done']);
    const deeper = mine.filter(e => subSteps.some(s => s.id === e.path[1]));
    const here = mine.filter(e => !deeper.includes(e));
    tickets[step.id] = here.map(e => e.line);
    counts[step.id] = mine.length;
    const robots = '🤖'.repeat(here.reduce((n, e) => n + e.agents, 0)) + '💻'.repeat(here.filter(e => e.script).length);
    if (robots) inside[step.id] = [robots];
    if (subSteps.length && (expanded || deeper.length)) {
      subflows[step.id] = nestedFloor(subSteps, deeper.map(e => ({ ...e, path: e.path.slice(1) })), { workflows, expanded, notes, look, running: [...running, name], parents: [...parents, step.id] });
    }
  }
  return { steps: steps.map(look), tickets, counts, inside, subflows, ...(notes ? { notes: notes(steps, parents) } : {}) };
}

// The hint for g on S and B: what it does next.
export const subflowHint = expanded => (expanded ? 'g close the empty sub-flows' : 'g open every sub-flow');

// The keys that scroll the S and B floors (ASS-263), whatever has the focus —
// none of the menu, the day or the view choice wants ↑/↓, so the floor never
// waits for tab: ↑/↓ a line, PgUp/PgDn a box's height, as the ticket screen
// pages, Home and End its first and last line.
export const scrollsFloor = key => !key.ctrl && ['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name);

// floorScroll(scroll, name, list, { width, height }) — the floor's first line
// shown after key `name` (none: where it is) in a scrollBox `width` ×
// `height`, kept between its first line and scrollLast. It moves from the line
// on show, which scrollBox stops at scrollLast while `scroll` may lie past it
// once g closes sub-flows or the terminal grows: no dead keypresses before it
// moves (ASS-263).
export function floorScroll(scroll, name, list, { width, height }) {
  const last = scrollLast(list, { width, height });
  const at = Math.min(scroll, last), page = Math.max(1, height - 2);
  const to = { up: at - 1, down: at + 1, pageup: at - page, pagedown: at + page, home: 0, end: last }[name] ?? at;
  return Math.max(0, Math.min(to, last));
}
