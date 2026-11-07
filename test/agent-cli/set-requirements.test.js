// ticket:set-requirements and ticket:set-acceptance-criteria - (ASS-180 AC2,
// AC3): the agent writes the ticket's description (and ticket-level
// acceptance criteria) through locked, host-only CLI commands, the Markdown
// / JSON on stdin. Off-board tickets: rewrites the .md file and the
// mirrored harness description in sprint.json / backlog.json, appends one
// { at, field, from, to } line to requirements-history.jsonl, all under
// tickets.lock. Jira tickets: writes nothing and exits 0 with a fixed
// message. Refuses bodies with an H1 or a `## Acceptance criteria` section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const run = promisify(execFile);
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

const write = (file, content) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};

// A ticket file written by hand, with fixed stamps, so a rewrite shows its new `updated`.
const STORY = (key, body, stamp = '2020-01-01T00:00:00Z') => `---\nkey: ${key}\ntype: Story\nstatus: Backlog\ncreated: ${stamp}\nupdated: ${stamp}\n---\n# ${key} title\n\n${body}`;

// Off-board project p (prefix HD), Jira project q.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'set-req-'));
  const projects = join(dir, 'projects');
  const offBoard = join(dir, 'off-board');
  write(join(projects, 'p', 'project.json'), { name: 'P', 'work-sources': [{ name: 'Harness Ticket', type: 'off-board', folder: 'p-tickets', 'key-prefix': 'HD' }] });
  write(join(projects, 'q', 'project.json'), { name: 'Q', 'work-sources': [{ name: 'Jira', type: 'jira', url: 'https://x.atlassian.net/jira/software/projects/QQQ/boards/1' }] });
  write(join(projects, 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(join(projects, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [], bugs: [], spikes: [] });
  write(join(projects, 'p', 'backlog.json'), { tickets: [] });
  write(join(projects, 'q', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(join(projects, 'q', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [], bugs: [], spikes: [] });
  write(join(projects, 'q', 'backlog.json'), { tickets: [] });
  mkdirSync(join(offBoard, 'p-tickets'), { recursive: true });
  const env = { ...process.env, PROJECTS_DIR: projects, OFF_BOARD_DIR: offBoard, ACLI_DISABLED: '1' };
  const sprintFile = join(projects, 'p', 'sprints', 'sprint-10', 'sprint.json');
  const backlogFile = join(projects, 'p', 'backlog.json');
  const historyFile = key => join(projects, 'p', 'work', key, 'requirements-history.jsonl');
  return {
    dir, projects, offBoard, env, sprintFile, backlogFile, historyFile,
    offBoardJson: async (...args) => JSON.parse((await run(OFF_BOARD, args, { env })).stdout),
    putTicket: (key, body) => writeFileSync(join(offBoard, 'p-tickets', `${key}.md`), STORY(key, body)),
    read: key => readFileSync(join(offBoard, 'p-tickets', `${key}.md`), 'utf8'),
    sprint: () => JSON.parse(readFileSync(sprintFile, 'utf8')),
    backlog: () => JSON.parse(readFileSync(backlogFile, 'utf8')),
    history: key => existsSync(historyFile(key)) ? readFileSync(historyFile(key), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
    pipe: (input, ...args) => new Promise(resolve => {
      const child = execFile(AGENT, args, { env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      child.stdin.end(input);
    }),
    seedBacklog: ticket => { const b = JSON.parse(readFileSync(backlogFile, 'utf8')); b.tickets.push(ticket); writeFileSync(backlogFile, JSON.stringify(b)); },
    seedSprint: (bucket, ticket) => { const s = JSON.parse(readFileSync(sprintFile, 'utf8')); s[bucket].push(ticket); writeFileSync(sprintFile, JSON.stringify(s)); },
  };
}

const ORIGINAL_BODY = '## User story\n\nAs a user.\n\n## Context\n\nSome context.\n\n## Acceptance criteria\n\n1. AC1: Old criterion\n';
const NEW_BODY = '## User story\n\nAs a reviser.\n\n## Context\n\nNew context.\n\n## Scope\n\nIn scope.\n';
const sections = text => text.split('---\n')[2];

test('ticket:set-requirements rewrites an off-board .md after the title, keeping the Acceptance criteria section, mirrors description to backlog.json and appends one requirements-history line', async () => {
  const f = fixture();
  f.putTicket('HD-1', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-1')).description;
  f.seedBacklog({ key: 'HD-1', title: 'HD-1 title', description: original, variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' } }] });
  const r = await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'hd-1');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { key: 'HD-1' });
  const got = await f.offBoardJson('ticket:get', 'p', 'HD-1');
  assert.ok(got.description.startsWith('## User story\n\nAs a reviser.'), 'the new sections are at the start');
  assert.ok(got.description.includes('## Acceptance criteria\n\n1. AC1: Old criterion'), 'the AC section is kept');
  const back = f.backlog().tickets[0];
  assert.equal(back.description, got.description, 'the mirror matches ticket:get description');
  const hist = f.history('HD-1');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].field, 'description');
  assert.equal(hist[0].from, original);
  assert.equal(hist[0].to, got.description);
  assert.match(hist[0].at, STAMP);
});

test('ticket:set-requirements updates both the active sprint.json and backlog.json when both list the ticket', async () => {
  const f = fixture();
  f.putTicket('HD-2', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-2')).description;
  const variations = [{ name: 'A', 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' } }];
  f.seedBacklog({ key: 'HD-2', title: 'HD-2 title', description: original, variations });
  f.seedSprint('features', { key: 'HD-2', title: 'HD-2 title', description: original, variations });
  assert.equal((await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'HD-2')).code, 0);
  const got = await f.offBoardJson('ticket:get', 'p', 'HD-2');
  assert.equal(f.backlog().tickets[0].description, got.description, 'backlog mirror');
  assert.equal(f.sprint().features[0].description, got.description, 'sprint mirror');
});

test('ticket:set-requirements writes nothing on an unchanged body (same text twice)', async () => {
  const f = fixture();
  f.putTicket('HD-3', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-3')).description;
  f.seedBacklog({ key: 'HD-3', title: 'HD-3 title', description: original, variations: [] });
  await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'HD-3');
  const beforeMd = readFileSync(join(f.offBoard, 'p-tickets', 'HD-3.md'), 'utf8');
  const h1 = f.history('HD-3').length;
  assert.equal((await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'HD-3')).code, 0);
  assert.equal(f.history('HD-3').length, h1, 'no new history line');
  assert.equal(readFileSync(join(f.offBoard, 'p-tickets', 'HD-3.md'), 'utf8'), beforeMd, 'the .md is unchanged');
});

test('ticket:set-requirements refuses a body with H1 or a `## Acceptance criteria` section, exit 1, nothing written', async () => {
  const f = fixture();
  f.putTicket('HD-4', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-4')).description;
  f.seedBacklog({ key: 'HD-4', title: 'HD-4 title', description: original, variations: [] });
  const before = { md: f.read('HD-4'), backlog: readFileSync(f.backlogFile, 'utf8') };
  for (const [name, body, pat] of [
    ['H1 heading', '# A new title\n\n## Context\n\ntext\n', /H1|# |title/],
    ['AC section',  '## User story\n\n## Acceptance criteria\n\n1. x\n', /ticket:set-acceptance-criteria|Acceptance criteria/],
    ['empty stdin', '', /empty|nothing on stdin/],
  ]) {
    const r = await f.pipe(body, 'ticket:set-requirements', 'p', 'HD-4');
    assert.equal(r.code, 1, `${name}: expected exit 1 — got ${JSON.stringify(r)}`);
    assert.match(r.stderr, pat, name);
  }
  assert.equal(f.read('HD-4'), before.md, 'the .md was not changed');
  assert.equal(readFileSync(f.backlogFile, 'utf8'), before.backlog, 'backlog was not changed');
  assert.deepEqual(f.history('HD-4'), [], 'no history line was written');
});

test('ticket:set-requirements accepts ## headings whose text happens to include "acceptance criteria" so long as they are not the exact section', async () => {
  const f = fixture();
  f.putTicket('HD-5', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-5')).description;
  f.seedBacklog({ key: 'HD-5', title: 'HD-5 title', description: original, variations: [] });
  const body = '## Context\n\nSomething with #tag inline, not an H1.\n\n## Acceptance criteria extra\n\nAside.\n';
  assert.equal((await f.pipe(body, 'ticket:set-requirements', 'p', 'HD-5')).code, 0);
});

test('ticket:set-requirements on a Jira project exits 0, prints the no-op message, writes nothing', async () => {
  const f = fixture();
  const before = readFileSync(f.backlogFile, 'utf8');
  const r = await f.pipe(NEW_BODY, 'ticket:set-requirements', 'q', 'QQQ-7');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /q is a Jira project; nothing written — post the settled answers with ticket:post-comment/);
  assert.doesNotMatch(r.stderr, /acli/, 'no acli call made');
  assert.equal(readFileSync(f.backlogFile, 'utf8'), before);
});

test('ticket:set-requirements on a key neither off-board nor Jira fails with "not an off-board ticket"', async () => {
  const f = fixture();
  write(join(f.projects, 'r', 'project.json'), { name: 'R', 'work-sources': [{ type: 'other' }] });
  const r = await f.pipe(NEW_BODY, 'ticket:set-requirements', 'r', 'FOO-1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not an off-board ticket|no off-board/);
});

test('ticket:set-acceptance-criteria - replaces the AC section (off-board .md + mirror), appends a history line, and leaves variations\' acceptance-criteria alone', async () => {
  const f = fixture();
  f.putTicket('HD-10', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-10')).description;
  const vac = [{ 'criteria-number': 1, description: 'variation AC kept', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' }];
  f.seedBacklog({ key: 'HD-10', title: 'HD-10 title', description: original, variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' }, 'acceptance-criteria': vac }] });
  const list = JSON.stringify([{ 'criteria-number': 1, description: 'AC1: new one' }, { 'criteria-number': 2, description: 'AC2: and another' }]);
  const r = await f.pipe(list, 'ticket:set-acceptance-criteria', 'p', 'hd-10', '-');
  assert.equal(r.code, 0, r.stderr);
  const got = await f.offBoardJson('ticket:get', 'p', 'HD-10');
  assert.deepEqual(got['acceptance-criteria'], [
    { 'criteria-number': 1, description: 'AC1: new one' },
    { 'criteria-number': 2, description: 'AC2: and another' },
  ]);
  assert.equal(f.backlog().tickets[0].description, got.description, 'mirror description updated');
  assert.deepEqual(f.backlog().tickets[0].variations[0]['acceptance-criteria'], vac, 'the variation\'s AC is untouched');
  const hist = f.history('HD-10');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].field, 'description');
  assert.match(hist[0].at, STAMP);
});

test('ticket:set-acceptance-criteria - refuses invalid JSON / shape, exit 1, nothing written', async () => {
  const f = fixture();
  f.putTicket('HD-11', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-11')).description;
  f.seedBacklog({ key: 'HD-11', title: 'HD-11 title', description: original, variations: [] });
  const before = { md: f.read('HD-11'), backlog: readFileSync(f.backlogFile, 'utf8') };
  for (const [name, body] of [
    ['not JSON', 'nope'],
    ['not array', '{"a":1}'],
    ['missing criteria-number', '[{"description":"no number"}]'],
    ['non-string description', '[{"criteria-number":1,"description":2}]'],
    ['empty description', '[{"criteria-number":1,"description":""}]'],
    ['multi-line description', '[{"criteria-number":1,"description":"a\nb"}]'],
    ['criteria-number not a number', '[{"criteria-number":"1","description":"x"}]'],
    ['empty stdin', ''],
  ]) {
    const r = await f.pipe(body, 'ticket:set-acceptance-criteria', 'p', 'HD-11', '-');
    assert.equal(r.code, 1, `${name}: expected exit 1 — got ${JSON.stringify(r)}`);
    // Prefix of the shape error message, not the usage error.
    assert.match(r.stderr, /ticket:set-acceptance-criteria:[^\n]*criteria-number/i, name);
  }
  assert.equal(f.read('HD-11'), before.md);
  assert.equal(readFileSync(f.backlogFile, 'utf8'), before.backlog);
  assert.deepEqual(f.history('HD-11'), []);
});

test('ticket:set-acceptance-criteria - on a Jira project exits 0 with the no-op message and writes nothing', async () => {
  const f = fixture();
  const before = readFileSync(f.backlogFile, 'utf8');
  const r = await f.pipe('[{"criteria-number":1,"description":"x"}]', 'ticket:set-acceptance-criteria', 'q', 'QQQ-7', '-');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /q is a Jira project; nothing written — post the settled answers with ticket:post-comment/);
  assert.equal(readFileSync(f.backlogFile, 'utf8'), before);
});

test('ticket:set-acceptance-criteria usage line lists both the 4-arg per-variation form and the 3-arg stdin form', async () => {
  const f = fixture();
  const r = await f.pipe('', 'ticket:set-acceptance-criteria');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: ticket:set-acceptance-criteria/);
  assert.match(r.stderr, /\(JSON on stdin\)/, 'the stdin form is listed with "(JSON on stdin)"');
  assert.match(r.stderr, /<json-file\|->/, 'the per-variation 4-arg form is listed, its file or stdin (ASS-182)');
});

test('ticket:set-acceptance-criteria: the 4-arg per-variation form still sets just that variation\'s AC', async () => {
  const f = fixture();
  f.putTicket('HD-20', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-20')).description;
  const vac = [{ 'criteria-number': 1, description: 'before', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' }];
  const mdBefore = f.read('HD-20');
  f.seedSprint('features', { key: 'HD-20', title: 'HD-20 title', description: original, variations: [{ name: 'A', 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' }, 'acceptance-criteria': vac }] });
  const file = join(f.dir, 'per-variation.json');
  writeFileSync(file, JSON.stringify([{ 'criteria-number': 1, description: 'variation AC written' }]));
  const r = await f.pipe('', 'ticket:set-acceptance-criteria', 'p', 'HD-20', 'A', file);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.sprint().features[0].variations[0]['acceptance-criteria'], [
    { 'criteria-number': 1, description: 'variation AC written', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' },
  ]);
  assert.equal(f.read('HD-20'), mdBefore, 'the off-board .md is untouched by the 4-arg form');
});

test('ticket:sync after ticket:set-requirements sees no change (no history line, variation harness-status unchanged)', async () => {
  const f = fixture();
  f.putTicket('HD-30', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-30')).description;
  f.seedBacklog({ key: 'HD-30', title: 'HD-30 title', description: original, 'issue-type': 'Story', priority: 1, 'manual-backlog-priority': null, variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'example-backlog-refinement' }, 'state-changes': [] }] });
  const sr = await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'HD-30');
  assert.equal(sr.code, 0, sr.stderr);
  const got = await f.offBoardJson('ticket:get', 'p', 'HD-30');
  assert.ok(got.description.startsWith('## User story\n\nAs a reviser.'), 'set-requirements rewrote the description');
  const h1 = f.history('HD-30').length;
  assert.equal(h1, 1, 'set-requirements appended one history line');
  const beforeStatus = JSON.stringify(f.backlog().tickets[0].variations[0]['harness-status']);
  const fetched = { tickets: [{
    key: 'HD-30', title: got.title, description: got.description, url: 'file:/not-used',
    'ticket-system-status': got.status ?? 'Backlog', 'ticket-system-priority': null, 'ticket-system-assignment': null,
    points: got.points ?? null, 'issue-type': 'Story', dependencies: [], 'sprint-tag': null,
  }] };
  const fetchedFile = join(f.dir, 'fetched.json');
  writeFileSync(fetchedFile, JSON.stringify(fetched));
  await run(AGENT, ['ticket:sync', 'p', 'backlog', fetchedFile], { env: f.env });
  assert.equal(f.history('HD-30').length, h1, 'ticket:sync appends no new history line');
  assert.equal(JSON.stringify(f.backlog().tickets[0].variations[0]['harness-status']), beforeStatus, 'variation harness-status is unchanged');
});

test('ticket:set-requirements accepts a lowercase key', async () => {
  const f = fixture();
  f.putTicket('HD-40', ORIGINAL_BODY);
  const original = (await f.offBoardJson('ticket:get', 'p', 'HD-40')).description;
  f.seedBacklog({ key: 'HD-40', title: 'HD-40 title', description: original, variations: [] });
  const r = await f.pipe(NEW_BODY, 'ticket:set-requirements', 'p', 'hd-40');
  assert.equal(r.code, 0, r.stderr);
});
