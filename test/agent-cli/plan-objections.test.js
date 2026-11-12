// ASS-399: plan:record-objections keeps every review that rejected a plan in
// plan-objections-<variation>.md — plan-review-<variation>.md is rewritten
// by each review — the stronger re-plan's input; plan:ask-about-objections
// records the last one and asks the operator, blocking, how to proceed, the
// open objections listed. And assignments:create --model puts every agent
// of a dispatch on one model, the stronger re-plan's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// Project p with ticket ABC-1's work folder.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-objections-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-1'), { recursive: true });
  return dir;
}
const work = (dir, name) => join(dir, 'p', 'work', 'ABC-1', name);
const agent = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const review = (dir, text) => writeFileSync(work(dir, 'plan-review-A.md'), text);

test('ASS-399 AC1: plan:record-objections adds each rejecting review to plan-objections-<variation>.md, numbered on, the earlier ones kept', async () => {
  const dir = project();
  review(dir, '# Plan review\n- must fix: AC2 is not covered\n');
  assert.equal((await agent(dir, 'plan:record-objections', 'p', 'abc-1', 'A')).stdout.trim(), '1');
  review(dir, '# Plan review\n- must fix: the migration is not reversible\n');
  assert.equal((await agent(dir, 'plan:record-objections', 'p', 'ABC-1', 'A')).stdout.trim(), '2');
  const text = readFileSync(work(dir, 'plan-objections-A.md'), 'utf8');
  assert.match(text, /^## Review 1, rejected \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n\n# Plan review\n- must fix: AC2 is not covered\n\n## Review 2, rejected [^\n]+\n\n# Plan review\n- must fix: the migration is not reversible\n$/);
  assert.equal(existsSync(work(dir, 'plan-objections-B.md')), false, 'the variation\'s own file');
});

test('ASS-399: plan:record-objections records a missing review as such; refuses a bad name or a ticket with no work folder; agents cannot rewrite the file', async () => {
  const dir = project();
  await agent(dir, 'plan:record-objections', 'p', 'ABC-1', 'A');
  assert.match(readFileSync(work(dir, 'plan-objections-A.md'), 'utf8'), /## Review 1, rejected [^\n]+\n\n\(no plan review was written\)\n/);
  await assert.rejects(agent(dir, 'plan:record-objections', 'p', 'ABC-2', 'A'), e => /ABC-2 has no work folder/.test(e.stderr));
  await assert.rejects(agent(dir, 'plan:record-objections', 'p', 'ABC-1', '../x'), e => /invalid variation/.test(e.stderr));
  await assert.rejects(agent(dir, 'plan:record-objections', 'p', 'ABC-1'), e => /usage: plan:record-objections/.test(e.stderr));
  const write = run('bash', ['-c', `printf x | "${AGENT}" work:write p ABC-1 A plan-objections.md`], { env: { ...process.env, PROJECTS_DIR: dir } });
  await assert.rejects(write, e => /plan-objections-A\.md is the harness's own/.test(e.stderr));
});

test('ASS-399 AC3: plan:ask-about-objections records the last review, then asks a blocking question listing its open objections and asking how to proceed', async () => {
  const dir = project();
  for (const fix of ['AC2 is not covered', 'still no rollback', 'the API change breaks clients']) {
    review(dir, `# Plan review\n- must fix: ${fix}\n`);
    await agent(dir, 'plan:record-objections', 'p', 'ABC-1', 'A');
  }
  review(dir, '# Plan review\n- must fix: the cache is never invalidated\n');
  await agent(dir, 'plan:ask-about-objections', 'p', 'abc-1', 'A');
  assert.match(readFileSync(work(dir, 'plan-objections-A.md'), 'utf8'), /## Review 4, rejected [^\n]+\n\n# Plan review\n- must fix: the cache is never invalidated\n$/);
  const [q] = JSON.parse(readFileSync(work(dir, 'questions-and-answers.json'), 'utf8')).list;
  assert.deepEqual([q.status, q.blocking, q['asked-on-ticket']], ['Asked', true, 'ABC-1']);
  assert.match(q.question, /^Variation A's plan was rejected 4 times, the last after a re-plan on a stronger model\. The open objections, from the last review:\n\n# Plan review\n- must fix: the cache is never invalidated\n\nHow should the plan proceed\?$/);
  assert.doesNotMatch(q.question, /AC2 is not covered/, 'the open objections are the last review\'s');
  assert.match(q['why-asked'], /plan-objections-A\.md/);
  assert.match(q['recomended-answer'], /which objections to resolve and how/);
});

test('ASS-399 AC3: a long review is cut in the question, the whole one named', async () => {
  const dir = project();
  review(dir, `# Plan review\n${'x'.repeat(7000)}\n`);
  await agent(dir, 'plan:ask-about-objections', 'p', 'ABC-1', 'A');
  const [q] = JSON.parse(readFileSync(work(dir, 'questions-and-answers.json'), 'utf8')).list;
  assert.ok(q.question.length < 6300, String(q.question.length));
  assert.match(q.question, /… \(cut: the whole review is plan-review-A\.md\)\n\nHow should the plan proceed\?$/);
});

test('ASS-399 AC1: assignments:create --model gives every record that model and leaves the round robin where it was', async () => {
  const f = fixture();
  const before = f.lastModelUsed();
  const records = JSON.parse((await f.agent('assignments:create', '--model', 'claude-opus-5', 'p', 'example-development', 'generate-solution', 'generate-solution', '2', 'false', 'ABC-3', 'A', '-')).stdout);
  assert.deepEqual(records.map(r => r.model), ['claude-opus-5', 'claude-opus-5']);
  assert.equal(f.lastModelUsed(), before);
  await assert.rejects(f.agent('assignments:create', '--model'), e => /usage: assignments:create \[--model <model>\]/.test(e.stderr));
});
