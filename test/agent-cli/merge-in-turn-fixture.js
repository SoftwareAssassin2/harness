// ASS-197's merge queue fixture (merge-request:merge-in-turn), shared by its
// tests: a real workspace, a clone of a bare origin; gh a fake that merges into
// it. ASS-257: every process a test starts through it — the lock holders it
// spawns, and each gate (a session of its own, setsid, so its process group is
// its pid) with all it runs — is killed when the test ends, however it ends:
// passing, failing or past its time limit (t.after), or the test process
// exiting first (--test-force-exit). The full tests' hang (slow) is lifted
// first, and gives up by itself after a couple of minutes, so not even a test
// process killed outright leaves a gate behind for long.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const REPO = 'https://github.com/owner/repo';
const pause = ms => new Promise(r => setTimeout(r, ms));

// The cleanups of the queues not yet cleaned up, run once more as the test process exits.
const pending = new Set();
process.once('exit', () => { for (const cleanup of pending) cleanup(); });
let ownGroup;
const myGroup = () => (ownGroup ??= Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()));
const commandOf = pid => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

// The child has ended (its exit already seen or not).
export const exited = child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(r => child.once('exit', r)));

// Project p: a workspace on main (check.sh, the "full tests": fails when a file
// named broken is there, logs where it ran and its process group, and hangs
// while q.slow is on) and a sprint of ABC-3 and ABC-4, each variation A with
// one Open pull request (#3, #4) from its branch, both cut from main before
// main moved on (main.txt). `t` is the test, whose end cleans up.
export function queue(t) {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'mit-'));
  const origin = join(dir, 'origin.git'), ws = join(dir, 'workspace'), bin = join(dir, 'bin'), runs = join(dir, 'runs.log');
  const slowFlag = join(dir, 'slow'), groupsLog = join(dir, 'groups.log');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', '--quiet', origin, ws], { stdio: 'ignore' });
  const commit = (file, text, message) => { writeFileSync(join(ws, file), text); git(ws, 'add', '.'); execFileSync('git', ['-C', ws, 'commit', '-q', '-m', message], { env: { ...process.env, ...ID } }); };
  // The process group first (the gate's: it is the session's leader), then the run; a hang lasts at most ~2 minutes, failing then.
  writeFileSync(join(ws, 'check.sh'), `#!/bin/sh
ps -o pgid= -p $$ | tr -d ' ' >> "$GATE_GROUPS"
pwd -P >> "$GATE_RUNS"
i=0; while [ -e "$GATE_SLOW" ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i + 1)); done
test ! -e "$GATE_SLOW" && test ! -e broken
`);
  chmodSync(join(ws, 'check.sh'), 0o755);
  commit('README.md', 'hi\n', 'first');
  git(ws, 'push', '-q', '-u', 'origin', 'main');
  git(ws, 'remote', 'set-head', 'origin', 'main');
  const branch = (name, file, text) => { git(ws, 'checkout', '-q', '-b', name, 'main'); commit(file, text, name); git(ws, 'push', '-q', 'origin', name); git(ws, 'checkout', '-q', 'main'); };
  // The fake gh: each pull request's view from pr-<n>.json; a merge merges its branch into main on origin, as GitHub would.
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.log"
case "$1 $2" in
  "api repos/owner/repo") echo '{"default_branch":"main"}' ;;
  "pr view") cat "${dir}/pr-$3.json" ;;
  "pr ready") ;;
  "pr merge") b="$(jq -r .branch "${dir}/pr-$3.json")"; w="$(mktemp -d)"
    git clone -q "${origin}" "$w" && git -C "$w" merge -q --no-ff "origin/$b" -m "Merge #$3" && git -C "$w" push -q origin main && git -C "$w" push -q origin --delete "$b" || exit 1
    jq '.state = "MERGED"' "${dir}/pr-$3.json" > "$w/v" && mv "$w/v" "${dir}/pr-$3.json" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const project = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(join(f.dir, 'projects', 'p', 'project.json'), JSON.stringify({ ...project, 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: ws }] }));
  const ticket = (key, n) => {
    writeFileSync(join(dir, `pr-${n}.json`), JSON.stringify({ state: 'OPEN', baseRefName: 'main', title: key, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', branch: `change/${key}-1` }));
    return { key, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'merge-request': [{ id: 1, repository: REPO, branch: `change/${key}-1`, contents: 'x', 'depends-on': [], status: 'Open', key: `#${n}`, url: `${REPO}/pull/${n}`, base: 'main' }] }] };
  };
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprintFile, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [ticket('ABC-3', 3), ticket('ABC-4', 4)] }, null, 4));
  const env = { ...f.env, ...ID, PATH: `${bin}:${process.env.PATH}`, GATE_RUNS: runs, GATE_SLOW: slowFlag, GATE_GROUPS: groupsLog };
  const step = key => run(AGENT, ['merge-request:merge-in-turn', 'p', key, 'A', './check.sh'], { env, timeout: 60_000 }).then(r => ({ code: 0, out: JSON.parse(r.stdout) }), e => ({ code: e.code, err: e.stderr }));
  // until <condition> <what> [ms] — polls until it holds; past the deadline, an error naming what never happened.
  const until = async (condition, what, ms = 60_000) => {
    for (const end = Date.now() + ms; !condition();) {
      if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
      await pause(50);
    }
  };
  // The step asked again, as its timer does, until it stops waiting.
  const settle = async (key, ms = 120_000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const r = await step(key);
      if (!(r.code === 0 && r.out.waiting)) return r;
      await pause(100);
    }
    throw new Error(`${key}: the gate never finished`);
  };
  const variation = key => JSON.parse(readFileSync(sprintFile, 'utf8')).features.find(x => x.key === key).variations[0];
  const onMain = file => { try { git(origin, 'cat-file', '-e', `main:${file}`); return true; } catch { return false; } };
  const read = (...p) => (existsSync(join(f.dir, 'projects', 'p', ...p)) ? readFileSync(join(f.dir, 'projects', 'p', ...p), 'utf8') : '');
  const lock = join(f.dir, 'projects', 'p', 'merge.lock');
  // A holder of the merge lock, as another ticket's gate would hold it, until killed.
  const holders = [];
  const hold = async key => {
    writeFileSync(join(f.dir, 'projects', 'p', 'merge-lock.json'), JSON.stringify({ ticket: key, variation: 'A', pid: 1, 'taken-at': '2026-10-27T00:00:00Z' }));
    const ready = join(dir, `held-${key}`);
    const child = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; open(my $r, ">", $ARGV[1]); close $r; sleep 600', lock, ready], { stdio: 'ignore' });
    holders.push(child);
    await until(() => existsSync(ready) || child.exitCode !== null, 'the lock holder taking the lock', 30_000);
    if (!existsSync(ready)) throw new Error('no lock');
    return child;
  };
  // The lock free and its holder record gone: the last gate has cleaned up and ended (it does so just after its result).
  const idle = async () => {
    const free = () => execFileSync('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; print flock($f, LOCK_EX | LOCK_NB) ? 1 : 0', lock], { encoding: 'utf8' }) === '1';
    await until(free, 'the merge lock freed');
    return read('merge-lock.json');
  };
  // The gate running now, per the holder record (it writes its pid first thing): its pid, if that process is a gate.
  const gateNow = () => {
    const pid = Number(read('merge-lock.json').match(/"pid": (\d+)/)?.[1]);
    return pid > 1 && /merge-in-turn\.sh --gate /.test(commandOf(pid)) ? pid : null;
  };
  // The process groups of the gates that got as far as the full tests, each a gate's (its pid).
  const groups = () => (existsSync(groupsLog) ? [...new Set(readFileSync(groupsLog, 'utf8').split('\n').filter(Boolean).map(Number))] : []);
  // Synchronous, so it can run as the process exits: the hang lifted, the holders and every gate's process group killed.
  const cleanup = () => {
    pending.delete(cleanup);
    rmSync(slowFlag, { force: true });
    for (const child of holders) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const gate = gateNow();
    for (const g of new Set([...groups(), ...(gate ? [gate] : [])])) {
      if (!(g > 1) || g === myGroup()) continue;
      try { process.kill(-g, 'SIGKILL'); } catch { /* the group has ended */ }
    }
  };
  pending.add(cleanup);
  t?.after(cleanup);
  // slow(on) — the full tests hang while on.
  const slow = on => (on ? writeFileSync(slowFlag, '') : rmSync(slowFlag, { force: true }));
  return { f, dir, idle, ws, origin, runs, branch, commit, step, settle, until, variation, onMain, read, hold, slow, groups, cleanup, ghLog: () => readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n') };
}
