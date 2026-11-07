// The memory screen (ASS-62 AC8): h opens the selected project's Hindsight
// memories — each with its source: ticket, step, model and date — fetched by
// main.js when the screen opens (memoryLoad); ↑/↓ select one, delete or
// backspace asks, y deletes it (memoryDelete, for main.js), any other key keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { memoryLoaded, healthPoller, memoryChecked, HEALTH_EVERY } from '../../src/tui/memory.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');
const screen = { columns: 160, rows: 40, now: new Date('2026-10-25T16:00:00Z') };
const lines = s => render(s, screen).map(strip);
const key = (name, extra = {}) => ({ name, ...extra });
const plain = letter => key(letter, { sequence: letter });

const projects = [{ id: 'harness', name: 'Harness', sprint: null, hindsight: { port: 8891 } }, { id: 'bare', name: 'Bare', sprint: null }];
const memories = [
  { id: 'u1', text: 'npm test runs every suite; timing tests flake under load', document_id: 'tests-npm', metadata: { ticket: 'ASS-62', step: 'generate-solution', model: 'claude-opus-5-5', date: '2026-10-25' }, mentioned_at: '2026-10-25T10:00:00Z' },
  { id: 'u2', text: 'zot listens on 127.0.0.1 only', document_id: 'zot-loopback', metadata: {}, mentioned_at: '2026-10-24T09:00:00Z' },
];
const opened = () => handleKey({ ...initialState({ projects }), menuHidden: true }, plain('h'));

test('AC8: h opens the memory screen, asking main.js for the project\'s memories; the ? menu lists it', () => {
  const s = opened();
  assert.equal(s.screen, 'h');
  assert.equal(s.memoryLoad, 'harness');
  const menu = lines(handleKey(s, { sequence: '?' }));
  assert.ok(menu.some(l => /│ u +updates +│/.test(l)) && menu.some(l => /│ h +memory +│/.test(l)));
  assert.ok(lines(s).some(l => l.includes('loading harness\'s memories')), lines(s).join('\n'));
});

test('AC8: the memories show with their source — ticket, step, model, date (the date it was saved when its metadata has none)', () => {
  const s = memoryLoaded(opened(), 'harness', { items: memories });
  const out = lines(s);
  const row = out.find(l => l.includes('npm test runs every suite'));
  assert.ok(row, out.join('\n'));
  for (const cell of ['ASS-62', 'generate-solution', 'claude-opus-5-5', '2026-10-25']) assert.ok(row.includes(cell), row);
  const other = out.find(l => l.includes('zot listens on 127.0.0.1 only'));
  assert.ok(other.includes('2026-10-24') && other.includes('—'), other);
  assert.ok(out.some(l => /Memory.*Ticket.*Step.*Model.*Saved/.test(l)), out.join('\n'));
  assert.ok(out.some(l => l.includes('2 memories in harness\'s Hindsight')), out.join('\n'));
});

test('AC8: ↓ selects the next memory; delete asks; y deletes it — its document, for main.js; any other key keeps it', () => {
  let s = memoryLoaded(opened(), 'harness', { items: memories });
  s = handleKey(s, key('down'));
  assert.equal(s.memorySelected, 1);
  const asking = handleKey(s, key('delete'));
  assert.deepEqual(asking.memoryConfirm, { project: 'harness', port: 8891, document: 'zot-loopback', text: 'zot listens on 127.0.0.1 only' });
  assert.ok(lines(asking).some(l => l.includes('Delete the memory \'zot listens on 127.0.0.1 only\'? y/n')), lines(asking).join('\n'));
  const yes = handleKey(asking, plain('y'));
  assert.deepEqual([yes.memoryConfirm, yes.memoryDelete], [null, { project: 'harness', port: 8891, document: 'zot-loopback' }]);
  const no = handleKey(asking, plain('n'));
  assert.deepEqual([no.memoryConfirm, no.memoryDelete, no.screen], [null, null, 'h']);
});

test('AC8: a project with no Hindsight, and one whose Hindsight does not answer, say so', () => {
  const s = handleKey({ ...initialState({ projects }), project: 1, menuHidden: true }, plain('h'));
  assert.equal(s.memoryLoad, null);
  assert.ok(lines(s).some(l => l.includes('Bare has no Hindsight: add "hindsight": { "port": <n>, "llm-api-key": null } to its project.json')), lines(s).join('\n'));
  const down = memoryLoaded(opened(), 'harness', { error: 'harness\'s Hindsight is not answering on 127.0.0.1:8891' });
  assert.ok(lines(down).some(l => l.includes('harness\'s Hindsight is not answering on 127.0.0.1:8891')), lines(down).join('\n'));
});

// ASS-147: the selected project's memory use over its current sprint, from its dispatches' memory counts.
const m = (recalls, returned, saves, deletes) => ({ 'dispatched-to': 'Thor', timestamp: '2026-10-25T10:00:00Z', memory: { recalls, returned, saves, deletes } });
const move = (to, log, sub) => ({ 'from-state': 'x', 'to-state': to, timestamp: '2026-10-25T10:00:00Z', 'agent-dispatch-log': log, ...(sub ? { 'sub-state-change': sub } : {}) });
const sprint = {
  number: 10,
  features: [{ key: 'ASS-1', variations: [
    { name: 'A', 'state-changes': [move('plan', [m(3, 4, 1, 0), { 'dispatched-to': 'Loki', timestamp: '2026-10-25T10:00:00Z' }]), move('build', [m(1, 2, 0, 0)])] },
    { name: 'B', 'is-deleted': true, 'state-changes': [move('plan', [m(9, 9, 9, 9)])] },          // deleted: not counted
  ] }],
  bugs: [{ key: 'ASS-2', variations: [{ name: 'A', 'state-changes': [
    move('plan', [m(2, 1, 2, 1)]),
    move('review', [m(0, 0, 0, 0)], { 'state-engine': 'r', 'from-state': 'draft', 'to-state': 'check' }),   // within a step: its sub-step
  ] }] }],
};
const withSprint = s => ({ ...initialState({ projects: [{ ...projects[0], sprint: s }, projects[1]] }), menuHidden: true });

test('ASS-147 AC2: the memory screen shows the project\'s memory use over its current sprint — recalls, memories returned, saves, deletes — in total and per step, the most used first', () => {
  const out = lines(handleKey(withSprint(sprint), plain('h')));
  const at = out.findIndex(l => l.includes('Memory use in sprint 10'));
  assert.ok(at >= 0, out.join('\n'));
  assert.match(out[at], /Memory use in sprint 10: recalls 6 {2}returned 7 {2}saves 3 {2}deletes 1$/);
  assert.match(out[at + 1], /^ {2}plan {3}recalls 5 {2}returned 5 {2}saves 3 {2}deletes 1$/);
  assert.match(out[at + 2], /^ {2}build {2}recalls 1 {2}returned 2 {2}saves 0 {2}deletes 0$/);
  assert.ok(!out.some(l => /^ {2}(check|review) /.test(l)), out.join('\n'));                      // no memory used there
  assert.ok(out.some(l => l.includes('loading harness\'s memories')), out.join('\n'));            // the memories still below
});

test('ASS-147 AC2: a sprint whose dispatches used no memory says so; no active sprint says so', () => {
  const none = { number: 11, features: [{ key: 'ASS-1', variations: [{ name: 'A', 'state-changes': [move('plan', [m(0, 0, 0, 0)])] }] }] };
  assert.ok(lines(handleKey(withSprint(none), plain('h'))).some(l => l.includes('Memory use in sprint 11: none recorded')));
  assert.ok(lines(opened()).some(l => l.includes('Memory use: no active sprint')));
});

// ASS-156: Hindsight's observations carry no metadata of their own; the facts
// they came from (source_memory_ids) do.
test('ASS-156 AC2: an observation shows its source as its source facts\' tickets — obs ← ASS-154, ASS-62 — and their steps and models', () => {
  const fact = (id, ticket, step, model) => ({ id, text: `fact ${id}`, document_id: id, fact_type: 'world', metadata: { ticket, step, model, date: '2026-10-25' }, mentioned_at: '2026-10-25T10:00:00Z' });
  const items = [fact('f1', 'ASS-154', 'classify', 'claude-opus-5-5'), fact('f2', 'ASS-62', 'build', 'claude-opus-5-5'), fact('f3', 'ASS-154', 'build', 'claude-sonnet-5'),
    { id: 'o1', text: 'vm credentials live in ~/.harness/vm-credentials.json', document_id: null, fact_type: 'observation', metadata: {}, mentioned_at: '2026-10-26T08:00:00Z', source_memory_ids: ['f1', 'f2', 'f3', 'gone'] }];
  const row = lines(memoryLoaded(opened(), 'harness', { items })).find(l => l.includes('vm credentials live'));
  for (const cell of ['obs ← ASS-154, ASS-62', 'classify, build', 'claude-opus-5-5, claude-sonnet-5', '2026-10-26']) assert.ok(row.includes(cell), row);
});

// ===== ASS-293: the dashboard checks each project's Hindsight itself =====
// A poller whose checks are held open until settled: check(port) recorded, answered by settle(i, healthy | Error).
function checks() {
  const asked = [], pending = [], results = [];
  const check = port => new Promise((resolve, reject) => { asked.push(port); pending.push({ resolve, reject }); });
  const poller = healthPoller({ check, onResult: (id, result) => results.push([id, result]) });
  const settle = async (i, answer) => { if (answer instanceof Error) pending[i].reject(answer); else pending[i].resolve(answer); await new Promise(r => setImmediate(r)); };
  return { asked, results, poller, settle };
}
const watched = [{ id: 'harness', hindsight: { port: 8891 } }, { id: 'bare' }, { id: 'other', hindsight: { port: 8892 } }];
const at = s => Date.parse(`2026-10-25T16:00:${s}Z`);

test('ASS-293 AC1: the dashboard checks each project with a hindsight at once and every 15 seconds after, one check in flight per project; poll never waits for a check', async () => {
  const c = checks();
  assert.equal(HEALTH_EVERY, 15_000);
  assert.equal(c.poller.poll(watched, at('00')), undefined);            // returns at once, the checks still open
  assert.deepEqual(c.asked, [8891, 8892]);
  c.poller.poll(watched, at('20'));                                      // still in flight: not asked again
  assert.deepEqual(c.asked, [8891, 8892]);
  await c.settle(0, true);
  assert.deepEqual(c.results, [['harness', { port: 8891, healthy: true, at: at('00') }]]);
  c.poller.poll(watched, at('20'));                                      // 15 seconds since harness's began: again; other still in flight
  assert.deepEqual(c.asked, [8891, 8892, 8891]);
  await c.settle(2, false);
  c.poller.poll(watched, at('34'));
  assert.deepEqual(c.asked, [8891, 8892, 8891]);
  c.poller.poll(watched, at('35'));
  assert.deepEqual(c.asked, [8891, 8892, 8891, 8891]);
  assert.deepEqual(c.results.at(-1), ['harness', { port: 8891, healthy: false, at: at('20') }]);
});

test('ASS-293 AC1: a check that throws counts as down; a project whose port changes is checked on the new port at once', async () => {
  const c = checks();
  c.poller.poll([watched[0]], at('00'));
  await c.settle(0, new Error('boom'));
  assert.deepEqual(c.results, [['harness', { port: 8891, healthy: false, at: at('00') }]]);
  c.poller.poll([{ id: 'harness', hindsight: { port: 9999 } }], at('01'));
  assert.deepEqual(c.asked, [8891, 9999]);
});

test('ASS-293 AC2: memoryChecked keeps each project\'s last check in memoryHealth — down since the first check that found it down, until one finds it up or its port changes', () => {
  let s = initialState({ projects });
  s = memoryChecked(s, 'harness', { port: 8891, healthy: false, at: at('00') });
  assert.deepEqual(s.memoryHealth.harness, { port: 8891, healthy: false, since: at('00') });
  s = memoryChecked(s, 'harness', { port: 8891, healthy: false, at: at('15') });
  assert.deepEqual(s.memoryHealth.harness, { port: 8891, healthy: false, since: at('00') });
  s = memoryChecked(s, 'harness', { port: 8891, healthy: true, at: at('30') });
  assert.deepEqual(s.memoryHealth.harness, { port: 8891, healthy: true, since: at('30') });
  s = memoryChecked(s, 'harness', { port: 8891, healthy: true, at: at('45') });
  assert.equal(s.memoryHealth.harness.since, at('30'));
  s = memoryChecked(s, 'harness', { port: 8892, healthy: true, at: at('50') });
  assert.equal(s.memoryHealth.harness.since, at('50'));
  assert.equal(memoryChecked(s, 'harness', { port: 8892, healthy: true, at: at('55') }), s);   // nothing changed: the same state, nothing to draw
});
