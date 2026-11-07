// agent-interaction:resume-thread — a prompt for a running agent, queued in its
// session's inbox for the supervisor, the only writer to its stdin, to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const DEAD = spawnSync('true').pid;                                     // a process that has ended

// An assignments file and an agents folder holding Spock's session, Spock
// running as `pid`.
function setup(pid = process.pid) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-'));
  const file = join(dir, 'assignments.json');
  writeFileSync(file, JSON.stringify({ assignments: [{ 'agent-name': 'Spock', 'process-id': pid, 'start-time': '2026-10-07T23:52:05Z' }] }));
  mkdirSync(join(dir, 'agents', 'Spock-20261007T235205Z'), { recursive: true });
  return { file, agents: join(dir, 'agents'), inbox: join(dir, 'agents', 'Spock-20261007T235205Z', 'inbox.jsonl') };
}
const resume = ({ file, agents }, ...args) => run(AGENT, ['agent-interaction:resume-thread', ...args], { env: { ...process.env, ASSIGNMENTS_FILE: file, AGENTS_DIR: agents } });
const queued = inbox => readFileSync(inbox, 'utf8').trim().split('\n').map(l => JSON.parse(l).prompt);

test('agent-interaction:resume-thread appends the prompt, whole, to the running agent\'s session inbox', async () => {
  const at = setup();
  await resume(at, 'Spock', 'Look at the latency test.');
  await resume(at, 'Spock', 'Then commit.\nAnd say so.');
  assert.deepEqual(queued(at.inbox), ['Look at the latency test.', 'Then commit.\nAnd say so.']);
});

test('agent-interaction:resume-thread fails, queuing nothing, for an agent without an assignment, one not running, or an empty prompt', async () => {
  for (const [at, args, message] of [
    [setup(), ['Leia', 'hi'], /no assignment for Leia/],
    [setup(DEAD), ['Spock', 'hi'], new RegExp(`Spock is not running \\(process ${DEAD}\\)`)],
    [setup(), ['Spock', '  '], /the prompt is empty/],
    [setup(), ['Spock'], /usage/],
  ]) {
    await assert.rejects(resume(at, ...args), e => message.test(e.stderr));
    assert.ok(!existsSync(at.inbox));
  }
});
