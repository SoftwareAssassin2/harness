// A product ticket waiting on a fix ticket (ASS-14): ticket:wait-on records
// the key it waits on; ticket:fix-landed reports whether that ticket is Done
// and merged (0), closed without a merge (3), or not yet (1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const exitOf = promise => promise.then(() => 0, e => e.code);

// The fixture with q's off-board source keyed Q, and its Q-1 as the fix ticket ABC-3 A waits on.
function waiting() {
  const f = fixture();
  const project = join(f.dir, 'projects', 'q', 'project.json');
  const q = JSON.parse(readFileSync(project, 'utf8'));
  q['work-sources'][0] = { ...q['work-sources'][0], folder: 'q', 'key-prefix': 'Q' };
  writeFileSync(project, JSON.stringify(q));
  const sprint = join(f.dir, 'projects', 'q', 'sprints', 'sprint-1', 'sprint.json');
  const fix = changes => {
    const s = JSON.parse(readFileSync(sprint, 'utf8'));
    s.features[0] = { ...s.features[0], ...changes };
    writeFileSync(sprint, JSON.stringify(s));
  };
  return { ...f, fix };
}

test('ticket:wait-on records the fix ticket a variation waits on, in the project its key names; refused for a key no project claims', async () => {
  const f = waiting();
  assert.deepEqual(JSON.parse((await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'q-1')).stdout), { ticket: 'ABC-3', variation: 'A', 'waits-on': { project: 'q', ticket: 'Q-1' } });
  assert.deepEqual(f.variation('A')['waits-on'], { project: 'q', ticket: 'Q-1' });
  await fails(f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'ZZZ-9'), /ZZZ-9 names no project/);
});

test('ticket:fix-landed: 0 once the fix is Done and merged, 3 when it was closed without a merge, 1 until then', async () => {
  const f = waiting();
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'Q-1');
  const landed = () => exitOf(f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A'));
  f.fix({ 'ticket-system-status': 'In Progress' });
  assert.equal(await landed(), 1);                                                             // not yet
  const merged = [{ 'from-state': 'merge-pull-request', 'to-state': 'update-workspace' }, { 'from-state': 'await-restart', 'to-state': 'done' }];
  f.fix({ 'ticket-system-status': 'Done', variations: [{ name: 'A', 'harness-status': { state: 'done' }, 'state-changes': merged }] });
  assert.equal(await landed(), 0);
  assert.deepEqual(JSON.parse((await f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A')).stdout), { 'waits-on': { project: 'q', ticket: 'Q-1' }, status: 'Done', landed: true });
  f.fix({ 'ticket-system-status': 'Done', variations: [{ name: 'A', 'harness-status': { state: 'done' }, 'state-changes': [{ 'from-state': 'committed', 'to-state': 'done' }] }] });
  assert.equal(await landed(), 3);                                                             // Done, but nothing merged
  await fails(f.agent('ticket:fix-landed', 'p', 'ABC-3', 'B'), /ABC-3 B waits on no ticket/);
});

// ASS-309 AC1: under a grouped engine (harness-development-v2) the merge step lives in a
// sub-engine (v2-release), so the fix ticket's own history has release → release with
// merge-pull-request in its sub-state-change — a merge at any depth landed the fix (ASS-304
// merged yet read as unmerged, sending Blocked's await-fix round again).
test('ticket:fix-landed: a merge step nested in a sub-state-change, at any depth, landed the fix too (ASS-309)', async () => {
  const f = waiting();
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'Q-1');
  const landed = () => exitOf(f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A'));
  const top = (from, to, sub) => ({ 'state-engine': 'harness-development-v2', 'from-state': from, 'to-state': to, 'agent-dispatch-log': [], ...(sub ? { 'sub-state-change': sub } : {}) });
  const release = sub => [top('test', 'release'), top('release', 'release', sub), top('release', 'done')];
  const done = changes => f.fix({ 'ticket-system-status': 'Done', variations: [{ name: 'A', 'harness-status': { state: 'done' }, 'state-changes': changes }] });
  done(release({ 'state-engine': 'v2-release', 'from-state': 'merge-pull-request', 'to-state': 'update-workspace' }));
  assert.equal(await landed(), 0);
  assert.deepEqual(JSON.parse((await f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A')).stdout), { 'waits-on': { project: 'q', ticket: 'Q-1' }, status: 'Done', landed: true });
  // Nested deeper still, and ensure-auto-merge (a GitLab project's own engine) as well as merge-pull-request.
  done(release({ 'state-engine': 'v2-release', 'from-state': 'raise-merge-request', 'to-state': 'await-checks', 'sub-state-change': { 'state-engine': 'merge-request', 'from-state': 'ensure-auto-merge', 'to-state': 'done' } }));
  assert.equal(await landed(), 0);
  // Nothing merged at any depth — it reached the merge step but never moved out of it: Done without its fix merged, as before.
  done(release({ 'state-engine': 'v2-release', 'from-state': 'raise-pull-request', 'to-state': 'merge-pull-request' }));
  assert.equal(await landed(), 3);
});

// ASS-340 AC1: a fix ticket built by hand and committed straight to its project's default branch reaches Done with
// no merge step in its history; a commit whose subject starts "<KEY>:" reachable from that branch (the project's
// local-pc workspace, its default branch origin's: main here, not master) landed it — locally or on origin as fetched.
// AC2: without one — another key that only starts the same, a commit on another branch, or a workspace that cannot be
// read — it is Done without its fix merged, as before.
test('ticket:fix-landed: a Done fix with no merge step landed when a "<KEY>:" commit is on its project\'s default branch (ASS-340)', async () => {
  const f = waiting();
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'Q-1');
  const landed = () => exitOf(f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A'));
  f.fix({ 'ticket-system-status': 'Done', variations: [{ name: 'A', 'harness-status': { state: 'done' }, 'state-changes': [{ 'from-state': 'backlog', 'to-state': 'plan' }] }] });
  const tmp = mkdtempSync(join(tmpdir(), 'fix-landed-'));
  const origin = join(tmp, 'origin.git'), ws = join(tmp, 'workspace');
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { stdio: 'ignore' });
  const commit = message => git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', message);
  const folder = dir => {
    const project = join(f.dir, 'projects', 'q', 'project.json');
    writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: dir }] }));
  };
  assert.equal(await landed(), 3);                                                             // q has no workspace: not landed
  folder(tmp);
  assert.equal(await landed(), 3);                                                             // not a git checkout: not landed
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '-q', origin, ws], { stdio: 'ignore' });
  commit('first');
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  folder(ws);
  commit('Q-10: another ticket whose key starts the same');
  commit('Fix Q-1: the key, but not first');
  assert.equal(await landed(), 3);
  git('checkout', '-q', '-b', 'side');
  commit('Q-1: the fix, on another branch');
  assert.equal(await landed(), 3);
  git('push', '-q', 'origin', 'side:main');                                                    // on origin's main, as last fetched; not the local main
  git('fetch', '-q', 'origin');
  assert.equal(await landed(), 0);
  git('checkout', '-q', 'main');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(await landed(), 3);                                                             // on neither main
  git('merge', '-q', '--ff-only', 'side');                                                     // committed straight to the local main
  assert.equal(await landed(), 0);
  assert.deepEqual(JSON.parse((await f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A')).stdout), { 'waits-on': { project: 'q', ticket: 'Q-1' }, status: 'Done', landed: true });
  f.fix({ 'ticket-system-status': 'In Progress' });
  assert.equal(await landed(), 1);                                                             // its commit alone does not land a ticket not yet Done
});

// ASS-107 AC6 (operator, 2026-10-24): as every state's, the count is per stay — it starts again each time the
// ticket enters Blocked anew. Within one stay Blocked may make up to 3 fix attempts — a fix ticket raised and
// waited on (its await-fix); one closed unmerged goes round Blocked again, the same stay (blocked → blocked).
test('ticket:fix-attempts counts the fix attempts made in the ticket\'s current stay in Blocked; 0 under three, 3 at three with why as its ai-feedback', async () => {
  const f = waiting();
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const history = changes => {
    const s = JSON.parse(readFileSync(sprint, 'utf8'));
    s.features[0].variations.find(v => v.name === 'A')['state-changes'] = changes;
    writeFileSync(sprint, JSON.stringify(s));
  };
  const top = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to });
  const sub = (from, to) => ({ ...top('blocked', 'blocked'), 'sub-state-change': { 'state-engine': 'blocked', 'from-state': from, 'to-state': to } });
  const attempts = async () => { const r = await f.agent('ticket:fix-attempts', 'p', 'ABC-3', 'A').catch(e => e); return [r.code ?? 0, JSON.parse(r.stdout)]; };
  const fixed = sub('wait-on', 'await-fix'), again = top('blocked', 'blocked');
  history([top('build', 'blocked'), sub(null, 'count-attempts'), sub('count-attempts', 'troubleshoot')]);
  assert.deepEqual(await attempts(), [0, { 'fix-attempts': 0 }]);                                     // entering Blocked is no attempt
  history([top('build', 'blocked'), fixed, again, fixed, again]);
  assert.deepEqual(await attempts(), [0, { 'fix-attempts': 2 }]);                                     // two closed unmerged, the same stay
  history([top('build', 'blocked'), fixed, again, fixed, again, fixed, again]);
  const [code, out] = await attempts();
  assert.equal(code, 3);
  assert.equal(out['fix-attempts'], 3);
  assert.equal(out['ai-feedback-short'], '3 fix attempts failed');
  assert.match(out['ai-feedback-long'], /3 fix tickets .* this stay in Blocked/);
  assert.match(out['ai-feedback-long'], /Read them and change-log-A\.md,/, 'ASS-181: the variation\'s own change log');
  // Entering Blocked anew — after a fix landed and the step failed again, or from Blocked for Human — starts the count again.
  history([top('build', 'blocked'), fixed, again, fixed, again, fixed, top('blocked', 'build'), top('build', 'blocked')]);
  assert.deepEqual(await attempts(), [0, { 'fix-attempts': 0 }]);
  history([top('build', 'blocked'), fixed, again, fixed, again, fixed, again, top('blocked', 'blocked-for-human'), top('blocked-for-human', 'blocked'), fixed, again]);
  assert.deepEqual(await attempts(), [0, { 'fix-attempts': 1 }]);
  await fails(f.agent('ticket:fix-attempts', 'p', 'ABC-3', 'Z'), /no ABC-3 variation Z/);
});

// ASS-107 AC7: a fix that cannot be raised or waited on never lets the ticket resume as if fixed —
// Blocked goes to Blocked for Human, these outputs (recorded by its run) saying why.
test('ticket:wait-on: no fix ticket raised (Blocked hands it the blocked ticket itself) or a key no project claims — refused, writing nothing, why printed as ai-feedback', async () => {
  const f = waiting();
  const refused = async (...args) => { const e = await f.agent('ticket:wait-on', ...args).then(() => assert.fail('accepted'), e => e); return [e.code, JSON.parse(e.stdout)]; };
  const [code, none] = await refused('p', 'ABC-3', 'A', 'abc-3');
  assert.equal(code, 3);
  assert.equal(none['ai-feedback-short'], 'No fix ticket was raised');
  const [, unknown] = await refused('p', 'ABC-3', 'A', 'ZZZ-9');
  assert.equal(unknown['ai-feedback-short'], 'The fix ticket cannot be waited on');
  assert.match(unknown['ai-feedback-long'], /ZZZ-9 names no project/);
  assert.equal(f.variation('A')['waits-on'], undefined);
});

// ASS-316 AC3: wait-on takes the reason and why grouped-blocked's
// create-fix-ticket ended with, as optional 5th/6th arguments, and names them
// in the own-key refusal's ai-feedback instead of the generic text; "-" (the
// runValues placeholder when the run has none) or an unknown reason keeps the
// current generic text; the 4-arg form (every other caller, ASS-107 AC7
// above) is unchanged.
test('ASS-316 AC3: ticket:wait-on names why no fix ticket was raised, given the reason and why as its 5th and 6th arguments', async () => {
  const f = waiting();
  // A usage error on the current 4-arg-only script prints no JSON on stdout: parsed leniently, so a still-unimplemented
  // 6-arg call fails these assertions cleanly instead of throwing out of JSON.parse.
  const refused = async (...args) => {
    const e = await f.agent('ticket:wait-on', ...args).then(() => assert.fail('accepted'), e => e);
    let out; try { out = JSON.parse(e.stdout); } catch { out = {}; }
    return [e.code, out];
  };

  const [failCode, failed] = await refused('p', 'ABC-3', 'A', 'abc-3', 'create-failed', 'ticket:create: the ticket store is locked by another run');
  assert.equal(failCode, 3);
  assert.equal(failed['ai-feedback-short'], 'No fix ticket: ticket:create failed');
  assert.match(failed['ai-feedback-long'], /ticket:create: the ticket store is locked by another run/);
  assert.equal(f.variation('A')['waits-on'], undefined, 'nothing written on refusal');

  const [, notHeld] = await refused('p', 'ABC-3', 'A', 'abc-3', 'analysis-did-not-hold', 'the failing job passes on the latest master: nothing to raise');
  assert.equal(notHeld['ai-feedback-short'], 'No fix ticket: the analysis did not hold');
  assert.match(notHeld['ai-feedback-long'], /the failing job passes on the latest master: nothing to raise/);

  for (const reason of ['-', 'something-unknown']) {
    const [code, generic] = await refused('p', 'ABC-3', 'A', 'abc-3', reason, '-');
    assert.equal(code, 3, reason);
    assert.equal(generic['ai-feedback-short'], 'No fix ticket was raised', reason);
  }

  // A why with spaces, quotes and a $ survives into ai-feedback-long as given (jq --arg), one argv word (fillArgs).
  const tricky = 'ticket:create: "the lock" is busy ($TMPDIR/ticket-body.md)';
  const [, withTricky] = await refused('p', 'ABC-3', 'A', 'abc-3', 'create-failed', tricky);
  assert.ok((withTricky['ai-feedback-long'] ?? '').includes(tricky), withTricky['ai-feedback-long']);

  // A real fix key still records waits-on as before — the reason arguments are ignored on that path. The current
  // 4-arg-only script rejects a 6-arg call (usage error), so this is parsed as leniently as `refused` above.
  const succeeds = async (...args) => {
    const r = await f.agent('ticket:wait-on', ...args).then(r => r, e => e);
    let out; try { out = JSON.parse(r.stdout); } catch { out = {}; }
    return out;
  };
  assert.deepEqual(await succeeds('p', 'ABC-3', 'A', 'Q-1', 'create-failed', 'ignored'), { ticket: 'ABC-3', variation: 'A', 'waits-on': { project: 'q', ticket: 'Q-1' } });
  assert.deepEqual(f.variation('A')['waits-on'], { project: 'q', ticket: 'Q-1' });
  // - as the fix key still removes waits-on, reason arguments ignored.
  assert.deepEqual(await succeeds('p', 'ABC-3', 'A', '-', 'create-failed', 'ignored'), { ticket: 'ABC-3', variation: 'A', 'waits-on': null });

  // 5 arguments: a usage error, nothing written.
  const bad = await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'abc-3', 'create-failed').then(() => assert.fail('accepted'), e => e);
  assert.equal(bad.code, 1);
  assert.equal(f.variation('A')['waits-on'], undefined);
});

test('ticket:fix-landed: a variation waiting on nothing exits 4, why printed as ai-feedback', async () => {
  const f = waiting();
  const e = await f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A').then(() => assert.fail('landed'), e => e);
  assert.equal(e.code, 4);
  assert.equal(JSON.parse(e.stdout)['ai-feedback-short'], 'The fix ticket cannot be waited on');
});

// ASS-253 AC3: an abandoned wait — ticket:wait-on with - for the fix key removes the variation's waits-on.
test('ticket:wait-on <p> <t> <v> - removes the waits-on link, leaving the other variations\' be; refused for an unknown variation', async () => {
  const f = waiting();
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', 'Q-1');
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'B', 'Q-1');
  assert.deepEqual(JSON.parse((await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', '-')).stdout), { ticket: 'ABC-3', variation: 'A', 'waits-on': null });
  assert.equal('waits-on' in f.variation('A'), false);
  assert.deepEqual(f.variation('B')['waits-on'], { project: 'q', ticket: 'Q-1' });
  assert.equal(await exitOf(f.agent('ticket:fix-landed', 'p', 'ABC-3', 'A')), 4);               // nothing to wait on any more
  await f.agent('ticket:wait-on', 'p', 'ABC-3', 'A', '-');                                     // none to remove: still fine
  await fails(f.agent('ticket:wait-on', 'p', 'ABC-3', 'Z', '-'), /no ABC-3 variation Z/);
});
