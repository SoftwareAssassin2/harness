// The seat queue overlay (ASS-566; the footer's "queue" box before, ASS-525): q on the sprint screen draws it over the
// screen, as the ? menu is drawn (app.js over), and q or Esc closes it. It lists the ticket variations control will
// give a seat to when one frees, first in line first, from control's seat-queue.json (project.seatQueue;
// src/control/seat-queue.js writes it each tick, in the planner's own order — the dashboard works none out). One line
// each: "<n> <key>[ <variation> when not A] <title cut to QUEUE_TITLE>" and what it waits for in gray: "build" (a build
// seat), "plan" (a planning seat; "plan, full" while max-tickets-ready-for-build lets none enter planning) or "memory"
// (ASS-398/ASS-420: memory for its VM). As many as the screen has room for (the footer's box showed 5), then a gray
// "+N more"; nobody waiting: a gray "empty"; a project with no active sprint has nothing to seat: "no active sprint".
import { boxRow } from '../boxes.js';
import { ellipsis, gray } from './shared.js';

export const QUEUE_KEY = 'q';
const QUEUE_TITLE = 60;
const WAIT_WORDS = { build: 'build', planning: 'plan', memory: 'memory' };

// queueLines(project, shown) — the overlay's lines under its title: at most `shown` queue lines, the "+N more" line
// included when the queue is longer.
export function queueLines(project, shown = Infinity) {
  if (!project?.sprint) return [gray('no active sprint')];
  const queue = Array.isArray(project.seatQueue) ? project.seatQueue : [];
  if (!queue.length) return [gray('empty')];
  const line = (q, i) => {
    const key = `${q.key}${q.variation && q.variation !== 'A' ? ` ${q.variation}` : ''}`;
    const waits = `${WAIT_WORDS[q.waits] ?? WAIT_WORDS.build}${q.full ? ', full' : ''}`;
    return [i + 1, key, ellipsis(String(q.title ?? ''), QUEUE_TITLE), gray(waits)].filter(part => part !== '').join(' ');
  };
  const room = Math.max(1, shown);
  if (queue.length <= room) return queue.map(line);
  return [...queue.slice(0, room - 1).map(line), gray(`+${queue.length - room + 1} more`)];
}

// queueBox(state, columns, rows) — the overlay drawn (boxRow): its title, "seat queue — <project> (q or esc closes)",
// a blank line, then queueLines, as many as fit `rows` less its borders, title and a margin of two lines.
export function queueBox(state, columns, rows) {
  const project = state.projects[state.project];
  const shown = Math.max(1, (rows ?? 24) - 7);
  return boxRow([[`seat queue — ${project?.name ?? 'no project'}   (${QUEUE_KEY} or esc closes)`, '', ...queueLines(project, shown).map(l => ellipsis(l, Math.max(10, columns - 8)))]], columns);
}
