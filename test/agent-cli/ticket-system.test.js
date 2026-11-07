// ticket:set-ticket-system-status, ticket:post-comment and
// ticket:set-acceptance-criteria — the ticket's own system's view, and its
// acceptance criteria, written to the active sprint and (behind acli) to Jira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fixture, run, AGENT, STAMP } from './harness-fixture.js';

const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

test('ticket:set-ticket-system-status writes the status on the whole ticket and would transition it in Jira; --dry-run only says so', async () => {
  const f = fixture();
  const { stderr } = await f.agent('ticket:set-ticket-system-status', 'p', 'abc-3', 'In Review');
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Review');
  assert.match(stderr, /acli jira workitem transition --key ABC-3 --status "In Review"/);   // skipped under ACLI_DISABLED, saying what it would run
  const before = f.snapshot();
  const { stdout } = await f.agent('ticket:set-ticket-system-status', 'p', 'ABC-3', 'Done', '--dry-run');
  assert.match(stdout, /ticket-system-status.*Done/);
  assert.match(stdout, /acli jira workitem transition --key ABC-3 --status "Done"/);
  assert.equal(f.snapshot(), before);
  // Not a Jira project: the sprint alone is written.
  const { stderr: quiet } = await f.agent('ticket:set-ticket-system-status', 'q', 'Q-1', 'Done');
  assert.doesNotMatch(quiet, /acli/);
  await fails(f.agent('ticket:set-ticket-system-status', 'p', 'ABC-9', 'Done'), /no ABC-9/);
  await fails(f.agent('ticket:set-ticket-system-status', 'p', 'ABC-3'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ticket:set-ticket-system-status records when it set the status on the sprint ticket (ticket-system-status-at, ASS-128 AC2)', async () => {
  const f = fixture();
  const before = Date.now() - 1000;
  await f.agent('ticket:set-ticket-system-status', 'p', 'abc-3', 'In Review');
  const at = f.sprint().features[0]['ticket-system-status-at'];
  assert.match(at, STAMP);
  assert.ok(Date.parse(at) >= Math.floor(before / 1000) * 1000 && Date.parse(at) <= Date.now(), at);
});

test('ticket:post-comment posts a file as a comment on a Jira ticket, writing nothing locally', async () => {
  const f = fixture();
  const body = join(f.dir, 'comment.md');
  writeFileSync(body, 'Looks good.\n');
  const before = f.snapshot();
  const { stderr } = await f.agent('ticket:post-comment', 'p', 'ABC-3', body);
  assert.match(stderr, /acli jira workitem comment create --key ABC-3 --body-file /);
  const { stderr: quiet } = await f.agent('ticket:post-comment', 'q', 'Q-1', body);
  assert.doesNotMatch(quiet, /acli/);
  await fails(f.agent('ticket:post-comment', 'p', 'ABC-3', join(f.dir, 'missing.md')), /no file/);
  await fails(f.agent('ticket:post-comment', 'p', 'ABC-3'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ticket:set-acceptance-criteria replaces the variation\'s criteria with the file\'s, statuses Incomplete unless given', async () => {
  const f = fixture();
  const file = join(f.dir, 'ac.json');
  writeFileSync(file, JSON.stringify([{ 'criteria-number': 1, description: 'Edges are written' }, { 'criteria-number': 2, description: 'Idempotent', 'dev-status': 'Passed', 'testing-status': 'Failed' }]));
  await f.agent('ticket:set-acceptance-criteria', 'p', 'abc-3', 'A', file);
  assert.deepEqual(f.variation('A')['acceptance-criteria'], [
    { 'criteria-number': 1, description: 'Edges are written', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' },
    { 'criteria-number': 2, description: 'Idempotent', 'dev-status': 'Passed', 'testing-status': 'Failed' },
  ]);
  assert.equal(f.variation('B')['acceptance-criteria'], undefined);
  const before = f.snapshot();
  for (const bad of ['{"a":1}', '[{"description":"no number"}]', '[{"criteria-number":"1","description":"x"}]', '[{"criteria-number":1}]', 'nope']) {
    writeFileSync(file, bad);
    await fails(f.agent('ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A', file), /an array of \{ criteria-number, description \}/);
  }
  writeFileSync(file, '[]');
  await fails(f.agent('ticket:set-acceptance-criteria', 'p', 'ABC-3', 'Z', file), /no ABC-3 variation Z/);
  await fails(f.agent('ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A', join(f.dir, 'missing.json')), /no file/);
  await fails(f.agent('ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A'), /usage/);
  assert.equal(f.snapshot(), before);
});

// ASS-182 AC1: from a VM, whose /mnt/ticket is read-only, the content comes on stdin: "-" in place of the file.
const piped = (f, input, ...args) => new Promise((resolve, reject) => {
  const child = execFile(AGENT, args, { env: f.env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })));
  child.stdin.end(input);
});

test('ASS-182 AC1: ticket:post-comment p ABC-3 - posts stdin; ticket:set-acceptance-criteria p ABC-3 A - records stdin\'s criteria — each as from a file', async () => {
  const f = fixture();
  const { stderr } = await piped(f, 'Looks good.\n', 'ticket:post-comment', 'p', 'ABC-3', '-');
  assert.match(stderr, /acli jira workitem comment create --key ABC-3 --body-file /);
  await assert.rejects(piped(f, '', 'ticket:post-comment', 'p', 'ABC-3', '-'), e => /nothing on stdin/.test(e.stderr));
  await piped(f, JSON.stringify([{ 'criteria-number': 1, description: 'Edges are written' }]), 'ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A', '-');
  assert.deepEqual(f.variation('A')['acceptance-criteria'], [{ 'criteria-number': 1, description: 'Edges are written', 'dev-status': 'Incomplete', 'testing-status': 'Incomplete' }]);
  const before = f.snapshot();
  await assert.rejects(piped(f, 'nope', 'ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A', '-'), e => /an array of \{ criteria-number, description \}/.test(e.stderr));
  assert.equal(f.snapshot(), before);
});

test('ticket:set-ticket-system-status on an off-board ticket (the project\'s off-board key prefix) writes the sprint and the off-board file, never Jira; --dry-run says so', async () => {
  const f = fixture();
  const offBoard = mkdtempSync(join(tmpdir(), 'off-board-'));
  const env = { ...f.env, OFF_BOARD_DIR: offBoard };
  const projectFile = join(f.dir, 'projects', 'p', 'project.json');
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  writeFileSync(projectFile, JSON.stringify({ ...project, 'work-sources': [...(project['work-sources'] ?? []), { name: 'Harness Ticket', type: 'off-board', folder: 'p-tickets', 'key-prefix': 'HD' }] }));
  const { key } = JSON.parse((await run(OFF_BOARD, ['ticket:create', 'p', 'Bug', 'The harness broke'], { env })).stdout);
  assert.equal(key, 'HD-1');
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(sprintFile, 'utf8'));
  sprint.bugs = [...(sprint.bugs ?? []), { key: 'HD-1', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': { state: 'backlog', 'state-engine': 'example-development' }, 'state-changes': [] }] }];
  writeFileSync(sprintFile, JSON.stringify(sprint));
  const { stderr } = await run(AGENT, ['ticket:set-ticket-system-status', 'p', 'hd-1', 'In Progress'], { env });
  assert.doesNotMatch(stderr, /acli/);
  assert.equal(f.sprint().bugs.find(t => t.key === 'HD-1')['ticket-system-status'], 'In Progress');
  assert.equal(JSON.parse((await run(OFF_BOARD, ['ticket:get', 'p', 'HD-1'], { env })).stdout).status, 'In Progress');
  const { stdout } = await run(AGENT, ['ticket:set-ticket-system-status', 'p', 'HD-1', 'Done', '--dry-run'], { env });
  assert.match(stdout, /would run: off-board\.sh ticket:update-status p HD-1 "Done"/);
  assert.doesNotMatch(stdout, /acli/);
  // A Jira key in the same project still goes to Jira.
  assert.match((await run(AGENT, ['ticket:set-ticket-system-status', 'p', 'ABC-3', 'Done'], { env })).stderr, /acli jira workitem transition --key ABC-3/);
});
