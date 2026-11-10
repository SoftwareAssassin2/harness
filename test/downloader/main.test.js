// The downloader as the harness runs it: `harness.sh downloader`, a real
// process, acli and glab replaced by fakes on PATH, the agent-cli real.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../support/until.js';
import { withExampleEngines } from '../support/engine-walk.js';

const HARNESS = join(import.meta.dirname, '..', '..', 'harness.sh');

// A folder of fake acli and glab: acli answers the board's active sprints with sprint 10 (its pinned one), a sprint search with EX-1 (or the sprint's keys given), a backlog search with EX-9 and any comment list with comment 7;
// glab lists one merged MR for EX-1 (or, given glab, runs that bash instead).
const issue = (key, type) => ({ key, fields: { summary: `Summary ${key}`, description: 'D', status: { name: 'To Do' }, priority: { name: 'Medium' }, assignee: null, issuetype: { name: type }, customfield_10016: 2, issuelinks: [], sprint: { name: 'Sprint 10' } } });
function fakeBin({ sprint = ['EX-1'], glab } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'acli'), `#!/usr/bin/env bash\ncase "$*" in *"list-sprints"*) echo '[{"id":10,"name":"Sprint 10","state":"active"}]';; *"comment list"*) echo '${JSON.stringify({ comments: [{ id: '7', author: { displayName: 'Ann' }, body: 'Hi', created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T10:00:00.000+0000' }] })}';; *"sprint = 10"*) echo '${JSON.stringify(sprint.map(k => issue(k, 'Bug')))}';; *) echo '${JSON.stringify({ issues: [issue('EX-9', 'Story')] })}';; esac\n`);
  writeFileSync(join(bin, 'glab'), `#!/usr/bin/env bash\n${glab ?? `echo '${JSON.stringify([{ iid: 3, title: 'EX-1: fix', source_branch: 'change/ex-1', state: 'merged', web_url: 'https://gitlab.com/g/p/-/merge_requests/3' }])}'`}\n`);
  chmodSync(join(bin, 'acli'), 0o755);
  chmodSync(join(bin, 'glab'), 0o755);
  return bin;
}
// A projects/ folder: project p (jira source, one Active repo, sprint 10 active, empty sprint and backlog, last download the day before) and q (no jira source).
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  mkdirSync(join(dir, 'q'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({
    'execution-state-engine': 'example-development',
    'work-sources': [{ type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/EX/boards/1' }],
    repositories: [{ url: 'https://gitlab.com/g/p', status: 'Active' }],
  }));
  writeFileSync(join(dir, 'p', 'last-data-download'), new Date(Date.now() - 86400e3).toISOString());
  writeFileSync(join(dir, 'q', 'project.json'), JSON.stringify({ 'work-sources': [{ type: 'off-board', folder: 'q' }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true, 'jira-sprint-id': 10 }] }));
  // r points at p's board: only the first project on a board is synced.
  mkdirSync(join(dir, 'r'));
  writeFileSync(join(dir, 'r', 'project.json'), JSON.stringify({ 'work-sources': [{ type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/EX/boards/1' }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, features: [], bugs: [], spikes: [] }));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  withExampleEngines(join(dir, 'p'));   // p's own example-development and its refinement (ASS-276)
  return dir;
}
const harnessJson = minutes => { const f = join(mkdtempSync(join(tmpdir(), 'hj-')), 'harness.json'); writeFileSync(f, JSON.stringify({ 'download-updates-interval-in-minutes': minutes })); return f; };
const read = (dir, ...p) => JSON.parse(readFileSync(join(dir, ...p), 'utf8'));

// The downloader, started with these arguments; its stdout and stderr lines, and a promise of its exit. Its
// process group is killed when its test ends, passed or failed (ASS-109). Its HARNESS_HOME is a folder of its
// own (or `home`), so its run-downloader.pid (ASS-338) never meets a real running harness's.
const groups = [];
afterEach(() => { for (const pid of groups.splice(0)) try { process.kill(-pid, 'SIGKILL'); } catch { /* ended */ } });
function start(dir, args, minutes = 60, bin = fakeBin(), home = mkdtempSync(join(tmpdir(), 'harness-home-'))) {
  const harness = harnessJson(minutes);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: dir, HARNESS_JSON: harness, HARNESS_HOME: home };
  const child = spawn(HARNESS, ['downloader', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env, detached: true });
  groups.push(child.pid);
  const out = [], err = [];
  createInterface({ input: child.stdout }).on('line', l => out.push(l));
  createInterface({ input: child.stderr }).on('line', l => err.push(l));
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, out, err, exit, harness, home };
}

test('harness.sh downloader --once runs one cycle for each project with a jira source (one per board) or an off-board one, writing through the agent-cli, and exits', async () => {
  const dir = projects();
  const { out, err, exit } = start(dir, ['--once']);
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.deepEqual(err, [], err.join('\n'));
  assert.ok(out.length >= 3 && out.every(l => /^\d{4}-\d\d-\d\dT[\d:.]+Z (p|q|r) /.test(l)), out.join('\n'));
  assert.ok(out.some(l => / q no jira work source; Jira skipped$/.test(l)), out.join('\n'));   // off-board only: downloaded too
  assert.ok(out.some(l => / r skipped: the same Jira board as p$/.test(l)), out.join('\n'));
  assert.ok(!existsSync(join(dir, 'r', 'backlog.json')));
  const sprint = read(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
  assert.deepEqual(sprint.bugs.map(t => [t.key, t.title, t.points, t.priority]), [['EX-1', 'Summary EX-1', 2, 1]]);
  assert.deepEqual(sprint.bugs[0].variations[0]['merge-request'], [{ key: '!3', 'build-status': 'Merged', url: 'https://gitlab.com/g/p/-/merge_requests/3', status: 'Merged', branch: 'change/ex-1' }]);
  assert.deepEqual(read(dir, 'p', 'backlog.json').tickets.map(t => [t.key, t.variations[0]['harness-status'].state]), [['EX-9', 'groom']]);   // its refinement engine's first step (ASS-144)
  assert.match(readFileSync(join(dir, 'p', 'last-data-download'), 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.ok(existsSync(join(dir, 'p', 'sprints', 'days')), 'the previous day was snapshotted');
  // The first cycle is a comment cycle (then every 15th): each Jira ticket's comments kept in its work folder.
  for (const key of ['EX-1', 'EX-9']) assert.deepEqual(read(dir, 'p', 'work', key, 'jira-comments.json'), { 7: { author: 'Ann', created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T10:00:00.000+0000', body: 'Hi' } });
});

test('harness.sh downloader --once --dry-run prints what it would run and writes nothing', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8');
  const { out, exit } = start(dir, ['--once', '--dry-run']);
  assert.equal((await exit).code, 0);
  assert.ok(out.some(l => /would run: agent\.sh ticket:sync p sprint/.test(l)), out.join('\n'));
  assert.equal(readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'), before);
  assert.ok(!existsSync(join(dir, 'p', 'sprints', 'days')));
});

test('the downloader waits for the interval in naps of at most 5 seconds, silently, reading the interval again each nap; and exits when its stdin closes', async () => {
  const dir = projects();
  const { child, out, exit, harness } = start(dir, [], 60);
  try {
    const cycles = () => out.filter(l => / p backlog: /.test(l)).length;
    assert.ok(await until(() => cycles() === 1), out.join('\n'));
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!out.some(l => /sleeping/.test(l)), out.join('\n'));           // nothing is logged while it waits
    writeFileSync(harness, JSON.stringify({ 'download-updates-interval-in-minutes': 0.01 }));   // an edit applies within one nap: the next cycle comes within seconds (a nap and a cycle, slower on a busy machine), not 60 minutes
    assert.ok(await until(() => cycles() >= 2), out.join('\n'));
    child.stdin.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
  } finally {
    child.kill();
  }
});

// ASS-122, with a fake glab: example-project's !3011 (EX-2368's, wrongly recorded on EX-1201 too) and !3012 (EX-2402's,
// a sprint-file ticket Jira's sprint no longer returns) are older than the newest 100, which list neither; EX-1201's real
// !2744 is found only by its branch. !404 cannot be read.
const MR = n => `https://gitlab.com/g/p/-/merge_requests/${n}`;
const glabMr = (iid, branch, state, pipeline) => JSON.stringify({ iid, title: 'T', source_branch: branch, state, web_url: MR(iid), head_pipeline: { status: pipeline } });
const OLD_GLAB = `case "$*" in
  *"mr view 3011 "*) echo '${glabMr(3011, 'change/EX-2368', 'closed', 'failed')}';;
  *"mr view 3012 "*) echo '${glabMr(3012, 'change/EX-2402', 'merged', 'success')}';;
  *"mr view "*) echo '404 Not Found' >&2; exit 1;;
  *"--source-branch change/EX-1201 "*) echo '[${glabMr(2744, 'change/EX-1201', 'merged', 'success')}]';;
  *) echo '[]';;
esac`;
function oldRecords(extra = []) {
  const dir = projects();
  const ticket = (key, mrs) => ({ key, title: `Summary ${key}`, 'issue-type': 'Bug', priority: 1, variations: [{ name: 'A', build: { branch: null }, 'harness-status': { state: 'backlog' }, 'merge-request': mrs }] });
  const pending = n => ({ key: `!${n}`, 'build-status': 'Pending', url: MR(n) });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, features: [], spikes: [], bugs: [
    ticket('EX-1201', [pending(3011)]), ticket('EX-2368', [pending(3011), ...extra]), ticket('EX-2402', [pending(3012)]),
  ] }));
  return dir;
}
const recordedMrs = dir => Object.fromEntries(read(dir, 'p', 'sprints', 'sprint-10', 'sprint.json').bugs.map(t => [t.key, t.variations[0]['merge-request'].map(m => [m.key, m.status ?? null, m['build-status']])]));

test('a lookup cycle refreshes recorded merge requests older than the newest 100 by their urls, on every sprint ticket, and finds a ticket\'s real one beside a wrong one recorded (ASS-122 AC1, AC2, AC4)', async () => {
  const dir = oldRecords();
  const { err, exit } = start(dir, ['--once'], 60, fakeBin({ sprint: ['EX-1201', 'EX-2368'], glab: OLD_GLAB }));
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.deepEqual(err, [], err.join('\n'));
  assert.deepEqual(recordedMrs(dir), {
    'EX-1201': [['!3011', 'Closed', 'Failed'], ['!2744', 'Merged', 'Merged']],   // the wrong one kept, refreshed; the real one beside it
    'EX-2368': [['!3011', 'Closed', 'Failed']],
    'EX-2402': [['!3012', 'Merged', 'Merged']],                                 // not in the fetch: refreshed all the same
  });
});

test('a recorded merge request that cannot be read keeps every record as it is, and nothing is added (ASS-122 AC3, AC4)', async () => {
  const dir = oldRecords([{ key: '!404', 'build-status': 'Pending', url: MR(404) }]);
  const before = recordedMrs(dir);
  const { out, exit } = start(dir, ['--once'], 60, fakeBin({ sprint: ['EX-1201', 'EX-2368'], glab: OLD_GLAB }));
  assert.equal((await exit).code, 0);
  assert.deepEqual(recordedMrs(dir), before);
  assert.ok(out.some(l => l.includes(`p ${MR(404)}: merge request skipped: `) && l.endsWith('404 Not Found')), out.join('\n'));
});

// ASS-338: a live process that ps shows running a downloader/main.js — the other downloader.
function otherDownloader() {
  const dir = mkdtempSync(join(tmpdir(), 'dl-other-'));
  mkdirSync(join(dir, 'downloader'));
  writeFileSync(join(dir, 'downloader', 'main.js'), 'setTimeout(() => {}, 600000);');
  const child = spawn(process.execPath, [join(dir, 'downloader', 'main.js')], { stdio: 'ignore', detached: true });
  groups.push(child.pid);
  return child.pid;
}

test('ASS-338 AC3: while another downloader runs (run-downloader.pid under HARNESS_HOME names it), the downloader says so and exits non-zero, syncing nothing', async () => {
  const dir = projects();
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  const other = otherDownloader();
  writeFileSync(join(home, 'run-downloader.pid'), `${other}\n`);
  const before = readFileSync(join(dir, 'p', 'last-data-download'), 'utf8');
  const { out, err, exit } = start(dir, ['--once'], 60, fakeBin(), home);
  const { code } = await exit;
  assert.notEqual(code, 0);
  assert.deepEqual(err, [`downloader: already running as pid ${other} (${join(home, 'run-downloader.pid')})`]);
  assert.deepEqual(out, []);
  assert.equal(readFileSync(join(dir, 'p', 'last-data-download'), 'utf8'), before, 'nothing synced');
  assert.ok(!existsSync(join(dir, 'p', 'sprints', 'days')));
  assert.equal(readFileSync(join(home, 'run-downloader.pid'), 'utf8'), `${other}\n`);
});

test('ASS-338 AC3: a run-downloader.pid whose process is gone, or is not a downloader, is stale: the downloader takes it over, runs, and removes it as it exits', async () => {
  for (const stale of [999999, process.pid]) {
    const dir = projects();
    const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
    writeFileSync(join(home, 'run-downloader.pid'), `${stale}\n`);
    const { child, out, exit } = start(dir, [], 60, fakeBin(), home);
    assert.ok(await until(() => out.some(l => / p backlog: /.test(l))), out.join('\n'));
    const held = Number(readFileSync(join(home, 'run-downloader.pid'), 'utf8'));
    assert.ok(held && held !== stale, `taken over from ${stale}`);
    child.stdin.end();
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.equal(existsSync(join(home, 'run-downloader.pid')), false);
  }
});
