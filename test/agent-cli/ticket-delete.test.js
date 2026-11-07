// ASS-104 — ticket:delete <project> <ticket-key>: a soft delete. The ticket
// gets is-deleted (and deleted-timestamp) wherever it is listed — the active
// sprint, backlog.json — and keeps everything else; first, whatever works on
// it is stopped, its open merge requests closed and its worktree removed.
// Refused once its work has merged. ticket:restore clears the mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixture, run, AGENT, STAMP, TEST_ENGINE, SELF_HEALING_ENGINE } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { fakeForge } from '../support/fake-forge.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const sprintFile = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
// The fixture's assignments without any live process: agent:kill signals none.
const noProcesses = f => edit(f.env.ASSIGNMENTS_FILE, a => { for (const r of a.assignments) r['process-id'] = null; });

test('AC1: ticket:delete marks the sprint ticket deleted, keeping it and its work folder, and prints what it did; an unknown ticket fails, writing nothing', async () => {
  const f = fixture();
  noProcesses(f);
  mkdirSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3'), { recursive: true });
  writeFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'notes.md'), 'kept\n');
  const before = f.snapshot();
  await fails(f.agent('ticket:delete', 'p', 'ABC-99'), /ticket:delete: no ABC-99 in p's sprint or backlog/);
  assert.equal(f.snapshot(), before);

  const { stdout } = await f.agent('ticket:delete', 'p', 'abc-3');
  const out = JSON.parse(stdout);
  assert.equal(out.key, 'ABC-3');
  assert.deepEqual(out.marked, ['sprint']);
  const t = f.sprint().features[0];
  assert.equal(t['is-deleted'], true);
  assert.match(t['deleted-timestamp'], STAMP);
  assert.equal(t.variations.length, 4);                                             // the ticket itself is kept
  assert.equal(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'notes.md'), 'utf8'), 'kept\n');
});

test('AC2: ticket:delete refuses, writing nothing, a ticket with a merged merge request on a live variation, naming it', async () => {
  const f = fixture();
  noProcesses(f);
  edit(sprintFile(f), s => {
    s.features[0].variations[1]['merge-request'] = [{ key: '!7', url: 'https://gitlab.com/g/app/-/merge_requests/7', status: 'Open', 'build-status': 'Pending' }];
    s.features[0].variations[2]['merge-request'] = [{ key: '!8', url: 'https://gitlab.com/g/app/-/merge_requests/8', status: 'Merged', 'build-status': 'Merged' }];
  });
  const before = f.snapshot();
  await fails(f.agent('ticket:delete', 'p', 'ABC-3'), /ticket:delete: ABC-3's work has merged \(variation C, !8 https:\/\/gitlab.com\/g\/app\/-\/merge_requests\/8\); it is not deleted/);
  assert.equal(f.snapshot(), before);
});

// A process in a group of its own, as control starts an agent; alive() asks whether it still runs.
function agentProcess() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid, alive: () => { try { process.kill(child.pid, 0); return true; } catch { return false; } } };
}

test('AC5: ticket:delete first stops the ticket\'s agents as control does (agent:kill, assignments:remove) and removes its transient runs and their agents; other work goes on', async () => {
  const f = fixture();
  const agent = agentProcess();
  edit(f.env.ASSIGNMENTS_FILE, a => {
    a.assignments[0]['process-id'] = agent.pid;                                     // Daredevil, on ABC-3 A
    a.assignments.push({ ...a.assignments[2], 'agent-name': 'Hulk', 'process-id': null, 'transient-state-engine': TEST_ENGINE, 'state-engine': 'test', state: 'test' });
  });
  const out = JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-3')).stdout);
  assert.equal(agent.alive(), false);
  assert.deepEqual(out.agents, ['Daredevil', 'Spock', 'Hulk']);
  assert.deepEqual(out.runs, [TEST_ENGINE]);
  const left = f.assignments();
  assert.deepEqual(left.assignments.map(a => a['agent-name']), ['Leia']);
  assert.deepEqual(left['transient-state-engines'].map(r => r.id), [SELF_HEALING_ENGINE]);
  // assignments:remove closed their dispatches on the sprint, as when control ends an agent.
  assert.ok(f.variation('A')['state-changes'][1]['agent-dispatch-log'].every(d => d['completed-timestamp'] != null));
  assert.equal(f.sprint().features[0]['is-deleted'], true);
});

test('AC5: ticket:delete stops the VM of each live variation (vm:stop) and keeps it', async () => {
  const f = fixture();
  noProcesses(f);
  const v = fakeVm(f.env);
  v.instance('abc-3-a', 'Running');
  v.instance('abc-3-b', 'Stopped');
  edit(join(f.dir, 'harness.json'), h => { h['vm-disk-limit-gb'] = 100; });
  edit(sprintFile(f), s => {
    s.features[0].variations[0].vm = { name: 'abc-3-a' };
    s.features[0].variations[1].vm = { name: 'abc-3-b' };
  });
  const out = JSON.parse((await run(AGENT, ['ticket:delete', 'p', 'ABC-3'], { env: v.env })).stdout);
  assert.deepEqual(out.vms, ['abc-3-a', 'abc-3-b']);
  assert.equal(readFileSync(join(v.instances, 'abc-3-a', 'status'), 'utf8'), 'Stopped');
  assert.ok(!v.calls().some(c => c.argv?.[0] === 'delete'));                         // kept, for a restore
  assert.deepEqual(v.calls().filter(c => c.argv?.[0] === 'stop').map(c => c.argv.at(-1)), ['abc-3-a']);
});

test('ticket:delete closes each open merge request of a live variation on its forge, unmerged (gh pr close; GitLab\'s API), recording it Closed', async () => {
  const f = fixture();
  noProcesses(f);
  const forge = fakeForge();
  forge.route('gh', /^pr close /, {});
  forge.route('glab', /^api projects\/g%2Fapp\/merge_requests\/7 --hostname gitlab.com -X PUT -f state_event=close$/, { out: { iid: 7, state: 'closed' } });
  const hub = 'https://github.com/o/h/pull/12', lab = 'https://gitlab.com/g/app/-/merge_requests/7';
  edit(sprintFile(f), s => {
    s.features[0].variations[0]['merge-request'] = [{ key: '#12', url: hub, status: 'Open', 'build-status': 'Passed' }, { id: 2, key: null, url: null, status: 'Not Created' }];
    s.features[0].variations[1]['merge-request'] = [{ key: '!7', url: lab, status: 'Open', 'build-status': 'Pending' }, { key: '!6', url: 'https://gitlab.com/g/app/-/merge_requests/6', status: 'Closed', 'build-status': 'Failed' }];
    s.features[0].variations[3]['merge-request'] = [{ key: '!5', url: 'https://gitlab.com/g/app/-/merge_requests/5', status: 'Open', 'build-status': 'Pending' }];   // D, set aside
  });
  const out = JSON.parse((await run(AGENT, ['ticket:delete', 'p', 'ABC-3'], { env: { ...f.env, PATH: forge.path } })).stdout);
  assert.deepEqual(out['closed-merge-requests'], [hub, lab]);
  assert.deepEqual(forge.log('gh'), [`pr close ${hub}`]);
  assert.deepEqual(forge.log('glab').filter(l => l !== 'auth status'), ['api projects/g%2Fapp/merge_requests/7 --hostname gitlab.com -X PUT -f state_event=close']);
  assert.deepEqual(f.variation('A')['merge-request'].map(m => m.status), ['Closed', 'Not Created']);
  assert.deepEqual(f.variation('B')['merge-request'].map(m => m.status), ['Closed', 'Closed']);
  assert.equal(f.variation('D')['merge-request'][0].status, 'Open');
  assert.ok(!forge.log('gh').some(l => /merge/.test(l)));                              // nothing merged
});

test('ticket:delete removes each live variation\'s worktree, uncommitted changes and all, and keeps its branch', async () => {
  const f = fixture();
  noProcesses(f);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=master');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(workspace, 'README.md'), 'one\n'); git('add', '.'); git('commit', '-q', '-m', 'one');
  git('branch', 'change/ABC-3');
  const folder = join(workspace, '.worktrees', 'ABC-3');
  git('worktree', 'add', '--quiet', folder, 'change/ABC-3');
  writeFileSync(join(folder, 'wip.txt'), 'unsaved\n');
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['local-environments'] = [{ type: 'local-pc', folder: workspace }]; });
  edit(sprintFile(f), s => {
    s.features[0].variations[0].build = { branch: 'change/ABC-3', 'branch-url': null, worktree: 'ABC-3', 'worktree-folder': folder };
    s.features[0].variations[1].build = { branch: 'change/ABC-3.B', worktree: 'ABC-3.B', 'worktree-folder': join(workspace, '.worktrees', 'ABC-3.B') };   // gone already
  });
  const out = JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-3')).stdout);
  assert.deepEqual(out.worktrees, [folder]);
  assert.equal(existsSync(folder), false);
  assert.ok(!git('worktree', 'list').includes('.worktrees/ABC-3'));
  assert.equal(git('branch', '--list', 'change/ABC-3'), 'change/ABC-3');
  assert.deepEqual(f.variation('A').build, { branch: 'change/ABC-3', 'branch-url': null, worktree: null, 'worktree-folder': null });
});

test('ticket:delete gives the workspace back (code:release-workspace) when the ticket holds it, as control does once it has stopped an agent there', async () => {
  const f = fixture();
  noProcesses(f);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=master');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(workspace, 'README.md'), 'one\n'); git('add', '.'); git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'change/ABC-3.B');
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['local-environments'] = [{ type: 'local-pc', folder: workspace, 'active-branch': 'change/ABC-3.B', 'return-to': 'master' }]; });
  edit(sprintFile(f), s => { s.features[0].variations[1].build = { branch: 'change/ABC-3.B' }; });
  await f.agent('ticket:delete', 'p', 'ABC-3');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'))['local-environments'][0]['active-branch'], null);
});

test('AC1: a backlog ticket, Jira\'s as much as off-board\'s, is marked in backlog.json; one listed in both files is marked in both', async () => {
  const f = fixture();
  noProcesses(f);
  const backlog = join(f.dir, 'projects', 'p', 'backlog.json');
  writeFileSync(backlog, JSON.stringify({ tickets: [
    { key: 'ABC-9', url: 'https://x.atlassian.net/browse/ABC-9', variations: [{ name: 'A', 'harness-status': { state: 'grooming', 'state-engine': null }, 'merge-request': [] }] },
    { key: 'ABC-3', variations: [] },
  ] }));
  assert.deepEqual(JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-9')).stdout).marked, ['backlog']);
  assert.deepEqual(JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-3')).stdout).marked, ['sprint', 'backlog']);
  const tickets = JSON.parse(readFileSync(backlog, 'utf8')).tickets;
  assert.deepEqual(tickets.map(t => t['is-deleted']), [true, true]);
  assert.equal(f.sprint().features[0]['is-deleted'], true);
});

test('ticket:restore clears the deleted mark wherever it is; a ticket not deleted fails, writing nothing', async () => {
  const f = fixture();
  noProcesses(f);
  const before = f.snapshot();
  await fails(f.agent('ticket:restore', 'p', 'ABC-3'), /ticket:restore: ABC-3 is not deleted in p/);
  assert.equal(f.snapshot(), before);
  await f.agent('ticket:delete', 'p', 'ABC-3');
  assert.deepEqual(JSON.parse((await f.agent('ticket:restore', 'p', 'abc-3')).stdout), { key: 'ABC-3', restored: ['sprint'] });
  const t = f.sprint().features[0];
  assert.equal('is-deleted' in t || 'deleted-timestamp' in t, false);
});

test('the mark survives every sync: ticket:sync keeps it on a ticket it updates, and a ticket deleted in one file arrives in the other deleted', async () => {
  const f = fixture();
  noProcesses(f);
  const backlog = join(f.dir, 'projects', 'p', 'backlog.json');
  writeFileSync(backlog, JSON.stringify({ tickets: [{ key: 'ABC-9', title: 'Old', variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': null } }] }] }));
  await f.agent('ticket:delete', 'p', 'ABC-3');
  await f.agent('ticket:delete', 'p', 'ABC-9');
  const fetched = (name, ...keys) => { const file = join(f.dir, name); writeFileSync(file, JSON.stringify({ tickets: keys.map(key => ({ key, title: 'New', 'ticket-system-status': 'To Do', 'issue-type': 'Story' })) })); return file; };
  await f.agent('ticket:sync', 'p', 'sprint', fetched('sprint-fetch.json', 'ABC-3', 'ABC-9'));
  await f.agent('ticket:sync', 'p', 'backlog', fetched('backlog-fetch.json', 'ABC-9', 'ABC-3'));
  const sprint = f.sprint().features, tickets = JSON.parse(readFileSync(backlog, 'utf8')).tickets;
  assert.deepEqual(sprint.map(t => [t.key, t.title, t['is-deleted']]), [['ABC-3', 'New', true], ['ABC-9', 'New', true]]);
  assert.deepEqual(tickets.map(t => [t.key, t.title, t['is-deleted']]), [['ABC-9', 'New', true], ['ABC-3', 'New', true]]);
  assert.equal(sprint[1]['deleted-timestamp'], tickets[0]['deleted-timestamp']);   // the one deletion, carried across
});

// ASS-146: the memories an agent saved working a deleted ticket may not hold;
// deleting it starts its project's check-memory run scoped to it — the
// execution engine's check-memory-steps, the ticket's key its work-item — once.
const withMemoryCheck = f => edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
  e['check-memory-steps'] = [{ id: 'check-memory', sequence: 1, action: { type: 'state-engine', engine: 'check-memory' } }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }];
});
const reviews = f => f.assignments()['transient-state-engines'].filter(r => r.parent.trigger === 'check-memory');

test('ASS-146 AC1: ticket:delete starts a review of the ticket\'s memories — its check-memory-steps, scoped to it — and names it; a second delete starts no second while it runs', async () => {
  const f = fixture();
  noProcesses(f);
  withMemoryCheck(f);
  const out = JSON.parse((await f.agent('ticket:delete', 'p', 'abc-3')).stdout);
  const [review, ...more] = reviews(f);
  assert.deepEqual(more, []);
  assert.deepEqual([review.project, review['state-engine'], review.state, review.parent], ['p', 'example-development/check-memory-steps', 'check-memory', { trigger: 'check-memory', 'work-item': 'ABC-3' }]);
  assert.equal(out['memory-review'], review.id);
  const again = JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-3')).stdout);
  assert.deepEqual(reviews(f).map(r => r.id), [review.id]);                        // kept, not stopped as the ticket's work is
  assert.equal(again['memory-review'], review.id);
});

test('ASS-146 AC1: an engine without check-memory-steps starts no review; ticket:restore starts none and brings back nothing removed', async () => {
  const f = fixture();
  noProcesses(f);
  const out = JSON.parse((await f.agent('ticket:delete', 'p', 'ABC-3')).stdout);
  assert.equal(out['memory-review'], null);
  assert.deepEqual(reviews(f), []);
  withMemoryCheck(f);
  const runs = f.assignments()['transient-state-engines'];
  await f.agent('ticket:restore', 'p', 'ABC-3');
  assert.deepEqual(f.assignments()['transient-state-engines'], runs);
});

// ASS-179 AC4: these writers choose the active sprint inside the project's
// tickets.lock (ASS-174), as sprint:advance takes it. holdTickets(t, f) holds
// it as an advance would; advanced(f) is that advance: sprint 11 begins, a copy
// of sprint 10, and sprint 10 closes. A write that waited lands on sprint 11.
async function holdTickets(t, f) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', join(f.dir, 'projects', 'p', 'tickets.lock')]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return () => new Promise(resolve => { holder.once('exit', resolve); holder.kill('SIGKILL'); });
}
function advanced(f) {
  const p = join(f.dir, 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-11'));
  writeFileSync(join(p, 'sprints', 'sprint-11', 'sprint.json'), readFileSync(sprintFile(f), 'utf8'));
  edit(join(p, 'sprints.json'), s => { for (const e of s.list) e['is-active'] = false; s.list.push({ number: 11, 'is-active': true }); });
  return file => JSON.parse(readFileSync(join(p, 'sprints', `sprint-${file}`, 'sprint.json'), 'utf8'));
}
const settle = () => new Promise(resolve => setTimeout(resolve, 1000));

test('ASS-179 AC4: ticket:delete and ticket:restore choose the sprint inside the tickets lock — one that waited out a sprint:advance marks the new sprint\'s copy, never the closed one', async t => {
  const f = fixture();
  noProcesses(f);
  let release = await holdTickets(t, f);
  const deleting = f.agent('ticket:delete', 'p', 'ABC-3');
  await settle();
  const sprint = advanced(f);
  await release();
  assert.deepEqual(JSON.parse((await deleting).stdout).marked, ['sprint']);
  assert.deepEqual([sprint(10).features[0]['is-deleted'], sprint(11).features[0]['is-deleted']], [undefined, true]);

  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0]['is-deleted'] = true; });
  release = await holdTickets(t, f);
  const restoring = f.agent('ticket:restore', 'p', 'ABC-3');
  await settle();
  // the next advance: sprint 12, from sprint 11 (ABC-3 deleted there)
  const p = join(f.dir, 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-12'));
  writeFileSync(join(p, 'sprints', 'sprint-12', 'sprint.json'), readFileSync(join(p, 'sprints', 'sprint-11', 'sprint.json'), 'utf8'));
  edit(join(p, 'sprints.json'), s => { for (const e of s.list) e['is-active'] = false; s.list.push({ number: 12, 'is-active': true }); });
  await release();
  await restoring;
  assert.deepEqual([sprint(11).features[0]['is-deleted'], sprint(12).features[0]['is-deleted']], [true, undefined]);
});

test('ASS-179 AC4: transient-state-engine:create counts its run into the sprint active once it holds the tickets lock, never one closed while it waited', async t => {
  const f = fixture();
  const release = await holdTickets(t, f);
  const creating = f.agent('transient-state-engine:create', 'p', 'test', 'test', JSON.stringify({ trigger: 'x' }));
  await settle();
  const sprint = advanced(f);
  await release();
  await creating;
  const count = n => (sprint(n)['connected-flows'] ?? []).find(e => e.name === 'test')?.['run-count'];
  assert.deepEqual([count(10), count(11)], [undefined, 1]);
});
