// Blocking and non-blocking questions (ASS-248) at the agent-cli: an answer
// to a non-blocking question that differs from its assumption starts the
// requirements-change flow (AC3); a ticket with an open blocking question
// cannot join the sprint (AC4); a ticket reaching Done closes its open
// non-blocking questions as Assumed (AC5); a one-off migration closes the
// unflagged ones on Done tickets, dry run first (AC6); and
// ticket:questions-answered waits on the blocking ones alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4)); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));
// A question as question:ask writes it, Asked unless `extra` says otherwise; `blocking` left out is an unflagged one from before ASS-248.
const q = (question, extra = {}) => ({ question, 'recomended-answer': 'Visa only.', answer: '', 'why-asked': '', 'why-this-answer': '', scope: '', 'asked-on-ticket': 'ABC-1', 'asked-time-stamp': '2026-10-29T00:00:00Z', 'answered-time-stamp': '', status: 'Asked', 'ai-feedback-if-not-accepted': '', ...extra });

// A projects/ folder whose project p (engine e) has sprint 10 active holding
// ABC-1 — variation A at plan, a step flagged for a re-check on a
// requirements change, B at setup, not flagged — and a backlog holding ABC-2;
// each with a questions file of `questions`.
function folders(questions) {
  const dir = mkdtempSync(join(tmpdir(), 'qb-'));
  write(join(dir, 'p', 'project.json'), { 'execution-state-engine': 'e' });
  write(join(dir, 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  const at = (name, state) => ({ name, 'harness-status': { state, 'state-engine': 'e' }, 'state-changes': [] });
  write(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [{ key: 'ABC-1', title: 'T', description: 'D', variations: [at('A', 'plan'), at('B', 'setup')] }] });
  write(join(dir, 'p', 'backlog.json'), { tickets: [{ key: 'ABC-2', title: 'U', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'r' } }] }] });
  write(join(dir, 'engines', 'e', 'state-engine.json'), { steps: [
    { id: 'setup', name: 'Setup', sequence: 1 },
    { id: 'plan', name: 'Plan', sequence: 2, 'recheck-on-requirements-change': true },
    { id: 'requirements-changed', name: 'Requirements Changed', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-requirements-changed' } },
  ] });
  for (const key of ['ABC-1', 'ABC-2']) write(join(dir, 'p', 'work', key, 'questions-and-answers.json'), { list: questions.map(x => ({ ...x, 'asked-on-ticket': key })) });
  return dir;
}
const agent = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: join(dir, 'engines'), ACLI_DISABLED: '1' } });
const questionsOf = (dir, key = 'ABC-1') => read(join(dir, 'p', 'work', key, 'questions-and-answers.json')).list;
const stateOf = (dir, name) => read(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json')).features[0].variations.find(v => v.name === name)['harness-status'].state;
const history = (dir, key = 'ABC-1') => {
  const file = join(dir, 'p', 'work', key, 'requirements-history.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
};

test('AC3: an answer to a non-blocking question that matches its assumption closes it, Answer Accepted, and changes nothing else', async () => {
  const dir = folders([q('Which cards?', { blocking: false })]);
  await agent(dir, 'question:answer', 'p', 'ABC-1', '0', '  visa  ONLY. ');
  assert.equal(questionsOf(dir)[0].status, 'Answer Accepted');
  assert.deepEqual([stateOf(dir, 'A'), stateOf(dir, 'B'), history(dir)], ['plan', 'setup', []]);
});

test('AC3: an answer to a non-blocking question that differs from its assumption is recorded as a requirements change, and each variation at a re-checked step starts the requirements-changed workflow', async () => {
  const dir = folders([q('Which cards?', { blocking: false })]);
  const { stdout } = await agent(dir, 'question:answer', 'p', 'ABC-1', '0', 'Visa and Mastercard.');
  assert.equal(questionsOf(dir)[0].status, 'Answered');
  const [line] = history(dir);
  assert.deepEqual({ ...line, at: '' }, { at: '', field: 'question', question: 'Which cards?', from: 'Visa only.', to: 'Visa and Mastercard.' });
  assert.equal(stateOf(dir, 'A'), 'requirements-changed');
  assert.equal(stateOf(dir, 'B'), 'setup');                                    // not at a re-checked step
  assert.match(stdout, /differs from the assumption/);
});

test('AC3: a differing answer on a backlog ticket is recorded for its next grooming, no workflow started; a blocking question\'s answer is only Answered', async () => {
  const dir = folders([q('Which cards?', { blocking: false }), q('Which region?', { blocking: true })]);
  await agent(dir, 'question:answer', 'p', 'ABC-2', '0', 'Mastercard.');
  assert.equal(questionsOf(dir, 'ABC-2')[0].status, 'Answered');
  assert.deepEqual(history(dir, 'ABC-2').map(l => [l.field, l.from, l.to]), [['question', 'Visa only.', 'Mastercard.']]);
  await agent(dir, 'question:answer', 'p', 'ABC-1', '1', 'Visa only.');       // the recommended answer, but blocking: the groomer judges it
  assert.equal(questionsOf(dir)[1].status, 'Answered');
  assert.deepEqual([stateOf(dir, 'A'), history(dir)], ['plan', []]);
});

// The harness fixture's project p, its sprint ticket ABC-3 with these questions.
function sprintFixture(questions) {
  const f = fixture();
  write(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'questions-and-answers.json'), { list: questions.map(x => ({ ...x, 'asked-on-ticket': 'ABC-3' })) });
  return { ...f, questions: () => read(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'questions-and-answers.json')).list };
}

test('AC4: ticket:join-sprint refuses a ticket with an open blocking question — or one with no flag — naming them, writing nothing; non-blocking or answered ones do not hold it', async () => {
  for (const open of [{ blocking: true }, {}, { blocking: true, status: 'Answer Rejected' }]) {
    const f = sprintFixture([q('Which cards?', open), q('Refunds?', { blocking: false }), q('Which region?', { blocking: true, status: 'Answered' })]);
    const before = f.snapshot();
    await assert.rejects(f.agent('ticket:join-sprint', 'p', 'ABC-3', 'done'), /ABC-3 has an open blocking question[^]*Which cards\?/);
    assert.equal(f.snapshot(), before, JSON.stringify(open));
  }
  const f = sprintFixture([q('Refunds?', { blocking: false }), q('Which region?', { blocking: true, status: 'Answer Accepted' })]);
  await f.agent('ticket:join-sprint', 'p', 'ABC-3', 'done');
  assert.equal(f.variation('C')['harness-status'].state, 'done');
});

test('AC5: a ticket reaching Done closes its open non-blocking questions as Assumed; blocking, answered and accepted ones are left as they are', async () => {
  const f = sprintFixture([
    q('Refunds?', { blocking: false }), q('Rejected?', { blocking: false, status: 'Answer Rejected' }), q('Answered?', { blocking: false, status: 'Answered', answer: 'x' }),
    q('Which cards?', { blocking: true }), q('Accepted?', { blocking: true, status: 'Answer Accepted' }),
  ]);
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'C', 'local-testing', 'generate-solution');
  assert.deepEqual(f.questions().map(x => x.status), ['Asked', 'Answer Rejected', 'Answered', 'Asked', 'Answer Accepted']);   // not Done yet
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'C', 'generate-solution', 'done');
  assert.deepEqual(f.questions().map(x => x.status), ['Assumed', 'Assumed', 'Answered', 'Asked', 'Answer Accepted']);
});

test('AC5: question:close-assumed closes a ticket\'s open non-blocking questions — with --unflagged its unflagged ones too — and says how many', async () => {
  const f = sprintFixture([q('Refunds?', { blocking: false }), q('Legacy?'), q('Which cards?', { blocking: true })]);
  assert.match((await f.agent('question:close-assumed', 'p', 'ABC-3')).stdout, /ABC-3: 1 question closed as Assumed/);
  assert.deepEqual(f.questions().map(x => x.status), ['Assumed', 'Asked', 'Asked']);
  assert.match((await f.agent('question:close-assumed', 'p', 'ABC-3', '--unflagged')).stdout, /ABC-3: 1 question closed as Assumed/);
  assert.deepEqual(f.questions().map(x => x.status), ['Assumed', 'Assumed', 'Asked']);
  assert.match((await f.agent('question:close-assumed', 'p', 'ABC-9')).stdout, /ABC-9: 0 questions closed as Assumed/);   // no file: none
  await assert.rejects(f.agent('question:close-assumed', '../p', 'ABC-3'), /invalid project/);
});

// The harness fixture with ABC-1 Done in an earlier sprint, ABC-2 in the
// backlog and ABC-3 In Progress in the active one, each with questions.
function migrating() {
  const f = fixture();
  const at = (...rest) => join(f.dir, 'projects', ...rest);
  write(at('p', 'sprints.json'), { list: [{ number: 9, 'is-active': false }, { number: 10, 'is-active': true }] });
  write(at('p', 'sprints', 'sprint-9', 'sprint.json'), { number: 9, features: [{ key: 'ABC-1', 'ticket-system-status': 'Done', variations: [] }] });
  write(at('p', 'backlog.json'), { tickets: [{ key: 'ABC-2', 'ticket-system-status': 'Backlog', variations: [] }] });
  const file = key => at('p', 'work', key, 'questions-and-answers.json');
  write(file('ABC-1'), { list: [q('A?'), q('B?', { status: 'Not Yet Answered' }), q('C?', { status: 'Answer Accepted' }), q('D?', { blocking: true })] });
  write(file('ABC-2'), { list: [q('E?'), q('F?', { status: 'Answered' })] });
  write(file('ABC-3'), { list: [q('G?'), q('H?')] });
  return { ...f, statuses: key => read(file(key)).list.map(x => x.status) };
}

test('AC6: question:migrate-unflagged reports, without writing, the unflagged open questions it would close on Done tickets and those now blocking elsewhere, per project', async () => {
  const f = migrating();
  const before = ['ABC-1', 'ABC-2', 'ABC-3'].map(f.statuses);
  const { stdout } = await f.agent('question:migrate-unflagged');
  const p = stdout.trim().split('\n').map(l => JSON.parse(l)).find(r => r.project === 'p');
  assert.deepEqual(p, { project: 'p', applied: false, 'done-tickets': 1, 'closing-as-assumed': 2, 'open-tickets': 2, 'now-blocking': 3 });
  assert.deepEqual(['ABC-1', 'ABC-2', 'ABC-3'].map(f.statuses), before);
});

test('AC6: question:migrate-unflagged --apply closes them as Assumed through question:close-assumed, and a second run finds none', async () => {
  const f = migrating();
  await f.agent('question:migrate-unflagged', '--apply');
  assert.deepEqual(f.statuses('ABC-1'), ['Assumed', 'Assumed', 'Answer Accepted', 'Asked']);   // the flagged blocking one stays open
  assert.deepEqual(f.statuses('ABC-2'), ['Asked', 'Answered']);
  assert.deepEqual(f.statuses('ABC-3'), ['Asked', 'Asked']);
  const again = (await f.agent('question:migrate-unflagged')).stdout.trim().split('\n').map(l => JSON.parse(l)).find(r => r.project === 'p');
  assert.equal(again['closing-as-assumed'], 0);
});

test('ticket:questions-answered counts the blocking questions not yet accepted — unflagged ones among them — never the non-blocking ones', async () => {
  const f = sprintFixture([q('Refunds?', { blocking: false }), q('Assumed?', { blocking: false, status: 'Assumed' }), q('Accepted?', { blocking: true, status: 'Answer Accepted' })]);
  assert.deepEqual(JSON.parse((await f.agent('ticket:questions-answered', 'p', 'ABC-3')).stdout), { ticket: 'ABC-3', open: 0 });
  const g = sprintFixture([q('Refunds?', { blocking: false }), q('Legacy?'), q('Which cards?', { blocking: true, status: 'Answered' })]);
  await assert.rejects(g.agent('ticket:questions-answered', 'p', 'ABC-3'), e => JSON.parse(e.stdout).open === 2);
});
