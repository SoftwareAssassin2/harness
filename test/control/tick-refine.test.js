// Backlog refinement (ASS-18, ASS-144): a backlog ticket sits at a step of its
// project's refinement engine — the one its execution engine's
// backlog-refinement-steps names — and control moves it through that engine
// itself, as it moves sprint tickets, with no run: an agent on its prompt
// steps (at the first step only once it is due: changed, answered, decided on
// or 48 hours after its last refinement), its script steps run, its human
// steps and done step left by their exits. Agents on backlog tickets are
// capped by max-tickets-in-grooming. A change while it was mid-run sends it
// back to the first step once it rests. A ticket at the done step joins the
// sprint when the engine says (ASS-44).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { run } from '../agent-cli/harness-fixture.js';
import { createContext, tick } from '../../src/control/tick.js';
import { LOADED_MS, until } from '../support/until.js';
import { engineDir } from '../support/engine-walk.js';

const FAKE = join(import.meta.dirname, '..', 'support', 'fake-agent.js');
const ROOT = join(import.meta.dirname, '..', '..');
const OFF_BOARD = join(ROOT, 'off-board.sh');
const EXAMPLE = 'example-backlog-refinement', HARNESS = 'harness-backlog-refinement';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
// A backlog ticket whose one variation is at `state` of the refinement engine `engine`.
const at = (key, state = 'groom', extra = {}, engine = EXAMPLE) => ({ key, title: key, 'manual-backlog-priority': null, priority: Number(key.split('-')[1]), variations: [{ name: 'A', 'harness-status': { state, 'state-engine': engine }, 'state-changes': [] }], ...extra });

// The control fixture whose execution engine refines its backlog with the
// real refinement engine `engine` (its groom and estimate prompts tiny ones),
// and a backlog. `settings` is merged into the execution engine, `harness`
// into harness.json. Plus backlog(), stateOf(key) and refiners(), the backlog
// tickets with an agent on them.
function refining(tickets, { harness = {}, settings = {}, engine = EXAMPLE } = {}) {
  const f = controlFixture();
  mkdirSync(join(f.dir, 'engines', engine), { recursive: true });
  writeFileSync(join(f.dir, 'engines', engine, 'state-engine.json'), readFileSync(join(engineDir(engine), 'state-engine.json')));
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['backlog-refinement-steps'] = [{ id: 'backlog-refinement', sequence: 1, action: { type: 'state-engine', engine }, 'exit-events': [{ condition: { 'is-done': true } }] }];
    Object.assign(e, settings);
  });
  for (const prompt of ['groom', 'estimate', 'find-dependencies', 'estimate-with-split', 'split-ticket']) {
    mkdirSync(join(f.dir, 'prompts', prompt), { recursive: true });
    writeFileSync(join(f.dir, 'prompts', prompt, 'prompt.txt'), `${prompt} {ticket}\n`);
  }
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, harness));
  const file = join(f.dir, 'projects', 'p', 'backlog.json');
  writeFileSync(file, JSON.stringify({ tickets }));
  const backlog = () => JSON.parse(readFileSync(file, 'utf8')).tickets;
  const stateOf = (key = 'ABC-50') => backlog().find(t => t.key === key).variations[0]['harness-status'].state;
  const refiners = () => f.assignments().assignments.filter(a => backlog().some(t => t.key === a['work-item']) && !a['transient-state-engine']).map(a => a['work-item']).toSorted();
  return { ...f, file, backlog, stateOf, refiners };
}

// The times control stamped the ticket refined (ticket:refined, ASS-208) — once per groom turn completed — and where it first did among the log's lines.
const stamped = key => l => l.startsWith(`cli agent.sh ticket:refined p ${key} `);
const stamps = (f, key = 'ABC-50') => f.lines.filter(stamped(key)).length;
const stampAt = (f, key = 'ABC-50') => f.lines.findIndex(stamped(key));
const turnEndedAt = f => f.lines.findIndex(l => /^cli agent\.sh assignments:remove /.test(l));
const questionsFile = (f, key = 'ABC-50') => join(f.dir, 'projects', 'p', 'work', key, 'questions-and-answers.json');
const writeQuestions = (f, list, key = 'ABC-50') => { mkdirSync(join(questionsFile(f, key), '..'), { recursive: true }); writeFileSync(questionsFile(f, key), JSON.stringify({ list })); };
// Holding every fake agent's turn open (FAKE_HOLD) while fn runs.
async function holding(f, fn) {
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try { return await fn(); } finally { delete process.env.FAKE_HOLD; f.ctx.stopAgents(); }
}
// Ticks until the backlog ticket rests (no agent on it, nothing moving), its turns answered with `output`, for up to LOADED_MS of real time, not a tick count (ASS-211); the states it passed through.
async function settle(f, output, key = 'ABC-50') {
  const seen = [f.stateOf(key)];
  process.env.FAKE_OUTPUT = JSON.stringify(output);
  const began = Date.now();
  try {
    for (let i = 0; Date.now() - began < LOADED_MS; i++) {
      await tick(f.ctx);
      if (seen.at(-1) !== f.stateOf(key)) seen.push(f.stateOf(key));
      await until(() => [...f.ctx.agents.values()].every(a => a.result));
      if (i > 1 && ![...f.ctx.agents.values()].some(a => a.record['work-item'] === key) && !f.refiners().length && seen.at(-1) === f.stateOf(key)) return seen;
    }
    throw new Error(`settle(): ${key} didn't rest within ${LOADED_MS}ms, seen ${JSON.stringify(seen)}`);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
}

// The groom's turn, held open, asking `questions` (as question:ask writes them)
// before it ends; then settle with `output`. A question asked before the groom
// was dispatched would hold it (ASS-248), so they are asked during its turn.
async function asking(f, questions, output) {
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  process.env.FAKE_OUTPUT = JSON.stringify(output);
  try {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    writeQuestions(f, questions);
    rmSync(process.env.FAKE_HOLD);
  } finally {
    delete process.env.FAKE_HOLD;
  }
  await until(() => [...f.ctx.agents.values()].every(a => a.result));
  return settle(f, output);
}

test('tick: a backlog ticket at its engine\'s first step gets an agent on it — no run — at that step of its refinement engine, not stamped refined by the dispatch itself; once refined, not groomed again until it changes or 48 hours pass (ASS-144 AC1, AC3; ASS-208 AC1)', async () => {
  const f = refining([at('ABC-50'), at('ABC-51', 'ready')], { harness: { 'max-tickets-in-grooming': 5 } });
  let now = Date.parse('2026-10-13T12:00:00Z');
  f.ctx.now = () => new Date(now);
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    const [record] = f.assignments().assignments.filter(a => a['work-item'] === 'ABC-50');
    assert.deepEqual([record['state-engine'], record.state, record.prompt, record.variation], [EXAMPLE, 'groom', 'groom', 'A']);
    assert.deepEqual(f.assignments()['transient-state-engines'], []);
    assert.ok(!f.backlog()[0]['last-refined'], 'not stamped by the dispatch, its turn still open (ASS-208)');
    // Its agent gone, its groom refined it (ticket:refined stamps the real clock), nothing changed: none again.
    edit(f.file, b => { b.tickets[0]['last-refined'] = '2026-10-13T12:00:00Z'; });
    edit(join(f.dir, 'assignments.json'), a => { a.assignments = []; });
    f.ctx.stopAgents();
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), []);
    edit(f.file, b => { b.tickets[0]['changed-at'] = '2099-01-01T00:00:00Z'; });
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});

test('ASS-215 AC3: a backlog ticket\'s groom agent, a claude host agent, is not dispatched while claude is rate limited — an anthropic limit leaves it be', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  const limit = kind => writeFileSync(join(f.dir, 'projects', 'p', 'rate-limit.json'), JSON.stringify({ [kind]: { since: '2026-10-13T11:00:00Z', type: 'five_hour', 'resets-at': '2099-01-01T00:00:00Z' } }));
  await holding(f, async () => {
    limit('claude');
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), [], f.lines.join('\n'));
    limit('anthropic');
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50'], f.lines.join('\n'));
  });
});

test('ASS-208 AC1: last-refined is stamped as the groom turn completes — nothing while its agent holds the turn open', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  const hold = join(f.dir, 'hold');
  process.env.FAKE_HOLD = hold;
  writeFileSync(hold, '');
  process.env.FAKE_OUTPUT = JSON.stringify({ 'is-ready': false, summary: 's' });
  try {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    assert.equal(stamps(f), 0, 'nothing stamped by the dispatch alone');
    assert.ok(!f.backlog()[0]['last-refined'], 'not refined yet');
    writeQuestions(f, [{ question: 'B?', status: 'Asked', blocking: true }]);                     // the groom asks (ASS-248: asked before, it would hold the groom)
    rmSync(hold);                                                                                  // the turn ends
    await until(() => [...f.ctx.agents.values()].every(a => a.result));
    await tick(f.ctx);
    assert.deepEqual([f.stateOf(), stamps(f)], ['awaiting-answers', 1], f.lines.join('\n'));
    assert.match(f.backlog()[0]['last-refined'] ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  } finally {
    delete process.env.FAKE_HOLD; delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('ASS-208 AC1: only the first step stamps — a later step of the refinement engine completing its turn does not', async () => {
  const f = refining([at('ABC-50', 'groom', {}, HARNESS)], { engine: HARNESS, harness: { 'max-tickets-in-grooming': 5 } });
  assert.deepEqual(await settle(f, { 'is-ready': true, points: 2, summary: 's' }), ['groom', 'find-dependencies', 'estimate', 'ready']);
  assert.equal(stamps(f), 1, f.lines.join('\n'));                                                 // groom's turn, not find-dependencies' or estimate's
  assert.ok(stampAt(f) > turnEndedAt(f), 'stamped by the groom turn that completed, not by its dispatch');
});

test('ASS-208 AC1: a groom agent that dies mid-turn leaves the ticket unstamped and due — groomed again once the failure\'s hold is over, not 48 hours on', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  let now = Date.parse('2026-10-13T12:00:00Z');
  f.ctx.now = () => new Date(now);
  process.env.FAKE_EXIT = '1';                                                                     // its process dies on its first message, no result
  try {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => /exited without ending its turn/.test(l)), f.lines.join('\n'));
    assert.deepEqual([f.refiners(), f.stateOf()], [[], 'groom']);
    assert.equal(stamps(f), 0, f.lines.join('\n'));
    assert.ok(!f.backlog()[0]['last-refined'], 'never refined');
    now += 31e3;                                                                                   // the failure's hold over (backoff.js)
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50'], 'due at once, not in 48 hours');
  } finally {
    delete process.env.FAKE_EXIT;
    f.ctx.stopAgents();
  }
});

test('ASS-208 AC1: a groom agent removed as stale leaves the ticket unstamped and due — groomed again at once (ASS-187, ASS-188, ASS-189)', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    edit(join(f.dir, 'assignments.json'), a => { a.assignments = []; });                           // as startup removes a stale assignment (main.js)
    f.ctx.stopAgents();
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50'], 'due at once, not in 48 hours');
    assert.ok(!f.backlog()[0]['last-refined'], 'never refined');
  });
});

// ASS-213: a groom started at 12:00, its question answered at `answered`, its turn ending at 12:05 — the agents on the ticket after it rests.
async function answeredAround(answered) {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  let now = Date.parse('2026-10-13T12:00:00Z');
  f.ctx.now = () => new Date(now);
  // Answered before the groom, or asked during it (ASS-248: asked before, an open question would hold the groom) and answered below.
  if (answered < now) writeQuestions(f, [{ question: 'B?', status: 'Answered', 'answered-time-stamp': new Date(answered).toISOString() }]);
  const hold = join(f.dir, 'hold');
  process.env.FAKE_HOLD = hold;
  writeFileSync(hold, '');
  process.env.FAKE_OUTPUT = JSON.stringify({ 'is-ready': false, summary: 's' });
  try {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    if (answered >= now) writeQuestions(f, [{ question: 'B?', status: 'Answered', 'answered-time-stamp': new Date(answered).toISOString() }]);
    now = Date.parse('2026-10-13T12:05:00Z');
    rmSync(hold);                                                                                  // the turn ends
    await until(() => [...f.ctx.agents.values()].every(a => a.result));
    writeFileSync(hold, '');
    for (let i = 0; i < 4; i++) await tick(f.ctx);                                                 // every turn held open again: nothing to wait for, each tick dispatches within itself (ASS-211)
    assert.equal(f.backlog()[0]['last-refined'], '2026-10-13T12:00:00Z', 'stamped with when the groom started');
    return f.refiners();
  } finally {
    delete process.env.FAKE_HOLD; delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
}

test('ASS-213 AC1: an answer given while a groom runs makes the ticket due again once that groom completes', async () => {
  assert.deepEqual(await answeredAround(Date.parse('2026-10-13T12:02:00Z')), ['ABC-50']);
});

test('ASS-213 AC1: an answer given before the groom started does not make it due again', async () => {
  assert.deepEqual(await answeredAround(Date.parse('2026-10-13T11:58:00Z')), []);
});

test('ASS-208 AC2: a ticket whose agent is still on it is not dispatched a second time, though its turn has stamped nothing', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
    assert.equal(f.assignments().assignments.filter(a => a['work-item'] === 'ABC-50').length, 1, 'one agent on it');
    assert.equal(stamps(f), 0, f.lines.join('\n'));
  });
});

test('tick: 48 hours after its last refinement a ticket at the first step is groomed again, changed or not', async () => {
  const f = refining([at('ABC-50', 'groom', { 'last-refined': '2026-10-11T11:00:00Z' })], { harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});

test('tick: a ticket at the first step is groomed again once the operator answers or decides after its last refinement — not for a pass\'s own accepting, rejecting or asking', async () => {
  const f = refining([at('ABC-50', 'groom', { 'last-refined': '2026-10-13T11:00:00Z' })], { harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    writeQuestions(f, [
      { question: 'A?', status: 'Answer Accepted', 'answered-time-stamp': '2026-10-13T10:00:00Z' },
      { question: 'B?', status: 'Answer Rejected', blocking: false, 'answered-time-stamp': '2026-10-13T10:00:00Z' },
      { question: 'C?', status: 'Asked', blocking: false, 'asked-time-stamp': '2026-10-13T11:05:00Z', 'answered-time-stamp': '' },   // B and C non-blocking: open, they hold no groom (ASS-248)
    ]);
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), []);
    edit(f.file, b => { b.tickets[0].variations[0]['human-review'] = { state: 'awaiting-approval', decision: 'Reject', timestamp: '2026-10-13T11:30:00Z' }; });
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});

test('tick: a groom that asks questions sends the ticket to Awaiting Answers, where it rests — no agent, not even 48 hours on — until no question is Asked or Answer Rejected; then it is groomed again', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  let now = Date.parse('2026-10-13T12:00:00Z');
  f.ctx.now = () => new Date(now);
  assert.deepEqual(await asking(f, [{ question: 'B?', status: 'Asked', blocking: true }], { 'is-ready': false, summary: 's' }), ['groom', 'awaiting-answers']);
  edit(f.file, b => { b.tickets[0]['last-refined'] = '2026-10-13T12:00:00Z'; });           // ticket:refined stamps the real clock
  now += 50 * 3600e3;
  await tick(f.ctx);
  assert.deepEqual([f.stateOf(), f.refiners()], ['awaiting-answers', []]);
  writeQuestions(f, [{ question: 'B?', status: 'Answered', 'answered-time-stamp': new Date(now).toISOString() }]);
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual([f.stateOf(), f.refiners()], ['groom', ['ABC-50']]);
    assert.deepEqual(f.backlog()[0].variations[0]['state-changes'].map(c => c['to-state']), ['awaiting-answers', 'groom']);
  });
});

test('tick: the harness\'s engine takes a ticket groomed ready, its questions accepted, through Check the Answers, Find Dependencies and Estimate to Ready — never Awaiting Approval (ASS-51, ASS-196)', async () => {
  for (const questions of [[], [{ question: 'A?', status: 'Answer Accepted', 'answered-time-stamp': '2026-10-13T10:00:00Z' }]]) {
    const f = refining([at('ABC-50', 'groom', {}, HARNESS)], { engine: HARNESS, harness: { 'max-tickets-in-grooming': 5 } });
    writeQuestions(f, questions);
    assert.deepEqual(await settle(f, { 'is-ready': true, points: 2, summary: 's' }), ['groom', 'find-dependencies', 'estimate', 'ready'], JSON.stringify(questions));
    assert.deepEqual(f.backlog()[0].variations[0]['state-changes'].map(c => c['to-state']), ['check-answers', 'find-dependencies', 'estimate', 'ready']);
  }
});

test('tick: a ticket groomed ready with a question not accepted is not made ready: Asked or Answer Rejected rests at Awaiting Answers; Answered (not yet judged) goes back to the first step and rests there', async () => {
  for (const [status, rests] of [['Asked', 'awaiting-answers'], ['Answer Rejected', 'awaiting-answers'], ['Answered', 'groom']]) {
    const f = refining([at('ABC-50', 'groom', {}, HARNESS)], { engine: HARNESS, harness: { 'max-tickets-in-grooming': 5 } });
    await asking(f, [{ question: 'A?', status, 'answered-time-stamp': '2026-01-01T00:00:00Z' }], { 'is-ready': true, points: 2, summary: 's' });
    assert.equal(f.stateOf(), rests, status);
    assert.deepEqual(f.refiners(), [], status);
  }
});

test('tick: example\'s check-points: a ticket with points goes from Check the Answers straight to Awaiting Approval; one without is estimated first (ASS-144 Q2)', async () => {
  for (const [points, path] of [[3, ['groom', 'awaiting-approval']], [null, ['groom', 'estimate', 'awaiting-approval']]]) {
    const f = refining([at('ABC-50', 'groom', { points })], { harness: { 'max-tickets-in-grooming': 5 } });
    assert.deepEqual(await settle(f, { 'is-ready': true, points: 2, summary: 's' }), path, String(points));
    const changes = f.backlog()[0].variations[0]['state-changes'].map(c => c['to-state']);
    assert.deepEqual(changes, points ? ['check-answers', 'check-points', 'awaiting-approval'] : ['check-answers', 'check-points', 'estimate', 'awaiting-approval']);
  }
});

test('tick: at Awaiting Approval the ticket rests for the operator; a choice recorded there (ticket:human-review) moves it by the step\'s exits — Accept to Ready, Reject to the first step, groomed again at once', async () => {
  for (const [decision, to] of [['Accept', 'ready'], ['Reject', 'groom']]) {
    const f = refining([at('ABC-50', 'awaiting-approval', { 'last-refined': '2026-10-13T11:00:00Z' })], { harness: { 'max-tickets-in-grooming': 5 } });
    f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
    await holding(f, async () => {
      await tick(f.ctx);
      assert.equal(f.stateOf(), 'awaiting-approval');
      await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-approval', decision, '');   // recorded only: control moves it
      await tick(f.ctx);
      assert.equal(f.stateOf(), to, decision);
      assert.deepEqual(f.refiners(), to === 'groom' ? ['ABC-50'] : [], decision);
    });
  }
});

// ASS-252: the harness's refinement splits a ticket too large.
test('ASS-252 AC1, AC2: tick: the harness\'s engine takes a ticket estimated too large past Check Kept Whole (not kept whole) to Split, whose agent\'s turn leaves it resting at Awaiting Split Decision for the operator', async () => {
  const f = refining([at('ABC-50', 'groom', {}, HARNESS)], { engine: HARNESS, harness: { 'max-tickets-in-grooming': 5 } });
  await settle(f, { 'is-ready': true, points: 5, 'too-large': true, summary: 's' });
  assert.deepEqual(f.backlog()[0].variations[0]['state-changes'].map(c => c['to-state']), ['check-answers', 'find-dependencies', 'estimate', 'check-kept-whole', 'split', 'awaiting-split-decision'], f.lines.join('\n'));
  assert.deepEqual(f.refiners(), []);
});

test('ASS-252 AC3: tick: Reject recorded at Awaiting Split Decision sends the ticket back to Split, its agent on it again', async () => {
  const f = refining([at('ABC-50', 'awaiting-split-decision', { 'last-refined': '2026-10-13T11:00:00Z' }, HARNESS)], { engine: HARNESS, harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    await tick(f.ctx);
    assert.equal(f.stateOf(), 'awaiting-split-decision');
    await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'awaiting-split-decision', 'Reject', '', 'too fine');   // recorded only: control moves it
    await tick(f.ctx);
    assert.equal(f.stateOf(), 'split');
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});

// ASS-265: the family's Too Large rests until the operator chooses; Split there puts Split's agent on the ticket.
test('ASS-265 AC2, AC4: tick: a family ticket at Too Large rests, no agent on it, until the operator\'s Split sends it to Split, its agent on it', async () => {
  const FAMILY = 'family-backlog-refinement';
  const f = refining([at('ABC-50', 'too-large', { 'last-refined': '2026-10-13T11:00:00Z' }, FAMILY)], { engine: FAMILY, harness: { 'max-tickets-in-grooming': 5 } });
  f.ctx.now = () => new Date('2026-10-13T12:00:00Z');
  await holding(f, async () => {
    await tick(f.ctx);
    assert.equal(f.stateOf(), 'too-large');
    assert.deepEqual(f.refiners(), []);
    await f.agent('ticket:human-review', 'p', 'ABC-50', 'A', 'too-large', 'Split', '');   // recorded only: control moves it
    await tick(f.ctx);
    assert.equal(f.stateOf(), 'split');
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});

test('tick: a ticket at Ready or Awaiting Approval that gets a question not accepted goes back to the first step', async () => {
  for (const state of ['ready', 'awaiting-approval']) {
    const f = refining([at('ABC-50', state, { 'last-refined': '2026-10-13T11:00:00Z' })], { harness: { 'max-tickets-in-grooming': 5 } });
    writeQuestions(f, [{ question: 'Which?', status: 'Asked' }]);
    await holding(f, () => tick(f.ctx));
    assert.equal(f.stateOf(), 'groom', state);
  }
});

test('tick: a ticket changed while mid-run is left to finish; once it rests it goes back to the first step and is groomed again (ASS-144 Q7)', async () => {
  const f = refining([at('ABC-50', 'estimate', { 'last-refined': '2026-10-13T11:00:00Z', 'changed-at': '2026-10-13T11:30:00Z' })], { harness: { 'max-tickets-in-grooming': 5 } });
  process.env.FAKE_OUTPUT = JSON.stringify({ points: 2, summary: 's' });
  try {
    await tick(f.ctx);
    assert.deepEqual([f.stateOf(), f.refiners()], ['estimate', ['ABC-50']]);                   // mid-run: left alone, estimated
    await until(() => [...f.ctx.agents.values()].every(a => a.result));
    await tick(f.ctx);
    assert.equal(f.stateOf(), 'groom', f.lines.join('\n'));
    assert.deepEqual(f.backlog()[0].variations[0]['state-changes'].map(c => c['to-state']), ['awaiting-approval', 'groom']);
    assert.ok(f.lines.some(l => l.startsWith('refine ABC-50 A awaiting-approval → groom (changed since it was last refined)')), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a backlog ticket not yet moved into its engine (an old refinement status, no engine) is left as it is, said nothing', async () => {
  const f = refining([{ ...at('ABC-50'), variations: [{ name: 'A', 'harness-status': { state: 'grooming', 'state-engine': null } }] }], { harness: { 'max-tickets-in-grooming': 5 } });
  await holding(f, () => tick(f.ctx));
  assert.deepEqual([f.stateOf(), f.refiners()], ['grooming', []]);
  assert.ok(!f.lines.some(l => /^error/.test(l)), f.lines.join('\n'));
});

test('ASS-126 AC5: backlog grooming dispatches nothing and moves nothing while its project is paused — a pause on it or on all; released, it does', async () => {
  for (const scope of ['p', 'all']) {
    const f = refining([at('ABC-50'), at('ABC-51', 'ready')], { harness: { 'max-tickets-in-grooming': 5 } });
    writeQuestions(f, [{ question: 'Which?', status: 'Answered', 'answered-time-stamp': '2026-10-13T10:00:00Z' }], 'ABC-51');   // not accepted; not open, so it holds no groom (ASS-248)
    await holding(f, async () => {
      await f.agent('assignments:pause', scope, 'human');
      await tick(f.ctx);
      assert.deepEqual([f.refiners(), f.stateOf('ABC-51')], [[], 'ready'], scope);
      await f.agent('assignments:start', scope, 'human');
      await tick(f.ctx);
      assert.deepEqual([f.refiners(), f.stateOf('ABC-51')], [['ABC-50', 'ABC-51'], 'groom'], scope);
    });
  }
});

test('ASS-83 AC5: a fast-tracked ticket left in the backlog by a failed join is never groomed — complete at creation, it waits there for the next join', async () => {
  const f = refining([at('ABC-50', 'groom', { 'fast-track': true }), at('ABC-51')], { harness: { 'max-tickets-in-grooming': 5 } });
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-51']);
  });
});

// max-tickets-in-grooming (ASS-87, ASS-129): the backlog tickets with an agent on them.
async function groomedWith(harness, own) {
  const f = refining([at('ABC-52'), at('ABC-50'), at('ABC-51')], { harness });
  if (own !== undefined) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-tickets-in-grooming'] = own; });
  return holding(f, async () => { await tick(f.ctx); await tick(f.ctx); return f.refiners(); });
}

test('agents on backlog tickets are capped by harness.json\'s max-tickets-in-grooming, in refinement order', async () => {
  assert.deepEqual(await groomedWith({ 'max-tickets-in-grooming': 2 }), ['ABC-50', 'ABC-51']);   // rankBacklog: by number with no other rank
});

test('ASS-87: a project\'s own max-tickets-in-grooming caps it below a higher harness-wide cap (0: none); harness.json\'s caps a project whose own is higher', async () => {
  assert.deepEqual(await groomedWith({ 'max-tickets-in-grooming': 5 }, 1), ['ABC-50']);
  assert.deepEqual(await groomedWith({ 'max-tickets-in-grooming': 5 }, 0), []);
  assert.deepEqual(await groomedWith({ 'max-tickets-in-grooming': 1 }, 3), ['ABC-50']);
});

test('max-tickets-in-grooming counts every project\'s groomed tickets together — two projects\' controls start no more than it between them', async () => {
  const f = refining([at('ABC-50'), at('ABC-51')], { harness: { 'max-tickets-in-grooming': 2 } });
  const dir = (...rest) => join(f.dir, 'projects', 'x', ...rest);
  mkdirSync(dir('sprints', 'sprint-1'), { recursive: true });
  writeFileSync(dir('project.json'), JSON.stringify({ name: 'X', 'execution-state-engine': 'example-development', 'work-sources': [], 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: join(f.dir, 'workspace'), 'active-branch': null }] }));
  writeFileSync(dir('sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(dir('sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [], bugs: [], spikes: [] }));
  writeFileSync(dir('backlog.json'), JSON.stringify({ tickets: [at('X-1'), at('X-2')] }));
  const control = project => createContext({ root: ROOT, env: f.env, command: ['node', FAKE], project, log: () => {} });
  const p = control('p'), x = control('x');
  try {
    await holding(f, async () => {
      await tick(p);
      await tick(x);
      assert.equal(f.assignments().assignments.filter(a => /^(ABC-5|X-)/.test(a['work-item'] ?? '')).length, 2);
    });
  } finally {
    p.stopAgents();
    x.stopAgents();
  }
});

test('ASS-129: a ticket being groomed when the limit is lowered keeps its agent, and holds its slot against a higher-ranked ticket', async () => {
  const f = refining([at('ABC-51')], { harness: { 'max-tickets-in-grooming': 5 } });
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-51']);
    edit(f.file, b => { b.tickets.push(at('ABC-50')); });
    edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-tickets-in-grooming'] = 1; });
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-51'], 'still groomed, and the only one');
    assert.ok([...f.ctx.agents.values()].some(a => !a.result), 'its agent not stopped');
  });
});

// refining() with project p also given an off-board work source (folder p, key
// prefix HD) and one off-board ticket per title — HD-1, HD-2 … at Backlog —
// so a ready one can really be joined to the sprint. Plus offBoardFile(key)
// and sprintTicket(key), the ticket in the active sprint, undefined until it joins.
async function offBoardRefining(tickets, { settings = {}, titles = ['Join the sprint'] } = {}) {
  const f = refining(tickets, { settings, harness: { 'max-tickets-in-grooming': 0 } });
  f.env.OFF_BOARD_DIR = join(f.dir, 'off-board');                                               // ctx holds the same env object
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => p['work-sources'].push({ name: 'Harness', type: 'off-board', folder: 'p', 'key-prefix': 'HD' }));
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps.find(s => s.id === 'committed')['paired-ticket-system-status'] = 'Committed'; });
  for (const title of titles) await run(OFF_BOARD, ['ticket:create', 'p', 'Story', title], { env: f.env });
  return {
    ...f,
    offBoardFile: key => readFileSync(join(f.dir, 'off-board', 'p', `${key}.md`), 'utf8'),
    sprintTicket: key => f.sprint().features.find(t => t.key === key),
  };
}
const JOIN = { 'ready-tickets-join-sprint-at': 'committed' };

test('ASS-44: a ticket at its refinement engine\'s done step joins the active sprint at the step the execution engine names, status its paired one — once; it then leaves the backlog', async () => {
  const f = await offBoardRefining([at('HD-1', 'ready')], { settings: JOIN });
  writeQuestions(f, [{ question: 'Ready?', status: 'Answer Accepted', 'answered-time-stamp': '2026-10-13T10:00:00Z' }], 'HD-1');
  try {
    await tick(f.ctx);
    const t = f.sprintTicket('HD-1');
    assert.equal(t.variations[0]['harness-status'].state, 'committed');
    assert.equal(t['ticket-system-status'], 'Committed');
    assert.match(f.offBoardFile('HD-1'), /^status: Committed$/m);
    await tick(f.ctx);
    assert.equal(f.lines.filter(l => l === 'refine p: HD-1 is ready; joined the sprint at committed').length, 1, f.lines.join('\n'));
    assert.equal(f.ctx.load().projects[0].backlog.some(x => x.key === 'HD-1'), false);
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-44: a ticket at a human step does not join, every question accepted or not; one at the done step with a question not accepted goes back first; without the setting a done ticket stays', async () => {
  const f = await offBoardRefining([at('HD-1', 'ready'), at('HD-2', 'awaiting-approval')], { settings: JOIN, titles: ['One', 'Two'] });
  writeQuestions(f, [{ question: 'Which?', status: 'Asked' }], 'HD-1');
  try {
    await tick(f.ctx);
    assert.deepEqual([f.sprintTicket('HD-1'), f.sprintTicket('HD-2')], [undefined, undefined]);
    assert.deepEqual([f.stateOf('HD-1'), f.stateOf('HD-2')], ['groom', 'awaiting-approval']);
    assert.ok(!f.lines.some(l => /joined the sprint/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
  const g = await offBoardRefining([at('HD-1', 'ready')]);
  try {
    await tick(g.ctx);
    assert.deepEqual([g.sprintTicket('HD-1'), g.stateOf('HD-1')], [undefined, 'ready']);
    assert.ok(!g.lines.some(l => /^error refine/.test(l)), g.lines.join('\n'));
  } finally {
    g.ctx.stopAgents();
  }
});

test('ASS-44: a Jira ticket at the done step fails to join, or any without an active sprint, every tick — logged through ctx.attempt, the ticket left as it is', async () => {
  const f = await offBoardRefining([at('ABC-77', 'ready')], { settings: JOIN });
  try {
    await tick(f.ctx);
    assert.equal(f.sprintTicket('ABC-77'), undefined);
    assert.equal(f.stateOf('ABC-77'), 'ready');
    assert.ok(f.lines.some(l => /^error refine p ABC-77:/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
  const g = await offBoardRefining([at('HD-1', 'ready')], { settings: JOIN });
  edit(join(g.dir, 'projects', 'p', 'sprints.json'), s => { s.list[0]['is-active'] = false; });
  try {
    await tick(g.ctx);
    const after1 = g.lines.filter(l => /^error refine p HD-1:/.test(l)).length;
    await tick(g.ctx);
    assert.ok(after1 >= 1 && g.lines.filter(l => /^error refine p HD-1:/.test(l)).length > after1, g.lines.join('\n'));
    assert.equal(g.stateOf('HD-1'), 'ready');
  } finally {
    g.ctx.stopAgents();
  }
});

// ASS-202 AC3: control never dispatches a grooming agent on a Done backlog
// ticket — through AC1's predicate, state.js's project.backlog is empty for a
// Done ticket, so dispatch.js (which walks that list) sees nothing. A ticket
// whose status is Backlog is still dispatched: the gate is only Done, not a
// wholesale skip.
test('ASS-202 AC3: tick dispatches no agent on a Done backlog ticket; the same ticket at Backlog is dispatched', async () => {
  const done = refining([at('ABC-50', 'groom', { 'ticket-system-status': 'Done' })], { harness: { 'max-tickets-in-grooming': 5 } });
  await holding(done, async () => {
    await tick(done.ctx);
    assert.deepEqual(done.refiners(), []);
    assert.deepEqual(done.ctx.load().projects[0].backlog.map(t => t.key), []);
  });
  const open = refining([at('ABC-50', 'groom', { 'ticket-system-status': 'Backlog' })], { harness: { 'max-tickets-in-grooming': 5 } });
  await holding(open, async () => {
    await tick(open.ctx);
    assert.deepEqual(open.refiners(), ['ABC-50']);
  });
});

test('ASS-166 AC2: a backlog ticket worked by hand is never groomed or moved; cleared, it is', async () => {
  const mark = { 'worked-manually': { by: 'alice', since: '2026-10-27T10:00:00Z', note: null } };
  const f = refining([at('ABC-50', 'groom', mark), at('ABC-51', 'ready', mark)], { harness: { 'max-tickets-in-grooming': 5 } });
  writeQuestions(f, [{ question: 'Which?', status: 'Answered', 'answered-time-stamp': '2026-10-13T10:00:00Z' }], 'ABC-51');   // not accepted; not open, so it holds no groom (ASS-248)
  await holding(f, async () => {
    await tick(f.ctx);
    assert.deepEqual([f.refiners(), f.stateOf('ABC-51')], [[], 'ready']);
    await f.agent('ticket:set-manual', 'p', 'ABC-50', 'off');
    await f.agent('ticket:set-manual', 'p', 'ABC-51', 'off');
    await tick(f.ctx);
    assert.deepEqual([f.refiners(), f.stateOf('ABC-51')], [['ABC-50', 'ABC-51'], 'groom']);
  });
});

test('ASS-248 AC2, AC3: a backlog ticket with an open blocking question is not groomed — logged once — until it is answered; a non-blocking one never holds it', async () => {
  const f = refining([at('ABC-50')], { harness: { 'max-tickets-in-grooming': 5 } });
  writeQuestions(f, [{ question: 'Which cards?', status: 'Asked', blocking: true }, { question: 'Refunds?', status: 'Asked', blocking: false }]);
  await holding(f, async () => {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), []);
    assert.equal(f.lines.filter(l => /^dispatch ABC-50 waits on the operator: 1 open blocking question \(Which cards\?\)/.test(l)).length, 1, f.lines.join('\n'));
    await f.agent('question:answer', 'p', 'ABC-50', '0', 'Visa only.');
    await tick(f.ctx);
    assert.deepEqual(f.refiners(), ['ABC-50']);
  });
});
