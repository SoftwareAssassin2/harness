// The memory screen (ASS-62 AC8): the selected project's Hindsight memories
// (src/agents/memory.js), each with its source — the ticket, step, model and
// date an agent saved it with (AC7) — for the operator to browse and delete;
// over them, how the project's agents used memory this sprint (ASS-147).
// Pure, as app.js is: opening the screen asks main.js for the memories
// (memoryLoad), which hands them back through memoryLoaded; y on a delete asks
// main.js to delete it (memoryDelete), which loads them again.
import { clip, visible, pad } from './text.js';

export const MEMORY_HEADERS = ['Memory', 'Ticket', 'Step', 'Model', 'Saved'];
const NONE = '—';
const TEXT_WIDTH = 90;

// The selected project's Hindsight port, or null when it has none.
const portOf = state => state.projects[state.project]?.hindsight?.port ?? null;

// memoryOpened(state) — the screen just opened: its first memory selected, the memories asked for when the project has a Hindsight.
export const memoryOpened = state => ({ ...state, memorySelected: 0, memoryScroll: 0, memoryMessage: '', memoryLoad: portOf(state) == null ? null : state.projects[state.project].id });

// memoryLoaded(state, project, result) — main.js's answer: { items } or { error }.
export const memoryLoaded = (state, project, result) => ({ ...state, memories: { ...state.memories, [project]: result } });

// The dashboard's own check of each project's Hindsight (ASS-293), for the
// control box's hindsight line (frame.js): the dashboard asks rather than
// reading what control found, so the line stays live while control is down
// or has never run. main.js polls every second; healthPoller starts, for each
// project with a hindsight in its project.json, a check (src/agents/memory.js
// memoryHealthy: GET /health, 2 seconds) at once, then HEALTH_EVERY after the
// last began — at once on a new port — never two in flight for a project; poll
// returns at once, so a check never holds up drawing. Each answer goes to
// onResult(id, { port, healthy, at }), at when its check began, which main.js
// hands to memoryChecked. A check that throws counts as down.
export const HEALTH_EVERY = 15_000;

export function healthPoller({ check, onResult, every = HEALTH_EVERY }) {
  const checks = new Map();   // id → { port, began, running }
  return {
    poll(projects, now) {
      for (const { id, hindsight } of projects) {
        const port = hindsight?.port;
        if (port == null) continue;
        const last = checks.get(id);
        if (last?.running || (last?.port === port && now - last.began < every)) continue;
        const current = { port, began: now, running: true };
        checks.set(id, current);
        new Promise(resolve => resolve(check(port))).then(healthy => healthy === true, () => false).then(healthy => {
          current.running = false;
          onResult(id, { port, healthy, at: now });
        });
      }
    },
  };
}

// memoryChecked(state, project, { port, healthy, at }) — a check's answer
// (ASS-293) in memoryHealth: id → { port, healthy, since }, since when the
// first check that found it so (on this port) began; the very same state when
// nothing changed, so there is nothing to draw.
export function memoryChecked(state, project, { port, healthy, at }) {
  const last = state.memoryHealth?.[project];
  if (last?.port === port && last.healthy === healthy) return state;
  return { ...state, memoryHealth: { ...state.memoryHealth, [project]: { port, healthy, since: at } } };
}

const memoriesOf = state => state.memories[state.projects[state.project]?.id]?.items ?? [];
const cell = value => (value ? String(value) : NONE);
// A memory's row: its text, cut, then its source; the date it was saved when its metadata names none.
// An observation (ASS-156) — Hindsight's consolidation writes it with no
// metadata, naming the facts it came from in source_memory_ids — takes its
// source from those facts among the items: their tickets as "obs ← ASS-154,
// ASS-62", their steps and models, each named once.
export function memoryRows(items) {
  const byId = new Map(items.map(m => [m.id, m]));
  const source = m => {
    if (m.fact_type !== 'observation') return m.metadata ?? {};
    const facts = (m.source_memory_ids ?? []).map(id => byId.get(id)?.metadata).filter(Boolean);
    const each = field => [...new Set(facts.map(f => f[field]).filter(Boolean))].join(', ');
    return { ticket: `obs ← ${each('ticket') || '?'}`, step: each('step'), model: each('model') };
  };
  return items.map(m => {
    const { ticket, step, model, date } = source(m);
    return [
      visible(m.text ?? '') <= TEXT_WIDTH ? m.text ?? '' : `${clip(m.text, TEXT_WIDTH - 1)}…`,
      cell(ticket), cell(step), cell(model), cell(date ?? m.mentioned_at?.slice(0, 10)),
    ];
  });
}

// memoryUse(sprint) — how the sprint's agents used memory (ASS-147), from
// the memory counts each finished dispatch records (assignments:remove
// --memory): { total, steps: [[step, counts]] } — counts { recalls, returned,
// saves, deletes } — over every live variation of its features, bugs and
// spikes; a dispatch's step the state its change moved into, or the deepest
// sub-step of a change within a step. Steps that used none are left out, the
// most used (calls of every kind) first.
const COUNTS = ['recalls', 'returned', 'saves', 'deletes'];
export function memoryUse(sprint) {
  const zero = () => Object.fromEntries(COUNTS.map(k => [k, 0]));
  const total = zero(), steps = new Map();
  const changes = ['features', 'bugs', 'spikes'].flatMap(list => sprint?.[list] ?? []).flatMap(t => t.variations ?? [])
    .filter(v => !v['is-deleted']).flatMap(v => v['state-changes'] ?? []);
  for (const c of changes) {
    let step = c;
    while (step['sub-state-change']) step = step['sub-state-change'];
    for (const { memory } of c['agent-dispatch-log'] ?? []) {
      if (!memory || !COUNTS.some(k => memory[k])) continue;
      if (!steps.has(step['to-state'])) steps.set(step['to-state'], zero());
      for (const k of COUNTS) { total[k] += memory[k] ?? 0; steps.get(step['to-state'])[k] += memory[k] ?? 0; }
    }
  }
  const calls = c => c.recalls + c.saves + c.deletes;
  return { total, steps: [...steps].sort(([, a], [, b]) => calls(b) - calls(a)) };
}

// memoryUseLines(state) — the selected project's memory use over its current
// sprint, over its memories: the totals, then a line per step (memoryUse).
export function memoryUseLines(state) {
  const sprint = state.projects[state.project]?.sprint;
  if (!sprint) return ['Memory use: no active sprint'];
  const { total, steps } = memoryUse(sprint);
  if (!steps.length) return [`Memory use in sprint ${sprint.number}: none recorded`];
  const counts = c => COUNTS.map(k => `${k} ${c[k]}`).join('  ');
  const width = Math.max(...steps.map(([step]) => visible(step)));
  return [`Memory use in sprint ${sprint.number}: ${counts(total)}`, ...steps.map(([step, c]) => `  ${pad(step, width)}  ${counts(c)}`)];
}

// memoryHead(state) — the line over the table: how many memories, or why there are none to show.
export function memoryHead(state) {
  const project = state.projects[state.project];
  if (!project) return '';
  if (portOf(state) == null) return `${project.name} has no Hindsight: add "hindsight": { "port": <n>, "llm-api-key": null } to its project.json`;
  const result = state.memories[project.id];
  if (!result) return `loading ${project.id}'s memories…`;
  if (result.error) return result.error;
  return `${result.items.length} memories in ${project.id}'s Hindsight — ↑/↓ to choose, delete to delete one`;
}

// memoryKey(state, key, move) — a key on the screen's grid: ↑/↓ through
// `move` (app.js's grid step); delete or backspace asks about the selected one.
export function memoryKey(state, key, move) {
  const items = memoriesOf(state);
  if (key.name === 'up' || key.name === 'down') {
    const [memorySelected, memoryScroll] = move(state.memorySelected, state.memoryScroll, key.name === 'up' ? -1 : 1);
    return { ...state, memorySelected, memoryScroll };
  }
  const m = items[state.memorySelected];
  if ((key.name === 'delete' || key.name === 'backspace') && m?.document_id) {
    return { ...state, memoryConfirm: { project: state.projects[state.project].id, port: portOf(state), document: m.document_id, text: m.text } };
  }
  return state;
}

// confirmMemory(state, key) — y deletes the memory asked about (memoryDelete, for main.js); any other key keeps it.
export function confirmMemory(state, key) {
  const yes = key.sequence === 'y' || key.name === 'y';
  const { text, ...doomed } = state.memoryConfirm;
  return { ...state, memoryConfirm: null, memoryDelete: yes ? doomed : null, memorySelected: yes ? Math.max(0, state.memorySelected - 1) : state.memorySelected };
}

// memoryAsking(state) — the question under the table while a delete is asked.
export const memoryAsking = state => (state.memoryConfirm ? `Delete the memory '${state.memoryConfirm.text}'? y/n` : state.memoryMessage ?? '');
