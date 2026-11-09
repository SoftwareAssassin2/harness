// ASS-252: splitting a harness ticket too large into smaller ones, the
// agent-cli side. Split's agent records its proposal with ticket:propose-split
// (checked: 1–5 points a ticket, each with a user story, context and acceptance
// criteria, every original criterion covered, dependencies that make no cycle);
// the operator's Accept runs ticket:apply-split, which creates the tickets
// through off-board.sh alone, records their dependencies and marks the original
// split into them, Done, so it leaves the backlog; Keep whole is off-board.sh
// ticket:keep-whole, which ticket:kept-whole reads at Check Kept Whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, AGENT, STAMP } from './harness-fixture.js';

const exec = promisify(execFile);
const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const exitOf = promise => promise.then(() => 0, e => e.code);

const STORY = (key, front = '') => `---\nkey: ${key}\ntype: Story\nstatus: Backlog\n${front}created: 2020-01-01T00:00:00Z\nupdated: 2020-01-01T00:00:00Z\n---\n# ${key} title\n\n## User story\n\nAs a user.\n\n## Context\n\nSome context.\n\n## Acceptance criteria\n\n1. AC1: first\n2. AC2: second\n3. AC3: third\n`;

// The fixture with project h: an off-board source (folder h-tickets, prefix
// HD), HD-1 in its backlog at Create the Split Tickets with its work folder;
// off-board HD-1 (priority High, depending on HD-9) and HD-5, which depends on HD-1.
function splitting() {
  const f = fixture();
  const at = (...path) => join(f.dir, ...path);
  const put = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4)); };
  put(at('projects', 'h', 'project.json'), { name: 'H', 'execution-state-engine': 'example-development', 'work-sources': [{ name: 'Harness Ticket', type: 'off-board', folder: 'h-tickets', 'key-prefix': 'HD' }] });
  put(at('projects', 'h', 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
  put(at('projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features: [], bugs: [], spikes: [] });
  put(at('projects', 'h', 'backlog.json'), { tickets: [{ key: 'HD-1', title: 'HD-1 title', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': { state: 'create-split-tickets', 'state-engine': 'harness-backlog-refinement' }, 'state-changes': [] }] }] });
  mkdirSync(at('projects', 'h', 'work', 'HD-1'), { recursive: true });
  put(at('off-board', 'h-tickets', 'HD-1.md'), STORY('HD-1', 'priority: High\ndepends-on: HD-9\n'));
  put(at('off-board', 'h-tickets', 'HD-5.md'), STORY('HD-5', 'depends-on: HD-1\n'));
  put(at('off-board', 'h-tickets', 'HD-9.md'), STORY('HD-9'));
  const env = { ...f.env, OFF_BOARD_DIR: at('off-board') };
  const agent = (args, input) => {
    const child = exec(AGENT, args, { env });
    if (input != null) { child.child.stdin.end(input); }
    return child;
  };
  return {
    ...f, env, at,
    agent,
    json: async (args, input) => JSON.parse((await agent(args, input)).stdout),
    offBoard: async (...args) => JSON.parse((await exec(OFF_BOARD, args, { env })).stdout),
    proposal: () => JSON.parse(readFileSync(at('projects', 'h', 'work', 'HD-1', 'split-proposal.json'), 'utf8')),
    backlog: () => JSON.parse(readFileSync(at('projects', 'h', 'backlog.json'), 'utf8')).tickets,
    store: () => ['HD-1', 'HD-5', 'HD-9'].map(k => readFileSync(at('off-board', 'h-tickets', `${k}.md`), 'utf8')).join('\n---\n'),
  };
}

const piece = (title, points, covers, dependsOn = [], extra = {}) => ({
  title, points, 'user-story': `As the operator, I want ${title}.`, context: `Part of ${title}.`,
  'acceptance-criteria': [`${title} works`, `AC2: ${title} is tested`], covers, 'depends-on': dependsOn, ...extra,
});
const PROPOSAL = { summary: 'two pieces', tickets: [piece('First piece', 2, [1]), piece('Second piece', 3, [2, 3], [1])] };

test('ASS-252 AC2: ticket:propose-split records a proposal, from stdin, in the ticket\'s work folder — the harness\'s own file, no work:write', async () => {
  const f = splitting();
  const out = await f.json(['ticket:propose-split', 'h', 'hd-1', '-'], JSON.stringify(PROPOSAL));
  assert.deepEqual(out, { ticket: 'HD-1', tickets: 2 });
  const saved = f.proposal();
  assert.equal(saved.ticket, 'HD-1');
  assert.match(saved['proposed-at'], STAMP);
  assert.equal(saved.summary, 'two pieces');
  assert.deepEqual(saved.tickets, PROPOSAL.tickets.map(t => ({ ...t, type: 'Story' })));
  // A file works too, and a new proposal replaces the last.
  const file = f.at('proposal.json');
  writeFileSync(file, JSON.stringify({ tickets: [piece('Only', 5, [1, 2]), piece('Other', 1, [3], ['HD-9'], { type: 'Spike' })] }));
  await f.json(['ticket:propose-split', 'h', 'HD-1', file]);
  assert.deepEqual(f.proposal().tickets.map(t => [t.title, t.type, t['depends-on']]), [['Only', 'Story', []], ['Other', 'Spike', ['HD-9']]]);
  await fails(f.agent(['work:write', 'h', 'HD-1', '-', 'split-proposal.json'], '{}'), /the harness's own: not written/);
});

test('ASS-252 AC2: ticket:propose-split refuses, writing nothing, a proposal that is not 1–5 point tickets with a story, context and criteria covering every original criterion, or whose dependencies are unknown or circular', async () => {
  const f = splitting();
  const refused = async (proposal, message) => fails(f.agent(['ticket:propose-split', 'h', 'HD-1', '-'], typeof proposal === 'string' ? proposal : JSON.stringify(proposal)), message);
  const two = (a, b) => ({ tickets: [a, b] });
  await refused('nope', /not JSON/);
  await refused({ tickets: [piece('Alone', 3, [1, 2, 3])] }, /at least two tickets/);
  await refused(two(piece('Big', 8, [1]), piece('B', 1, [2, 3])), /ticket 1: points must be 1, 2, 3 or 5/);
  await refused(two(piece('A', 1, [1], [], { 'user-story': ' ' }), piece('B', 1, [2, 3])), /ticket 1: needs a user-story/);
  await refused(two(piece('A', 1, [1]), piece('B', 1, [2, 3], [], { context: '' })), /ticket 2: needs a context/);
  await refused(two(piece('', 1, [1]), piece('B', 1, [2, 3])), /ticket 1: needs a title/);
  await refused(two(piece('A', 1, [1], [], { 'acceptance-criteria': [] }), piece('B', 1, [2, 3])), /ticket 1: needs acceptance-criteria/);
  await refused(two(piece('A', 1, [1], [], { 'acceptance-criteria': ['a\nb'] }), piece('B', 1, [2, 3])), /ticket 1: needs acceptance-criteria/);
  await refused(two(piece('A', 1, [1], [], { type: 'Task' }), piece('B', 1, [2, 3])), /ticket 1: type must be Story, Bug or Spike/);
  await refused(two(piece('A', 1, [1]), piece('B', 1, [2])), /HD-1's AC3 is covered by no ticket/);
  await refused(two(piece('A', 1, [1, 7]), piece('B', 1, [2, 3])), /ticket 1: covers AC7, which HD-1 does not have/);
  await refused(two(piece('A', 1, [1], [1]), piece('B', 1, [2, 3])), /ticket 1: cannot depend on itself/);
  await refused(two(piece('A', 1, [1], [3]), piece('B', 1, [2, 3])), /ticket 1: depends on ticket 3, which the proposal does not have/);
  await refused(two(piece('A', 1, [1], [2]), piece('B', 1, [2, 3], [1])), /dependencies make a cycle/);
  await refused(two(piece('A', 1, [1], ['HD-77']), piece('B', 1, [2, 3])), /ticket 1: depends on HD-77, no ticket of h/);
  await refused(two(piece('A', 1, [1], ['HD-1']), piece('B', 1, [2, 3])), /ticket 1: cannot depend on HD-1, the ticket being split/);
  assert.ok(!existsSync(f.at('projects', 'h', 'work', 'HD-1', 'split-proposal.json')));
  await fails(f.agent(['ticket:propose-split', 'h', 'HD-1']), /^usage: ticket:propose-split/);
});

test('ASS-252 AC3: ticket:apply-split creates the proposed tickets through off-board.sh, with their points, criteria and dependencies, rewires what depended on the original, and marks the original split into them, Done, out of the backlog', async () => {
  const f = splitting();
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(PROPOSAL));
  assert.deepEqual(await f.json(['ticket:apply-split', 'h', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11'] });
  const [first, second] = [await f.offBoard('ticket:get', 'h', 'HD-10'), await f.offBoard('ticket:get', 'h', 'HD-11')];
  assert.deepEqual([first.title, first.type, first.status, first.points, first.priority], ['First piece', 'Story', 'Backlog', 2, 'High']);
  assert.deepEqual(first['acceptance-criteria'], [{ 'criteria-number': 1, description: 'AC1: First piece works' }, { 'criteria-number': 2, description: 'AC2: First piece is tested' }]);
  assert.match(first.description, /^## User story\n\nAs the operator, I want First piece\.\n\n## Context\n\nPart of First piece\.\n\nSplit from HD-1 \(HD-1 title\); covers its AC1\.\n/);
  assert.deepEqual(first['depends-on'], ['HD-9']);                  // a first piece takes what the original waited on
  assert.deepEqual([second.points, second['depends-on']], [3, ['HD-10']]);
  assert.match(second.description, /covers its AC2, AC3\./);
  assert.deepEqual((await f.offBoard('ticket:get', 'h', 'HD-5'))['depends-on'], ['HD-10', 'HD-11']);
  const original = await f.offBoard('ticket:get', 'h', 'HD-1');
  assert.deepEqual([original.status, original['split-into']], ['Done', ['HD-10', 'HD-11']]);
  const [entry] = f.backlog();
  assert.deepEqual([entry['ticket-system-status'], entry['split-into']], ['Done', ['HD-10', 'HD-11']]);
  assert.deepEqual(f.proposal().tickets.map(t => t.key), ['HD-10', 'HD-11']);
  // Run again (a stop part way, say): nothing created twice.
  assert.deepEqual(await f.json(['ticket:apply-split', 'h', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11'] });
  assert.equal((await f.offBoard('ticket:list', 'h')).length, 5);
});

test('ASS-252 AC3: ticket:apply-split fails, creating nothing, with no proposal', async () => {
  const f = splitting();
  const before = f.store();
  await fails(f.agent(['ticket:apply-split', 'h', 'HD-1']), /ticket:apply-split: HD-1 has no split proposal/);
  assert.equal(f.store(), before);
  assert.equal((await f.offBoard('ticket:list', 'h')).length, 3);
  await fails(f.agent(['ticket:apply-split', 'h']), /^usage: ticket:apply-split/);
});

test('ASS-252 AC3: ticket:kept-whole exits 0 once the operator kept the ticket whole (off-board.sh ticket:keep-whole), 1 before', async () => {
  const f = splitting();
  assert.equal(await exitOf(f.agent(['ticket:kept-whole', 'h', 'HD-1'])), 1);
  await f.offBoard('ticket:keep-whole', 'h', 'HD-1');
  assert.deepEqual(await f.json(['ticket:kept-whole', 'h', 'hd-1']), { ticket: 'HD-1', 'kept-whole': true });
  await fails(f.agent(['ticket:kept-whole', 'h', 'HD-77']), /no ticket HD-77 in h/);
});

// ASS-265: the example GitHub project's Split, at the operator's choice at Too Large, runs the
// same prompt and the same ticket:propose-split; its Check the Proposal asks
// ticket:split-proposed whether this visit to Split recorded one — a proposal
// made since the ticket's last move to Split — so one Split did not write, or
// one left from an earlier Split the operator rejected, sends the ticket back
// to Too Large instead of to a gate showing nothing, or something stale.
const toSplit = timestamp => ({ 'state-engine': 'example-github-backlog-refinement', 'from-state': 'too-large', 'to-state': 'split', timestamp, 'agent-dispatch-log': [], 'work-is-done': false });
const movedToSplit = (f, timestamp) => {
  const backlog = JSON.parse(readFileSync(f.at('projects', 'h', 'backlog.json'), 'utf8'));
  backlog.tickets[0].variations[0]['state-changes'].push(toSplit(timestamp));
  writeFileSync(f.at('projects', 'h', 'backlog.json'), JSON.stringify(backlog, null, 4));
};

test('ASS-265 AC3: ticket:split-proposed exits 0 when a proposal was recorded since the ticket\'s last move to Split, 1 with none, or with one from before', async () => {
  const f = splitting();
  movedToSplit(f, '2020-01-01T00:00:00Z');
  assert.equal(await exitOf(f.agent(['ticket:split-proposed', 'h', 'HD-1'])), 1);
  await fails(f.agent(['ticket:split-proposed', 'h', 'HD-1']), /HD-1 has no split proposal/);
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(PROPOSAL));
  const out = await f.json(['ticket:split-proposed', 'h', 'hd-1']);
  assert.deepEqual([out.ticket, out.proposed, out['proposed-at']], ['HD-1', true, f.proposal()['proposed-at']]);
  // Split again — moved there after that proposal — and nothing new recorded: the old one is not this visit's.
  movedToSplit(f, '2999-01-01T00:00:00Z');
  assert.equal(await exitOf(f.agent(['ticket:split-proposed', 'h', 'HD-1'])), 1);
  await fails(f.agent(['ticket:split-proposed', 'h', 'HD-1']), /HD-1's split proposal is from before its last move to Split/);
  await fails(f.agent(['ticket:split-proposed', 'h']), /^usage: ticket:split-proposed/);
});

test('ASS-265 AC3: ticket:split-proposed takes any proposal when the ticket has no move to Split recorded', async () => {
  const f = splitting();
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(PROPOSAL));
  assert.equal((await f.json(['ticket:split-proposed', 'h', 'HD-1'])).proposed, true);
});

// The example GitHub project's own project — GH tickets off-board, its execution engine example-github-development — split as the
// harness's are: the tickets created at Backlog (the downloader starts each in refinement), the original marked split.
test('ASS-265 AC3, AC5: an example GitHub ticket split at the operator\'s word — proposed, checked, then applied: its tickets created and the original marked split, Done, out of the backlog', async () => {
  const f = splitting();
  const put = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4)); };
  put(f.at('projects', 'github', 'project.json'), { name: 'Example GitHub', 'execution-state-engine': 'example-github-development', 'uses-points': true, 'work-sources': [{ name: 'Example GitHub Ticket', type: 'off-board', folder: 'github', 'key-prefix': 'GH' }] });
  put(f.at('projects', 'github', 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
  put(f.at('projects', 'github', 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features: [], bugs: [], spikes: [] });
  put(f.at('projects', 'github', 'backlog.json'), { tickets: [{ key: 'GH-1', title: 'GH-1 title', 'ticket-system-status': 'Backlog',
    variations: [{ name: 'A', 'harness-status': { state: 'split', 'state-engine': 'example-github-backlog-refinement' }, 'state-changes': [toSplit('2020-01-01T00:00:00Z')] }] }] });
  mkdirSync(f.at('projects', 'github', 'work', 'GH-1'), { recursive: true });
  put(f.at('off-board', 'github', 'GH-1.md'), STORY('GH-1'));
  assert.equal(await exitOf(f.agent(['ticket:split-proposed', 'github', 'GH-1'])), 1);   // Split's agent wrote nothing yet
  await f.json(['ticket:propose-split', 'github', 'GH-1', '-'], JSON.stringify(PROPOSAL));
  assert.equal((await f.json(['ticket:split-proposed', 'github', 'GH-1'])).proposed, true);
  assert.deepEqual(await f.json(['ticket:apply-split', 'github', 'GH-1']), { ticket: 'GH-1', 'split-into': ['GH-2', 'GH-3'] });
  const made = [await f.offBoard('ticket:get', 'github', 'GH-2'), await f.offBoard('ticket:get', 'github', 'GH-3')];
  assert.deepEqual(made.map(t => [t.title, t.status, t.points]), [['First piece', 'Backlog', 2], ['Second piece', 'Backlog', 3]]);
  assert.deepEqual(made[1]['depends-on'], ['GH-2']);
  const original = await f.offBoard('ticket:get', 'github', 'GH-1');
  assert.deepEqual([original.status, original['split-into']], ['Done', ['GH-2', 'GH-3']]);
  const [entry] = JSON.parse(readFileSync(f.at('projects', 'github', 'backlog.json'), 'utf8')).tickets;
  assert.deepEqual([entry['ticket-system-status'], entry['split-into']], ['Done', ['GH-2', 'GH-3']]);
});

// ASS-266: a split that failed part way, tried again, never creates a ticket
// twice. ticket:apply-split reuses what it made before — the keys it recorded
// on the proposal, or, should a run stop between creating a ticket and
// recording its key, the ticket whose title matches and whose context carries
// its marker ("Split from <KEY> (") — and creates only what is missing. A new
// proposal after a partial apply builds on what was made: ticket:propose-split
// records each ticket already made as already-created, with the place in the
// new proposal that reuses it (the same title) or null when none does, which
// the operator sees at the gate; apply reuses the one and leaves the other as
// it is, outside the split.
const THREE = { summary: 'three pieces', tickets: [piece('First piece', 2, [1]), piece('Second piece', 3, [2], [1]), piece('Third piece', 1, [3])] };
const titles = async (f, home) => (await f.offBoard('ticket:list', home)).map(t => t.title);
const once = (all, title) => assert.equal(all.filter(t => t === title).length, 1, `${title}: ${all.join(', ')}`);

// Apply fails at the third ticket — its type one off-board.sh refuses — once the first two are made.
async function failPartWay(f, project, key) {
  await f.json(['ticket:propose-split', project, key, '-'], JSON.stringify(THREE));
  const file = f.at('projects', project, 'work', key, 'split-proposal.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.tickets[2].type = 'Task';
  writeFileSync(file, JSON.stringify(saved, null, 4));
  await fails(f.agent(['ticket:apply-split', project, key]), /unknown type 'Task'/);
  return { file, mend: () => { const now = JSON.parse(readFileSync(file, 'utf8')); now.tickets[2].type = 'Spike'; writeFileSync(file, JSON.stringify(now, null, 4)); } };
}

test('ASS-266 AC1, AC3: ticket:apply-split failed part way and run again creates only the tickets not yet made, and marks the original split once', async () => {
  const f = splitting();
  const { mend } = await failPartWay(f, 'h', 'HD-1');
  assert.deepEqual((await f.offBoard('ticket:list', 'h')).map(t => t.key), ['HD-1', 'HD-5', 'HD-9', 'HD-10', 'HD-11']);
  const half = await f.offBoard('ticket:get', 'h', 'HD-1');
  assert.deepEqual([half.status, half['split-into']], ['Backlog', undefined]);   // not split yet
  assert.deepEqual(f.proposal().tickets.map(t => t.key), ['HD-10', 'HD-11', undefined]);
  mend();
  assert.deepEqual(await f.json(['ticket:apply-split', 'h', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11', 'HD-12'] });
  const all = await titles(f, 'h');
  assert.equal(all.length, 6);
  for (const title of ['First piece', 'Second piece', 'Third piece']) once(all, title);
  assert.equal((await f.offBoard('ticket:get', 'h', 'HD-12')).type, 'Spike');
  assert.deepEqual((await f.offBoard('ticket:get', 'h', 'HD-11'))['depends-on'], ['HD-10']);
  const original = await f.offBoard('ticket:get', 'h', 'HD-1');
  assert.deepEqual([original.status, original['split-into']], ['Done', ['HD-10', 'HD-11', 'HD-12']]);
  assert.equal(f.store().match(/^split-into:/gm).length, 1);
  assert.deepEqual(f.backlog()[0]['split-into'], ['HD-10', 'HD-11', 'HD-12']);
});

test('ASS-266 AC1, AC3: a run stopped between creating a ticket and recording its key finds it by its marker and title, and creates it no second time', async () => {
  const f = splitting();
  const { file, mend } = await failPartWay(f, 'h', 'HD-1');
  mend();
  const lost = JSON.parse(readFileSync(file, 'utf8'));
  delete lost.tickets[1].key;                                          // HD-11 made, its key never written
  writeFileSync(file, JSON.stringify(lost, null, 4));
  assert.deepEqual(await f.json(['ticket:apply-split', 'h', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11', 'HD-12'] });
  const all = await titles(f, 'h');
  assert.equal(all.length, 6);
  for (const title of ['First piece', 'Second piece', 'Third piece']) once(all, title);
});

// A project whose own tickets are Jira's, its harness tickets off-board in the harness project (harness.json
// harness-project): the proposal and backlog entry are the project's, the tickets made in the harness's store.
test('ASS-266 AC1, AC3: on a Jira project splitting a harness ticket, a failed apply run again creates only the missing tickets, in the harness project', async () => {
  const f = splitting();
  const put = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(content, null, 4)); };
  const harness = JSON.parse(readFileSync(f.at('harness.json'), 'utf8'));
  put(f.at('harness.json'), { ...harness, 'harness-project': 'h' });
  put(f.at('projects', 'cl', 'project.json'), { name: 'CL', 'execution-state-engine': 'example-development', 'work-sources': [{ name: 'Jira', type: 'jira', url: 'https://example.atlassian.net/jira/software/projects/CL/boards/1' }] });
  put(f.at('projects', 'cl', 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
  put(f.at('projects', 'cl', 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features: [], bugs: [], spikes: [] });
  put(f.at('projects', 'cl', 'backlog.json'), { tickets: [{ key: 'HD-1', title: 'HD-1 title', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': { state: 'create-split-tickets', 'state-engine': 'harness-backlog-refinement' }, 'state-changes': [] }] }] });
  mkdirSync(f.at('projects', 'cl', 'work', 'HD-1'), { recursive: true });
  const { mend } = await failPartWay(f, 'cl', 'HD-1');
  assert.equal((await titles(f, 'h')).length, 5);
  mend();
  assert.deepEqual(await f.json(['ticket:apply-split', 'cl', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11', 'HD-12'] });
  assert.deepEqual(await f.json(['ticket:apply-split', 'cl', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-11', 'HD-12'] });
  const all = await titles(f, 'h');
  assert.equal(all.length, 6);
  for (const title of ['First piece', 'Second piece', 'Third piece']) once(all, title);
  const [entry] = JSON.parse(readFileSync(f.at('projects', 'cl', 'backlog.json'), 'utf8')).tickets;
  assert.deepEqual([entry['ticket-system-status'], entry['split-into']], ['Done', ['HD-10', 'HD-11', 'HD-12']]);
});

test('ASS-266 AC2, AC3: a new proposal after a partial apply records the tickets already made — the one it reuses by title, the one it leaves — and applying it creates neither again', async () => {
  const f = splitting();
  await failPartWay(f, 'h', 'HD-1');                                  // HD-10 First piece, HD-11 Second piece made
  const again = { summary: 'two, after all', tickets: [piece('First piece', 5, [1], [], { context: 'Now bigger.' }), piece('Fourth piece', 3, [2, 3], [1])] };
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(again));
  const made = [{ key: 'HD-10', title: 'First piece', place: 1 }, { key: 'HD-11', title: 'Second piece', place: null }];
  assert.deepEqual(f.proposal()['already-created'], made);
  assert.deepEqual(f.proposal().tickets.map(t => t.key), [undefined, undefined]);
  // Proposed once more before any apply: still known, by the marker each carries.
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(again));
  assert.deepEqual(f.proposal()['already-created'], made);
  assert.deepEqual(await f.json(['ticket:apply-split', 'h', 'HD-1']), { ticket: 'HD-1', 'split-into': ['HD-10', 'HD-12'] });
  const all = await titles(f, 'h');
  assert.equal(all.length, 6);
  for (const title of ['First piece', 'Second piece', 'Fourth piece']) once(all, title);
  const reused = await f.offBoard('ticket:get', 'h', 'HD-10');
  assert.equal(reused.points, 5);                                     // the new proposal's, its story and context too
  assert.match(reused.description, /## Context\n\nNow bigger\.\n\nSplit from HD-1 \(HD-1 title\); covers its AC1\./);
  assert.deepEqual((await f.offBoard('ticket:get', 'h', 'HD-12'))['depends-on'], ['HD-10']);
  const left = await f.offBoard('ticket:get', 'h', 'HD-11');          // left as it was, outside the split
  assert.deepEqual([left.status, left.title, left['split-into']], ['Backlog', 'Second piece', undefined]);
  assert.deepEqual((await f.offBoard('ticket:get', 'h', 'HD-1'))['split-into'], ['HD-10', 'HD-12']);
  assert.deepEqual((await f.offBoard('ticket:get', 'h', 'HD-5'))['depends-on'], ['HD-10', 'HD-12']);
});

test('ASS-266 AC2: a first proposal, with nothing made yet, records no already-created', async () => {
  const f = splitting();
  await f.json(['ticket:propose-split', 'h', 'HD-1', '-'], JSON.stringify(PROPOSAL));
  assert.equal('already-created' in f.proposal(), false);
});
