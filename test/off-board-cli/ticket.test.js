// The off-board ticket store: one Markdown file per ticket under
// OFF_BOARD_DIR/<folder>, <folder> and the key prefix from the project's
// off-board work source. Every command runs through off-board.sh against a
// temp projects folder and a temp store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priorityOrder } from '../../src/control/rank.js';

const run = promisify(execFile);
const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const COMMANDS = ['create', 'get', 'list', 'update-name', 'update-status', 'update-requirements', 'add-acceptance-criteria', 'update-acceptance-criteria', 'replace-acceptance-criteria', 'update-points', 'update-priority', 'set-dependencies', 'set-overlaps', 'keep-whole', 'mark-split', 'mark-fast-track', 'history'];
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

const write = (file, content) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4));
};

// A ticket file written by hand, with fixed stamps, so a rewrite shows its new `updated`.
const STORY = (key, body, stamp = '2020-01-01T00:00:00Z') => `---\nkey: ${key}\ntype: Story\nstatus: To Do\ncreated: ${stamp}\nupdated: ${stamp}\n---\n# ${key} title\n\n${body}`;
const BODY = '## User story\n\nAs a user.\n\n## Context\n\nSome context.\n\n## Acceptance criteria\n\n1. AC1: first\n2. AC2: second\n\n## Related\n\nHD-9\n';
// The same, with a hand-written `depends-on:` line after the status (ASS-194), for a graph the command did not write.
const DEPENDS = (key, ...keys) => STORY(key, BODY).replace('status: To Do\n', `status: To Do\ndepends-on: ${keys.join(', ')}\n`);
// The same, with a hand-written `overlaps-with:` line after the status (ASS-196).
const OVERLAPS = (key, ...keys) => STORY(key, BODY).replace('status: To Do\n', `status: To Do\noverlaps-with: ${keys.join(', ')}\n`);
const sections = text => text.split('---\n')[2];   // everything after the front matter

// Projects: p (folder p-tickets, prefix HD), r (no key-prefix), z (prefix ZZ), q (no off-board source).
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ob-'));
  const source = (folder, rest = {}) => ({ name: 'Harness Ticket', type: 'off-board', folder, ...rest });
  write(join(dir, 'projects', 'p', 'project.json'), { name: 'P', 'work-sources': [{ name: 'Jira', type: 'jira' }, source('p-tickets', { 'key-prefix': 'HD' })] });
  write(join(dir, 'projects', 'r', 'project.json'), { name: 'R', 'work-sources': [source('r-tickets')] });
  write(join(dir, 'projects', 'z', 'project.json'), { name: 'Z', 'work-sources': [source('z-tickets', { 'key-prefix': 'ZZ' })] });
  write(join(dir, 'projects', 'q', 'project.json'), { name: 'Q', 'work-sources': [{ name: 'Jira', type: 'jira' }] });
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), OFF_BOARD_DIR: join(dir, 'off-board') };
  const folder = join(dir, 'off-board', 'p-tickets');
  return {
    dir, folder,
    offBoard: (...args) => run(OFF_BOARD, args, { env }),
    json: async (...args) => JSON.parse((await run(OFF_BOARD, args, { env })).stdout),
    file: key => join(folder, `${key}.md`),
    read: key => readFileSync(join(folder, `${key}.md`), 'utf8'),
    put: (key, content) => write(join(folder, `${key}.md`), content),
    body: (name, content) => { const file = join(dir, name); writeFileSync(file, content); return file; },
    // Every ticket file as text, to show a failed command wrote nothing; the empty store lock (ASS-175) is not one.
    snapshot: () => existsSync(folder) ? readdirSync(folder).filter(f => f !== '.lock').sort().map(f => `${f}\n${readFileSync(join(folder, f), 'utf8')}`).join('\n---\n') : '',
  };
}

test('ticket:create numbers from the highest key in the folder, writes the empty-body file exactly, and names the file', async () => {
  const f = fixture();
  assert.deepEqual(await f.json('ticket:create', 'p', 'Bug', 'Something broke'), { key: 'HD-1', file: f.file('HD-1') });
  const text = f.read('HD-1');
  const stamp = text.match(/^created: (.*)$/m)[1];
  assert.match(stamp, STAMP);
  assert.equal(text, `---\nkey: HD-1\ntype: Bug\nstatus: Backlog\ncreated: ${stamp}\nupdated: ${stamp}\n---\n# Something broke\n\n## User story\n\n## Context\n\n## Acceptance criteria\n`);
  assert.deepEqual(await f.json('ticket:create', 'p', 'Story', 'Second'), { key: 'HD-2', file: f.file('HD-2') });
  f.put('HD-10', STORY('HD-10', BODY));
  assert.equal((await f.json('ticket:create', 'p', 'Spike', 'Third')).key, 'HD-11');
});

test('ticket:create puts a body file after the title; the key prefix is the work source\'s own — a source without one is refused, there is no default', async () => {
  const f = fixture();
  const { key } = await f.json('ticket:create', 'p', 'Story', 'With body', f.body('body.md', BODY));
  assert.equal(sections(f.read(key)), `# With body\n\n${BODY}`);
  await fails(f.offBoard('ticket:create', 'r', 'Story', 'No prefix'), /project 'r' has no off-board key-prefix/);
  assert.equal((await f.json('ticket:create', 'z', 'Story', 'Own prefix')).key, 'ZZ-1');
});

test('ticket:create takes an optional --priority, one of the ranking\'s names, written after the status, with or without a body file; any other name fails, writing nothing', async () => {
  const f = fixture();
  const { key } = await f.json('ticket:create', 'p', 'Story', 'Urgent', '--priority', 'Very High');
  assert.match(f.read(key), /^status: Backlog\npriority: Very High\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', key)).priority, 'Very High');
  const body = await f.json('ticket:create', 'p', 'Bug', 'With body', f.body('body.md', BODY), '--priority', 'Low');
  assert.equal((await f.json('ticket:get', 'p', body.key)).priority, 'Low');
  assert.equal(sections(f.read(body.key)), `# With body\n\n${BODY}`);
  assert.equal((await f.json('ticket:get', 'p', (await f.json('ticket:create', 'p', 'Bug', 'None')).key)).priority, null);
  const before = f.snapshot();
  await fails(f.offBoard('ticket:create', 'p', 'Story', 'x', '--priority', 'Urgent'), new RegExp(`ticket:create: 'Urgent' is not a priority; one of ${priorityOrder.join(', ')}$`, 'm'));
  await fails(f.offBoard('ticket:create', 'p', 'Story', 'x', '--priority'), /^usage: ticket:create/);
  await fails(f.offBoard('ticket:create', 'p', 'Story', 'x', f.body('b.md', BODY), 'extra'), /^usage: ticket:create/);
  assert.equal(f.snapshot(), before);
});

test('ASS-83 AC1: ticket:create --fast-track writes fast-track: true in the front matter, with or without a body file and --priority; get and list return it; without it, a ticket has no fast-track', async () => {
  const f = fixture();
  const { key } = await f.json('ticket:create', 'p', 'Story', 'Rebuild', '--fast-track');
  assert.match(f.read(key), /^status: Backlog\nfast-track: true\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', key))['fast-track'], true);
  const both = await f.json('ticket:create', 'p', 'Bug', 'With body', f.body('body.md', BODY), '--fast-track', '--priority', 'High');
  assert.match(f.read(both.key), /^status: Backlog\npriority: High\nfast-track: true\ncreated:/m);
  assert.equal(sections(f.read(both.key)), `# With body\n\n${BODY}`);
  const plain = await f.json('ticket:create', 'p', 'Story', 'Plain');
  assert.equal('fast-track' in (await f.json('ticket:get', 'p', plain.key)), false);
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t['fast-track'] ?? null), [true, true, null]);
  // A rewrite keeps it.
  await f.offBoard('ticket:update-status', 'p', key, 'In Progress');
  assert.equal((await f.json('ticket:get', 'p', key))['fast-track'], true);
});

// ASS-343: a fix ticket for an earlier step of the blocked ticket's engine names that step, where the
// blocked ticket resumes once the fix lands (agent.sh ticket:fix-resume-step reads it through ticket:get).
test('ASS-343: ticket:create --resume-at <step> writes resume-at in the front matter, with the other options in any order; get returns it; a bad step is refused, writing nothing', async () => {
  const f = fixture();
  const { key } = await f.json('ticket:create', 'p', 'Bug', 'Plan prompt', '--resume-at', 'plan');
  assert.match(f.read(key), /^status: Backlog\nresume-at: plan\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', key))['resume-at'], 'plan');
  const all = await f.json('ticket:create', 'p', 'Bug', 'With body', f.body('body.md', BODY), '--resume-at', 'build', '--fast-track', '--priority', 'High');
  assert.match(f.read(all.key), /^status: Backlog\npriority: High\nfast-track: true\nresume-at: build\ncreated:/m);
  assert.equal(sections(f.read(all.key)), `# With body\n\n${BODY}`);
  const plain = await f.json('ticket:create', 'p', 'Story', 'Plain');
  assert.equal('resume-at' in (await f.json('ticket:get', 'p', plain.key)), false);
  // A rewrite keeps it.
  await f.offBoard('ticket:update-status', 'p', key, 'In Progress');
  assert.equal((await f.json('ticket:get', 'p', key))['resume-at'], 'plan');
  const before = f.snapshot();
  await fails(f.offBoard('ticket:create', 'p', 'Bug', 'Bad', '--resume-at', '../plan'), /invalid resume-at step '\.\.\/plan'/);
  await fails(f.offBoard('ticket:create', 'p', 'Bug', 'Bad', '--resume-at'), /usage: ticket:create/);
  assert.equal(f.snapshot(), before);
});

test('ticket:get parses the front matter, title, description and numbered criteria; the key matches in any case', async () => {
  const f = fixture();
  f.put('HD-3', STORY('HD-3', BODY));
  assert.deepEqual(await f.json('ticket:get', 'p', 'hd-3'), {
    key: 'HD-3', type: 'Story', status: 'To Do', points: null, priority: null, title: 'HD-3 title', created: '2020-01-01T00:00:00Z', updated: '2020-01-01T00:00:00Z', file: f.file('HD-3'),
    description: BODY.trim(), 'depends-on': [], 'overlaps-with': [],
    'acceptance-criteria': [{ 'criteria-number': 1, description: 'AC1: first' }, { 'criteria-number': 2, description: 'AC2: second' }],
  });
  const { key } = await f.json('ticket:create', 'p', 'Bug', 'Empty');
  const empty = await f.json('ticket:get', 'p', key);
  assert.equal(empty.status, 'Backlog');
  assert.deepEqual(empty['acceptance-criteria'], []);
  assert.equal(empty.description, '## User story\n\n## Context\n\n## Acceptance criteria');
  f.put('HD-9', STORY('HD-9', BODY).replace('status: To Do\n', 'status: To Do\npriority: Very High\n'));
  assert.equal((await f.json('ticket:get', 'p', 'HD-9')).priority, 'Very High');             // a priority: line, its name
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t.priority), [null, null, 'Very High']);
});

test('ticket:list gives every ticket in number order, skipping a malformed file with a warning; an empty or missing folder gives []', async () => {
  const f = fixture();
  assert.deepEqual(await f.json('ticket:list', 'p'), []);
  f.put('HD-10', STORY('HD-10', BODY));
  f.put('HD-2', STORY('HD-2', BODY));
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-5', '# No front matter\n\n## User story\n');
  f.put('HD-6', '---\ntype: Story\n---\n# No key\n');
  const { stdout, stderr } = await f.offBoard('ticket:list', 'p');
  const list = JSON.parse(stdout);
  assert.deepEqual(list.map(t => t.key), ['HD-1', 'HD-2', 'HD-10']);
  assert.equal(list[2].title, 'HD-10 title');
  assert.match(stderr, /ticket:list: skipping .*HD-5\.md/);
  assert.match(stderr, /ticket:list: skipping .*HD-6\.md/);
  mkdirSync(join(f.dir, 'off-board', 'r-tickets'), { recursive: true });
  assert.deepEqual(await f.json('ticket:list', 'r'), []);
});

test('ticket:update-status takes only the four off-board statuses: Backlog, Committed, In Progress, Done', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  for (const status of ['Backlog', 'Committed', 'In Progress', 'Done']) assert.deepEqual(await f.json('ticket:update-status', 'p', 'HD-1', status), { key: 'HD-1', status });
  const before = f.read('HD-1');
  for (const status of ['To Do', 'Blocked', 'In Review', 'done']) await fails(f.offBoard('ticket:update-status', 'p', 'HD-1', status), /one of Backlog, Committed, In Progress, Done/);
  assert.equal(f.read('HD-1'), before);                                                     // nothing written
});

test('ticket:update-points sets 1, 2, 3 or 5 points in the front matter, none clears them; get and list return them; the same value writes nothing', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  assert.deepEqual(await f.json('ticket:update-points', 'p', 'hd-1', '3'), { key: 'HD-1', points: 3 });
  assert.match(f.read('HD-1'), /^status: To Do\npoints: 3\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', 'HD-1')).points, 3);
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t.points), [3]);
  assert.match((await f.json('ticket:get', 'p', 'HD-1')).updated, STAMP);
  f.put('HD-2', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  const same = f.read('HD-2');
  assert.deepEqual(await f.json('ticket:update-points', 'p', 'HD-2', '3'), { key: 'HD-2', points: 3 });
  assert.equal(f.read('HD-2'), same);                                                       // unchanged: not even updated
  assert.deepEqual(await f.json('ticket:update-points', 'p', 'HD-2', '5'), { key: 'HD-2', points: 5 });
  assert.match(f.read('HD-2'), /^points: 5$/m);
  assert.deepEqual(await f.json('ticket:update-points', 'p', 'HD-2', 'none'), { key: 'HD-2', points: null });
  assert.doesNotMatch(f.read('HD-2'), /^points:/m);
  assert.equal((await f.json('ticket:get', 'p', 'HD-2')).points, null);
  const before = f.snapshot();
  for (const bad of ['0', '4', '8', 'x', '']) await fails(f.offBoard('ticket:update-points', 'p', 'HD-1', bad), /one of 1, 2, 3, 5 or none/);
  await fails(f.offBoard('ticket:update-points', 'p', 'HD-1'), /^usage: ticket:update-points/);
  assert.equal(f.snapshot(), before);
});

test('ticket:update-priority sets any of the ranking\'s priority names in the front matter, none clears it; get and list return it; the same value writes nothing; any other name fails, writing nothing', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  for (const priority of priorityOrder) assert.deepEqual(await f.json('ticket:update-priority', 'p', 'hd-1', priority), { key: 'HD-1', priority });
  assert.match(f.read('HD-1'), /^status: To Do\npriority: Lowest\ncreated:/m);
  assert.equal(f.read('HD-1').match(/^priority:/gm).length, 1);                            // replaced, never added twice
  assert.equal((await f.json('ticket:get', 'p', 'HD-1')).priority, 'Lowest');
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t.priority), ['Lowest']);
  assert.match((await f.json('ticket:get', 'p', 'HD-1')).updated, STAMP);
  f.put('HD-2', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  const same = f.read('HD-2');
  assert.deepEqual(await f.json('ticket:update-priority', 'p', 'HD-2', 'Lowest'), { key: 'HD-2', priority: 'Lowest' });
  assert.equal(f.read('HD-2'), same);                                                       // unchanged: not even updated
  assert.deepEqual(await f.json('ticket:update-priority', 'p', 'HD-2', 'none'), { key: 'HD-2', priority: null });
  assert.doesNotMatch(f.read('HD-2'), /^priority:/m);
  assert.match(f.read('HD-2'), /^updated: (?!2020)/m);                                      // cleared: stamped
  assert.equal((await f.json('ticket:get', 'p', 'HD-2')).priority, null);
  f.put('HD-3', STORY('HD-3', BODY));
  const absent = f.read('HD-3');
  assert.deepEqual(await f.json('ticket:update-priority', 'p', 'HD-3', 'none'), { key: 'HD-3', priority: null });
  assert.equal(f.read('HD-3'), absent);                                                     // already none: not even updated
  const before = f.snapshot();
  const names = new RegExp(`one of ${priorityOrder.join(', ')} or none`);
  for (const bad of ['high', 'Urgent', 'Blocker', 'null', '']) await fails(f.offBoard('ticket:update-priority', 'p', 'HD-1', bad), names);
  await fails(f.offBoard('ticket:update-priority', 'p', 'HD-1'), /^usage: ticket:update-priority/);
  await fails(f.offBoard('ticket:update-priority', 'p', 'HD-9', 'High'), /ticket:update-priority: no ticket HD-9 in p/);
  assert.equal(f.snapshot(), before);
});

test('ASS-194 AC1: ticket:set-dependencies replaces the whole depends-on list; none clears it; the same list in the same order writes nothing; a reorder writes', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-2', STORY('HD-2', BODY));
  f.put('HD-3', STORY('HD-3', BODY));
  f.put('HD-4', STORY('HD-4', BODY));

  // Sets a list: case-insensitive resolution, canonical output and file contents, order kept — not sorted.
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'hd-1', 'HD-3', 'HD-2'), { key: 'HD-1', dependencies: ['HD-3', 'HD-2'] });
  assert.match(f.read('HD-1'), /^status: To Do\ndepends-on: HD-3, HD-2\ncreated:/m);
  assert.match((await f.json('ticket:get', 'p', 'HD-1')).updated, STAMP);

  // ticket:get and ticket:list always print depends-on: the keys for HD-1, [] for every other ticket.
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-1'))['depends-on'], ['HD-3', 'HD-2']);
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t['depends-on']), [['HD-3', 'HD-2'], [], [], []]);

  // The line lands after points: when the ticket has one.
  await f.offBoard('ticket:update-points', 'p', 'HD-4', '3');
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-4', 'HD-2'), { key: 'HD-4', dependencies: ['HD-2'] });
  assert.match(f.read('HD-4'), /^points: 3\ndepends-on: HD-2\ncreated:/m);

  // Replacing writes one line only, not a second.
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'HD-2'), { key: 'HD-1', dependencies: ['HD-2'] });
  assert.equal(f.read('HD-1').match(/^depends-on:/gm).length, 1);
  assert.match(f.read('HD-1'), /^depends-on: HD-2$/m);

  // Duplicates collapse first-wins, case-insensitively, keeping the order passed.
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'HD-2', 'hd-2', 'HD-3'), { key: 'HD-1', dependencies: ['HD-2', 'HD-3'] });
  assert.match(f.read('HD-1'), /^depends-on: HD-2, HD-3$/m);

  // none clears and stamps.
  f.put('HD-1', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'none'), { key: 'HD-1', dependencies: [] });
  assert.doesNotMatch(f.read('HD-1'), /^depends-on:/m);
  assert.match(f.read('HD-1'), /^updated: (?!2020)/m);

  // none on a ticket that already has none writes nothing at all — the update-priority "already none" idiom.
  const absent = f.read('HD-1');
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'none'), { key: 'HD-1', dependencies: [] });
  assert.equal(f.read('HD-1'), absent);

  // Same list, same order: no write, no stamp — but still prints the keys.
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-3', 'HD-2'), { key: 'HD-3', dependencies: ['HD-2'] });
  f.put('HD-3', f.read('HD-3').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  const same = f.read('HD-3');
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-3', 'HD-2'), { key: 'HD-3', dependencies: ['HD-2'] });
  assert.equal(f.read('HD-3'), same);

  // A reorder writes.
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'HD-3', 'HD-4'), { key: 'HD-1', dependencies: ['HD-3', 'HD-4'] });
  f.put('HD-1', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-1', 'HD-4', 'HD-3'), { key: 'HD-1', dependencies: ['HD-4', 'HD-3'] });
  assert.match(f.read('HD-1'), /^depends-on: HD-4, HD-3$/m);
  assert.match(f.read('HD-1'), /^updated: (?!2020)/m);

  // Parser edge cases, written by hand — no command involved.
  f.put('HD-5', DEPENDS('HD-5', 'HD-2', 'HD-3'));
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-5'))['depends-on'], ['HD-2', 'HD-3']);
  f.put('HD-6', STORY('HD-6', BODY).replace('status: To Do\n', 'status: To Do\ndepends-on: HD-2,HD-3\n'));
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-6'))['depends-on'], ['HD-2', 'HD-3']);
  f.put('HD-7', STORY('HD-7', BODY).replace('status: To Do\n', 'status: To Do\ndepends-on: \n'));
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-7'))['depends-on'], []);
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-2'))['depends-on'], []);   // no line at all
});

test('ASS-194 AC3: ticket:set-dependencies refuses an unknown, foreign, self or cyclic dependency, writing nothing', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-2', DEPENDS('HD-2', 'HD-1'));                          // HD-2 depends on HD-1 — the direct-cycle case
  f.put('HD-3', STORY('HD-3', BODY));                              // a plain, unrelated ticket
  f.put('HD-6', DEPENDS('HD-6', 'HD-7'));                          // HD-6 -> HD-7 -> HD-8 — the indirect-cycle case
  f.put('HD-7', DEPENDS('HD-7', 'HD-8'));
  f.put('HD-8', STORY('HD-8', BODY));
  f.put('HD-5', '# No front matter\n');                            // malformed subject
  f.put('HD-28', '# No front matter\n');                           // malformed dependency, reached by the walk
  write(join(f.dir, 'off-board', 'z-tickets', 'ZZ-1.md'), STORY('ZZ-1', BODY));   // only in project z's folder
  const before = f.snapshot();

  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-9'), /ticket:set-dependencies: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'PROJ-1'), /ticket:set-dependencies: no ticket PROJ-1 in p/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'ZZ-1'), /ticket:set-dependencies: no ticket ZZ-1 in p/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'hd-1'), /ticket:set-dependencies: HD-1 cannot depend on itself/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-2'), /ticket:set-dependencies: HD-1 cannot depend on HD-2: HD-2 depends on HD-1, directly or through another ticket/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-8', 'HD-6'), /ticket:set-dependencies: HD-8 cannot depend on HD-6: HD-6 depends on HD-8, directly or through another ticket/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-3', 'HD-9'), /ticket:set-dependencies: no ticket HD-9 in p/);
  assert.doesNotMatch(f.read('HD-1'), /^depends-on:/m);                                    // the valid HD-3 before it was not partially written
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-3', 'HD-2'), /ticket:set-dependencies: HD-1 cannot depend on HD-2: HD-2 depends on HD-1, directly or through another ticket/);
  assert.doesNotMatch(f.read('HD-1'), /^depends-on:/m);                                    // a cycle later in the list still writes nothing
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-3', 'hd-1'), /ticket:set-dependencies: HD-1 cannot depend on itself/);   // self after dedup, not first
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1'), /^usage: ticket:set-dependencies/);
  await fails(f.offBoard('ticket:set-dependencies'), /^usage: ticket:set-dependencies/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-3', 'none'), /ticket:set-dependencies: no ticket NONE in p/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-9', 'HD-1'), /ticket:set-dependencies: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:set-dependencies', 'q', 'HD-1', 'HD-1'), /ticket:set-dependencies: project 'q' has no off-board work source/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-5', 'HD-1'), /malformed/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', 'HD-28'), /malformed/);
  await fails(f.offBoard('ticket:set-dependencies', 'p', 'HD-1', ''), /ticket:set-dependencies: no ticket\s*in p/);

  assert.equal(f.snapshot(), before);

  // Edge cases that must succeed despite a hazard elsewhere in the folder.
  f.put('HD-29', DEPENDS('HD-29', 'HD-404'));              // HD-404.md does not exist — a dangling edge from a hand-edit
  f.put('HD-30', STORY('HD-30', BODY));
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-30', 'HD-29'), { key: 'HD-30', dependencies: ['HD-29'] });
  assert.match(f.read('HD-30'), /^depends-on: HD-29$/m);

  f.put('HD-31', DEPENDS('HD-31', 'HD-32'));
  f.put('HD-32', DEPENDS('HD-32', 'HD-31'));                // a hand-edited reciprocal cycle, pre-existing in the folder
  f.put('HD-33', STORY('HD-33', BODY));
  assert.deepEqual(await f.json('ticket:set-dependencies', 'p', 'HD-33', 'HD-31'), { key: 'HD-33', dependencies: ['HD-31'] });
  assert.match(f.read('HD-33'), /^depends-on: HD-31$/m);
});

test('ASS-196 AC2: ticket:set-overlaps replaces the whole overlaps-with list; none clears it; the same list in the same order writes nothing; a reorder writes; the line lands after depends-on, else after points', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-2', STORY('HD-2', BODY));
  f.put('HD-3', STORY('HD-3', BODY));
  f.put('HD-4', STORY('HD-4', BODY));

  // Sets a list: case-insensitive resolution, canonical output and file contents, order kept — not sorted.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'hd-1', 'HD-3', 'HD-2'), { key: 'HD-1', overlaps: ['HD-3', 'HD-2'] });
  assert.match(f.read('HD-1'), /^status: To Do\noverlaps-with: HD-3, HD-2\ncreated:/m);
  assert.match((await f.json('ticket:get', 'p', 'HD-1')).updated, STAMP);

  // ticket:get and ticket:list always print overlaps-with: the keys for HD-1, [] for every other ticket.
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-1'))['overlaps-with'], ['HD-3', 'HD-2']);
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t['overlaps-with']), [['HD-3', 'HD-2'], [], [], []]);

  // The line lands after depends-on: when the ticket has one (ASS-194 wrote it before status).
  await f.offBoard('ticket:set-dependencies', 'p', 'HD-4', 'HD-2');
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-4', 'HD-3'), { key: 'HD-4', overlaps: ['HD-3'] });
  assert.match(f.read('HD-4'), /^depends-on: HD-2\noverlaps-with: HD-3\ncreated:/m);

  // After points: when there is no depends-on.
  await f.offBoard('ticket:update-points', 'p', 'HD-3', '3');
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-3', 'HD-2'), { key: 'HD-3', overlaps: ['HD-2'] });
  assert.match(f.read('HD-3'), /^points: 3\noverlaps-with: HD-2\ncreated:/m);

  // Replacing writes one line only, not a second.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'HD-2'), { key: 'HD-1', overlaps: ['HD-2'] });
  assert.equal(f.read('HD-1').match(/^overlaps-with:/gm).length, 1);
  assert.match(f.read('HD-1'), /^overlaps-with: HD-2$/m);

  // Duplicates collapse first-wins, case-insensitively, keeping the order passed.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'HD-2', 'hd-2', 'HD-3'), { key: 'HD-1', overlaps: ['HD-2', 'HD-3'] });
  assert.match(f.read('HD-1'), /^overlaps-with: HD-2, HD-3$/m);

  // none clears and stamps.
  f.put('HD-1', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'none'), { key: 'HD-1', overlaps: [] });
  assert.doesNotMatch(f.read('HD-1'), /^overlaps-with:/m);
  assert.match(f.read('HD-1'), /^updated: (?!2020)/m);

  // none on a ticket that already has none writes nothing at all.
  const absent = f.read('HD-1');
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'none'), { key: 'HD-1', overlaps: [] });
  assert.equal(f.read('HD-1'), absent);

  // Same list, same order: no write, no stamp — but still prints the keys.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-4', 'HD-3'), { key: 'HD-4', overlaps: ['HD-3'] });
  f.put('HD-4', f.read('HD-4').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  const same = f.read('HD-4');
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-4', 'HD-3'), { key: 'HD-4', overlaps: ['HD-3'] });
  assert.equal(f.read('HD-4'), same);

  // A reorder writes.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'HD-3', 'HD-2'), { key: 'HD-1', overlaps: ['HD-3', 'HD-2'] });
  f.put('HD-1', f.read('HD-1').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00Z'));
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'HD-2', 'HD-3'), { key: 'HD-1', overlaps: ['HD-2', 'HD-3'] });
  assert.match(f.read('HD-1'), /^overlaps-with: HD-2, HD-3$/m);
  assert.match(f.read('HD-1'), /^updated: (?!2020)/m);
});

test('ASS-196 AC2: ticket:set-overlaps refuses an unknown, foreign or self key, writing nothing, but has NO cycle check — A and B may overlap each other', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-2', STORY('HD-2', BODY));
  f.put('HD-3', STORY('HD-3', BODY));
  f.put('HD-5', '# No front matter\n');                            // malformed subject
  write(join(f.dir, 'off-board', 'z-tickets', 'ZZ-1.md'), STORY('ZZ-1', BODY));   // only in project z's folder
  const before = f.snapshot();

  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'HD-9'), /ticket:set-overlaps: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'PROJ-1'), /ticket:set-overlaps: no ticket PROJ-1 in p/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'ZZ-1'), /ticket:set-overlaps: no ticket ZZ-1 in p/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'hd-1'), /ticket:set-overlaps: HD-1 cannot overlap itself/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'HD-2', 'HD-9'), /ticket:set-overlaps: no ticket HD-9 in p/);
  assert.doesNotMatch(f.read('HD-1'), /^overlaps-with:/m);                                   // the valid HD-2 before it was not partially written
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'HD-2', 'hd-1'), /ticket:set-overlaps: HD-1 cannot overlap itself/);   // self after dedup, not first
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1'), /^usage: ticket:set-overlaps/);
  await fails(f.offBoard('ticket:set-overlaps'), /^usage: ticket:set-overlaps/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', 'HD-2', 'none'), /ticket:set-overlaps: no ticket NONE in p/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-9', 'HD-1'), /ticket:set-overlaps: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:set-overlaps', 'q', 'HD-1', 'HD-1'), /ticket:set-overlaps: project 'q' has no off-board work source/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-5', 'HD-1'), /malformed/);
  await fails(f.offBoard('ticket:set-overlaps', 'p', 'HD-1', ''), /ticket:set-overlaps: no ticket\s*in p/);

  assert.equal(f.snapshot(), before);

  // NO cycle check (the one case set-dependencies refuses): A overlaps B, then B overlaps A — both succeed.
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-1', 'HD-2'), { key: 'HD-1', overlaps: ['HD-2'] });
  assert.deepEqual(await f.json('ticket:set-overlaps', 'p', 'HD-2', 'HD-1'), { key: 'HD-2', overlaps: ['HD-1'] });
  assert.match(f.read('HD-1'), /^overlaps-with: HD-2$/m);
  assert.match(f.read('HD-2'), /^overlaps-with: HD-1$/m);

  // get and list print overlaps-with on a populated and an empty ticket; the parser reads a hand-written line.
  f.put('HD-6', OVERLAPS('HD-6', 'HD-2', 'HD-3'));
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-6'))['overlaps-with'], ['HD-2', 'HD-3']);
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-3'))['overlaps-with'], []);
});

test('ticket:update-name rewrites the title and ticket:update-status the status; each stamps updated and leaves the rest', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  assert.deepEqual(await f.json('ticket:update-name', 'p', 'hd-1', 'New title'), { key: 'HD-1', title: 'New title' });
  let t = await f.json('ticket:get', 'p', 'HD-1');
  assert.equal(t.title, 'New title');
  assert.match(t.updated, STAMP);
  assert.notEqual(t.updated, t.created);
  assert.equal(t.description, BODY.trim());
  assert.deepEqual(await f.json('ticket:update-status', 'p', 'HD-1', 'In Progress'), { key: 'HD-1', status: 'In Progress' });
  t = await f.json('ticket:get', 'p', 'HD-1');
  assert.equal(t.status, 'In Progress');
  assert.equal(t.created, '2020-01-01T00:00:00Z');
  assert.equal(sections(f.read('HD-1')), `# New title\n\n${BODY}`);
});

test('ticket:update-requirements replaces every section but the acceptance criteria, which stay as they were, last', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  const body = f.body('req.md', '## User story\n\nAs a reviser.\n\n## Context\n\nNew context.\n\n## Acceptance criteria\n\n1. AC1: ignored\n\n## Scope\n\nIn.\n');
  assert.deepEqual(await f.json('ticket:update-requirements', 'p', 'HD-1', body), { key: 'HD-1' });
  assert.equal(sections(f.read('HD-1')), '# HD-1 title\n\n## User story\n\nAs a reviser.\n\n## Context\n\nNew context.\n\n## Scope\n\nIn.\n\n## Acceptance criteria\n\n1. AC1: first\n2. AC2: second\n');
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-1'))['acceptance-criteria'].map(c => c.description), ['AC1: first', 'AC2: second']);
});

test('ticket:add-acceptance-criteria appends the next number, creating the section when missing; ticket:update-acceptance-criteria replaces one', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  assert.deepEqual(await f.json('ticket:add-acceptance-criteria', 'p', 'HD-1', 'AC3: third'), { key: 'HD-1', 'criteria-number': 3 });
  assert.deepEqual(await f.json('ticket:update-acceptance-criteria', 'p', 'HD-1', '2', 'AC2: changed'), { key: 'HD-1', 'criteria-number': 2 });
  assert.equal(sections(f.read('HD-1')), '# HD-1 title\n\n## User story\n\nAs a user.\n\n## Context\n\nSome context.\n\n## Acceptance criteria\n\n1. AC1: first\n2. AC2: changed\n3. AC3: third\n\n## Related\n\nHD-9\n');
  const { key } = await f.json('ticket:create', 'p', 'Bug', 'Empty');   // an empty section, last
  assert.deepEqual(await f.json('ticket:add-acceptance-criteria', 'p', key, 'AC1: only'), { key, 'criteria-number': 1 });
  assert.equal(sections(f.read(key)), '# Empty\n\n## User story\n\n## Context\n\n## Acceptance criteria\n\n1. AC1: only\n');
  f.put('HD-3', STORY('HD-3', '## User story\n\nNo criteria.\n'));   // no section
  assert.deepEqual(await f.json('ticket:add-acceptance-criteria', 'p', 'HD-3', 'AC1: new'), { key: 'HD-3', 'criteria-number': 1 });
  assert.equal(sections(f.read('HD-3')), '# HD-3 title\n\n## User story\n\nNo criteria.\n\n## Acceptance criteria\n\n1. AC1: new\n');
  assert.deepEqual((await f.json('ticket:get', 'p', 'HD-3'))['acceptance-criteria'], [{ 'criteria-number': 1, description: 'AC1: new' }]);
});

test('ASS-175: concurrent creates take the store lock, so each gets its own key and no ticket is lost', async () => {
  const f = fixture();
  const created = await Promise.all(Array.from({ length: 12 }, (_, i) => f.json('ticket:create', 'p', 'Bug', `Bug ${i}`)));
  const keys = created.map(c => c.key).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  assert.deepEqual(keys, Array.from({ length: 12 }, (_, i) => `HD-${i + 1}`));
  const titles = await Promise.all(keys.map(async key => (await f.json('ticket:get', 'p', key)).title));
  assert.deepEqual(titles.sort(), Array.from({ length: 12 }, (_, i) => `Bug ${i}`).sort());
});

test('ASS-175: concurrent rewrites of one ticket take the store lock, so no edit is lost', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  const added = await Promise.all(Array.from({ length: 8 }, (_, i) => f.json('ticket:add-acceptance-criteria', 'p', 'HD-1', `extra ${i}`)));
  assert.deepEqual(added.map(a => a['criteria-number']).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 10]);
  const criteria = (await f.json('ticket:get', 'p', 'HD-1'))['acceptance-criteria'];
  assert.deepEqual(criteria.map(c => c['criteria-number']), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(criteria.slice(2).map(c => c.description).sort(), Array.from({ length: 8 }, (_, i) => `extra ${i}`));
});

test('every command fails, writing nothing, on a missing project, one without an off-board source, a missing ticket, an unknown type, a malformed file, a missing criterion or bad arguments', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  f.put('HD-2', '# No front matter\n');
  const before = f.snapshot();
  await fails(f.offBoard('ticket:create', 'nope', 'Bug', 'x'), /ticket:create: no project 'nope'/);
  await fails(f.offBoard('ticket:create', 'q', 'Bug', 'x'), /ticket:create: project 'q' has no off-board work source/);
  await fails(f.offBoard('ticket:create', 'p', 'Task', 'x'), /ticket:create: unknown type 'Task'/);
  await fails(f.offBoard('ticket:create', 'p', 'Bug', 'x', join(f.dir, 'missing.md')), /ticket:create: no file/);
  await fails(f.offBoard('ticket:create', 'p'), /^usage: ticket:create/);
  await fails(f.offBoard('ticket:get', 'p', 'HD-9'), /ticket:get: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:get', 'q', 'HD-1'), /ticket:get: project 'q' has no off-board work source/);
  await fails(f.offBoard('ticket:get', 'p', 'HD-2'), /malformed/);
  await fails(f.offBoard('ticket:list'), /^usage: ticket:list/);
  await fails(f.offBoard('ticket:update-name', 'p', 'HD-9', 'x'), /ticket:update-name: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:update-status', 'p', 'HD-1'), /^usage: ticket:update-status/);
  await fails(f.offBoard('ticket:update-status', 'p', 'HD-2', 'Done'), /malformed/);
  await fails(f.offBoard('ticket:update-requirements', 'p', 'HD-1', join(f.dir, 'missing.md')), /ticket:update-requirements: no file/);
  await fails(f.offBoard('ticket:add-acceptance-criteria', 'p', 'HD-9', 'x'), /ticket:add-acceptance-criteria: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:update-acceptance-criteria', 'p', 'HD-1', '7', 'x'), /ticket:update-acceptance-criteria: no criterion 7 in HD-1/);
  await fails(f.offBoard('ticket:update-acceptance-criteria', 'p', 'HD-1', 'two', 'x'), /^usage: ticket:update-acceptance-criteria/);
  assert.equal(f.snapshot(), before);
});

test('--help lists the ticket commands with their descriptions', async () => {
  const { stdout } = await run(OFF_BOARD, ['--help']);
  for (const command of COMMANDS) assert.match(stdout, new RegExp(`^  ticket:${command} +\\S.* — ticket:${command} `, 'm'));
  assert.doesNotMatch(stdout, /no description/);
});

test('ASS-180: ticket:replace-acceptance-criteria replaces the whole AC section with the file\'s list, creates it when missing, bad JSON refused', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  // Replace an existing section with a new list.
  const list = f.body('ac.json', JSON.stringify([{ 'criteria-number': 1, description: 'AC1: new one' }, { 'criteria-number': 2, description: 'AC2: and another' }]));
  assert.deepEqual(await f.json('ticket:replace-acceptance-criteria', 'p', 'hd-1', list), { key: 'HD-1' });
  const got = await f.json('ticket:get', 'p', 'HD-1');
  assert.deepEqual(got['acceptance-criteria'], [{ 'criteria-number': 1, description: 'AC1: new one' }, { 'criteria-number': 2, description: 'AC2: and another' }]);
  assert.notEqual(got.updated, '2020-01-01T00:00:00Z');
  assert.match(got.updated, STAMP);
  // Append when the section is missing.
  f.put('HD-2', STORY('HD-2', '## User story\n\nNo criteria.\n'));
  const only = f.body('ac2.json', JSON.stringify([{ 'criteria-number': 1, description: 'AC1: only' }]));
  await f.json('ticket:replace-acceptance-criteria', 'p', 'HD-2', only);
  const got2 = await f.json('ticket:get', 'p', 'HD-2');
  assert.deepEqual(got2['acceptance-criteria'], [{ 'criteria-number': 1, description: 'AC1: only' }]);
  // Bad JSON refused, writing nothing.
  const before = f.snapshot();
  for (const bad of ['nope', '{"a":1}', '[{"description":"no number"}]', '[{"criteria-number":"1","description":"x"}]', '[{"criteria-number":1,"description":""}]', '[{"criteria-number":1,"description":"a\nb"}]']) {
    const file = f.body('bad.json', bad);
    await fails(f.offBoard('ticket:replace-acceptance-criteria', 'p', 'HD-1', file), /ticket:replace-acceptance-criteria/);
  }
  assert.equal(f.snapshot(), before);
  // Unknown ticket refused.
  await fails(f.offBoard('ticket:replace-acceptance-criteria', 'p', 'HD-9', list), /no ticket HD-9 in p/);
});

test('a project with no off-board work source uses the harness project\'s — harness.json names it — so a harness ticket raised from any project lands there; with none named, it is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-'));
  write(join(dir, 'projects', 'case', 'project.json'), { name: 'Case', 'work-sources': [{ name: 'Jira', type: 'jira' }] });
  write(join(dir, 'projects', 'harness', 'project.json'), { name: 'Harness', 'work-sources': [{ name: 'Harness Ticket', type: 'off-board', folder: 'harness', 'key-prefix': 'ASS' }] });
  write(join(dir, 'projects', 'other', 'project.json'), { name: 'Other', 'work-sources': [{ name: 'Other Ticket', type: 'off-board', folder: 'other', 'key-prefix': 'OTH' }] });   // a second off-board project: no guessing
  write(join(dir, 'harness.json'), { 'harness-project': 'harness' });
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), OFF_BOARD_DIR: join(dir, 'off-board'), HARNESS_FILE: join(dir, 'harness.json') };
  const ob = (...args) => run(OFF_BOARD, args, { env });
  assert.deepEqual(JSON.parse((await ob('ticket:create', 'case', 'Bug', 'Raised from case')).stdout).key, 'ASS-1');
  assert.ok(existsSync(join(dir, 'off-board', 'harness', 'ASS-1.md')));
  assert.deepEqual(JSON.parse((await ob('ticket:list', 'case')).stdout).map(t => t.key), ['ASS-1']);
  write(join(dir, 'harness.json'), {});
  await assert.rejects(ob('ticket:create', 'case', 'Bug', 'Nowhere'), e => /project 'case' has no off-board work source/.test(e.stderr));
});

// ASS-252: the harness's backlog refinement splits a ticket too large. Keep
// whole marks it, so its refinement never splits it again; an accepted split
// marks the original split into its pieces, status Done, so it leaves the
// backlog and never joins a sprint. ticket:get shows either mark only when set.
test('ASS-252 AC3: ticket:keep-whole marks a ticket kept whole — once, a second time writing nothing — and ticket:get shows it', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  assert.equal((await f.json('ticket:get', 'p', 'HD-1'))['kept-whole'], undefined);
  assert.deepEqual(await f.json('ticket:keep-whole', 'p', 'hd-1'), { key: 'HD-1', 'kept-whole': true });
  assert.match(f.read('HD-1'), /^status: To Do\nkept-whole: true\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', 'HD-1'))['kept-whole'], true);
  const once = f.read('HD-1');
  await f.json('ticket:keep-whole', 'p', 'HD-1');
  assert.equal(f.read('HD-1'), once);
  assert.equal(sections(once), sections(STORY('HD-1', BODY)));
  await fails(f.offBoard('ticket:keep-whole', 'p', 'HD-9'), /ticket:keep-whole: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:keep-whole', 'p'), /^usage: ticket:keep-whole/);
});

// ASS-306 AC2: the grouped blocked flow fast-tracks the existing off-board fix
// ticket it finds at Backlog. ticket:mark-fast-track writes `fast-track: true`
// into its front matter (before created:, see ticket.bash) and stamps updated,
// so a later ticket:join-sprint carries the mark into the sprint; a ticket
// already marked writes nothing and stamps nothing; a missing ticket fails.
test('ASS-306 AC2: ticket:mark-fast-track marks a ticket fast-track — once, a second time writing nothing — ticket:get shows it, a missing ticket fails writing nothing', async () => {
  const f = fixture();
  f.put('HD-1', STORY('HD-1', BODY));
  assert.equal((await f.json('ticket:get', 'p', 'HD-1'))['fast-track'], undefined);
  assert.deepEqual(await f.json('ticket:mark-fast-track', 'p', 'hd-1'), { key: 'HD-1', 'fast-track': true });
  assert.match(f.read('HD-1'), /^status: To Do\nfast-track: true\ncreated:/m);
  assert.equal((await f.json('ticket:get', 'p', 'HD-1'))['fast-track'], true);
  assert.match((await f.json('ticket:get', 'p', 'HD-1')).updated, STAMP);
  assert.notEqual((await f.json('ticket:get', 'p', 'HD-1')).updated, '2020-01-01T00:00:00Z');   // stamped
  const once = f.read('HD-1');
  await f.json('ticket:mark-fast-track', 'p', 'HD-1');
  assert.equal(f.read('HD-1'), once);                                                           // already marked: no write, no stamp
  assert.equal(sections(once), sections(STORY('HD-1', BODY)));                                  // nothing but the front matter touched
  const before = f.snapshot();
  await fails(f.offBoard('ticket:mark-fast-track', 'p', 'HD-9'), /ticket:mark-fast-track: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:mark-fast-track', 'p'), /^usage: ticket:mark-fast-track/);
  assert.equal(f.snapshot(), before);
});

test('ASS-252 AC3: ticket:mark-split marks a ticket split into its pieces and Done; ticket:get shows the pieces; unknown keys, itself, or none are refused, writing nothing', async () => {
  const f = fixture();
  for (const key of ['HD-1', 'HD-2', 'HD-3']) f.put(key, STORY(key, BODY));
  assert.equal((await f.json('ticket:get', 'p', 'HD-1'))['split-into'], undefined);
  const before = f.snapshot();
  await fails(f.offBoard('ticket:mark-split', 'p', 'HD-1', 'HD-9'), /ticket:mark-split: no ticket HD-9 in p/);
  await fails(f.offBoard('ticket:mark-split', 'p', 'HD-1', 'HD-1'), /ticket:mark-split: HD-1 cannot be split into itself/);
  await fails(f.offBoard('ticket:mark-split', 'p', 'HD-1'), /^usage: ticket:mark-split/);
  assert.equal(f.snapshot(), before);
  assert.deepEqual(await f.json('ticket:mark-split', 'p', 'HD-1', 'hd-2', 'HD-3', 'HD-2'), { key: 'HD-1', 'split-into': ['HD-2', 'HD-3'], status: 'Done' });
  assert.match(f.read('HD-1'), /^status: Done\nsplit-into: HD-2, HD-3\ncreated:/m);
  const got = await f.json('ticket:get', 'p', 'HD-1');
  assert.deepEqual([got.status, got['split-into']], ['Done', ['HD-2', 'HD-3']]);
  assert.deepEqual((await f.json('ticket:list', 'p')).find(t => t.key === 'HD-1')['split-into'], ['HD-2', 'HD-3']);
});
