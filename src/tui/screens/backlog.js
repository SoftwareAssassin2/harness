// The backlog screen (b): its ticket grid (ASS-201: moved from app.js).
import { boxTable } from '../table.js';
import { workedByHand } from '../ticket.js';
import { below, headerLines, platform } from './frame.js';
import { ticketLink, NONE, agentLines, projectAssignments, ticketMarks, needMark, ICONS, move, backlogTickets, refinementOf, refinementName, backlogPriority } from './shared.js';
import { openTicket } from './ticket.js';

// The backlog screen's columns (ASS-20).
const BACKLOG_HEADERS = ['Ticket', 'Priority', 'Points', 'State', 'Assignee', 'Agents'];

// backlogRows(state) — the backlog grid's tickets (ASS-56): closest to done
// first, as the sprint grid (sprintTickets): the highest sequence of the step
// each sits at in its own refinement engine (refinementOf), a step its engine
// lacks or none last; within one step, backlogTickets' order (the sort is
// stable). Screen-only — control's rankBacklog stays step-blind (ASS-144 Q6),
// and B groups by step from backlogTickets. Enter opens the row from this list.
const backlogRows = state => backlogTickets(state)
  .map(t => ({ t, sequence: refinementOf(state, t).step?.sequence ?? -1 }))
  .toSorted((a, b) => b.sequence - a.sequence)
  .map(({ t }) => t);

// The backlog grid's rows (backlogRows) — ticket (type icon, key: title), priority
// (backlogPriority), points, refinement, assignee, the agents on it — and its body height. A
// ticket worked by hand (ASS-166) has ✋ before its key and who since when after its refinement;
// one waiting on the operator (operatorNeeded) a blue ● (needMark, ASS-242), one going on with an assumption alone a dim grey one (ASS-248).
function backlogLayout(state, { columns = 0, rows = Infinity }) {
  const bottom = below(state) + Math.max(1, platform(state, columns, 0).length);
  const free = rows - headerLines(state, columns, 0).length - bottom;
  const icon = t => ({ Bug: ICONS.bugs, Spike: ICONS.spikes }[t['issue-type']] ?? ICONS.features);
  const marks = ticketMarks(state);
  return {
    rows: backlogRows(state).map(t => [
      `${icon(t)} ${workedByHand(t) ? '✋ ' : ''}${needMark(marks, t.key)}${ticketLink(`${t.key}: ${t.title ?? ''}`, t.url)}`,
      backlogPriority(t),
      String(t.points ?? NONE),
      [refinementName(refinementOf(state, t)) ?? NONE, workedByHand(t)].filter(Boolean).join(' · '),
      t['ticket-system-assignment'] ?? NONE,
      agentLines(projectAssignments(state).filter(a => a['work-item'] === t.key)),
    ]),
    bodyHeight: free - 4,
  };
}

export function view(state, size) {
  const backlog = backlogLayout(state, size);
  return boxTable(BACKLOG_HEADERS, backlog.rows.length ? backlog.rows : [['the backlog is empty']], {
    columns: size.columns, stretch: 0, height: backlog.bodyHeight + 4, scroll: state.backlogScroll, dashed: true,
    selected: state.focus === 'backlog' && backlog.rows.length ? state.backlogSelected : undefined,
  });
}

// Its keys: ↑/↓ move the grid's selection, enter opens the selected ticket's screen.
export function onKey(state, key, size, { step, sideways }) {
  if (step && !sideways && state.focus === 'backlog') {
    const [backlogSelected, backlogScroll] = move(backlogLayout(state, size), state.backlogSelected, state.backlogScroll, step);
    return { ...state, backlogSelected, backlogScroll };
  }
  if (key.name === 'return' && state.focus === 'backlog') {
    const t = backlogRows(state)[state.backlogSelected];
    return t ? openTicket(state, { key: t.key, variation: t.variations?.find(v => !v['is-deleted'])?.name ?? 'A', backlog: true }) : state;
  }
}
