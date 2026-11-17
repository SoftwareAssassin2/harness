// ASS-504: machine:restart-imminent — every agent on a ticket variation's
// machine told it is about to go down: an interrupt line with the restart
// prompt queued in its inbox, none for an agent anywhere else; and the prompt,
// engine-independent, in one place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const ROOT = join(import.meta.dirname, '..', '..');
const lines = (f, name, stamp = '20261007T235205Z') => {
  const file = join(f.dir, 'agents', `${name}-${stamp}`, 'inbox.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
};

// The fixture's p ABC-3 A has Daredevil and Spock; Leia is on a self-healing run. Thor is put on ABC-3 B, Yoda on q's
// Q-1 A (another project), and Hulk on ABC-3 A but Killed.
function withOthers() {
  const f = fixture(), file = join(f.dir, 'assignments.json'), json = f.assignments();
  const base = json.assignments[1];
  json.assignments.push({ ...base, 'agent-name': 'Thor', variation: 'B' }, { ...base, 'agent-name': 'Yoda', project: 'q', 'work-item': 'Q-1' }, { ...base, 'agent-name': 'Hulk', status: 'Killed' });
  writeFileSync(file, JSON.stringify(json));
  return f;
}

test('ASS-504 AC2: machine:restart-imminent queues an interrupt line with the restart prompt for every agent on the ticket variation, and nothing for any other', async () => {
  const f = withOthers();
  const { stdout } = await f.agent('machine:restart-imminent', 'p', 'abc-3', 'A', 'cloud-vm:p:ada-vm:/home/ada/harness');
  assert.equal(stdout, 'restart imminent on cloud-vm:p:ada-vm:/home/ada/harness: told Daredevil Spock\n');
  for (const name of ['Daredevil', 'Spock']) assert.deepEqual(lines(f, name), [{ prompt: 'RESTART NOW', interrupt: true }], name);
  for (const name of ['Thor', 'Yoda', 'Hulk']) assert.deepEqual(lines(f, name), [], name);
  assert.deepEqual(lines(f, 'Leia', '20261008T000000Z'), []);
});

test('ASS-504: a variation with no agents is told so, and nothing is queued; the usage is checked', async () => {
  const f = withOthers();
  assert.equal((await f.agent('machine:restart-imminent', 'p', 'ABC-3', 'C')).stdout, 'restart imminent on p ABC-3 C\'s machine: no agents to tell\n');
  const bad = await f.agent('machine:restart-imminent', 'p').catch(e => e);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /usage: machine:restart-imminent <project> <ticket> <variation>/);
});

test('ASS-504: the restart prompt is prompts/restart-imminent/prompt.txt, the scope\'s text, with no engine placeholder', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'restart-imminent', 'prompt.txt'), 'utf8').trim();
  assert.equal(text, 'RESTART IMMINENT — under 30 seconds. Stop what you are doing now. Immediately commit and push your work in progress on this branch, with your change log and notes saying where you got to and what is next. You will be started again on this machine shortly to pick up from there. Do nothing else.');
  assert.doesNotMatch(text, /\{[a-z-]+\}/);
});
