// The forwarder (ASS-74): one HTTP server on the Mac through which an agent
// in a VM runs agent.sh — only the allowlisted commands, and only for the
// ticket variation its VM's token is bound to; for both projects. The
// in-VM client (src/agent-cli/vm/in-vm/agent.sh) is run here against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { within } from '../support/until.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { authorize, startForwarder, forwardedEnv } from '../../src/control/forwarder.js';

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
  assert.deepEqual(allowlist['automated-tests:record'], { project: 0, ticket: 1, variation: 2, 'max-args': 3 });   // ASS-428: its file path the Mac's alone
  assert.ok(Object.hasOwn(allowlist, 'ticket:set-demo-plan'), 'ticket:set-demo-plan on the allowlist');
  assert.deepEqual(allowlist['ticket:set-demo-plan'], { project: 0, ticket: 1, variation: 2, 'max-args': 3 });
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

// ASS-483: a VM agent retries an infra-flaked failed job (no test ran) on its merge request through the host.
test('ASS-483 AC1: merge-request:retry is allowed for the VM\'s own ticket variation; another ticket, variation or project is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('merge-request:retry', 'harness', 'ASS-74', 'A', '1').argv, ['merge-request:retry', 'harness', 'ASS-74', 'A', '1']);
  assert.match(may('merge-request:retry', 'harness', 'ASS-70', 'A', '1').refuse, /^ticket "ASS-70"/);
  assert.match(may('merge-request:retry', 'harness', 'ASS-74', 'B', '1').refuse, /^variation "B"/);
  assert.match(may('merge-request:retry', 'example', 'ASS-74', 'A', '1').refuse, /^project "example"/);
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

// ASS-298 AC2: work:write's optional 5th argument (a host file path) is the
// Mac's alone: the forwarder caps the rule at 4 arguments, so a VM keeps the
// stdin form only.
test('ASS-298 AC2: a VM\'s work:write with a 5th argument — a path or "-" — is refused (max-args); the 4-argument stdin form is still allowed', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.deepEqual(may('work:write', 'harness', 'ASS-74', 'A', 'execution-plan.md').argv, ['work:write', 'harness', 'ASS-74', 'A', 'execution-plan.md']);
  for (const fifth of ['/mnt/ticket/body.md', '-']) {
    const r = may('work:write', 'harness', 'ASS-74', 'A', 'execution-plan.md', fifth);
    assert.equal(r.argv, undefined, fifth);
    assert.match(r.refuse ?? '', /work:write takes at most 4 arguments/, fifth);
  }
});

// ASS-428: work:append, automated-tests:record, ticket:set-demo-plan and merge-request:create-fix took the same trailing file path, capped the same way.
const CAPPED = { 'machine:restart-imminent': 0, 'work:write': 4, 'work:append': 4, 'automated-tests:record': 3, 'ticket:set-demo-plan': 3, 'merge-request:create-fix': 6, 'assignments:status-update': 2, 'agent-interaction:send-message': 3 };
test('ASS-298 AC2, ASS-428: the allowlist caps work:write at 4 arguments — { project: 0, ticket: 1, variation: 2, max-args: 4 } — and each other command with a trailing file path at its stdin form\'s count; no other rule carries max-args', () => {
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  assert.deepEqual(allowlist['work:write'], { project: 0, ticket: 1, variation: 2, 'max-args': 4 });
  for (const [command, max] of Object.entries(CAPPED)) assert.equal(allowlist[command]['max-args'], max, command);
  assert.deepEqual(Object.entries(allowlist).filter(([k, r]) => !Object.hasOwn(CAPPED, k) && r && typeof r === 'object' && Object.hasOwn(r, 'max-args')).map(([k]) => k), []);
});

test('ASS-428: a VM\'s work:append, automated-tests:record, ticket:set-demo-plan or merge-request:create-fix given a file path past its stdin form is refused (max-args); the stdin form, and ticket:add-merge-request\'s "-", still pass', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  const forms = [['work:append', 'harness', 'ASS-74', 'A', 'change-log.md'], ['automated-tests:record', 'harness', 'ASS-74', 'A'], ['ticket:set-demo-plan', 'harness', 'ASS-74', 'A'],
    ['merge-request:create-fix', 'harness', 'ASS-74', 'A', 'https://github.com/o/harness', 'change/ASS-74-fix-1', 'the fix']];
  for (const argv of forms) {
    assert.deepEqual(may(...argv).argv, argv, argv[0]);
    const r = may(...argv, '/mnt/ticket/body.md');
    assert.equal(r.argv, undefined, argv[0]);
    assert.match(r.refuse ?? '', new RegExp(`${argv[0]} takes at most ${argv.length - 1} arguments`), argv[0]);
  }
  assert.match(may('ticket:add-merge-request', 'harness', 'ASS-74', 'A', '/mnt/ticket/mr.json').refuse ?? '', /stdin|"-"/, 'a path in place of "-" is refused');
});

test('ASS-463: a VM\'s assignments:status-update or agent-interaction:send-message given --from <file> is refused (max-args: a Mac path never reaches the host); the text as the argument passes', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (...argv) => authorize(tokens, assignments, 'harness-token', argv);
  assert.ok(may('assignments:status-update', 'Hulk', 'reading the plan').argv);
  assert.match(may('assignments:status-update', 'Hulk', '--from', '/etc/hosts').refuse ?? '', /assignments:status-update takes at most 2 arguments/);
  assert.ok(may('agent-interaction:send-message', 'Hulk', 'Thor', 'hi').argv);
  assert.match(may('agent-interaction:send-message', 'Hulk', 'Thor', '--from', '/etc/hosts').refuse ?? '', /agent-interaction:send-message takes at most 3 arguments/);
});

// ASS-504: a cloud VM's restart watcher knows no ticket: machine:restart-imminent takes no arguments from the VM, and
// the forwarder appends its token's binding and machine, so a VM only ever tells its own ticket variation's agents.
test('ASS-504 AC2: machine:restart-imminent from a VM gets its binding\'s project, ticket, variation and machine appended; any argument of its own is refused', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const may = (token, ...argv) => authorize(tokens, assignments, token, argv);
  assert.deepEqual(may('harness-token', 'machine:restart-imminent'), { vm: 'ass-74-a', binding: tokens['ass-74-a'], argv: ['machine:restart-imminent', 'harness', 'ASS-74', 'A', 'ass-74-a'], logged: true });
  assert.deepEqual(may('example-token', 'machine:restart-imminent').argv, ['machine:restart-imminent', 'example', 'EX-9', 'B', 'ex-9-b']);
  assert.match(may('harness-token', 'machine:restart-imminent', 'example', 'EX-9', 'B').refuse, /^machine:restart-imminent takes at most 0 arguments/);
  assert.equal(may('harness-token', 'ticket:questions-answered', 'harness', 'ASS-74').logged, false, 'only a "logged" rule\'s output is logged');
});

test('ASS-504 AC2: through the forwarder, the VM\'s agent.sh machine:restart-imminent queues the interrupt and restart prompt for its variation\'s agents alone, and control\'s log says which machine and which agents were told', async () => {
  const { f, server, client, lines } = await served();
  try {
    const json = f.assignments();
    json.assignments.push({ ...json.assignments[1], 'agent-name': 'Thor', variation: 'B' });
    writeFileSync(join(f.dir, 'assignments.json'), JSON.stringify(json));
    const told = await client('machine:restart-imminent');
    assert.equal(told.code, 0, told.stderr);
    assert.equal(told.stdout, 'restart imminent on abc-3-a: told Daredevil Spock\n');
    for (const name of ['Daredevil', 'Spock']) assert.deepEqual(f.inbox(name), ['RESTART NOW'], name);
    assert.deepEqual(f.inbox('Thor'), []);
    assert.ok(lines.includes('forwarder RUN abc-3-a ["machine:restart-imminent"]'), lines.join('\n'));
    assert.ok(lines.includes('forwarder abc-3-a: restart imminent on abc-3-a: told Daredevil Spock'), lines.join('\n'));
  } finally { server.close(); }
});

// ASS-509 (review): Automated Testing and CI Checks bring a branch's base in (rebase or merge, then push) only on
// control's own run of the step — a vm step, so it comes through here too — never on an agent's call mid-step.
test('ASS-509: CATCH_UP_BASE only for verify-success and ci-checks:verify called while no agent of the variation is at work; never passed through otherwise', () => {
  const f = fixture(), { tokens, assignments } = bindings(f.dir);
  const b = tokens['ass-74-a'], env = { PATH: '/bin', CATCH_UP_BASE: '1' };
  for (const command of ['automated-tests:verify-success', 'ci-checks:verify']) {
    assert.equal(forwardedEnv(env, [command, 'harness', 'ASS-74', 'A'], b, []).CATCH_UP_BASE, '1', `${command}: control's own run`);
    assert.equal(forwardedEnv(env, [command, 'harness', 'ASS-74', 'A'], b, assignments).CATCH_UP_BASE, undefined, `${command}: an agent at work`);
  }
  assert.equal(forwardedEnv(env, ['work:append', 'harness', 'ASS-74', 'A'], b, []).CATCH_UP_BASE, undefined, 'no other command');
  assert.equal(forwardedEnv({ PATH: '/bin' }, ['ci-checks:verify'], tokens['ex-9-b'], assignments.filter(a => a.project === 'harness')).CATCH_UP_BASE, '1', 'another variation\'s agent is no agent of this one');
  assert.equal(forwardedEnv(env, ['ci-checks:verify'], b, []).PATH, '/bin');
});

// ASS-589: the in-machine client's file form. A stdin-taking command given one argument past its stdin form's count
// (work:write, work:append 4; automated-tests:record, ticket:set-demo-plan 3) takes the last as a local file: its
// bytes go as the base64 stdin field and the path is dropped from argv, so the forwarder still sees the stdin form.
// A stub forwarder: records each posted body, answers exit 0.
async function stubForwarder() {
  const dir = mkdtempSync(join(tmpdir(), 'ass-589-'));
  const cwd = join(dir, 'cwd'); mkdirSync(cwd);
  writeFileSync(join(dir, 'token'), 'stub-token\n');
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); res.end('{"exit":0}\n'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, AGENT_FORWARDER_URL: `http://127.0.0.1:${server.address().port}/`, AGENT_TOKEN_FILE: join(dir, 'token') };
  // input: bytes to pipe (the stdin form), or undefined to leave stdin empty and closed.
  const call = (args, input) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, cwd, encoding: 'buffer', maxBuffer: 1 << 24 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.toString(), stderr: stderr.toString() }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
  const file = (name, content) => { const path = join(dir, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); return path; };
  return { dir, cwd, env, bodies, call, file, close: () => server.close() };
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const REPORT = '# Report\n\nünïcödé, "quotes", $dollars and `ticks`';

test('ASS-589 AC1: work:write and work:append with a trailing local file send argv of 4 and the file\'s bytes as base64 stdin, exit 0, with the token', async () => {
  const s = await stubForwarder();
  try {
    for (const command of ['work:write', 'work:append']) {
      for (const content of [REPORT + '\n', REPORT]) {
        const path = s.file(`${command.replace(':', '-')}.md`, content);
        s.bodies.length = 0;
        const r = await s.call([command, 'p', 'K', 'A', 'r.md', path]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(s.bodies.length, 1, command);
        assert.deepEqual(s.bodies[0].argv, [command, 'p', 'K', 'A', 'r.md'], command);
        assert.equal(s.bodies[0].stdin, b64(content), command);
        assert.equal(s.bodies[0].token, 'stub-token');
      }
    }
  } finally { s.close(); }
});

test('ASS-589 AC1: the file form goes by argument count, not by an argument naming a file: a report name that exists in the cwd is never read', async () => {
  const s = await stubForwarder();
  try {
    writeFileSync(join(s.cwd, 'r.md'), 'decoy\n');
    const path = s.file('real.md', REPORT);
    const r = await s.call(['work:write', 'p', 'K', 'A', 'r.md', path]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.bodies[0].argv, ['work:write', 'p', 'K', 'A', 'r.md']);
    assert.equal(s.bodies[0].stdin, b64(REPORT));
    const piped = await s.call(['work:write', 'p', 'K', 'A', 'r.md'], 'piped bytes\n');
    assert.equal(piped.code, 0, piped.stderr);
    assert.deepEqual(s.bodies[1].argv, ['work:write', 'p', 'K', 'A', 'r.md']);
    assert.equal(s.bodies[1].stdin, b64('piped bytes\n'), 'the stdin form: its 4th argument is never taken as a file');
  } finally { s.close(); }
});

test('ASS-589 AC1: automated-tests:record and ticket:set-demo-plan with a trailing local file send argv of 3 and the file as stdin', async () => {
  const s = await stubForwarder();
  try {
    for (const command of ['automated-tests:record', 'ticket:set-demo-plan']) {
      const content = '[{"list":"a","run":"b $x `y`"}]';
      const path = s.file(`${command.replace(':', '-')}.json`, content);
      s.bodies.length = 0;
      const r = await s.call([command, 'p', 'K', 'A', path]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(s.bodies.length, 1, command);
      assert.deepEqual(s.bodies[0].argv, [command, 'p', 'K', 'A'], command);
      assert.equal(s.bodies[0].stdin, b64(content), command);
    }
  } finally { s.close(); }
});

test('ASS-589 AC1, AC3: through the real forwarder, work:write and work:append with a local file land in the work folder, and the RUN line shows 4 arguments, no path', async () => {
  const { f, server, env, lines } = await served();
  const dir = mkdtempSync(join(tmpdir(), 'ass-589-'));
  const file = (name, content) => { const path = join(dir, name); writeFileSync(path, content); return path; };
  const client = (...args) => new Promise(resolve => {
    const child = execFile(CLIENT, args, { env, cwd: dir }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  try {
    const plan = file('plan.md', REPORT + '\n');
    const wrote = await client('work:write', 'p', 'ABC-3', 'A', 'execution-plan.md', plan);
    assert.equal(wrote.code, 0, wrote.stderr);
    assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), REPORT + '\n');
    for (const [name, text] of [['f1.md', '- one\n'], ['f2.md', '- two']]) {
      const r = await client('work:append', 'p', 'ABC-3', 'A', 'change-log.md', file(name, text));
      assert.equal(r.code, 0, r.stderr);
    }
    assert.equal(readFileSync(join(folder, 'change-log-A.md'), 'utf8'), '- one\n- two');
    assert.ok(lines.includes('forwarder RUN abc-3-a ["work:write","p","ABC-3","A","execution-plan.md"]'), lines.join('\n'));
    assert.ok(!lines.join('\n').includes(dir), 'no local path reaches the Mac');
    const six = await client('work:write', 'p', 'ABC-3', 'A', 'execution-plan.md', plan, 'extra');
    assert.equal(six.code, 77, 'a wrong count is still sent, and refused by the forwarder');
    assert.match(six.stderr, /work:write takes at most 4 arguments/);
  } finally { server.close(); }
});

test('ASS-589 AC1: the file form never reads stdin: an open, idle stdin cannot hold it up', async () => {
  const s = await stubForwarder();
  const path = s.file('r.md', REPORT);
  const child = execFile(CLIENT, ['work:write', 'p', 'K', 'A', 'r.md', path], { env: s.env, cwd: s.cwd });
  child.stdin.on('error', () => {});
  try {
    const code = await within(new Promise(resolve => child.on('exit', resolve)));   // hang guard only
    assert.equal(code, 0);
    assert.deepEqual(s.bodies[0]?.argv, ['work:write', 'p', 'K', 'A', 'r.md']);
    assert.equal(s.bodies[0]?.stdin, b64(REPORT));
  } finally { child.stdin.end(); child.kill(); s.close(); }
});

test('ASS-589 AC1: a file of exactly 1 MB is sent whole; a path with spaces is read', async () => {
  const s = await stubForwarder();
  try {
    const big = s.file('big.md', Buffer.alloc(1 << 20, 'a'));
    const r = await s.call(['work:write', 'p', 'K', 'A', 'r.md', big]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(Buffer.from(s.bodies[0].stdin, 'base64').length, 1 << 20);
    const spaced = s.file('a b/report one.md', REPORT);
    const r2 = await s.call(['work:append', 'p', 'K', 'A', 'r.md', spaced]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(s.bodies[1].argv, ['work:append', 'p', 'K', 'A', 'r.md']);
    assert.equal(s.bodies[1].stdin, b64(REPORT));
  } finally { s.close(); }
});

test('ASS-589 AC2: a missing file exits 1 saying so, and nothing is sent', async () => {
  const s = await stubForwarder();
  try {
    for (const command of ['work:write', 'work:append']) {
      const r = await s.call([command, 'p', 'K', 'A', 'r.md', '/nonexistent/x.md']);
      assert.equal(r.code, 1, command);
      assert.match(r.stderr, new RegExp(`agent\\.sh: ${command}: no readable file /nonexistent/x\\.md: not sent`), command);
    }
    assert.equal(s.bodies.length, 0);
  } finally { s.close(); }
});

test('ASS-589 AC2: a directory, an unreadable file or a file over 1 MB exits 1 and nothing is sent', async () => {
  const s = await stubForwarder();
  try {
    const folder = join(s.dir, 'a-folder'); mkdirSync(folder);
    assert.equal((await s.call(['work:write', 'p', 'K', 'A', 'r.md', folder])).code, 1, 'a directory');
    if (process.getuid?.() !== 0) {
      const locked = s.file('locked.md', 'x'); chmodSync(locked, 0o000);
      assert.equal((await s.call(['work:write', 'p', 'K', 'A', 'r.md', locked])).code, 1, 'mode 000');
    }
    const over = await s.call(['work:write', 'p', 'K', 'A', 'r.md', s.file('over.md', Buffer.alloc((1 << 20) + 1, 'a'))]);
    assert.equal(over.code, 1);
    assert.match(over.stderr, /over 1 MB: not sent/);
    assert.equal(s.bodies.length, 0);
  } finally { s.close(); }
});

test('ASS-589 AC2: the stdin form is unchanged: work:write with 4 arguments and ticket:post-comment with "-" send the piped bytes', async () => {
  const s = await stubForwarder();
  try {
    const r = await s.call(['work:write', 'p', 'K', 'A', 'r.md'], REPORT);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.bodies[0].argv, ['work:write', 'p', 'K', 'A', 'r.md']);
    assert.equal(s.bodies[0].stdin, b64(REPORT));
    const c = await s.call(['ticket:post-comment', 'p', 'K', '-'], 'a comment\n');
    assert.equal(c.code, 0, c.stderr);
    assert.deepEqual(s.bodies[1].argv, ['ticket:post-comment', 'p', 'K', '-']);
    assert.equal(s.bodies[1].stdin, b64('a comment\n'));
  } finally { s.close(); }
});

test('ASS-589 AC2: a wrong count, or a command that takes no stdin, is sent verbatim: no file read', async () => {
  const s = await stubForwarder();
  try {
    const path = s.file('r.md', REPORT);
    const six = await s.call(['work:write', 'p', 'K', 'A', 'r.md', path, 'y'], 'piped\n');
    assert.equal(six.code, 0, six.stderr);
    assert.deepEqual(s.bodies[0].argv, ['work:write', 'p', 'K', 'A', 'r.md', path, 'y']);
    assert.equal(s.bodies[0].stdin, b64('piped\n'));
    const other = await s.call(['ticket:questions-answered', 'p', 'K', path]);
    assert.equal(other.code, 0, other.stderr);
    assert.deepEqual(s.bodies[1].argv, ['ticket:questions-answered', 'p', 'K', path]);
    assert.ok(!Object.hasOwn(s.bodies[1], 'stdin'), 'no stdin field');
  } finally { s.close(); }
});
