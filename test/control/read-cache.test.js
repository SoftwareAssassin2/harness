// ASS-495: loadState reuses a file's last parse while the file is unchanged
// (read.js readJsonCached: same device, inode, size, mtime and ctime) and its
// derived pieces while their inputs are (state.js memo), deep-frozen so no
// caller can change what the next load is handed; anything changed, a
// rename-over or an in-place write, is read again, and a half-written file
// is the data's trouble as before (ASS-457/458).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, renameSync, mkdtempSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readJsonCached, cacheStats, deepFreeze } from '../../src/control/read.js';
import { paths, loadState, memoStats } from '../../src/control/state.js';
import { fixture } from '../agent-cli/harness-fixture.js';

const parses = fn => { const before = cacheStats.parses; const value = fn(); return [cacheStats.parses - before, value]; };
const edit = (file, fn) => { const json = JSON.parse(readFileSync(file, 'utf8')); fn(json); writeFileSync(`${file}.tmp`, JSON.stringify(json)); renameSync(`${file}.tmp`, file); };   // as cli.js writes: temp + rename

test('ASS-495 AC1, AC5: an unchanged file is not parsed again; a rename-over, an in-place write of the same size and an mtime change are each read again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-cache-'));
  const file = join(dir, 'a.json');
  writeFileSync(file, '{"a":1}');
  const [first, a] = parses(() => readJsonCached(file));
  assert.equal(first, 1);
  assert.deepEqual(a, { a: 1 });
  const [again, b] = parses(() => readJsonCached(file));
  assert.equal(again, 0);                                                // unchanged: the same parse
  assert.equal(b, a);
  // Renamed over by a file of the same content and size (how the harness writes): a new inode, read again.
  writeFileSync(join(dir, 'a.tmp'), '{"a":1}');
  renameSync(join(dir, 'a.tmp'), file);
  const [renamed, c] = parses(() => readJsonCached(file));
  assert.equal(renamed, 1);
  assert.notEqual(c, a);
  // Written in place, the same size: same inode, but mtime and ctime move.
  const ino = statSync(file).ino;
  writeFileSync(file, '{"a":2}');
  assert.equal(statSync(file).ino, ino);
  const [inPlace, d] = parses(() => readJsonCached(file));
  assert.equal(inPlace, 1);
  assert.deepEqual(d, { a: 2 });
  // Only its mtime changed (the content as it was).
  utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1));
  const [touched, e] = parses(() => readJsonCached(file));
  assert.equal(touched, 1);
  assert.deepEqual(e, { a: 2 });
  assert.equal(parses(() => readJsonCached(file))[0], 0);
});

test('ASS-495 AC3, AC5: a file caught half-written still fails as the data\'s trouble, never served from the cache, and reads once whole again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-cache-'));
  const file = join(dir, 'a.json');
  writeFileSync(file, '{"a":1,"b":[1,2,3]}');
  assert.deepEqual(readJsonCached(file), { a: 1, b: [1, 2, 3] });
  writeFileSync(file, '{"a":1,"b":[');                                   // a merge rewriting it in place
  assert.throws(() => readJsonCached(file, [1, 1]), error => error instanceof SyntaxError && error.file === file);
  assert.throws(() => readJsonCached(file, [1, 1]), SyntaxError);         // and again: nothing kept of the bad read
  writeFileSync(file, '{"a":3}');
  assert.deepEqual(readJsonCached(file), { a: 3 });
  // A file gone fails as readJson's own read does: the same code and message.
  assert.throws(() => readJsonCached(join(dir, 'gone.json')), error => error.code === 'ENOENT' && /open '.*gone\.json'/.test(error.message));
  // Through loadState: assignments.json caught half-written throws, as before (tick.js marks it the data's trouble).
  const f = fixture();
  const p = paths('/repo', f.env);
  loadState(p);
  writeFileSync(f.env.ASSIGNMENTS_FILE, '{"assignments": [');
  assert.throws(() => loadState(p), error => error instanceof SyntaxError && error.file === f.env.ASSIGNMENTS_FILE);
});

test('ASS-495 AC2, AC5: what loadState hands out is frozen, so a mutation throws and cannot leak into the next load; the state and project objects are its own each load', () => {
  const f = fixture();
  const p = paths('/repo', f.env);
  const one = loadState(p);
  const [ticket] = one.projects[0].tickets;
  assert.throws(() => { ticket.title = 'changed'; }, TypeError);
  assert.throws(() => { ticket.variations.push({ name: 'z' }); }, TypeError);
  assert.throws(() => { one.projects[0].json.name = 'changed'; }, TypeError);
  assert.throws(() => { one.engines['example-development'].steps[0].id = 'changed'; }, TypeError);
  assert.throws(() => { one.assignments.pop(); }, TypeError);
  assert.throws(() => { one.harness['max-agents'] = 3; }, TypeError);
  // The project object is the load's own: setting its seats (seats.js does) leaves the next load's as read.
  one.projects[0].seats = [{ key: 'ABC-3' }];
  one.projects[0].memoryWait = { waiting: [] };
  const two = loadState(p);
  assert.notEqual(two.projects[0], one.projects[0]);
  assert.notEqual(two, one);
  assert.deepEqual(two.projects[0].seats, []);
  assert.equal(two.projects[0].memoryWait, null);
  assert.equal(two.projects[0].tickets[0].title, ticket.title);
  assert.equal(two.projects[0].tickets[0].variations.length, ticket.variations.length);
  // deepFreeze freezes all the way down.
  const deep = deepFreeze({ a: [{ b: { c: 1 } }] });
  assert.ok(Object.isFrozen(deep.a[0].b));
});

test('ASS-495 AC1, AC3, AC5: loadState\'s derived pieces are kept while their inputs are unchanged, and recomputed, the write seen, when one changes', () => {
  const f = fixture();
  const p = paths('/repo', f.env);
  const projectDir = join(f.dir, 'projects', 'p');
  const sprintFile = join(projectDir, 'sprints', 'sprint-10', 'sprint.json');
  const one = loadState(p);
  const computes = memoStats.computes;
  const [n, two] = parses(() => loadState(p));
  assert.equal(n, 0);                                                    // nothing changed: nothing parsed
  assert.equal(memoStats.computes, computes);                           // nor derived
  assert.equal(two.projects[0].tickets, one.projects[0].tickets);
  assert.equal(two.projects[0].backlog, one.projects[0].backlog);
  assert.equal(two.projects[0].engines, one.projects[0].engines);
  assert.equal(two.engines, one.engines);
  // The sprint (flattenSprint): a ticket's title changed.
  edit(sprintFile, s => { s.features[0].title = 'Renamed'; });
  const [sprintParses, three] = parses(() => loadState(p));
  assert.equal(sprintParses, 1);                                         // the sprint.json alone
  assert.equal(three.projects[0].tickets[0].title, 'Renamed');
  assert.equal(three.projects[1].tickets, two.projects[1].tickets);       // the other project's kept
  // The backlog: a new entry.
  writeFileSync(join(projectDir, 'backlog.json'), JSON.stringify({ tickets: [{ key: 'ABC-40' }] }));
  assert.deepEqual(loadState(p).projects[0].backlog.map(t => t.key), ['ABC-40']);
  // The ticket moving into the sprint takes it off the backlog: recomputed for the sprint's change too.
  edit(sprintFile, s => { s.features.push({ key: 'ABC-40', title: 'Moved in', variations: [] }); });
  const four = loadState(p);
  assert.deepEqual(four.projects[0].backlog, []);
  assert.ok(four.projects[0].tickets.some(t => t.key === 'ABC-40'));
  // The engine merge and switchOff: engines/'s engine changed (take-screenshots given a way past it), then
  // switched-off-steps in p's project.json, then the engine changed again.
  edit(join(f.dir, 'engines', 'test', 'workflow.yaml'), e => { e.steps[1]['exit-events'] = [{ condition: { always: true }, 'move-to-state': 'done' }]; });
  const five = loadState(p);
  assert.deepEqual(five.engines.test.steps[1]['exit-events'][0]['move-to-state'], 'done');
  assert.equal(five.projects[0].engines.test, five.engines.test);
  edit(join(projectDir, 'project.json'), j => { j['switched-off-steps'] = ['test/take-screenshots']; });
  const six = loadState(p);
  assert.deepEqual(six.projects[0].switchedOffErrors, []);
  assert.equal(six.projects[0].engines.test.steps.find(s => s.id === 'take-screenshots')['is-active'], false);
  assert.equal(six.projects[1].engines.test.steps.find(s => s.id === 'take-screenshots')['is-active'], undefined);
  edit(join(f.dir, 'engines', 'test', 'workflow.yaml'), e => { e.steps[0].name = 'Renamed'; });
  const seven = loadState(p);
  assert.equal(seven.engines.test.steps[0].name, 'Renamed');
  assert.equal(seven.projects[0].engines.test.steps[0].name, 'Renamed');
  assert.equal(seven.projects[0].engines.test.steps.find(s => s.id === 'take-screenshots')['is-active'], false);
  assert.equal(seven.projects[1].engines.test.steps[0].name, 'Renamed');
});
