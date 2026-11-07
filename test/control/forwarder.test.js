// The forwarder (ASS-74): one HTTP server on the Mac through which an agent
// in a VM runs agent.sh — only the allowlisted commands, and only for the
// ticket variation its VM's token is bound to; for both projects. The
// in-VM client (src/agent-cli/vm/in-vm/agent.sh) is run here against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../agent-cli/harness-fixture.js';
import { authorize, startForwarder } from '../../src/control/forwarder.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const CLIENT = join(ROOT, 'src', 'agent-cli', 'vm', 'in-vm', 'agent.sh');
const sha = t => createHash('sha256').update(t).digest('hex');

// Two VMs' bindings — a harness ticket's and a example one's — and an agent assigned to each.
function bindings(dir) {
  const folder = key => { const f = join(dir, 'work', key); mkdirSync(f, { recursive: true }); return f; };
  const tokens = {
    'ass-74-a': { project: 'harness', ticket: 'ASS-74', variation: 'A', 'ticket-folder': folder('ASS-74'), 'token-sha256': sha('harness-token') },
    'ex-9-b': { project: 'example', ticket: 'EX-9', variation: 'B', 'ticket-folder': folder('EX-9'), 'token-sha256': sha('example-token') },
  };
  const assignments = [
    { 'agent-name': 'Hulk', project: 'harness', 'work-item': 'ASS-74', variation: 'A' },
    { 'agent-name': 'Thor', project: 'harness', 'work-item': 'ASS-74', variation: 'A' },
    { 'agent-name': 'Yoda', project: 'example', 'work-item': 'EX-9', variation: 'B' },
  ];
  return { tokens, assignments };
}

test('a call is run for its own ticket variation, in either project; another ticket, variation, project or agent is refused', async () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (token, ...argv) => authorize(tokens, assignments, token, argv);
  for (const [token, project, ticket, variation, agent, other] of [['harness-token', 'harness', 'ASS-74', 'A', 'Hulk', 'Yoda'], ['example-token', 'example', 'EX-9', 'B', 'Yoda', 'Hulk']]) {
    assert.deepEqual(may(token, 'ticket:questions-answered', project, ticket).argv, ['ticket:questions-answered', project, ticket]);
    assert.ok(may(token, 'ticket:questions-answered', project, ticket.toLowerCase()).argv, 'a key in any case');
    assert.ok(may(token, 'automated-tests:verify-success', project, ticket, variation).argv);
    assert.ok(may(token, 'assignments:status-update', agent, 'reading the plan').argv);
    assert.match(may(token, 'ticket:questions-answered', project, 'ASS-70').refuse, /^ticket "ASS-70" is not this VM's/);
    assert.match(may(token, 'automated-tests:verify-success', project, ticket, 'C').refuse, /^variation "C" is not this VM's/);
    assert.match(may(token, 'ticket:questions-answered', project === 'harness' ? 'example' : 'harness', ticket).refuse, /^project .* is not this VM's/);
    assert.match(may(token, 'assignments:status-update', other, 'x').refuse, new RegExp(`^agent "${other}" has no assignment on ${ticket} ${variation}`));
    assert.match(may(token, 'ticket:questions-answered', project).refuse, /^ticket null is not this VM's/);
  }
  assert.ok(may('harness-token', 'agent-interaction:send-message', 'Hulk', 'Thor', 'hi').argv, 'its pair');
  assert.match(may('harness-token', 'agent-interaction:send-message', 'Hulk', 'Yoda', 'hi').refuse, /agent "Yoda"/);
  assert.match(may('harness-token', 'project:clear-rate-limit', 'harness').refuse, /^command not allowed: project:clear-rate-limit/);
  assert.match(may('harness-token', 'self-healing:start', 'harness', 'ASS-74').refuse, /^command not allowed/);
  assert.match(may('harness-token', '_comment').refuse, /^command not allowed/);
  assert.equal(may('', 'ticket:questions-answered', 'harness', 'ASS-74').refuse, 'no token');
  assert.equal(may(undefined, 'ticket:questions-answered', 'harness', 'ASS-74').refuse, 'no token');
  assert.equal(may('stolen', 'ticket:questions-answered', 'harness', 'ASS-74').refuse, 'unknown token');
});

// ASS-182 AC1: /mnt/ticket is read-only, so a command that once took a file there takes "-" and its content on stdin; no path is ever passed to the Mac.
test('ASS-182 AC1: ticket:post-comment, ticket:set-acceptance-criteria and ticket:set-merge-request-plan take "-" (the content on stdin) from a VM, never a path: not /mnt/ticket\'s, not the Mac\'s', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('ticket:post-comment', 'harness', 'ASS-74', '-').argv, ['ticket:post-comment', 'harness', 'ASS-74', '-']);
  assert.deepEqual(may('ticket:set-acceptance-criteria', 'harness', 'ASS-74', 'A', '-').argv, ['ticket:set-acceptance-criteria', 'harness', 'ASS-74', 'A', '-']);
  assert.deepEqual(may('ticket:set-merge-request-plan', 'harness', 'ASS-74', 'A', '-').argv, ['ticket:set-merge-request-plan', 'harness', 'ASS-74', 'A', '-']);
  for (const path of ['/mnt/ticket/steps-to-test.md', join(f.dir, 'harness.json'), 'steps-to-test.md', undefined]) {
    assert.match(may('ticket:post-comment', 'harness', 'ASS-74', ...(path ? [path] : [])).refuse, /must be "-": the content goes on stdin/, String(path));
    assert.match(may('ticket:set-merge-request-plan', 'harness', 'ASS-74', 'A', ...(path ? [path] : [])).refuse, /must be "-"/, String(path));
  }
  assert.match(may('ticket:set-acceptance-criteria', 'harness', 'ASS-74', 'A', '/mnt/ticket/ac.json').refuse, /must be "-"/);
});

// ASS-198 AC1: merge-request:conflicting-tickets, read-only, binds project/ticket/variation to the caller like the other three-position rules.
test('ASS-198 AC1: merge-request:conflicting-tickets is allowed for the VM\'s own project/ticket/variation; another project, ticket or variation is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('merge-request:conflicting-tickets', 'harness', 'ASS-74', 'A').argv, ['merge-request:conflicting-tickets', 'harness', 'ASS-74', 'A']);
  assert.ok(may('merge-request:conflicting-tickets', 'harness', 'ass-74', 'A').argv, 'a key in any case');
  assert.match(may('merge-request:conflicting-tickets', 'harness', 'ASS-70', 'A').refuse, /^ticket "ASS-70"/);
  assert.match(may('merge-request:conflicting-tickets', 'harness', 'ASS-74', 'B').refuse, /^variation "B"/);
  assert.match(may('merge-request:conflicting-tickets', 'example', 'ASS-74', 'A').refuse, /^project "example"/);
});

// The server and the client: the fixture's data, one binding for its ABC-3 A.
async function served() {
  const f = fixture();
  const home = join(f.dir, 'home'), folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(home, { recursive: true }); mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, 'vm-tokens.json'), JSON.stringify({ 'abc-3-a': { project: 'p', ticket: 'ABC-3', variation: 'A', 'ticket-folder': folder, 'token-sha256': sha('s3cr3t-9f3c') } }));
  writeFileSync(join(folder, 'questions-and-answers.json'), JSON.stringify({ list: [{ status: 'Answered' }] }));
  writeFileSync(join(home, 'agent-token'), 's3cr3t-9f3c\n');
  const lines = [];
  const server = await startForwarder({ root: ROOT, env: { ...f.env, HARNESS_HOME: home }, port: 0, log: (phase, text) => lines.push(`${phase} ${text}`) });
  const env = { ...process.env, AGENT_FORWARDER_URL: `http://127.0.0.1:${server.address().port}/run`, AGENT_TOKEN_FILE: join(home, 'agent-token') };
  const client = (...args) => run(CLIENT, args, { env }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  return { f, home, server, client, lines, env };
}

test('agent.sh in the VM runs an allowed call on the Mac through the forwarder, with its stdout, stderr and exit code; a refused one exits 77, saying why', async () => {
  const { f, server, client, lines, home, env } = await served();
  try {
    assert.deepEqual(await client('ticket:questions-answered', 'p', 'ABC-3'), { code: 1, stdout: '{"ticket":"ABC-3","open":1}\n', stderr: '' });
    const status = await client('assignments:status-update', 'Daredevil', 'in the VM');
    assert.equal(status.code, 0, status.stderr);
    assert.equal(f.assignments().assignments[0]['ai-status-update-short'], 'in the VM');
    const refused = await client('ticket:questions-answered', 'p', 'ABC-4');
    assert.equal(refused.code, 77);
    assert.match(refused.stderr, /agent\.sh: refused by the host: ticket "ABC-4" is not this VM's ABC-3/);
    writeFileSync(join(home, 'agent-token'), 'wrong\n');
    assert.match((await client('ticket:questions-answered', 'p', 'ABC-3')).stderr, /refused by the host: unknown token/);
    assert.ok(lines.some(l => /^forwarder REFUSE abc-3-a \["ticket:questions-answered","p","ABC-4"\]: ticket "ABC-4"/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /^forwarder RUN abc-3-a \["ticket:questions-answered","p","ABC-3"\]$/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('s3cr3t'), 'no token is logged');
  } finally { server.close(); }
  const gone = await run(CLIENT, ['ticket:questions-answered', 'p', 'ABC-3'], { env }).catch(e => e);
  assert.equal(gone.code, 125);
  assert.match(gone.stderr, /host forwarder unreachable/);
});

test('ASS-151 AC3: vm:build-golden-start and vm:golden-status are allowed only from a fast-tracked ticket\'s VM, for any project\'s image; any other VM is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const fast = binding => binding.ticket === 'ASS-74';
  for (const command of ['vm:build-golden-start', 'vm:golden-status']) {
    assert.deepEqual(authorize(tokens, assignments, 'harness-token', [command, 'example'], fast).argv, [command, 'example'], command);
    assert.deepEqual(authorize(tokens, assignments, 'harness-token', [command, 'harness'], fast).argv, [command, 'harness'], command);
    assert.equal(authorize(tokens, assignments, 'example-token', [command, 'example'], fast).refuse, 'EX-9 is not fast-tracked', command);
    assert.equal(authorize(tokens, assignments, 'harness-token', [command, 'harness']).refuse, 'ASS-74 is not fast-tracked', `${command}: none is, unless told`);
  }
  assert.match(authorize(tokens, assignments, 'harness-token', ['vm:build-golden', 'harness'], fast).refuse, /^command not allowed/, 'the build itself is never called from a VM');
});

test('ASS-151 AC3: through the forwarder, a VM whose sprint ticket is fast-tracked (fast-track: true) runs vm:golden-status on the Mac; refused while it is not', async () => {
  const { f, server, client } = await served();
  try {
    const refused = await client('vm:golden-status', 'q');
    assert.equal(refused.code, 77);
    assert.match(refused.stderr, /refused by the host: ABC-3 is not fast-tracked/);
    const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s = JSON.parse(readFileSync(sprint, 'utf8'));
    s.features[0]['fast-track'] = true;
    writeFileSync(sprint, JSON.stringify(s));
    const ran = await client('vm:golden-status', 'q');
    assert.equal(ran.code, 1);                                                 // run on the Mac: q has no golden image
    assert.match(ran.stderr, /vm:golden-status: q has no golden-image/);
  } finally { server.close(); }
});

// ASS-181 AC6: work:write and work:append hold a VM to its own ticket variation: "-" (the ticket's own file) is the Mac's alone.
test('ASS-181 AC6: work:write and work:append are allowed for the VM\'s own variation only; "-" or another variation is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  for (const command of ['work:write', 'work:append']) {
    const may = (...argv) => authorize(tokens, assignments, 'harness-token', [command, ...argv]);
    assert.deepEqual(may('harness', 'ASS-74', 'A', 'execution-plan.md').argv, [command, 'harness', 'ASS-74', 'A', 'execution-plan.md']);
    assert.match(may('harness', 'ASS-74', '-', 'estimate.md').refuse, /^variation "-" is not this VM's A/);
    assert.match(may('harness', 'ASS-74', 'B', 'execution-plan.md').refuse, /^variation "B" is not this VM's A/);
    assert.match(may('harness', 'ASS-70', 'A', 'execution-plan.md').refuse, /^ticket "ASS-70"/);
    assert.match(may('example', 'ASS-74', 'A', 'execution-plan.md').refuse, /^project "example"/);
  }
});

// A raw call to the forwarder, as the in-VM agent.sh makes it: { status, lines }.
async function post(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, lines: (await res.text()).trim().split('\n').map(l => JSON.parse(l)) };
}
const decoded = (lines, key) => lines.filter(l => l[key]).map(l => Buffer.from(l[key], 'base64').toString()).join('');

test('ASS-181 AC1: agent.sh in the VM sends stdin, base64, for work:write and work:append, and the forwarder gives the host command those bytes', async () => {
  const { f, server, env } = await served();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  const piped = (input, ...args) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, encoding: 'buffer' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.toString(), stderr: stderr.toString() }));
    child.stdin.end(input);
  });
  try {
    const plan = '# Plan\n\nünïcödé, "quotes", $dollars and `ticks`\n';
    const wrote = await piped(plan, 'work:write', 'p', 'ABC-3', 'A', 'execution-plan.md');
    assert.equal(wrote.code, 0, wrote.stderr);
    assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), plan);
    assert.equal((await piped('- one\n', 'work:append', 'p', 'ABC-3', 'A', 'change-log.md')).code, 0);
    assert.equal((await piped('- two\n', 'work:append', 'p', 'ABC-3', 'A', 'change-log.md')).code, 0);
    assert.equal(readFileSync(join(folder, 'change-log-A.md'), 'utf8'), '- one\n- two\n');
    const exactly = Buffer.alloc(1 << 20, 'a');
    assert.equal((await piped(exactly, 'work:write', 'p', 'ABC-3', 'A', 'test-results.md')).code, 0, 'exactly 1 MB is sent');
    assert.equal(readFileSync(join(folder, 'test-results-A.md')).length, 1 << 20);
    const refused = await piped('x\n', 'work:write', 'p', 'ABC-3', '-', 'estimate.md');
    assert.equal(refused.code, 77);
    assert.match(refused.stderr, /refused by the host: variation "-" is not this VM's A/);
  } finally { server.close(); }
});

test('ASS-181 AC1: over 1 MB on stdin the VM\'s agent.sh fails before sending, saying so; a command that takes no stdin sends none, its stdin left unread', async () => {
  const { f, server, env, lines } = await served();
  const piped = (input, ...args) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, encoding: 'buffer' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.toString(), stderr: stderr.toString() }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  try {
    const over = await piped(Buffer.alloc((1 << 20) + 1, 'a'), 'work:write', 'p', 'ABC-3', 'A', 'test-results.md');
    assert.equal(over.code, 1);
    assert.match(over.stderr, /agent\.sh: stdin is over 1 MB: not sent/);
    assert.ok(!lines.some(l => l.includes('test-results.md')), 'nothing reached the forwarder');
    assert.ok(!existsSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'test-results-A.md')));
    // A command that takes none never waits on its stdin: an open, idle one included.
    const idle = execFile(CLIENT, ['ticket:questions-answered', 'p', 'ABC-3'], { env });
    const done = await new Promise(resolve => idle.on('exit', code => resolve(code)));
    assert.equal(done, 1, 'ran (ABC-3 has an open question) without stdin ever closing');
    idle.stdin.end();
  } finally { server.close(); }
});

test('ASS-181 AC1: the forwarder passes a call\'s stdin field, decoded, to the host command; with none the command\'s stdin is empty, as before; over 1 MB it is refused', async () => {
  const { server } = await served();
  try {
    const call = argv => ({ token: 's3cr3t-9f3c', argv });
    const none = await post(server, call(['work:write', 'p', 'ABC-3', 'A', 'code-review.md']));
    assert.equal(none.lines.at(-1).exit, 1);
    assert.match(decoded(none.lines, 'e'), /work:write: nothing on stdin/);
    const given = await post(server, { ...call(['work:write', 'p', 'ABC-3', 'A', 'code-review.md']), stdin: Buffer.from('findings\n').toString('base64') });
    assert.equal(given.lines.at(-1).exit, 0, decoded(given.lines, 'e'));
    const big = await post(server, { ...call(['work:write', 'p', 'ABC-3', 'A', 'code-review.md']), stdin: Buffer.alloc((1 << 20) + 1, 'a').toString('base64') });
    assert.equal(big.status, 403);
    assert.equal(big.lines[0].refused, 'stdin is over 1 MB');
    const bad = await post(server, { ...call(['work:write', 'p', 'ABC-3', 'A', 'code-review.md']), stdin: 42 });
    assert.equal(bad.status, 403);
    assert.equal(bad.lines[0].refused, 'stdin is not base64 text');
  } finally { server.close(); }
});

// ASS-180 AC5: automated-tests:record and ticket:set-demo-plan are allowed for the VM's own
// ticket variation only; ticket:set-requirements and ticket:set-acceptance-criteria stay
// host-only (not on the forwarder allowlist); the in-VM agent.sh forwards stdin for both
// new commands.
test('ASS-180 AC5: automated-tests:record and ticket:set-demo-plan are allowed for the VM\'s own variation; other variation, ticket or project refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  for (const command of ['automated-tests:record', 'ticket:set-demo-plan']) {
    const may = (...argv) => authorize(tokens, assignments, 'harness-token', [command, ...argv]);
    assert.deepEqual(may('harness', 'ASS-74', 'A').argv, [command, 'harness', 'ASS-74', 'A']);
    assert.match(may('harness', 'ASS-74', 'B').refuse, /^variation "B" is not this VM's A/);
    assert.match(may('harness', 'ASS-74', '-').refuse, /^variation "-" is not this VM's A/);
    assert.match(may('harness', 'ASS-70', 'A').refuse, /^ticket "ASS-70"/);
    assert.match(may('example', 'ASS-74', 'A').refuse, /^project "example"/);
  }
});

test('ASS-180 AC5: ticket:set-requirements and ticket:set-acceptance-criteria - are host-only; a VM is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.match(may('ticket:set-requirements', 'harness', 'ASS-74').refuse, /^command not allowed: ticket:set-requirements/);
  assert.match(may('ticket:set-acceptance-criteria', 'harness', 'ASS-74', '-').refuse, /^variation "-" is not this VM's A|^command not allowed/);
});

test('ASS-180 AC5: the forwarder allowlist has exactly these two new keys (automated-tests:record, ticket:set-demo-plan) and no new entry for the host-only commands', () => {
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  assert.ok(Object.hasOwn(allowlist, 'automated-tests:record'), 'automated-tests:record on the allowlist');
  assert.deepEqual(allowlist['automated-tests:record'], { project: 0, ticket: 1, variation: 2 });
  assert.ok(Object.hasOwn(allowlist, 'ticket:set-demo-plan'), 'ticket:set-demo-plan on the allowlist');
  assert.deepEqual(allowlist['ticket:set-demo-plan'], { project: 0, ticket: 1, variation: 2 });
  assert.ok(!Object.hasOwn(allowlist, 'ticket:set-requirements'), 'ticket:set-requirements is NOT on the allowlist');
});

test('ASS-180 AC5: the in-VM agent.sh forwards stdin for automated-tests:record and ticket:set-demo-plan', async () => {
  const { f, server, env } = await served();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  const piped = (input, ...args) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, encoding: 'buffer' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.toString(), stderr: stderr.toString() }));
    child.stdin.end(input);
  });
  try {
    const list = '[{"list":"a","run":"b"}]';
    const r1 = await piped(list, 'automated-tests:record', 'p', 'ABC-3', 'A');
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(readFileSync(join(folder, 'automated-tests-A.json'), 'utf8'), list);
    const BROWSER = { demo: true, setup: ['pnpm install'], 'ready-check': 'curl -fs http://localhost:4200', view: { with: 'browser', address: 'http://localhost:4200' }, 'look-at': ['Open the page'] };
    const plan = JSON.stringify(BROWSER);
    const r2 = await piped(plan, 'ticket:set-demo-plan', 'p', 'ABC-3', 'A');
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(readFileSync(join(folder, 'demo-plan-A.json'), 'utf8'), plan);
  } finally { server.close(); }
});

test('ASS-180 AC5, ASS-182 AC1: the in-VM agent.sh takes_stdin lists exactly work:write, work:append, automated-tests:record, ticket:set-demo-plan and the three that once took a file (ticket:post-comment, ticket:set-acceptance-criteria, ticket:set-merge-request-plan), ASS-238\'s merge-request:update and :upload-image, and ASS-239\'s merge-request:reply', () => {
  const script = readFileSync(CLIENT, 'utf8');
  const match = script.match(/takes_stdin\(\)[^\n]*case "\$1" in ([^)]+)\)/);
  assert.ok(match, 'takes_stdin case line not found');
  assert.deepEqual(match[1].split('|').sort(), ['automated-tests:record', 'merge-request:reply', 'merge-request:update', 'merge-request:upload-image', 'ticket:post-comment', 'ticket:set-acceptance-criteria', 'ticket:set-demo-plan', 'ticket:set-merge-request-plan', 'work:add-screenshot', 'work:append', 'work:write']);
});

// ASS-238: a VM agent reads and updates its merge requests through the host — merge-request:view, :update (the
// description on stdin) and :upload-image (a PNG on stdin) — bound to its own ticket variation.
test('ASS-238 AC1: merge-request:view, :update and :upload-image are allowed for the VM\'s own ticket variation, the last two only with "-" (stdin); another ticket, variation or project is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('merge-request:view', 'harness', 'ASS-74', 'A', '1').argv, ['merge-request:view', 'harness', 'ASS-74', 'A', '1']);
  assert.ok(may('merge-request:update', 'harness', 'ass-74', 'A', '1', '-', 'ASS-74: title').argv);
  assert.ok(may('merge-request:update', 'harness', 'ASS-74', 'A', '1', '-').argv);
  assert.ok(may('merge-request:upload-image', 'harness', 'ASS-74', 'A', '1', '-', 'shot.png').argv);
  for (const command of ['merge-request:view', 'merge-request:update', 'merge-request:upload-image']) {
    assert.match(may(command, 'harness', 'ASS-70', 'A', '1', '-').refuse, /^ticket "ASS-70"/, command);
    assert.match(may(command, 'harness', 'ASS-74', 'B', '1', '-').refuse, /^variation "B"/, command);
    assert.match(may(command, 'example', 'ASS-74', 'A', '1', '-').refuse, /^project "example"/, command);
  }
  for (const command of ['merge-request:update', 'merge-request:upload-image']) assert.match(may(command, 'harness', 'ASS-74', 'A', '1', '/mnt/ticket/screenshots/1/a.png').refuse, /must be "-"/, command);
});

// ASS-239: a VM agent replies to (the reply on stdin) and resolves its merge requests' review threads through the host.
test('ASS-239 AC1: merge-request:reply and :resolve are allowed for the VM\'s own ticket variation, reply only with "-" (stdin); another ticket, variation or project is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('merge-request:reply', 'harness', 'ass-74', 'A', '1', 'd1', '-').argv, ['merge-request:reply', 'harness', 'ass-74', 'A', '1', 'd1', '-']);
  assert.deepEqual(may('merge-request:resolve', 'harness', 'ASS-74', 'A', '1', 'd1').argv, ['merge-request:resolve', 'harness', 'ASS-74', 'A', '1', 'd1']);
  for (const command of ['merge-request:reply', 'merge-request:resolve']) {
    assert.match(may(command, 'harness', 'ASS-70', 'A', '1', 'd1', '-').refuse, /^ticket "ASS-70"/, command);
    assert.match(may(command, 'harness', 'ASS-74', 'B', '1', 'd1', '-').refuse, /^variation "B"/, command);
    assert.match(may(command, 'example', 'ASS-74', 'A', '1', 'd1', '-').refuse, /^project "example"/, command);
  }
  assert.match(may('merge-request:reply', 'harness', 'ASS-74', 'A', '1', 'd1', '/mnt/ticket/reply.md').refuse, /must be "-"/);
});

// ASS-241: a VM agent records each acceptance criterion's dev or testing status through the host.
test('ASS-241 AC1: ticket:set-ac-status is allowed for the VM\'s own ticket variation; another ticket, variation or project is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('ticket:set-ac-status', 'harness', 'ass-74', 'A', 'dev', '1', 'Passed').argv, ['ticket:set-ac-status', 'harness', 'ass-74', 'A', 'dev', '1', 'Passed']);
  assert.match(may('ticket:set-ac-status', 'harness', 'ASS-70', 'A', 'dev', '1', 'Passed').refuse, /^ticket "ASS-70"/);
  assert.match(may('ticket:set-ac-status', 'harness', 'ASS-74', 'B', 'testing', '1', 'Failed').refuse, /^variation "B"/);
  assert.match(may('ticket:set-ac-status', 'example', 'ASS-74', 'A', 'dev', '1', 'Passed').refuse, /^project "example"/);
});

test('ASS-238 AC1, ASS-239 AC1: the VM\'s agent.sh sends merge-request:update\'s description, merge-request:upload-image\'s PNG and merge-request:reply\'s reply on stdin, byte for byte, to the command on the Mac', async () => {
  const { server, env } = await served();
  const piped = (input, ...args) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, encoding: 'buffer' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr: stderr.toString() }));
    child.stdin.end(input);
  });
  try {
    // Run on the Mac with its stdin: past the PNG and description checks, it finds ABC-3 A has no merge request.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([0, 255, 128, 10, 13])]);
    for (const [input, args] of [[png, ['merge-request:upload-image', 'p', 'ABC-3', 'A', '1', '-', 'shot.png']], ['## Summary\nx\n', ['merge-request:update', 'p', 'ABC-3', 'A', '1', '-']], ['Done in abc123\n', ['merge-request:reply', 'p', 'ABC-3', 'A', '1', 'd1', '-']]]) {
      const ran = await piped(input, ...args);
      assert.equal(ran.code, 1, args[0]);
      assert.match(ran.stderr, new RegExp(`^${args[0]}: ABC-3 A has no merge request`), args[0]);
    }
  } finally { server.close(); }
});
