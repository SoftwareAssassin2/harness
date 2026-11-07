// The agent:* commands and agent-interaction:send-message — prompts composed
// from the engine's templates and queued in the agent's session inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fixture, AGENT, STAMP, SELF_HEALING_ENGINE } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const DEAD = spawnSync('true').pid;                                     // a process that has ended

test('agent:dispatch wraps the pen-holder\'s assignment prompt in receive-dispatch, the persona first, and queues it before the process runs', async () => {
  const f = fixture();
  const { stdout } = await f.agent('agent:dispatch', 'Daredevil');
  const expected = [
    'You are a developer.',
    '',
    `LEAD update: ${AGENT} assignments:status-update Daredevil "<your update>" approve: ${AGENT} assignments:approve Daredevil`,
    `Build ABC-3 variation A of p in ${join(f.dir, 'projects', 'p', 'work', 'ABC-3')} with ${AGENT}. Keep {assignment} literal.`,
  ].join('\n');
  assert.equal(stdout, `${expected}\n`);
  assert.deepEqual(f.inbox('Daredevil'), [expected]);
  assert.ok(existsSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3')), 'the ticket folder is made for the agent');
  assert.equal(f.assignments().assignments[0].status, 'Running');       // nothing on the record changes
});

test('agent:dispatch wraps a pair agent\'s prompt in receive-pair-dispatch, naming the others and the pen-holder; a transient engine\'s fills {problem} and falls back to the project engine\'s templates', async () => {
  const f = fixture();
  await f.agent('agent:dispatch', 'Spock');
  assert.deepEqual(f.inbox('Spock'), [[
    'You are a developer.',
    '',
    `PAIR with Daredevil; pen Daredevil; send: ${AGENT} agent-interaction:send-message Spock <to-agent> "<message>"; approve: ${AGENT} assignments:approve Spock; update: ${AGENT} assignments:status-update Spock "<your update>"`,
    `Build ABC-3 variation A of p in ${join(f.dir, 'projects', 'p', 'work', 'ABC-3')} with ${AGENT}. Keep {assignment} literal.`,
  ].join('\n')]);
  await f.agent('agent:dispatch', 'Leia');                             // persona "nobody" has no file: none prepended
  assert.deepEqual(f.inbox('Leia', '20261008T000000Z'), [`LEAD update: ${AGENT} assignments:status-update Leia "<your update>" approve: ${AGENT} assignments:approve Leia\nFind a ticket in p for: the build is red`]);
});

test('agent:dispatch fills the persona\'s placeholders as the assignment\'s, so a persona can name the harness and the project; {harness-folder} the harness repo and {project-folder} the project\'s folder in it, absolute', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'personas', 'developer.md'), 'Harness: {harness-folder}, the folder holding {agent-sh}. Project: {project-folder}/project.json.\n');
  await f.agent('agent:dispatch', 'Daredevil');
  assert.equal(f.inbox('Daredevil')[0].split('\n')[0], `Harness: ${dirname(AGENT)}, the folder holding ${AGENT}. Project: ${join(f.dir, 'projects', 'p')}/project.json.`);
});

test('agent:dispatch writes the ticket as it stands now to {ticket-folder}/ticket.json — its fields and the agent\'s variation, or its first live one for an agent without — before the agent starts', async () => {
  const f = fixture();
  await f.agent('agent:dispatch', 'Daredevil');
  const ticket = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'ticket.json'), 'utf8'));
  assert.equal(ticket.key, 'ABC-3');
  assert.equal(ticket['ticket-system-status'], 'In Progress');
  assert.equal(ticket.variation.name, 'A');
  assert.equal(ticket.variation['harness-status'].state, 'generate-solution');
  assert.equal(ticket.variations, undefined);                           // only the agent's own variation
  const file = join(f.dir, 'assignments.json');                          // an agent with no variation (a fix ticket's) gets the ticket's first live one
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(data.assignments.find(a => a['agent-name'] === 'Leia'), { 'work-item': 'ABC-3', variation: null });
  writeFileSync(file, JSON.stringify(data, null, 4));
  await f.agent('agent:dispatch', 'Leia');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'ticket.json'), 'utf8')).variation.name, 'A');
});

// ASS-240 AC4: written on dispatch alone, ticket.json goes stale as scripted steps, Jira and the merge request move on:
// it says so itself — when it was written, and that the active sprint is the current record.
test('ASS-240 AC4: ticket.json is labelled a snapshot from the last dispatch: when it was written, and where the ticket stands now', async () => {
  const f = fixture();
  await f.agent('agent:dispatch', 'Daredevil');
  const { snapshot } = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'ticket.json'), 'utf8'));
  assert.match(snapshot, /^Written at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, when an agent was last dispatched on the ticket; not rewritten as it moves on: its step, ticket system status and merge requests now are in the project's active sprint\.$/);
});

test('agent:dispatch run 40 at once, for one ticket, all succeed: each writes ticket.json through a temp file of its own, leaving none behind (ASS-176)', async () => {
  const f = fixture();
  const names = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'Spock' : 'Daredevil'));
  const results = await Promise.allSettled(names.map(name => f.agent('agent:dispatch', name)));
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.stderr), []);
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  assert.equal(JSON.parse(readFileSync(join(folder, 'ticket.json'), 'utf8')).key, 'ABC-3');
  assert.deepEqual(readdirSync(folder).filter(file => file.startsWith('ticket.json.') || file.startsWith('.ticket.json')), []);
});

test('agent:dispatch gives a run\'s work without a ticket its root run\'s folder, work/run-<id>, made for it; the wrappers fill the ticket\'s placeholders too', async () => {
  const f = fixture();
  const file = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data['transient-state-engines'].push({ ...data['transient-state-engines'][0], id: 'bbbbbbbb-0000-4000-8000-000000000003', parent: { 'transient-state-engine': SELF_HEALING_ENGINE } });
  data.assignments.find(a => a['agent-name'] === 'Leia')['transient-state-engine'] = 'bbbbbbbb-0000-4000-8000-000000000003';
  writeFileSync(file, JSON.stringify(data, null, 4));
  writeFileSync(join(f.dir, 'prompts', 'find-existing-ticket', 'prompt.txt'), 'Reports in {ticket-folder}.\n');
  writeFileSync(join(f.dir, 'prompts', 'receive-dispatch', 'prompt.txt'), 'First read {ticket-folder}/.\n{assignment}\n');
  const folder = join(f.dir, 'projects', 'p', 'work', `run-${SELF_HEALING_ENGINE}`);
  await f.agent('agent:dispatch', 'Leia');
  assert.deepEqual(f.inbox('Leia', '20261008T000000Z'), [`First read ${folder}/.\nReports in ${folder}.`]);
  assert.ok(existsSync(folder));
  await f.agent('agent:dispatch', 'Daredevil');
  assert.match(f.inbox('Daredevil')[0], new RegExp(`\\nFirst read ${join(f.dir, 'projects', 'p', 'work', 'ABC-3')}/\\.\nBuild ABC-3 .* Keep \\{assignment\\} literal\\.$`));
});

test('agent:dispatch of a run about another project\'s ticket (ticket-project=<project>, control\'s sampleHealth) gives {ticket-folder} as that project\'s, making no folder under its own and writing no ticket.json (ASS-204)', async () => {
  const f = fixture();
  const file = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(data.assignments.find(a => a['agent-name'] === 'Leia'), { project: 'q', 'work-item': 'ABC-3', variation: null });
  writeFileSync(file, JSON.stringify(data, null, 4));
  writeFileSync(join(f.dir, 'prompts', 'find-existing-ticket', 'prompt.txt'), 'Read {ticket-folder}/ of {ticket-project}.\n');
  await f.agent('agent:dispatch', 'Leia', 'ticket-project=p');
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  assert.match(f.inbox('Leia', '20261008T000000Z')[0], new RegExp(`Read ${folder}/ of p\\.$`));
  assert.ok(!existsSync(join(f.dir, 'projects', 'q', 'work', 'ABC-3')), 'no stray folder under the run\'s own project');
  assert.ok(!existsSync(join(folder, 'ticket.json')), 'the ticket\'s own agents keep its ticket.json');
  // The fix ticket such a run makes is its own project's: its folder stays there.
  const q = join(f.dir, 'projects', 'q', 'project.json');
  writeFileSync(q, JSON.stringify({ ...JSON.parse(readFileSync(q, 'utf8')), 'work-sources': [{ name: 'Local', type: 'off-board', 'key-prefix': 'Q' }] }));
  const again = JSON.parse(readFileSync(file, 'utf8'));
  again.assignments.find(a => a['agent-name'] === 'Leia')['work-item'] = 'Q-1';
  writeFileSync(file, JSON.stringify(again, null, 4));
  await f.agent('agent:dispatch', 'Leia', 'ticket-project=p');
  assert.match(f.inbox('Leia', '20261008T000000Z')[0], new RegExp(`Read ${join(f.dir, 'projects', 'q', 'work', 'Q-1')}/ of p\\.$`));
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'projects', 'q', 'work', 'Q-1', 'ticket.json'), 'utf8')).key, 'Q-1');
  assert.ok(!existsSync(join(f.dir, 'projects', 'p', 'work', 'Q-1')));
});

test('agent:dispatch fails, queuing nothing, for no assignment or a missing prompt', async () => {
  const f = fixture();
  await fails(f.agent('agent:dispatch', 'Hulk'), /no assignment for Hulk/);
  await fails(f.agent('agent:dispatch'), /usage/);
  f.env.PROMPTS_DIR = f.dir;                                           // no templates there
  await fails(f.agent('agent:dispatch', 'Spock'), /no prompt generate-solution/);
  assert.deepEqual([f.inbox('Spock'), f.inbox('Hulk')], [[], []]);
});

test('agent:request-status-update queues the ask with the minutes since the last update, or since the start when there was none', async () => {
  const f = fixture();
  const minutesAgo = m => new Date(Date.now() - m * 60000 - 30000).toISOString().replace(/\.\d+Z$/, 'Z');
  await f.agent('assignments:status-update', 'Spock', 'Testing');
  const data = f.assignments();
  data.assignments[1]['last-ai-status-update'] = minutesAgo(12);
  data.assignments[0]['start-time'] = minutesAgo(7);
  writeFileSync(f.env.ASSIGNMENTS_FILE, JSON.stringify(data, null, 4));
  await f.agent('agent:request-status-update', 'Spock');
  assert.deepEqual(f.inbox('Spock'), [`12 minutes; update: ${AGENT} assignments:status-update Spock "<your update>"; approve: ${AGENT} assignments:approve Spock`]);
  await f.agent('agent:request-status-update', 'Daredevil');
  const stamp = data.assignments[0]['start-time'].replace(/[-:]/g, '');
  assert.deepEqual(f.inbox('Daredevil', stamp), [`7 minutes; update: ${AGENT} assignments:status-update Daredevil "<your update>"; approve: ${AGENT} assignments:approve Daredevil`]);
  assert.deepEqual(f.assignments(), data);                             // asking changes nothing on the records
  await fails(f.agent('agent:request-status-update', 'Hulk'), /no assignment for Hulk/);
});

test('agent:shut-down queues the shut-down prompt and marks the record Shutting Down, saying when', async () => {
  const f = fixture();
  await f.agent('agent:shut-down', 'Spock');
  assert.deepEqual(f.inbox('Spock'), ['STOP NOW']);
  const spock = f.assignments().assignments[1];
  assert.equal(spock.status, 'Shutting Down');
  assert.match(spock['shut-down-requested'], STAMP);
  assert.equal(f.assignments().assignments[0].status, 'Running');
  const before = f.snapshot();
  await fails(f.agent('agent:shut-down', 'Hulk'), /no assignment for Hulk/);
  assert.equal(f.snapshot(), before);
});

test('ASS-181 AC5: agent:shut-down fills {ticket-folder} and {agent-sh} from the record, or from ticket-folder= and agent-sh= given after the name, as agent:dispatch does', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'prompts', 'shut-down', 'prompt.txt'), 'Append to {ticket-folder}/change-log-{variation}.md with {agent-sh} work:append {project} {ticket} {variation} change-log.md\n');
  await f.agent('agent:shut-down', 'Spock');
  assert.deepEqual(f.inbox('Spock'), [`Append to ${join(f.dir, 'projects', 'p', 'work', 'ABC-3')}/change-log-A.md with ${AGENT} work:append p ABC-3 A change-log.md`]);
  await f.agent('agent:shut-down', 'Daredevil', 'ticket-folder=/mnt/ticket', 'agent-sh=agent.sh');
  const stamp = f.assignments().assignments[0]['start-time'].replace(/[-:]/g, '');
  assert.deepEqual(f.inbox('Daredevil', stamp), ['Append to /mnt/ticket/change-log-A.md with agent.sh work:append p ABC-3 A change-log.md']);
  await fails(f.agent('agent:shut-down', 'Spock', 'nonsense'), /expected <placeholder>=<value>/);
});

test('agent:kill ends the agent\'s process group and marks the record Killed; a process already gone, or none, is no failure', async t => {
  const f = fixture();
  const child = spawn('sleep', ['1000'], { detached: true, stdio: 'ignore' });
  child.unref();
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  await f.agent('assignments:set-process', 'Spock', String(child.pid), '-');
  await f.agent('agent:kill', 'Spock');
  const [code, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
  assert.equal(code, null);
  assert.equal(f.assignments().assignments[1].status, 'Killed');
  await f.agent('assignments:set-process', 'Daredevil', String(DEAD), '-');
  await f.agent('agent:kill', 'Daredevil');                            // already gone
  await f.agent('agent:kill', 'Leia');                                 // never started
  assert.deepEqual(f.assignments().assignments.map(a => a.status), ['Killed', 'Killed', 'Killed']);
  await fails(f.agent('agent:kill', 'Hulk'), /no assignment for Hulk/);
});

test('agent:dispatch starts the session\'s inbox afresh — an earlier process of that name and second left lines there — and every queued prompt goes in under inbox.jsonl.lock, waiting while it is held (ASS-179 AC1)', async t => {
  const f = fixture();
  const inbox = join(f.dir, 'agents', 'Daredevil-20261007T235205Z', 'inbox.jsonl');
  mkdirSync(dirname(inbox), { recursive: true });
  writeFileSync(inbox, '{"prompt":"an earlier session\'s"}\n');
  await f.agent('agent:dispatch', 'Daredevil');
  assert.equal(f.inbox('Daredevil').length, 1);
  assert.doesNotMatch(f.inbox('Daredevil')[0], /earlier session/);

  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${inbox}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout, 'data');
  let done = false;
  const sending = f.agent('agent-interaction:send-message', 'Spock', 'Daredevil', 'later').then(() => { done = true; });
  await new Promise(r => setTimeout(r, 700));
  assert.equal(done, false, 'waits for the inbox lock');
  holder.kill('SIGKILL');
  await sending;
  assert.equal(f.inbox('Daredevil').length, 2);
});

test('agent-interaction:send-message queues the message to the other agent with the way to reply and to approve', async () => {
  const f = fixture();
  await f.agent('agent-interaction:send-message', 'Spock', 'Daredevil', 'Use the existing helper.\nSee foo.js.');
  assert.deepEqual(f.inbox('Daredevil'), [`FROM Spock; reply: ${AGENT} agent-interaction:send-message Daredevil Spock "<your reply>"; approve: ${AGENT} assignments:approve Daredevil\nUse the existing helper.\nSee foo.js.`]);
  assert.deepEqual(f.inbox('Spock'), []);
  await fails(f.agent('agent-interaction:send-message', 'Spock', 'Hulk', 'hi'), /no assignment for Hulk/);
  await fails(f.agent('agent-interaction:send-message', 'Hulk', 'Spock', 'hi'), /no assignment for Hulk/);
  await fails(f.agent('agent-interaction:send-message', 'Spock', 'Daredevil', '  '), /the message is empty/);
  await fails(f.agent('agent-interaction:send-message', 'Spock', 'Daredevil'), /usage/);
  assert.deepEqual([f.inbox('Daredevil').length, f.inbox('Spock')], [1, []]);
});

test('agent:dispatch fills any <placeholder>=<value> given after the name — control passes the agent\'s folder and, in the dev container, where that folder is', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'prompts', 'generate-solution', 'prompt.txt'), 'Work in {folder}; the app runs in {dev-container}, where this folder is {dev-container-folder}.\n');
  const { stdout } = await f.agent('agent:dispatch', 'Daredevil', 'folder=/Users/me/ws/.worktrees/ABC-3', 'dev-container=devc', 'dev-container-folder=/workspace/.worktrees/ABC-3');
  assert.ok(stdout.includes('Work in /Users/me/ws/.worktrees/ABC-3; the app runs in devc, where this folder is /workspace/.worktrees/ABC-3.'), stdout);
  await fails(f.agent('agent:dispatch', 'Daredevil', 'no-equals-sign'), /agent:dispatch: expected <placeholder>=<value>, not "no-equals-sign"/);
});

// ASS-219 AC1: {merge-request-title} is the project's title format — project.json's
// "merge-request-title": "key-summary" (the default, `KEY: summary`) or
// "conventional" (`type(scope): subject (KEY)`, as example-ci's mr-title job
// requires); an unknown one fails the dispatch, naming it.
test('ASS-219 AC1: agent:dispatch fills {merge-request-title} with the project\'s merge request title format, key-summary by default, conventional when project.json says so', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'prompts', 'generate-solution', 'prompt.txt'), 'Title: {merge-request-title}.\n');
  await f.agent('agent:dispatch', 'Daredevil');
  assert.match(f.inbox('Daredevil').at(-1), /Title: the ticket key and summary, e\.g\. "ABC-1234: Fix the search timeout"\./);
  const file = join(f.dir, 'projects', 'p', 'project.json');
  const set = format => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'merge-request-title': format }));
  set('conventional');
  await f.agent('agent:dispatch', 'Daredevil');
  assert.match(f.inbox('Daredevil').at(-1), /Title: a conventional commit ending in the ticket key, "type\(scope\): subject \(KEY\)" — .*e\.g\. "fix\(search\): stop the search timing out \(ABC-1234\)"\./);
  set('shouty');
  await fails(f.agent('agent:dispatch', 'Daredevil'), /unknown "merge-request-title" "shouty"/);
});
