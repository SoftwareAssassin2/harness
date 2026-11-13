// The performance screen (p, ASS-411): each developer's performance over a
// span — the active sprint to today by default, a sprint stepped to, or a
// from/to span set by hand — as src/analytics/performance.js (ASS-410) works it
// out from the project's analytics files, team.json and engines. A boxed grid,
// a row per developer, each cell its value over the labelled figures behind it;
// the operator's own row highlighted. Pure, as app.js is: opening the screen
// asks main.js for the files (performanceLoad, load.js loadAnalytics), which
// hands them back through analyticsLoaded, so reading them never holds up a
// draw or any other screen.
import { performance, COLUMNS, cellLines, activeSprint, dateIn } from '../../analytics/performance.js';
import { visible, pad, wrap } from '../text.js';
import { thumb } from '../table.js';
import { below, headerLines, platform } from './frame.js';
import { clamp, red, gray } from './shared.js';

export const HEADERS = ['Developer', ...COLUMNS.map(c => c.title)];

// The id the operator's row is found by (ASS-411 AC3): the project's
// ticket-system-account-id (matched to team.json's ticket-system-id), or, for a
// project with none — an off-board project — "operator", the fixed id ASS-413
// credits off-board tickets to.
export const OPERATOR_ID = 'operator';

// The time zone whose calendar days make the span: the machine's own, as
// the operator reads dates; a test passes its own in the size.
const zoneOf = size => size.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const projectOf = state => state.projects[state.project];

// opened(state) — the screen as it opens, or its project is switched to, or l
// asks again: its analytics asked of main.js, scrolled to the top. A span set
// stays while the project does; a project switched to starts on its active sprint.
export const opened = (state, { switched = false } = {}) => ({
  ...state, performanceLoad: projectOf(state)?.id ?? null, performanceScroll: 0, performanceMessage: '',
  ...(switched ? { performanceSpan: null, performanceForm: null } : {}),
});

// analyticsLoaded(state, project, result) — main.js's answer: { data } (data
// null when the project has no analytics yet) or { error }.
export const analyticsLoaded = (state, project, result) => ({ ...state, analytics: { ...state.analytics, [project]: result } });

// The project's engines (ASS-410 reads a status's meaning from them alone):
// its own (data/projects/<p>/engines, ASS-276), else, for a project on
// engines/'s, its execution engine — never another project's, whose steps
// may pair the same status names otherwise.
function enginesOf(state) {
  const project = projectOf(state);
  const own = state.workflows.filter(w => w.project != null && w.project === project?.id);
  return own.length ? own : state.workflows.filter(w => w.project == null && w.name === project?.stateEngine);
}

// The board's sprints that have started by today, in analytics/sprints.json's
// order (start order) — the ones [ and ] step through.
const startedSprints = (data, today) => (data.sprints?.sprints ?? []).filter(s => s.start && dateIn(s.start, 'UTC') <= today);

// The span asked of performance(), and its sprint's name for the header:
// none for the active sprint (performance's default), a sprint's own dates —
// its UTC start date to its end, or today when that is earlier, as ASS-410
// works out the active one — or the dates set by hand.
function givenSpan(state, data, today, zone) {
  const span = state.performanceSpan;
  if (span?.sprint == null) return { given: span ?? undefined, name: null };
  const sprint = (data.sprints?.sprints ?? []).find(s => s.id === span.sprint);
  if (!sprint) return { given: undefined, name: null };
  const ends = sprint.end ? dateIn(sprint.end, zone) : today;
  return { given: { start: dateIn(sprint.start, 'UTC'), end: ends < today ? ends : today }, name: sprint.name };
}

// One result at a time is kept: a draw (every second and on every change)
// works the grid out again only when its data, engines, span or day did.
let kept = null;
function worked(state, data, size) {
  const zone = zoneOf(size), now = size.now ?? Date.now(), today = dateIn(now, zone);
  const { given, name } = givenSpan(state, data, today, zone);
  const key = `${projectOf(state)?.id}|${today}|${zone}|${given?.start}|${given?.end}`;
  if (kept?.data === data && kept.workflows === state.workflows && kept.key === key) return kept.result;
  const result = performance({ tickets: data.tickets, sprints: data.sprints, mergeRequests: data.mergeRequests, team: data.team, engines: enginesOf(state), span: given, now, timeZone: zone });
  const days = `(${result.span.days} day${result.span.days === 1 ? '' : 's'})`;
  const header = `${name ? `${name}: ` : ''}${result.span.label} ${days}`;
  kept = { data, workflows: state.workflows, key, result: { ...result, header, today } };
  return kept.result;
}

// The grid as lines: { head, body, foot } — its top border, headings and the
// rule under them; a row's lines with a rule between rows; its bottom border.
// The operator's row (its member id `mine`) has ▶ before the name, its lines
// in reverse video between the outer borders, and double rules (═) above and
// below it in place of the single ones (ASS-411 AC3).
export function grid(rows, mine) {
  const table = rows.map(r => {
    const own = mine != null && r.member.id === mine;
    return { own, cells: [[`${own ? '▶' : ' '} ${r.member.name}`], ...COLUMNS.map(c => cellLines(r.cells[c.key]))] };
  });
  const widths = HEADERS.map((h, i) => Math.max(visible(h), ...table.flatMap(r => r.cells[i].map(visible))));
  const rule = (left, line, cross, right) => left + widths.map(w => line.repeat(w + 2)).join(cross) + right;
  const single = rule('├', '─', '┼', '┤'), double = rule('╞', '═', '╪', '╡');
  const center = (text, w) => pad(' '.repeat(Math.floor((w - visible(text)) / 2)) + text, w);
  const line = (texts, own) => {
    const inner = texts.map((t, i) => ` ${pad(t, widths[i])} `).join('│');
    return own ? `│\x1b[7m${inner}\x1b[0m│` : `│${inner}│`;
  };
  const head = [rule('┌', '─', '┬', '┐'), `│${HEADERS.map((h, i) => ` ${center(h, widths[i])} `).join('│')}│`];
  const body = [table[0]?.own ? double : single];
  table.forEach((r, n) => {
    if (n) body.push(r.own || table[n - 1].own ? double : single);
    const height = Math.max(...r.cells.map(c => c.length));
    for (let k = 0; k < height; k++) body.push(line(r.cells.map(c => c[k] ?? ''), r.own));
  });
  const foot = table.at(-1)?.own ? rule('╘', '═', '╧', '╛') : rule('└', '─', '┴', '┘');
  return { head, body, foot };
}

// The line under the grid (AC5): new team members first seen in the span and
// git authors not on the team, for the operator to check team.json; [] when
// there are neither.
export function noticeLines({ newMembers, unknownAuthors }, columns) {
  const parts = [
    ...(newMembers.length ? [`new on the team in this span: ${newMembers.map(m => `${m.name} (${m.role ?? 'no role'}, first seen ${m.firstSeen})`).join(', ')}`] : []),
    ...(unknownAuthors.length ? [`git authors not on the team: ${unknownAuthors.map(a => `${a.username}${a.name && a.name !== a.username ? ` (${a.name})` : ''}, ${a.mrs} MR${a.mrs === 1 ? '' : 's'}`).join('; ')}`] : []),
  ];
  return parts.length ? wrap(`Check team.json — ${parts.join('; ')}.`, Math.max(20, columns)) : [];
}

// The keys, as the line over the grid shows them.
const KEYS = '[ previous sprint   ] next sprint   t this sprint   l loads again';
const FOCUSED_KEYS = '   enter sets from/to dates   ↑/↓ scroll';

// The screen laid out: { head, grid, notice, height, last } — the lines over
// the grid, the grid ({ head, body, foot }, or null with a one-line message in
// head in its place), the lines under it, how many body lines fit, and the
// furthest it scrolls.
function layout(state, size) {
  const { columns = 0, rows = Infinity, now = 0 } = size;
  const project = projectOf(state);
  const loaded = state.analytics?.[project?.id];
  const form = state.performanceForm;
  const field = id => {
    const text = `${form[id]}${form.field === id ? '█' : ''}` || gray('YYYY-MM-DD');
    return form.field === id ? `\x1b[7m${text}\x1b[0m` : text;
  };
  const keys = form ? `From ${field('from')}   to ${field('to')}   (dates in ${zoneOf(size)})`
    : `${KEYS}${state.focus === 'performance' ? FOCUSED_KEYS : ''}`;
  const third = form ? 'type   tab next field   enter sets the span   esc cancels' : state.performanceMessage ? red(state.performanceMessage) : '';
  const message = text => ({ head: [text, ...(third ? [third] : [])], grid: null, notice: [], height: 0, last: 0 });
  if (!project) return message('No project selected.');
  if (!loaded) return message(`loading ${project.id}'s analytics…`);
  if (loaded.error) return message(red(loaded.error));
  if (!loaded.data) return message(`No analytics data for ${project.name ?? project.id} yet: the grid fills once its tickets are downloaded (analytics/tickets.json).`);
  const result = worked(state, loaded.data, size);
  const head = [result.header, keys, third];   // third: the form's keys or a message, else the blank line over the grid
  const notice = noticeLines(result, columns);
  if (!result.rows.length) return { head: [...head, 'No developer moved a ticket to Done, merged a merge request or has work in progress in this span.'], grid: null, notice, height: 0, last: 0 };
  const table = grid(result.rows, loaded.data.accountId ?? OPERATOR_ID);
  const bottom = below(state) + Math.max(1, platform(state, columns, now).length);
  const free = rows - headerLines(state, columns, now).length - bottom - head.length - table.head.length - 1 - (notice.length ? notice.length + 1 : 0);
  const height = Math.max(1, free);
  return { head, grid: table, notice, height, last: Math.max(0, table.body.length - height) };
}

export function view(state, size) {
  const { head, grid: table, notice, height, last } = layout(state, size);
  if (!table) return [...head, ...(notice.length ? ['', ...notice] : [])];
  // Scrolled: the headings stay, the body lines from performanceScroll on, a
  // scrollbar thumb on the right border while lines are hidden (AC6).
  const start = Math.min(state.performanceScroll ?? 0, last);
  const body = table.body.slice(start, start + height);
  if (last > 0) {
    const [top, size] = thumb(body.length, table.body.length, start, last);
    for (let i = top; i < top + size; i++) body[i] = `${body[i].slice(0, -1)}█`;
  }
  return [...head, ...table.head, ...body, table.foot, ...(notice.length ? ['', ...notice] : [])];
}

// A step through the started sprints, by -1 ([) or +1 (]) (AC4): from the
// sprint on show; from the active sprint to today, the active one (after the
// last when none is active); from dates set by hand, the latest sprint starting
// by their start. The active sprint stepped to is the default span again.
function stepSprint(state, size, by) {
  const data = state.analytics?.[projectOf(state)?.id]?.data;
  if (!data) return state;
  const today = dateIn(size.now ?? Date.now(), zoneOf(size));
  const list = startedSprints(data, today);
  if (!list.length) return { ...state, performanceMessage: 'No sprints in analytics/sprints.json yet.' };
  const span = state.performanceSpan, active = activeSprint(data.sprints);
  const at = span?.sprint != null ? list.findIndex(s => s.id === span.sprint)
    : !span ? (active ? list.findIndex(s => s.id === active.id) : list.length)
      : list.findLastIndex(s => dateIn(s.start, 'UTC') <= span.start);
  const next = at + by;
  if (next < 0 || next >= list.length) return { ...state, performanceMessage: `No ${by < 0 ? 'earlier' : 'later'} sprint.` };
  const sprint = list[next];
  return { ...state, performanceSpan: sprint.id === active?.id ? null : { sprint: sprint.id }, performanceScroll: 0, performanceMessage: '' };
}

// A key while the from/to form is open (AC4, as the updates screen's date and
// time form): tab moves between from and to; digits and dashes are typed into
// the field being edited; enter sets the span to two real dates, from no later
// than to, else says what is wanted; escape gives up.
export function editSpan(state, key) {
  const form = state.performanceForm;
  if (key.name === 'escape') return { ...state, performanceForm: null, performanceMessage: '' };
  if (key.name === 'tab') return { ...state, performanceForm: { ...form, field: form.field === 'from' ? 'to' : 'from' } };
  const edit = text => ({ ...state, performanceForm: { ...form, [form.field]: text } });
  if (key.name === 'backspace') return edit(form[form.field].slice(0, -1));
  if (key.name === 'return' || key.name === 'enter') {
    const real = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
    return real(form.from) && real(form.to) && form.from <= form.to
      ? { ...state, performanceSpan: { start: form.from, end: form.to }, performanceForm: null, performanceScroll: 0, performanceMessage: '' }
      : { ...state, performanceMessage: 'Give both dates as YYYY-MM-DD, from no later than to.' };
  }
  const text = key.sequence ?? '';
  return /^[0-9-]$/.test(text) && form[form.field].length < 10 ? edit(form[form.field] + text) : state;
}

// Its keys (AC4, AC6): [ and ] step to the previous and next sprint, t goes
// back to this sprint, l loads the files again — wherever the focus is; with
// the grid focused, enter opens the from/to form on the span on show and ↑/↓ scroll.
export function onKey(state, key, size, { step, sideways }) {
  const typed = key.ctrl ? null : key.sequence;
  if (typed === '[') return stepSprint(state, size, -1);
  if (typed === ']') return stepSprint(state, size, 1);
  if (typed === 't') return { ...state, performanceSpan: null, performanceScroll: 0, performanceMessage: '' };
  if (typed === 'l') return opened(state);
  if (state.focus !== 'performance') return undefined;
  if (key.name === 'return') {
    const data = state.analytics?.[projectOf(state)?.id]?.data;
    const span = data ? worked(state, data, size).span : null;
    return { ...state, performanceMessage: '', performanceForm: { field: 'from', from: span?.start ?? '', to: span?.end ?? '' } };
  }
  if (step && !sideways) {
    const { last } = layout(state, size);
    return { ...state, performanceScroll: clamp((state.performanceScroll ?? 0) + step, 0, last) };
  }
  return undefined;
}
