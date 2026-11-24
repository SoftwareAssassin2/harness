// ASS-561: the dashboard's side of a missing or failing Atlassian API token or acli login. While
// project:check-credentials' atlassian-needs.json is there (load.js atlassianNeeds), the sprint header shows a
// white-on-red chip naming the project's fix command — a header warning, so it notifies once too (ASS-412) — and
// the project is not held (no "Project blocked by credentials" chip). Gone with the file. Generic projects only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, render } from '../../src/tui/app.js';
import { headerWarnings } from '../../src/tui/screens/frame.js';
import { loadProjects } from '../../src/tui/load.js';
import { liveWarnings } from '../../src/notify/warnings.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-11-23T16:00:00Z');
const wide = { columns: 240, rows: 50, now: NOW, timeZone: 'UTC' };
const steps = [
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const NEEDS = { since: '2026-11-23T15:00:00Z', problems: [
  { credential: 'keychain item "Atlassian API Token (Test)" (atlassian)', problem: 'missing from the keychain: the analytics cannot sign in to Jira', fix: './agent.sh project:set-atlassian-token p' },
  { credential: 'the acli login (example.atlassian.net)', problem: 'acli is not logged in to Jira', fix: './agent.sh project:set-atlassian-token p' },
] };
const CHIP = "Atlassian sign-in: run './agent.sh project:set-atlassian-token p'";
function dashboard(atlassianNeeds = null) {
  const p = { id: 'p', name: 'P', stateEngine: 'e', sprint: { number: 10, start: '2026-11-17', end: '2026-11-30', features: [{ key: 'A-0', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }], bugs: [], spikes: [] }, backlog: [], questions: [], days: {}, notifications: true, atlassianNeeds };
  return initialState({ projects: [p], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
}

test('ASS-561: load.js reads atlassian-needs.json as atlassianNeeds, null without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlassian-needs-'));
  for (const id of ['a', 'b']) { mkdirSync(join(dir, id)); writeFileSync(join(dir, id, 'project.json'), JSON.stringify({ name: id.toUpperCase() })); }
  writeFileSync(join(dir, 'a', 'atlassian-needs.json'), JSON.stringify(NEEDS));
  try {
    assert.deepEqual(loadProjects(dir, join(dir, 'lima')).map(p => [p.id, p.atlassianNeeds]), [['a', NEEDS], ['b', null]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ASS-561 AC1/AC2: while the record is there the header shows a red chip naming the fix and it notifies, saying each problem; the project is not held', () => {
  const shown = render(dashboard(NEEDS), wide);
  assert.ok(shown.some(l => l.includes(`\x1b[41;97m ${CHIP} \x1b[0m`)), shown.map(strip).join('\n'));
  const warnings = headerWarnings(dashboard(NEEDS), NOW.getTime());
  const warning = warnings.find(w => w.id === 'atlassian-token');
  assert.equal(warning.text, CHIP);
  assert.equal(warning.chip, true);
  assert.equal(warning.operator, false);
  assert.equal(warning.scope, 'project');
  assert.match(warning.todo, /^keychain item "Atlassian API Token \(Test\)" \(atlassian\): missing from the keychain.*; the acli login \(example\.atlassian\.net\): acli is not logged in to Jira\. .*run \.\/agent\.sh project:set-atlassian-token p/);
  assert.ok(!warnings.some(w => w.id === 'credentials'), 'not a credentials hold');
  assert.ok(liveWarnings(dashboard(NEEDS), NOW.getTime()).p.some(w => w.key === 'atlassian-token'));
});

test('ASS-561 AC5: once the check removes the record (or finds no problem), neither the chip nor the warning', () => {
  for (const state of [dashboard(), dashboard({ since: null, problems: [] })]) {
    assert.ok(!render(state, wide).some(l => strip(l).includes('Atlassian sign-in')));
    assert.ok(!headerWarnings(state, NOW.getTime()).some(w => w.id === 'atlassian-token'));
  }
});
