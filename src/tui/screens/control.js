// The control screen (c): control's output and its log file (ASS-201: moved from app.js).
import { pathToFileURL } from 'node:url';
import { pad, link } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { ellipsis, red } from './shared.js';
import { problemText } from '../../control/credentials.js';

export function view(state, size) {
  // Control's output in a box filling the space between the header and the
  // platform boxes, its log file beneath: lines top down as a terminal shows
  // them, the newest that fit once it is full, each with its UTC time and
  // cut to the box — its title says the times are UTC (ASS-294); stderr in red. Beside it, to the right, the project's
  // transient state engines, a box each (see engineBoxes).
  const { columns, now = 0 } = size;
  const width = columns;
  const inner = width - 4;                // "│ " … " │"
  // ASS-395: the project held by its credentials — each problem, and its fix, in red above control's output.
  const hold = state.projects[state.project]?.credentialsHold;
  const held = hold ? [red(ellipsis(`Project blocked by credentials since ${hold.since ?? '?'}: no new agent or VM setup starts until they pass`, width)), ...(hold.problems ?? []).map(p => red(ellipsis(`  ${problemText(p)}`, width)))] : [];
  const room = size.rows - headerLines(state, columns, now).length - below(state) - platform(state, columns, now).length - held.length;
  const height = Math.max(1, room - 3);   // less the borders and the log line
  const id = state.projects[state.project]?.id;
  const log = state.controlLog.filter(l => l.project == null || l.project === id);   // this project's control, and what is everyone's
  const shown = log.length
    ? log.slice(-height).map(({ text, stream, at }) => {
      const body = ellipsis(text, inner - 10);
      return `${at.toISOString().slice(11, 19)}  ${stream === 'stderr' ? red(body) : body}`;
    })
    : ['control has not printed anything yet'];
  const control = [
    `┌─ control (times UTC) ${'─'.repeat(Math.max(0, width - 24))}┐`,
    ...Array.from({ length: height }, (_, i) => `│ ${pad(shown[i] ?? '', inner)} │`),
    `└${'─'.repeat(Math.max(0, width - 2))}┘`,
  ];
  return [
    ...held,
    ...control,
    ...((file => (file ? [`log: ${link(file, pathToFileURL(file).href)}`] : []))(state.controlLogFiles?.[id] ?? state.controlLogFile)),
  ];
}
