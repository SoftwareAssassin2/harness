// Backlog refinement's agent-cli side (ASS-18, ASS-34, ASS-144): a backlog
// ticket sits at a step of its project's refinement engine — the engine its
// execution engine's backlog-refinement-steps names — and moves with the one
// generic move, ticket:change-state, checked against that engine; a human's
// choice at its human step is ticket:human-review's; when it was last
// refined, whether its questions are all answered and whether it has points;
// and the one-off reset of every backlog ticket to its engine's first step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT, STAMP } from './harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const exitOf = promise => promise.then(() => 0, e => e.code);
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };

// The fixture whose project p refines its backlog through the real
// example-backlog-refinement engine, with ABC-50 in its backlog at `state`
// of that engine (groom unless given).
function inBacklog(state = 'groom', extra = {}) {
  const f = fixture();
  const engines = join(f.dir, 'engines');
  mkdirSync(join(engines, 'example-backlog-refinement'), { recursive: true });
  copyFileSync(join(engineDir('example-backlog-refinement'), 'state-engine.json'), join(engines, 'example-backlog-refinement', 'state-engine.json'));
  edit(join(engines, 'example-development', 'state-engine.json'), e => {
    e['backlog-refinement-steps'] = [{ id: 'backlog-refinement', sequence: 1, action: { type: 'state-engine', engine: 'example-backlog-refinement' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  const file = join(f.dir, 'projects', 'p', 'backlog.json');
  writeFileSync(file, JSON.stringify({ tickets: [{ key: 'ABC-50', title: 'T', variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-backlog-refinement' }, 'state-changes': [] }], ...extra }] }));
  const ticket = () => JSON.parse(readFileSync(file, 'utf8')).tickets[0];
  return { ...f, file, ticket, variation: () => ticket().variations[0] };
}
const at = state => ({ state, 'state-engine': 'example-backlog-refinement' });

test('ticket:change-state moves a backlog ticket to any step of its own refinement engine, recording the change as a sprint move does (ASS-144 AC3, AC4)', async () => {
  const f = inBacklog();
  await f.agent('ticket:change-state', 'p', 'abc-50', 'A', 'groom', 'awaiting-answers');
  assert.deepEqual(f.variation()['harness-status'], at('awaiting-answers'));
  const [change] = f.variation()['state-changes'];
  assert.deepEqual({ ...change, timestamp: 'T' }, { 'state-engine': 'example-backlog-refinement', 'from-state': 'groom', 'to-state': 'awaiting-answers', timestamp: 'T', 'agent-dispatch-log': [], 'work-is-done': false });
  assert.match(change.timestamp, STAMP);
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'awaiting-answers', 'groom');
  assert.deepEqual(f.variation()['state-changes'].map(c => [c['to-state'], c['work-is-done']]), [['awaiting-answers', true], ['groom', false]]);
});

test('ticket:change-state on a backlog ticket fails, writing nothing, for a step its engine lacks, a from-state it is not at, a sub-engine start, or a ticket in no sprint or backlog', async () => {
  const f = inBacklog();
  const before = readFileSync(f.file, 'utf8');
  await fails(f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'grooming'), /example-backlog-refinement has no step grooming/);
  await fails(f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'committed'), /example-backlog-refinement has no step committed/);
  await fails(f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'estimate', 'groom'), /not at estimate/);
  await fails(f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'estimate', 'x'), /a backlog ticket enters no sub-engine/);
  await fails(f.agent('ticket:change-state', 'p', 'ABC-99', 'A', 'groom', 'estimate'), /no ABC-99/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('a backlog ticket entering its engine\'s done step is announced on a Jira project\'s ticket; other moves are not', async () => {
  const f = inBacklog('awaiting-approval');
  const quiet = await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'awaiting-approval', 'groom');
  assert.doesNotMatch(quiet.stderr, /comment create/);
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'awaiting-approval');
  const { stderr } = await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'awaiting-approval', 'ready');
  assert.match(stderr, /skipping: acli jira workitem comment create --key ABC-50/);
  assert.deepEqual(f.variation()['harness-status'], at('ready'));
});

test('a backlog move renumbers the backlog: each priority its place in control\'s refinement order (ASS-84 AC1)', async () => {
  const f = inBacklog();
  edit(f.file, b => { b.tickets = [{ ...b.tickets[0], priority: 1 }, { key: 'ABC-49', priority: 2, 'manual-backlog-priority': null, variations: [] }]; });
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'awaiting-answers');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).tickets.map(t => [t.key, t.priority]), [['ABC-50', 2], ['ABC-49', 1]]);
});

test('ticket:human-review at a backlog ticket\'s human step records the choice, keeps a reason as its rejection-reason, and moves it at once (the TUI\'s Accept and Reject)', async () => {
  const f = inBacklog('awaiting-approval');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Reject', 'groom', 'AC3 is vague');
  const v = f.variation();
  assert.deepEqual([v['harness-status'], v['human-review'].decision, v['human-review'].reason, v['rejection-reason']], [at('groom'), 'Reject', 'AC3 is vague', 'AC3 is vague']);
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'awaiting-approval');
  const { stderr } = await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Accept', 'ready');
  assert.deepEqual([f.variation()['harness-status'], f.variation()['human-review'].decision], [at('ready'), 'Accept']);
  assert.match(stderr, /comment create --key ABC-50/);                                   // into the done step: announced
  await fails(f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Accept', 'ready'), /not at awaiting-approval/);
});

test('ticket:human-review on a backlog ticket stopped after the choice, before the move, makes the move when run again (ASS-178)', async () => {
  const f = inBacklog('awaiting-approval');
  edit(f.file, b => { b.tickets[0].variations[0]['human-review'] = { state: 'awaiting-approval', decision: 'Reject', timestamp: '2026-10-27T00:00:00Z' }; });   // the choice alone written
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Reject', 'groom', 'AC3 is vague');
  const v = f.variation();
  assert.deepEqual([v['harness-status'], v['human-review'].reason, v['state-changes'].length], [at('groom'), 'AC3 is vague', 1]);
});

test('a rejection reaches the next groom: its agent\'s ticket.json carries the variation\'s rejection-reason, and the groom prompt has it read', async () => {
  const f = inBacklog('awaiting-approval');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Reject', 'groom', 'AC3 is vague');
  edit(join(f.dir, 'assignments.json'), data => Object.assign(data.assignments.find(a => a['agent-name'] === 'Daredevil'), { 'work-item': 'ABC-50', variation: 'A' }));
  await f.agent('agent:dispatch', 'Daredevil');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-50', 'ticket.json'), 'utf8')).variation['rejection-reason'], 'AC3 is vague');
  assert.match(readFileSync(join(ROOT, 'prompts', 'groom', 'prompt.txt'), 'utf8'), /variation in \{ticket-folder\}\/ticket\.json[^\n]*"rejection-reason"/);
});

test('ticket:refined stamps when the ticket was last refined', async () => {
  const f = inBacklog();
  await f.agent('ticket:refined', 'p', 'ABC-50');
  assert.match(f.ticket()['last-refined'], STAMP);
});

test('ticket:refined <project> <ticket-key> <at>: stamps `at`, when the groom started (ASS-213)', async () => {
  const f = inBacklog();
  await f.agent('ticket:refined', 'p', 'ABC-50', '2026-10-13T12:00:00Z');
  assert.equal(f.ticket()['last-refined'], '2026-10-13T12:00:00Z');
});

test('ticket:questions-answered: 0 when every question on the ticket has an accepted answer, or there are none; 1 otherwise', async () => {
  const f = inBacklog();
  const answered = () => exitOf(f.agent('ticket:questions-answered', 'p', 'ABC-50'));
  assert.equal(await answered(), 0);                                                         // no questions file
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-50');
  mkdirSync(folder, { recursive: true });
  const write = statuses => writeFileSync(join(folder, 'questions-and-answers.json'), JSON.stringify({ list: statuses.map((status, i) => ({ question: `Q${i}`, status })) }));
  write(['Answer Accepted', 'Unanswered']);
  assert.equal(await answered(), 1);
  write(['Answer Accepted', 'Answer Accepted']);
  assert.equal(await answered(), 0);
});

test('ticket:has-points (example\'s check-points): 0 when the backlog ticket has story points, 1 when it has none', async () => {
  const f = inBacklog();
  assert.equal(await exitOf(f.agent('ticket:has-points', 'p', 'abc-50')), 1);
  edit(f.file, b => { b.tickets[0].points = null; });
  assert.equal(await exitOf(f.agent('ticket:has-points', 'p', 'ABC-50')), 1);
  edit(f.file, b => { b.tickets[0].points = 3; });
  assert.deepEqual(JSON.parse((await f.agent('ticket:has-points', 'p', 'ABC-50')).stdout), { ticket: 'ABC-50', points: 3 });
  await fails(f.agent('ticket:has-points', 'p', 'ABC-99'), /no ABC-99 in p's backlog/);
});

test('the refinement-state commands are gone (ASS-144 Q4): set-refinement, request-answers, refinement-is, decide-approval', async () => {
  const f = inBacklog();
  for (const command of ['ticket:set-refinement', 'ticket:request-answers', 'ticket:refinement-is', 'ticket:decide-approval']) {
    await assert.rejects(f.agent(command, 'p', 'ABC-50', 'ready'), command);
  }
});

test('ticket:restart-refinement (the one-off migration, ASS-144 Q5): every live backlog ticket to its engine\'s first step by sequence, the change recorded, due to be groomed at once; deleted tickets and variations, and tickets in the sprint, left alone', async () => {
  const f = inBacklog('grooming');
  edit(f.file, b => {
    b.tickets[0].variations[0]['harness-status'] = { state: 'awaiting-answer', 'state-engine': null };
    b.tickets[0]['last-refined'] = '2026-10-20T00:00:00Z';
    b.tickets.push(
      { key: 'ABC-51', variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': null } }, { name: 'B', 'is-deleted': true, 'harness-status': { state: 'ready', 'state-engine': null } }] },
      { key: 'ABC-52', 'is-deleted': true, variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': null } }] },
      { key: 'ABC-3', variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': null } }] },   // in the active sprint too
    );
  });
  const { stdout } = await f.agent('ticket:restart-refinement', 'p');
  assert.deepEqual(JSON.parse(stdout), { project: 'p', engine: 'example-backlog-refinement', step: 'groom', reset: ['ABC-50', 'ABC-51'] });
  const tickets = JSON.parse(readFileSync(f.file, 'utf8')).tickets;
  const states = tickets.map(t => [t.key, t.variations.map(v => v['harness-status'])]);
  assert.deepEqual(states, [
    ['ABC-50', [at('groom')]],
    ['ABC-51', [at('groom'), { state: 'ready', 'state-engine': null }]],
    ['ABC-52', [{ state: 'ready', 'state-engine': null }]],
    ['ABC-3', [{ state: 'ready', 'state-engine': null }]],
  ]);
  assert.deepEqual(tickets[0].variations[0]['state-changes'].map(c => [c['from-state'], c['to-state'], c['state-engine']]), [['awaiting-answer', 'groom', 'example-backlog-refinement']]);
  assert.equal(tickets[0]['last-refined'], undefined, 'groomed again at once');
  await f.agent('ticket:restart-refinement', 'p');                                         // again: each stays at the first step
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).tickets[0].variations[0]['harness-status'], at('groom'));
  edit(join(f.dir, 'projects', 'q', 'project.json'), q => { q['execution-state-engine'] = 'self-healing'; });
  await fails(f.agent('ticket:restart-refinement', 'q'), /q's execution engine names no backlog refinement engine/);
});

test('assignments:create and assignments:remove on a backlog ticket\'s refinement step log the dispatch and its end on its latest change in backlog.json (ASS-144)', async () => {
  const f = inBacklog();
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'estimate');
  const [record] = JSON.parse((await f.agent('assignments:create', 'p', 'example-backlog-refinement', 'estimate', 'generate-solution', '1', 'false', 'ABC-50', 'A', '-')).stdout);
  assert.deepEqual([record['work-item'], record.variation, record['state-engine']], ['ABC-50', 'A', 'example-backlog-refinement']);
  assert.deepEqual(f.variation()['state-changes'].at(-1)['agent-dispatch-log'].map(e => e['dispatched-to']), [record['agent-name']]);
  await f.agent('assignments:remove', record['agent-name'], '0.5', '1', '2', '3', '4');      // its end logged there too
  const [entry] = f.variation()['state-changes'].at(-1)['agent-dispatch-log'];
  assert.deepEqual([entry['cost-usd'], entry.tokens.input], [0.5, 1]);
  assert.match(entry['completed-timestamp'], STAMP);
  await fails(f.agent('assignments:create', 'p', 'example-backlog-refinement', 'groom', 'generate-solution', '1', 'false', 'ABC-50', 'A', '-'), /not at groom/);
});

// ASS-42: a backlog ticket's refinement history is its backlog variation's
// state-changes in backlog.json; a move no step's exit made says what caused it.
const lastChange = f => f.variation()['state-changes'].at(-1);

test('ASS-42 AC1/AC2: an exit\'s move of a backlog ticket appends one entry naming the refinement engine, with no cause, and never writes the sprint', async () => {
  const f = inBacklog();
  const sprint = readFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8');
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'awaiting-answers');
  assert.equal(f.variation()['state-changes'].length, 1);
  assert.deepEqual([lastChange(f)['state-engine'], 'cause' in lastChange(f)], ['example-backlog-refinement', false]);
  assert.equal(readFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'), sprint);
});

test('ASS-42 AC2: the operator\'s Accept and Reject on a backlog ticket (ticket:human-review) record cause operator, a rejection with its reason', async () => {
  const f = inBacklog('awaiting-approval');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Reject', 'groom', 'AC3 is vague');
  assert.deepEqual([lastChange(f)['to-state'], lastChange(f).cause, lastChange(f).reason], ['groom', 'operator', 'AC3 is vague']);
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'awaiting-approval');
  assert.equal('cause' in lastChange(f), false, 'an exit\'s move after it carries none');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', 'Accept', 'ready');
  assert.deepEqual([lastChange(f)['to-state'], lastChange(f).cause, 'reason' in lastChange(f)], ['ready', 'operator', false]);
  assert.equal(f.variation()['state-changes'].length, 3);
});

test('ASS-42 AC2: ticket:restart-refinement\'s reset records cause migrated', async () => {
  const f = inBacklog('awaiting-approval');
  await f.agent('ticket:restart-refinement', 'p');
  assert.deepEqual([lastChange(f)['from-state'], lastChange(f)['to-state'], lastChange(f).cause], ['awaiting-approval', 'groom', 'migrated']);
});

// ASS-152: ticket:set-points writes an estimate to the harness (backlog.json,
// pending until the ticket system shows it) and to the ticket system —
// off-board through off-board.sh, Jira through acli — on the project's scale.
// A fake acli on PATH records each call and the --from-json file's content;
// FAKE_ACLI_REFUSE makes it fail as acli does on a field it will not take.
function withAcli(f) {
  const bin = join(f.dir, 'bin'), log = join(f.dir, 'acli.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'acli'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
while [[ $# -gt 0 ]]; do [[ "$1" == --from-json ]] && cat "$2" >> '${log}' && echo >> '${log}'; shift; done
[[ -z "\${FAKE_ACLI_REFUSE:-}" ]] || { echo "$FAKE_ACLI_REFUSE" >&2; exit 1; }
`);
  chmodSync(join(bin, 'acli'), 0o755);
  const env = { ...f.env, ACLI_DISABLED: '', PATH: `${bin}:${process.env.PATH}` };
  return { env, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean), set: (...args) => run(AGENT, ['ticket:set-points', ...args], { env }) };
}
const projectFile = f => join(f.dir, 'projects', 'p', 'project.json');

// acli cannot edit a custom field (`json: unknown field "additionalAttributes"`, acli 1.3.39; CLOUD-12876),
// so a Jira ticket's estimate stays in the harness (operator, 2026-10-26).
test('ticket:set-points on a Jira ticket writes backlog.json, pending, and never Jira (ASS-152 AC2)', async () => {
  const f = inBacklog('estimate');
  const a = withAcli(f);
  const { stdout } = await a.set('p', 'abc-50', '3');
  assert.deepEqual(JSON.parse(stdout), { ticket: 'ABC-50', points: 3 });
  assert.equal(f.ticket().points, 3);
  assert.match(f.ticket()['points-set-at'], STAMP);
  assert.deepEqual(a.calls(), []);
  await fails(a.set('p', 'ABC-99', '3'), /no ABC-99/);
  await fails(a.set('p', 'ABC-50'), /usage/);
});

test('ticket:set-points takes the project\'s scale: example\'s Fibonacci to 13, 1-5 by default (ASS-152 AC2)', async () => {
  const f = inBacklog('estimate');
  const a = withAcli(f);
  await fails(a.set('p', 'ABC-50', '8'), /8 is not on p's story-point scale: 1, 2, 3, 5/);
  await fails(a.set('p', 'ABC-50', 'x'), /x is not on p's story-point scale/);
  assert.equal(f.ticket().points, undefined);
  assert.deepEqual(a.calls(), []);
  edit(projectFile(f), p => { p['work-sources'][0]['story-points-field'] = 'customfield_10024'; p['story-point-scale'] = [1, 2, 3, 5, 8, 13]; });
  await a.set('p', 'ABC-50', '13');
  assert.equal(f.ticket().points, 13);
  assert.deepEqual(a.calls(), []);
  await fails(a.set('p', 'ABC-50', '21'), /21 is not on p's story-point scale: 1, 2, 3, 5, 8, 13/);
  assert.equal((await f.agent('project:story-point-scale', 'p')).stdout.trim(), '[1,2,3,5,8,13]');
  assert.equal((await f.agent('project:story-point-scale', 'q')).stdout.trim(), '[1,2,3,5]');
});

test('ticket:set-points on an off-board ticket writes backlog.json and the ticket\'s file through off-board.sh, never Jira (ASS-152 AC2)', async () => {
  const f = inBacklog('estimate');
  const a = withAcli(f);
  const offBoard = mkdtempSync(join(tmpdir(), 'off-board-'));
  const env = { ...a.env, OFF_BOARD_DIR: offBoard };
  edit(projectFile(f), p => { p['work-sources'].push({ name: 'Harness Ticket', type: 'off-board', folder: 'p-tickets', 'key-prefix': 'HD' }); });
  await run(join(ROOT, 'off-board.sh'), ['ticket:create', 'p', 'Story', 'Estimate me'], { env });
  edit(f.file, b => { b.tickets.push({ key: 'HD-1', title: 'Estimate me', points: null, variations: [] }); });
  await run(AGENT, ['ticket:set-points', 'p', 'hd-1', '2'], { env });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).tickets[1].points, 2);
  assert.equal(JSON.parse((await run(join(ROOT, 'off-board.sh'), ['ticket:get', 'p', 'HD-1'], { env })).stdout).points, 2);
  assert.deepEqual(a.calls(), []);
});

test('an Estimate run on a example ticket: the one estimate prompt reads the harness\'s data, sizes on example\'s scale and writes through ticket:set-points — the harness alone — after which check-points skips it (ASS-152 AC2, AC4)', async () => {
  const text = readFileSync(join(ROOT, 'prompts', 'estimate', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(text, /off-board\.sh/);                                                   // no ticket system's own command
  const commands = [...text.matchAll(/`\{harness-folder\}\/agent\.sh ([^`]+)`/g)].map(m => m[1].replaceAll('{project}', 'p').replaceAll('{ticket}', 'ABC-50').split(' '));
  assert.deepEqual(commands.map(c => c[0]), ['project:story-point-scale', 'ticket:set-points']);
  const output = JSON.parse(readFileSync(join(ROOT, 'prompts', 'estimate', 'prompt.json'), 'utf8')).output.properties.points.enum;
  assert.deepEqual(output, [1, 2, 3, 5, 8, 13, null]);

  const f = inBacklog('estimate');
  const a = withAcli(f);
  edit(projectFile(f), p => { p['work-sources'][0]['story-points-field'] = 'customfield_10024'; p['story-point-scale'] = [1, 2, 3, 5, 8, 13]; });
  const [scale, set] = commands;
  assert.deepEqual(JSON.parse((await run(AGENT, scale, { env: a.env })).stdout), [1, 2, 3, 5, 8, 13]);
  await run(AGENT, set.map(w => w === '<points>' ? '8' : w), { env: a.env });
  assert.deepEqual(a.calls(), []);
  assert.equal(await exitOf(f.agent('ticket:has-points', 'p', 'ABC-50')), 0);
});

// ASS-264: the family's refinement, on an estimate above its scale (8 or 13), notes it on the ticket
// (ticket:note-too-large, at Note the Estimate) and rests at Too Large for the operator: Accept to Ready,
// points none; Return, with a note, to Groom — the note the groomer reads as the rejection-reason.
function inFamily(state = 'too-large', extra = {}) {
  const f = inBacklog(state, extra);
  mkdirSync(join(f.dir, 'engines', 'family-backlog-refinement'), { recursive: true });
  copyFileSync(join(engineDir('family-backlog-refinement'), 'state-engine.json'), join(f.dir, 'engines', 'family-backlog-refinement', 'state-engine.json'));
  edit(f.file, b => { b.tickets[0].variations[0]['harness-status']['state-engine'] = 'family-backlog-refinement'; });
  return f;
}

test('ASS-264 AC2: ticket:note-too-large keeps the estimate above the scale on the ticket and leaves it without points; a later estimate on the scale clears the note', async () => {
  const f = inFamily('note-estimate-8', { points: 3, 'points-set-at': '2026-10-29T00:00:00Z' });
  const a = withAcli(f);
  const { stdout } = await run(AGENT, ['ticket:note-too-large', 'p', 'abc-50', '8'], { env: a.env });
  assert.deepEqual(JSON.parse(stdout), { ticket: 'ABC-50', 'too-large-estimate': 8 });
  const t = f.ticket();
  assert.deepEqual([t.points, t['points-set-at'], t['too-large-estimate'].points], [null, undefined, 8]);
  assert.match(t['too-large-estimate']['noted-at'], STAMP);
  assert.deepEqual(a.calls(), []);                                                          // a Jira ticket: the harness alone
  await fails(run(AGENT, ['ticket:note-too-large', 'p', 'ABC-50', '5'], { env: a.env }), /5 is on p's story-point scale/);
  await fails(run(AGENT, ['ticket:note-too-large', 'p', 'ABC-50', 'x'], { env: a.env }), /x is not a whole number/);
  await fails(run(AGENT, ['ticket:note-too-large', 'p', 'ABC-99', '13'], { env: a.env }), /no ABC-99/);
  await fails(run(AGENT, ['ticket:note-too-large', 'p', 'ABC-50'], { env: a.env }), /usage/);
  assert.equal(f.ticket()['too-large-estimate'].points, 8);
  await a.set('p', 'ABC-50', '2');                                                          // estimated again, on the scale
  assert.deepEqual([f.ticket().points, f.ticket()['too-large-estimate']], [2, undefined]);
});

test('ASS-264 AC2: ticket:note-too-large on an off-board ticket takes its points off the ticket\'s file too (none)', async () => {
  const f = inFamily('note-estimate-13');
  const a = withAcli(f);
  const offBoard = mkdtempSync(join(tmpdir(), 'off-board-'));
  const env = { ...a.env, OFF_BOARD_DIR: offBoard };
  edit(projectFile(f), p => { p['work-sources'].push({ name: 'Harness Ticket', type: 'off-board', folder: 'p-tickets', 'key-prefix': 'HD' }); });
  await run(join(ROOT, 'off-board.sh'), ['ticket:create', 'p', 'Story', 'Too big'], { env });
  edit(f.file, b => { b.tickets.push({ key: 'HD-1', title: 'Too big', points: null, variations: [] }); });
  await run(AGENT, ['ticket:set-points', 'p', 'HD-1', '3'], { env });                      // an earlier estimate
  await run(AGENT, ['ticket:note-too-large', 'p', 'hd-1', '13'], { env });
  const t = JSON.parse(readFileSync(f.file, 'utf8')).tickets[1];
  assert.deepEqual([t.points, t['too-large-estimate'].points], [null, 13]);
  assert.equal(JSON.parse((await run(join(ROOT, 'off-board.sh'), ['ticket:get', 'p', 'HD-1'], { env })).stdout).points, null);
  assert.deepEqual(a.calls(), []);
});

test('ASS-264 AC2: at Too Large, Accept moves the ticket to Ready with no points; Return keeps the operator\'s note as the rejection-reason the next groom reads and moves it to Groom', async () => {
  const f = inFamily('too-large');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'too-large', 'Return', 'groom', 'Cut it to AC1 and AC2; AC3 is its own ticket');
  const v = f.variation();
  assert.deepEqual([v['harness-status'], v['human-review'].decision, v['rejection-reason']],
    [{ state: 'groom', 'state-engine': 'family-backlog-refinement' }, 'Return', 'Cut it to AC1 and AC2; AC3 is its own ticket']);
  assert.deepEqual([v['state-changes'].at(-1).cause, v['state-changes'].at(-1).reason], ['operator', 'Cut it to AC1 and AC2; AC3 is its own ticket']);
  await f.agent('ticket:change-state', 'p', 'ABC-50', 'A', 'groom', 'too-large');
  await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'too-large', 'Accept', 'ready');
  assert.deepEqual([f.variation()['harness-status'].state, f.variation()['human-review'].decision, f.ticket().points ?? null], ['ready', 'Accept', null]);
});

test('ASS-179 AC4: ticket:restart-refinement reads which tickets are in the sprint inside the tickets lock — one that joined the sprint while it waited is left alone', async t => {
  const f = inBacklog('grooming');
  const { spawn } = await import('node:child_process');
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', join(f.dir, 'projects', 'p', 'tickets.lock')]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const restarting = f.agent('ticket:restart-refinement', 'p');
  await new Promise(resolve => setTimeout(resolve, 1000));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features.push({ key: 'ABC-50', variations: [] }); });   // ABC-50 joins the sprint
  holder.kill('SIGKILL');
  assert.deepEqual(JSON.parse((await restarting).stdout).reset, []);
  assert.equal(f.ticket().variations[0]['harness-status'].state, 'grooming');
});
