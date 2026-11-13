// ASS-409: the project's team, joining ticket-system and git identities, from
// the analytics data and the project's engines (src/analytics/team.js).
// Invented people, tickets and repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateTeam, migrate, normalName, ticketKeys, byTicketKeys } from '../../src/analytics/team.js';

// Made-up status names, given meaning only by the engine's steps.
const ENGINE = { steps: [
  { id: 'backlog', 'paired-ticket-system-status': 'Ready', 'is-planning-stage': true },
  { id: 'build', 'paired-ticket-system-status': 'Working' },
  { id: 'check', 'paired-ticket-system-status': 'Checking', 'is-qa': true },
  { id: 'done', 'paired-ticket-system-status': 'Finished', 'is-done': true },
] };
const ADA = { id: 'a1', name: 'Ada Lovelace' };
const GRACE = { id: 'g1', name: 'Grace Hopper' };
const LIN = { id: 'q1', name: 'Lin Tester' };
const TODAY = '2026-11-12';

const day = d => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;
// ticket(key, { moves: [[day, to, by]], assigns: [[day, from, to]], assignee })
function ticket(key, { moves = [], assigns = [], assignee = null }) {
  let from = 'Ready';
  return {
    key, title: key, type: 'Story', created: day(1), points: 1, assignee, sprints: [],
    status: moves.at(-1)?.[1] ?? 'Ready',
    'status-changes': moves.map(([d, to, by]) => { const c = { at: day(d), from, to, by }; from = to; return c; }),
    'assignee-changes': assigns.map(([d, f, t]) => ({ at: day(d), from: f, to: t })),
  };
}
const tickets = (...list) => ({ 'fetched-through': day(12), tickets: Object.fromEntries(list.map(t => [t.key, t])) });
let iid = 0;
const mr = (username, name, { branch = 'change', title = 'A change', at = day(5) } = {}) => {
  iid++;
  return [`group/app!${iid}`, { repo: 'group/app', host: 'gitlab', iid, title, branch, author: { username, name }, 'merged-at': at }];
};
const mrs = (...list) => ({ 'fetched-through': {}, 'merge-requests': Object.fromEntries(list) });

// Ada builds PROJ-1 and hands it to Lin for QA, who finishes it.
const handedToQa = () => ticket('PROJ-1', { assignee: LIN, moves: [[2, 'Working', ADA], [3, 'Checking', ADA], [4, 'Finished', LIN]], assigns: [[1, null, ADA], [3, ADA, LIN]] });

const run = (over = {}) => updateTeam({ team: null, tickets: tickets(), mergeRequests: mrs(), engines: [ENGINE], today: TODAY, ...over });
const find = (team, pred) => team.members.find(pred);
const byId = (team, id) => find(team, m => m['ticket-system-id'] === id);
const byUser = (team, u) => find(team, m => m['git-username'] === u);

test('AC1: a member has every field in order, first-seen the day added, set-by-operator a list', () => {
  const { team, added } = run({ tickets: tickets(handedToQa()) });
  assert.deepEqual(team.members, [{
    'ticket-system-id': 'a1', 'ticket-system-name': 'Ada Lovelace', 'git-username': null, 'git-name': null,
    role: 'developer', 'matched-by': null, 'first-seen': TODAY, 'set-by-operator': [],
  }]);
  assert.deepEqual(added.map(m => m['ticket-system-id']), ['a1']);
});

test('AC2: the developer credited is the assignee just before the first QA status, or before done when it skipped QA; an unfinished ticket adds no one', () => {
  const straight = ticket('PROJ-2', { assignee: GRACE, moves: [[2, 'Working', GRACE], [5, 'Finished', GRACE]], assigns: [[1, null, GRACE]] });
  const open = ticket('PROJ-3', { assignee: { id: 'x1', name: 'Open Person' }, moves: [[2, 'Working']] });
  const { team } = run({ tickets: tickets(handedToQa(), straight, open) });
  assert.deepEqual(team.members.map(m => m['ticket-system-id']).sort(), ['a1', 'g1']);   // not Lin (she held it at done) nor x1
});

test('AC2: every merged merge request\'s author is added by git username, git-only when not linked', () => {
  const { team, added } = run({ mergeRequests: mrs(mr('zed', 'Zed Unknown'), mr('zed', 'Zed Unknown')) });
  assert.deepEqual(team.members, [{
    'ticket-system-id': null, 'ticket-system-name': null, 'git-username': 'zed', 'git-name': 'Zed Unknown',
    role: 'unmatched', 'matched-by': null, 'first-seen': TODAY, 'set-by-operator': [],
  }]);
  assert.equal(added.length, 1);
});

test('AC3: a git author is linked by name, case and punctuation ignored, to a member or to anyone in the tickets', () => {
  const { team, added, linked } = run({
    tickets: tickets(handedToQa()),
    mergeRequests: mrs(mr('ada.l', 'ADA  lovelace'), mr('lin-tester', 'Someone Else')),
  });
  const ada = byId(team, 'a1');
  assert.equal(ada['git-username'], 'ada.l');
  assert.equal(ada['git-name'], 'ADA  lovelace');
  assert.equal(ada['matched-by'], 'name');
  // Lin is not a member through the tickets, but her username matches her ticket-system name: one member, both identities.
  const lin = byUser(team, 'lin-tester');
  assert.deepEqual([lin['ticket-system-id'], lin['ticket-system-name'], lin['matched-by']], ['q1', 'Lin Tester', 'name']);
  assert.equal(team.members.length, 2);
  assert.equal(added.length, 2);
  assert.deepEqual(linked, []);   // both new this run: reported as added
  assert.equal(normalName('Ada-Lovelace!'), normalName('ada lovelace'));
});

test('AC3: else by ticket keys — at least 3 merge requests and 60% of the keyed ones name one person\'s tickets', () => {
  const done = n => ticket(`PROJ-${n}`, { assignee: GRACE, moves: [[2, 'Working', GRACE], [5, 'Finished', GRACE]], assigns: [[1, null, GRACE]] });
  const other = ticket('PROJ-9', { assignee: ADA, moves: [[2, 'Working', ADA]] });
  const { team } = run({
    tickets: tickets(done(1), done(2), done(3), other),
    mergeRequests: mrs(
      mr('gh42', 'G. H.', { branch: 'feature/proj-1-login' }),
      mr('gh42', 'G. H.', { title: 'PROJ-2: search' }),
      mr('gh42', 'G. H.', { branch: 'PROJ-3' }),
      mr('gh42', 'G. H.', { branch: 'proj-9-fix' }),
      mr('gh42', 'G. H.', { branch: 'UTF-8 cleanup' }),   // names no ticket: not keyed
    ),
  });
  const grace = byId(team, 'g1');
  assert.deepEqual([grace['git-username'], grace['matched-by'], grace.role], ['gh42', 'ticket-keys', 'developer']);
  assert.equal(team.members.length, 1);   // the git-only entry folded into Grace's
  assert.deepEqual(ticketKeys('feature/proj-1-login PROJ-2: x'), ['PROJ-1', 'PROJ-2']);
});

test('AC3: below either threshold the author stays git-only and unmatched, and is tried again on a later run', () => {
  const holder = new Map([['PROJ-1', 'g1'], ['PROJ-2', 'g1'], ['PROJ-3', 'g1'], ['PROJ-4', 'a1'], ['PROJ-5', 'a1']]);
  const m = branch => ({ branch, title: '' });
  assert.equal(byTicketKeys([m('PROJ-1'), m('PROJ-2')], holder), null);                                   // 2 < 3
  assert.equal(byTicketKeys([m('PROJ-1'), m('PROJ-2'), m('PROJ-3'), m('PROJ-4'), m('PROJ-5')], holder), 'g1');   // 3/5 = 60%: enough
  assert.equal(byTicketKeys([m('PROJ-1'), m('PROJ-2'), m('PROJ-3'), m('PROJ-4'), m('PROJ-5'), m('PROJ-4')], holder), null);   // 3/6 < 60%
  assert.equal(byTicketKeys([m('PROJ-1 PROJ-4'), m('PROJ-2 PROJ-5'), m('PROJ-3 PROJ-4')], holder), null);   // 3 each: a tie is no one
  assert.equal(byTicketKeys([m('PROJ-1'), m('PROJ-2'), m('PROJ-3'), m('PROJ-4')], holder), 'g1');          // 3/4

  const done = n => ticket(`PROJ-${n}`, { assignee: GRACE, moves: [[2, 'Working', GRACE], [5, 'Finished', GRACE]], assigns: [[1, null, GRACE]] });
  const two = mrs(mr('gh42', 'G. H.', { branch: 'PROJ-1' }), mr('gh42', 'G. H.', { branch: 'PROJ-2' }));
  const first = run({ tickets: tickets(done(1), done(2), done(3)), mergeRequests: two });
  assert.deepEqual([byUser(first.team, 'gh42').role, byUser(first.team, 'gh42')['ticket-system-id']], ['unmatched', null]);
  // A third merge request later: linked on that run, and reported as linked.
  const three = mrs(...Object.entries(two['merge-requests']), mr('gh42', 'G. H.', { branch: 'PROJ-3' }));
  const again = run({ team: first.team, tickets: tickets(done(1), done(2), done(3)), mergeRequests: three });
  assert.deepEqual([byId(again.team, 'g1')['git-username'], again.team.members.length], ['gh42', 1]);
  assert.deepEqual(again.linked.map(m => m['git-username']), ['gh42']);
  assert.deepEqual(again.added, []);
  assert.equal(byId(again.team, 'g1')['first-seen'], TODAY);
});

test('AC4: qa when at least half of a person\'s status changes move a ticket out of a QA status; developer otherwise', () => {
  // Lin, credited as developer on PROJ-5, mostly moves tickets out of Checking.
  const own = ticket('PROJ-5', { assignee: LIN, moves: [[2, 'Working', LIN], [3, 'Finished', LIN]], assigns: [[1, null, LIN]] });
  const checked = n => ticket(`PROJ-${n}`, { assignee: LIN, moves: [[2, 'Working', ADA], [3, 'Checking', ADA], [4, 'Finished', LIN]], assigns: [[1, null, ADA], [3, ADA, LIN]] });
  const { team } = run({ tickets: tickets(own, checked(6), checked(7)) });
  assert.equal(byId(team, 'q1').role, 'qa');          // 2 of 4 out of Checking
  assert.equal(byId(team, 'a1').role, 'developer');   // none of hers
  // One out of Checking in four: developer.
  const fewer = run({ tickets: tickets(own, checked(6), ticket('PROJ-8', { moves: [[2, 'Working', LIN]] })) });
  assert.equal(byId(fewer.team, 'q1').role, 'developer');
});

test('AC4: a git-only member is bot when its username or name contains "bot", else unmatched; product is kept', () => {
  const { team } = run({
    team: { members: [{ 'ticket-system-id': 'p1', 'ticket-system-name': 'Pat Product', role: 'product', 'first-seen': '2026-10-01' }] },
    mergeRequests: mrs(mr('renovate-bot', 'Renovate'), mr('helper', 'Release Bot'), mr('zed', 'Zed')),
  });
  assert.deepEqual(team.members.map(m => [m['git-username'] ?? m['ticket-system-id'], m.role]),
    [['p1', 'product'], ['renovate-bot', 'bot'], ['helper', 'bot'], ['zed', 'unmatched']]);
});

test('AC5: a field in set-by-operator is never changed — role, names, a link the operator refused', () => {
  const existing = { members: [
    { 'ticket-system-id': 'a1', 'ticket-system-name': 'Countess', 'git-username': null, 'git-name': null, role: 'qa', 'matched-by': null, 'first-seen': '2026-10-01', 'set-by-operator': ['role', 'ticket-system-name'] },
    { 'ticket-system-id': null, 'ticket-system-name': null, 'git-username': 'ada.l', 'git-name': 'Ada Lovelace', role: 'developer', 'matched-by': null, 'first-seen': '2026-10-01', 'set-by-operator': ['ticket-system-id', 'role'] },
  ] };
  const { team, added, linked } = run({ team: existing, tickets: tickets(handedToQa()), mergeRequests: mrs(mr('ada.l', 'Ada Lovelace')) });
  assert.deepEqual(team, existing);   // nothing to change: every change it would make is the operator's field
  assert.deepEqual([added, linked], [[], []]);
});

test('AC5: the operator\'s link and fields survive a git-only entry being folded into its person', () => {
  const existing = { members: [
    { 'ticket-system-id': 'g1', 'ticket-system-name': 'Grace Hopper', role: 'developer', 'first-seen': '2026-10-05', 'set-by-operator': [] },
    { 'git-username': 'grace-h', 'git-name': 'Grace Hopper', role: 'developer', 'first-seen': '2026-10-01', 'set-by-operator': ['role'] },
  ] };
  const { team } = run({ team: existing });
  assert.deepEqual(team.members, [{
    'ticket-system-id': 'g1', 'ticket-system-name': 'Grace Hopper', 'git-username': 'grace-h', 'git-name': 'Grace Hopper',
    role: 'developer', 'matched-by': 'name', 'first-seen': '2026-10-01', 'set-by-operator': ['role'],
  }]);
});

test('AC6: a prototype-shaped team.json is read and rewritten in the new shape, its roles and set-by-operator kept', () => {
  const prototype = { members: [
    { 'jira-account-id': 'a1', 'jira-name': 'Ada Lovelace', 'gitlab-username': 'ada', 'gitlab-name': 'Ada Lovelace', role: 'developer', 'matched-by': 'name', 'first-seen': '2026-10-01', 'set-by-operator': [] },
    { 'jira-account-id': 'p1', 'jira-name': 'Pat Product', 'gitlab-username': null, 'gitlab-name': null, role: 'product', 'matched-by': null, 'first-seen': '2026-10-01', 'set-by-operator': ['role', 'jira-name'] },
    { 'jira-account-id': null, 'jira-name': null, 'gitlab-username': 'ci-bot', 'gitlab-name': 'CI', role: 'bot', 'matched-by': null, 'first-seen': '2026-10-02' },
    { 'jira-account-id': 'q1', 'jira-name': 'Lin Tester', 'gitlab-username': null, 'gitlab-name': null, role: 'qa', 'matched-by': null, 'first-seen': '2026-10-03', 'set-by-operator': [] },
  ] };
  const { team, migrated, added } = run({ team: prototype });
  assert.equal(migrated, true);
  assert.deepEqual(added, []);
  assert.deepEqual(team.members, [
    { 'ticket-system-id': 'a1', 'ticket-system-name': 'Ada Lovelace', 'git-username': 'ada', 'git-name': 'Ada Lovelace', role: 'developer', 'matched-by': 'name', 'first-seen': '2026-10-01', 'set-by-operator': [] },
    { 'ticket-system-id': 'p1', 'ticket-system-name': 'Pat Product', 'git-username': null, 'git-name': null, role: 'product', 'matched-by': null, 'first-seen': '2026-10-01', 'set-by-operator': ['role', 'ticket-system-name'] },
    { 'ticket-system-id': null, 'ticket-system-name': null, 'git-username': 'ci-bot', 'git-name': 'CI', role: 'bot', 'matched-by': null, 'first-seen': '2026-10-02', 'set-by-operator': [] },
    // No status changes of hers in the data: her qa role stands.
    { 'ticket-system-id': 'q1', 'ticket-system-name': 'Lin Tester', 'git-username': null, 'git-name': null, role: 'qa', 'matched-by': null, 'first-seen': '2026-10-03', 'set-by-operator': [] },
  ]);
  assert.equal(run({ team }).migrated, false);
  assert.deepEqual(migrate({ members: [team.members[0]] }), [team.members[0]]);
});

test('AC2: nobody is ever removed — members absent from the data stay, and an operator-added one is untouched', () => {
  const existing = { members: [
    { 'ticket-system-id': 'old1', 'ticket-system-name': 'Former Dev', 'git-username': 'former', 'git-name': 'Former Dev', role: 'developer', 'matched-by': 'name', 'first-seen': '2026-01-01', 'set-by-operator': [] },
    { 'ticket-system-id': null, 'ticket-system-name': null, 'git-username': 'gone', 'git-name': 'Gone', role: 'unmatched', 'matched-by': null, 'first-seen': '2026-01-01', 'set-by-operator': [] },
  ] };
  const { team } = run({ team: existing, tickets: tickets(handedToQa()), mergeRequests: mrs(mr('zed', 'Zed')) });
  assert.deepEqual(team.members.slice(0, 2), existing.members);
  assert.deepEqual(team.members.map(m => m['git-username'] ?? m['ticket-system-id']), ['former', 'gone', 'a1', 'zed']);
  // A second run on the same data changes nothing and adds no one.
  const again = run({ team: structuredClone(team), tickets: tickets(handedToQa()), mergeRequests: mrs(mr('zed', 'Zed')) });
  assert.deepEqual([again.team, again.added, again.linked], [team, [], []]);
});

test('AC3: a name two people share links no one; a person who already has a git identity takes no second', () => {
  const twin = { id: 'a2', name: 'ada lovelace' };
  const both = ticket('PROJ-4', { assignee: twin, moves: [[2, 'Working', twin], [3, 'Finished', twin]], assigns: [[1, null, twin]] });
  const shared = run({ tickets: tickets(handedToQa(), both), mergeRequests: mrs(mr('ada', 'Ada Lovelace')) });
  assert.equal(byUser(shared.team, 'ada').role, 'unmatched');
  const taken = run({
    team: { members: [{ 'ticket-system-id': 'a1', 'ticket-system-name': 'Ada Lovelace', 'git-username': 'ada', 'git-name': 'Ada Lovelace', role: 'developer', 'matched-by': 'name', 'first-seen': '2026-10-01', 'set-by-operator': [] }] },
    tickets: tickets(handedToQa()), mergeRequests: mrs(mr('ada-alt', 'Ada Lovelace')),
  });
  assert.deepEqual([byUser(taken.team, 'ada-alt')['ticket-system-id'], byUser(taken.team, 'ada-alt').role], [null, 'unmatched']);
});

test('ASS-413\'s off-board operator, credited on every ticket, is added and linked like anyone else', () => {
  const operator = { id: 'operator', name: 'Ada Example' };
  const t = ticket('PROJ-1', { assignee: operator, moves: [[2, 'Working', operator], [3, 'Finished', operator]], assigns: [] });
  const { team } = run({ tickets: tickets(t), mergeRequests: mrs(mr('ada-example', 'Ada Example')) });
  assert.deepEqual(team.members.map(m => [m['ticket-system-id'], m['git-username'], m.role, m['matched-by']]), [['operator', 'ada-example', 'developer', 'name']]);
});
