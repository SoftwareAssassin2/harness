// A ticket screen's questions (ASS-101; the questions screen went with
// ASS-103): its list, the selected one's details and the answer being
// written. Pure rendering; app.js owns the state and keys, main.js saves
// answers through the agent-cli.
import { wrap, pad, visible, link } from './text.js';
import { isOpenQuestion } from '../control/engine.js';

const LABEL = 20;   // the details' label column

// The three columns a ticket screen's questions are listed in (ASS-101 AC7):
// no Ticket, Ticket Status or Priority — they are all one ticket's.
const TICKET_HEADERS = ['Status', 'Scope', 'Question'];

// A question's status as listed: an open one's says whether it blocks
// (ASS-248) — "Asked · blocking", one with no flag counted so, or
// "Asked · non-blocking"; a closed one's is its status alone.
const statusOf = q => (q.status ?? '—') + (isOpenQuestion(q) ? ` · ${q.blocking === false ? 'non-blocking' : 'blocking'}` : '');

// ticketQuestionLines(list, { selected, focused, columns }) — one ticket's
// questions (ASS-101 AC7) in `columns`: the three headers over a row per
// question, its answer status and scope beside the question wrapped into what
// is left — a global one's (global-questions-and-answers.json) led by
// "(global)" (ASS-103) — the selected one marked ▸ (in reverse video while the list has
// focus); a line saying so when the ticket has none. In a column too narrow
// for the question beside its status and scope, it is wrapped under them.
export function ticketQuestionLines(list, { selected = 0, focused = false, columns }) {
  if (!list.length) return ['no questions on this ticket'];
  const rows = list.map(q => [statusOf(q), q.scope || '—', `${q.source === 'global' ? '(global) ' : ''}${q.question ?? ''}`]);
  const widths = TICKET_HEADERS.map((head, i) => Math.max(head.length, ...rows.map(row => visible(row[i]))));
  const beside = columns - 6 - widths[0] - widths[1] >= 20;
  const indent = beside ? widths[0] + widths[1] + 4 : 2;
  const mark = (text, i, k) => {
    if (i !== selected) return `  ${text}`;
    return focused ? `${k ? '  ' : '▸ '}\x1b[7m${text}\x1b[0m` : `${k ? '  ' : '▸ '}${text}`;
  };
  return [
    beside
      ? `  ${pad(TICKET_HEADERS[0], widths[0])}  ${pad(TICKET_HEADERS[1], widths[1])}  ${TICKET_HEADERS[2]}`
      : `  ${TICKET_HEADERS[0]}  ${TICKET_HEADERS[1]}`,
    ...rows.flatMap(([status, scope, question], i) => {
      const wrapped = wrap(question, Math.max(10, beside ? columns - 6 - widths[0] - widths[1] : columns - 4));
      const head = beside ? [] : [mark(`${status}  ${scope}`, i, 0)];
      return [...head, ...wrapped.map((line, k) => mark(
        k || !beside ? `${' '.repeat(indent)}${line}` : `${pad(status, widths[0])}  ${pad(scope, widths[1])}  ${line}`,
        i, beside ? k : k + 1,
      ))];
    }),
  ];
}

// A question's fields, each label beside its text wrapped to the screen.
// While the answer form is open (`draft`), its fields show what is being
// written, and the one being edited has its label in reverse video and a cursor.
// The ticket it was asked on links to `url` (the open ticket's) when there is one (ASS-86).
// Whether it blocks shows under the question (ASS-248); a non-blocking one's
// recommended answer is the assumption the work went on with, labelled so.
export function questionDetails(q, draft, columns, url) {
  const asked = q['asked-time-stamp'] ? ` at ${q['asked-time-stamp'].replace('T', ' ').replace(/:\d\dZ$/, ' UTC')}` : '';
  const form = (label, field) => {
    if (!draft) return [label, q[field] || '—'];
    const editing = draft.field === field;
    return [label, draft[field] + (editing ? '█' : ''), editing];
  };
  const fields = [
    ['Question', q.question || '—'],
    ['Why asked', q['why-asked'] || '—'],
    ['Blocking', q.blocking === false ? 'no — work goes on, assuming the recommended answer' : 'yes — the ticket waits for the answer'],
    [q.blocking === false ? 'Assumption' : 'Recommended answer', q['recomended-answer'] || '—'],
    form('Answer', 'answer'),
    form('Why this answer', 'why-this-answer'),
    form('Scope', 'scope'),
    ...(q['ai-feedback-if-not-accepted'] ? [['Why rejected', q['ai-feedback-if-not-accepted']]] : []),
    ['Asked', `on ${(on => (url ? link(on, url) : on))((q['asked-on-ticket'] || '—').toUpperCase())}${asked}, ${q.status}`],
  ];
  // Beside its label while the screen holds both, else under it (ASS-101: the ticket screen's column can be narrow).
  const beside = columns >= LABEL + 20;
  return fields.flatMap(([label, text, editing]) => {
    const lines = wrap(text, beside ? columns - LABEL : Math.max(10, columns));
    if (!beside) return [editing ? `\x1b[7m${label}\x1b[0m` : label, ...lines];
    return lines.map((line, i) => {
      if (i) return ' '.repeat(LABEL) + line;
      return (editing ? `\x1b[7m${label}\x1b[0m${' '.repeat(LABEL - label.length)}` : label.padEnd(LABEL)) + line;
    });
  });
}
