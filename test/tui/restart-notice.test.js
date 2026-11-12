// ASS-393 AC3: a ticket waiting only for a harness restart to load the
// harness fix it waits on — ticket:fix-landed set its variation's
// awaiting-restart while it stands at that ticket:fix-landed step — counts
// towards one white-on-red "Restart to load <n> landed fixes" in the sprint
// header, as "No work in progress" is shown, not as Operator Needed ticket by
// ticket; a stale mark at any other step counts for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { operatorNeeded, restartFixes } from '../../src/tui/screens/shared.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 220, rows: 50, now: new Date('2026-10-01T16:04:00Z') };
// The project's engine: its Blocked step a blocked state here, so a ticket in it would be Operator Needed but for the wait.
const steps = [
  { id: 'blocked', name: 'Blocked', sequence: 0, 'is-blocked-state': true, action: { type: 'state-engine', engine: 'gb' } },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const blockedSteps = [
  { id: 'troubleshoot', name: 'Troubleshoot', sequence: 1, action: { type: 'prompt' } },
  { id: 'await-fix', name: 'Await the Fix', sequence: 2, action: { type: 'script', command: './agent.sh ticket:fix-landed {project} {work-item} {variation}', mode: 'timer' } },
];
const at = (state, sub) => ({ state, 'state-engine': 'e', ...(sub ? { 'sub-status': { state: sub, 'state-engine': 'gb' } } : {}) });
const ticket = (key, status, fix) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': status, ...(fix ? { 'awaiting-restart': fix } : {}) }] });
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });
function dashboard(features) {
  const p = { id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf([ticket('A-0', at('build')), ...features]), backlog: [], questions: [], days: {} };
  return initialState({ projects: [p], workflows: [{ name: 'e', steps }, { name: 'gb', steps: blockedSteps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
}
const notice = text => `\x1b[41;97m ${text} \x1b[0m`;

test('ASS-393 AC3: tickets waiting only on a restart make one header notice, counting their landed fixes, and none of them is Operator Needed', () => {
  const waiting = [ticket('A-1', at('blocked', 'await-fix'), 'HD-9'), ticket('A-2', at('blocked', 'await-fix'), 'HD-9'), ticket('A-3', at('blocked', 'await-fix'), 'HD-7')];
  const state = dashboard(waiting);
  assert.deepEqual([...restartFixes(state)].sort(), ['HD-7', 'HD-9']);
  assert.deepEqual([...operatorNeeded(state)], []);
  const out = render(state, wide);
  assert.ok(out.some(l => l.includes(notice('Restart to load 2 landed fixes'))), out.map(strip).join('\n'));
  assert.equal(out.map(strip).join('\n').match(/Restart to load/g).length, 1);
  assert.ok(render(dashboard([waiting[0]]), wide).some(l => l.includes(notice('Restart to load 1 landed fix'))));
});

test('ASS-393 AC3: no notice without a ticket waiting on a restart; a stale mark away from the fix-landed step is ignored, a blocked ticket still Operator Needed', () => {
  assert.ok(!render(dashboard([]), wide).some(l => strip(l).includes('Restart to load')));
  const stale = dashboard([ticket('A-1', at('blocked', 'troubleshoot'), 'HD-9'), ticket('A-2', at('blocked', 'await-fix'))]);
  assert.deepEqual([...restartFixes(stale)], []);
  assert.deepEqual([...operatorNeeded(stale)].sort(), ['A-1', 'A-2']);
  assert.ok(!render(stale, wide).some(l => strip(l).includes('Restart to load')));
});
