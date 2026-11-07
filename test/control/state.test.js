// What control reads each tick, and where: the paths the env overrides, and
// the data as one object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { paths, loadState } from '../../src/control/state.js';
import { fixture, SELF_HEALING_ENGINE, TEST_ENGINE } from '../agent-cli/harness-fixture.js';

test('paths are under the root, the data in its data/ folder, unless the env names them, as the agent-cli commands take them', () => {
  assert.deepEqual(paths('/repo', {}), {
    assignments: '/repo/data/assignments.json', harness: '/repo/data/harness.json', engines: '/repo/engines', projects: '/repo/data/projects', agents: '/repo/data/agents', prompts: '/repo/prompts', contextWindows: '/repo/data/context-windows.json', diskSpace: '/repo/data/disk-space.json',
  });
  const f = fixture();
  assert.deepEqual(paths('/repo', f.env), {
    assignments: join(f.dir, 'assignments.json'), harness: join(f.dir, 'harness.json'), engines: join(f.dir, 'engines'), projects: join(f.dir, 'projects'), agents: join(f.dir, 'agents'), prompts: join(f.dir, 'prompts'), contextWindows: f.env.CONTEXT_WINDOWS_FILE, diskSpace: f.env.DISK_SPACE_FILE,
  });
  // ASS-288: disk-space.json beside the harness.json in use, without DISK_SPACE_FILE.
  assert.equal(paths('/repo', { HARNESS_FILE: '/elsewhere/harness.json' }).diskSpace, '/elsewhere/disk-space.json');
});

test('ASS-288: loadState reads disk-space.json into diskSpace (null without it, or caught half-written)', () => {
  const f = fixture();
  assert.equal(loadState(paths('/repo', f.env)).diskSpace, null);
  writeFileSync(f.env.DISK_SPACE_FILE, JSON.stringify({ level: 'hold', 'free-bytes': 1 }));
  assert.deepEqual(loadState(paths('/repo', f.env)).diskSpace, { level: 'hold', 'free-bytes': 1 });
  writeFileSync(f.env.DISK_SPACE_FILE, '{"lev');
  assert.equal(loadState(paths('/repo', f.env)).diskSpace, null);
});

// ASS-190 AC2: control reads the learned context-window cache so a tile can
// show ctx NN% from an earlier session's window; {} without the file.
test('ASS-190 AC2: loadState reads context-windows.json into contextWindows ({} without; honours CONTEXT_WINDOWS_FILE)', () => {
  const f = fixture();
  assert.deepEqual(loadState(paths('/repo', f.env)).contextWindows, {});
  writeFileSync(f.env.CONTEXT_WINDOWS_FILE, JSON.stringify({ 'fake-model': 200000 }));
  assert.deepEqual(loadState(paths('/repo', f.env)).contextWindows, { 'fake-model': 200000 });
});

test('loadState reads the harness, the assignments and their runs and pauses, every engine by name, and each project with its execution engine and active sprint', () => {
  const f = fixture();
  const state = loadState(paths('/repo', f.env));
  assert.equal(state.harness['max-agents'], null);
  assert.deepEqual(state.assignments.map(a => a['agent-name']), ['Daredevil', 'Spock', 'Leia']);
  assert.deepEqual(state.transient.map(t => t.id), [SELF_HEALING_ENGINE, TEST_ENGINE]);
  assert.deepEqual([state.pauses, state.selfHealing], [{}, {}]);
  assert.deepEqual(Object.keys(state.engines).toSorted(), ['example-development', 'self-healing', 'test']);
  assert.equal(state.engines['example-development'].steps.length, 3);
  assert.deepEqual(state.projects.map(p => [p.id, p.engineName, p.json.name]), [['p', 'example-development', 'P'], ['q', 'example-development', 'Q']]);
  const [p] = state.projects;
  assert.equal(p.engine, state.engines['example-development']);
  assert.equal(p.sprintFile, join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'));
  assert.equal(p.sprint.features[0].key, 'ABC-3');
  assert.deepEqual(p.tickets.map(t => [t.key, t.type]), [['ABC-3', 'feature']]);
  assert.equal(p.tickets[0].variations.length, 4);                                  // deleted ones included: control decides what to skip
});

test('a project with no active sprint, or none at all, has a null sprint and no tickets; missing pauses read as none', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'projects', 'q', 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': false }] }));
  const data = f.assignments();
  delete data.pauses;
  writeFileSync(f.env.ASSIGNMENTS_FILE, JSON.stringify(data));
  const state = loadState(paths('/repo', f.env));
  assert.deepEqual([state.projects[1].sprint, state.projects[1].tickets, state.pauses], [null, [], {}]);
});

for (const tool of ['gcloud', 'glab']) test(`each project carries ${tool}RequiresReauthentication from its own file (ASS-58): true only for content exactly true; missing or anything else is false`, () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', `${tool}-requires-reauthentication`);
  const flag = () => loadState(paths('/repo', f.env)).projects.map(p => p[`${tool}RequiresReauthentication`]);
  assert.deepEqual(flag(), [false, false]);                                         // no file
  writeFileSync(file, 'true');
  assert.deepEqual(flag(), [true, false]);
  for (const other of ['false', 'true\n', 'True', '', 'yes']) {
    writeFileSync(file, other);
    assert.deepEqual(flag(), [false, false], JSON.stringify(other));
  }
});

test('each project carries rateLimit from its own rate-limit.json (ASS-94), the whole per-kind map (ASS-215), null without one; a rate-limit in project.json is not read', () => {
  const f = fixture();
  const limits = () => loadState(paths('/repo', f.env)).projects.map(p => p.rateLimit);
  assert.deepEqual(limits(), [null, null]);
  const hold = { claude: { since: '2026-10-11T12:00:00Z', type: 'five_hour', 'resets-at': '2026-10-11T13:00:00Z' }, anthropic: { since: '2026-10-11T12:30:00Z', type: 'seven_day', 'resets-at': '2026-10-18T12:30:00Z' } };
  writeFileSync(join(f.dir, 'projects', 'q', 'rate-limit.json'), JSON.stringify(hold));
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'rate-limit': hold }));
  assert.deepEqual(limits(), [null, hold]);
});

// ASS-104: control ignores a soft-deleted ticket (ticket:delete) — in the sprint
// or the backlog — and one deleted in the sprint does not come back from the backlog.
test('loadState leaves soft-deleted tickets (is-deleted) out of a project\'s tickets and backlog', () => {
  const f = fixture();
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  s.features.push({ key: 'ABC-4', 'is-deleted': true, variations: [] });
  writeFileSync(sprint, JSON.stringify(s));
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [{ key: 'ABC-4' }, { key: 'ABC-5', 'is-deleted': true }, { key: 'ABC-6' }] }));
  const [p] = loadState(paths('/repo', f.env)).projects;
  assert.deepEqual(p.tickets.map(t => t.key), ['ABC-3']);
  assert.deepEqual(p.backlog.map(t => t.key), ['ABC-6']);
});

// ASS-202 AC1: a backlog entry is hidden only while its ticket is Done or in
// the active sprint — one shared predicate. A delivered ticket stays hidden
// across sprint rollovers; a ticket reopened from Done returns to the backlog.
test('ASS-202 AC1: loadState hides a Done backlog entry across a sprint rollover, and reveals it again once it is reopened', () => {
  const f = fixture();
  const projectDir = join(f.dir, 'projects', 'p');
  // sprint-10 (the fixture's) made inactive; sprint-11 active and empty — the rollover.
  writeFileSync(join(projectDir, 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': false }, { number: 11, 'is-active': true }] }));
  mkdirSync(join(projectDir, 'sprints', 'sprint-11'), { recursive: true });
  writeFileSync(join(projectDir, 'sprints', 'sprint-11', 'sprint.json'), JSON.stringify({ number: 11, features: [], bugs: [], spikes: [] }));
  // Entry K has a kept backlog entry (its ticket is in the now-inactive sprint-10) with a Done status.
  const file = join(projectDir, 'backlog.json');
  const entry = status => JSON.stringify({ tickets: [{ key: 'ABC-3', 'ticket-system-status': status }, { key: 'ABC-6' }] });
  writeFileSync(file, entry('Done'));
  assert.deepEqual(loadState(paths('/repo', f.env)).projects[0].backlog.map(t => t.key), ['ABC-6']);
  // Reopened (ticket-system-status back to Backlog), the entry returns to the backlog.
  writeFileSync(file, entry('Backlog'));
  assert.deepEqual(loadState(paths('/repo', f.env)).projects[0].backlog.map(t => t.key), ['ABC-3', 'ABC-6']);
});

// ASS-202 AC1: a Done entry whose ticket is in the active sprint stays
// omitted (both clauses hide it); a soft-deleted Done entry still omitted
// (the is-deleted branch unchanged); a Done entry in a project with no active
// sprint still hidden (the Done clause alone); an entry missing
// ticket-system-status is shown (strict equality, not Done).
test('ASS-202 AC1: Done, soft-deleted, no-active-sprint and status-missing cases', () => {
  const f = fixture();
  const projectDir = join(f.dir, 'projects', 'p');
  // ABC-3 is in the active sprint (fixture) → hidden by active-sprint clause; ABC-5 soft-deleted and Done; ABC-6 status missing; ABC-7 Done, hidden.
  writeFileSync(join(projectDir, 'backlog.json'), JSON.stringify({ tickets: [
    { key: 'ABC-3' },
    { key: 'ABC-5', 'is-deleted': true, 'ticket-system-status': 'Done' },
    { key: 'ABC-6' },
    { key: 'ABC-7', 'ticket-system-status': 'Done' },
  ] }));
  assert.deepEqual(loadState(paths('/repo', f.env)).projects[0].backlog.map(t => t.key), ['ABC-6']);
  // No active sprint: Done still hidden by the Done clause alone.
  writeFileSync(join(projectDir, 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': false }] }));
  assert.deepEqual(loadState(paths('/repo', f.env)).projects[0].backlog.map(t => t.key), ['ABC-3', 'ABC-6']);   // ABC-3 shows: sprint gone; ABC-7 still hidden (Done).
});

// ASS-202 AC1: the hide predicate is one shared export from src/control/rank.js
// — no second copy in state.js, load.js or renumber-backlog.js. The predicate
// hides a Done entry, an is-deleted entry and an entry whose key is in the
// active sprint; a plain Backlog entry is shown.
test('ASS-202 AC1: isLiveBacklogEntry is exported from src/control/rank.js and imported by state.js, tui/load.js and renumber-backlog.js', async () => {
  const { isLiveBacklogEntry } = await import('../../src/control/rank.js');
  assert.equal(typeof isLiveBacklogEntry, 'function');
  const inSprint = new Set(['ABC-3']);
  assert.equal(isLiveBacklogEntry({ key: 'ABC-6', 'ticket-system-status': 'Backlog' }, inSprint), true);
  assert.equal(isLiveBacklogEntry({ key: 'ABC-7', 'ticket-system-status': 'Done' }, inSprint), false);
  assert.equal(isLiveBacklogEntry({ key: 'ABC-8', 'is-deleted': true }, inSprint), false);
  assert.equal(isLiveBacklogEntry({ key: 'abc-3' }, inSprint), false);                                 // key compared upper case
  // The import sits in rank.js's three callers, so the predicate's shape is not duplicated (ASS-202).
  for (const path of ['../../src/control/state.js', '../../src/tui/load.js', '../../src/agent-cli/ticket/renumber-backlog.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(src, /\bisLiveBacklogEntry\b.*from\s+['"][^'"]*rank\.js['"]|from\s+['"][^'"]*rank\.js['"][^;]*\bisLiveBacklogEntry\b/s, path);
  }
});
