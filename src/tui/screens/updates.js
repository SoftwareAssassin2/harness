// The updates screen (u): the progress made since a date and time (ASS-201: moved from app.js).
import { progressSince, progressLines } from '../updates.js';
import { below, headerLines, platform } from './frame.js';
import { clamp, red, gray } from './shared.js';

// The updates screen: the line of its date and time fields — while the form
// is open, its values, the field being edited in reverse video with a cursor —
// what the keys do, any message, and the lines listing the progress since the
// date and time set, in the space left above the platform boxes.
function updatesView(state, { columns = 0, rows = Infinity }) {
  const form = state.updatesForm;
  const set = state.updatesSince == null ? null : new Date(state.updatesSince).toISOString();
  const field = (id, placeholder, value) => {
    if (!form) return value ?? gray(placeholder);
    const text = `${form[id]}${form.field === id ? '█' : ''}` || gray(placeholder);
    return form.field === id ? `\x1b[7m${text}\x1b[0m` : text;
  };
  const fields = `Since   date ${field('date', 'YYYY-MM-DD', set?.slice(0, 10))}   time ${field('time', 'HH:MM', set?.slice(11, 16))} UTC`;
  const keys = form ? 'type   tab next field   enter shows the progress since then   esc cancels'
    : state.focus === 'updates' ? 'enter sets the date and time   ↑/↓ scroll' : '';
  const project = state.projects[state.project];
  const steps = state.workflows.find(w => w.name === project?.stateEngine)?.steps ?? [];
  const list = state.updatesSince == null
    ? ['Set a date and time to see the progress made since then.']
    : progressLines(progressSince({ sprint: project?.sprint, steps, since: state.updatesSince }), columns);
  const bottom = below(state) + platform(state, columns, 0).length;
  const height = Math.max(1, rows - headerLines(state, columns, 0).length - bottom - 4);
  return { head: [fields, keys, state.updatesMessage ? red(state.updatesMessage) : '', ''], list, height };
}

// A key while the updates form is open: tab and shift-tab move between date
// and time; digits, dashes and colons are typed into the field being edited;
// enter shows the progress since a real UTC date and time, else says what is
// wanted; escape gives up.
export function editUpdates(state, key) {
  const form = state.updatesForm;
  if (key.name === 'escape') return { ...state, updatesForm: null, updatesMessage: '' };
  if (key.name === 'tab') return { ...state, updatesForm: { ...form, field: form.field === 'date' ? 'time' : 'date' } };
  const edit = text => ({ ...state, updatesForm: { ...form, [form.field]: text } });
  if (key.name === 'backspace') return edit(form[form.field].slice(0, -1));
  if (key.name === 'return' || key.name === 'enter') {
    const [, hours, minutes] = /^(\d{1,2}):(\d{2})$/.exec(form.time) ?? [];
    const since = Date.parse(`${form.date}T${hours?.padStart(2, '0')}:${minutes}:00Z`);
    const real = /^\d{4}-\d{2}-\d{2}$/.test(form.date) && hours < 24 && minutes < 60 && !Number.isNaN(since)
      && new Date(since).toISOString().startsWith(form.date);
    return real
      ? { ...state, updatesSince: since, updatesForm: null, updatesScroll: 0, updatesMessage: '' }
      : { ...state, updatesMessage: 'Give the date as YYYY-MM-DD and time as HH:MM, 24-hour, in UTC.' };
  }
  const text = key.sequence ?? '';
  return /^[0-9:-]$/.test(text) ? edit(form[form.field] + text) : state;
}

export function view(state, size) {
  const { head, list, height } = updatesView(state, size);
  return [...head, ...list.slice(state.updatesScroll, state.updatesScroll + height)];
}

// Its keys: enter opens the date and time form, ↑/↓ scroll.
export function onKey(state, key, size, { step, sideways }) {
  if (state.focus === 'updates') {
    if (key.name === 'return') {
      const set = state.updatesSince == null ? null : new Date(state.updatesSince).toISOString();
      return { ...state, updatesForm: { field: 'date', date: set?.slice(0, 10) ?? '', time: set?.slice(11, 16) ?? '' } };
    }
    if (step && !sideways) {
      const { list, height } = updatesView(state, size);
      return { ...state, updatesScroll: clamp(state.updatesScroll + step, 0, Math.max(0, list.length - height)) };
    }
  }
}
