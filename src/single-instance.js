// One harness at a time (ASS-338): a pid file under HARNESS_HOME
// (~/.harness by default) names the process that runs a part of the harness
// — run-tui.pid the dashboard, run-downloader.pid the downloader — and a
// second one finds it and stops. Control's own run-<id>.pid (control/main.js)
// is older and kept as it is.
import { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// harnessHome(env) — the folder of the pid files: HARNESS_HOME, or ~/.harness.
export const harnessHome = (env = process.env) => env.HARNESS_HOME ?? join(homedir(), '.harness');

// runs(script) — pid => whether that process is alive and running `script`
// (e.g. 'tui/main.js'), by its command line as ps shows it: a stale file's
// pid may since have gone to something else, which holds no claim.
export const runs = script => pid => {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes(script); } catch { return false; }
};

const pidIn = file => { try { return Number(readFileSync(file, 'utf8').trim()) || null; } catch { return null; } };
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// claim(file, { owner, pid }) — { claimed: true } once `file` names `pid`
// (this process by default); { claimed: false, pid } while it names another
// process that owner(pid) says is alive and one of ours. A file naming a
// process that is gone, or isn't ours, is stale and taken over.
// Race-safe: the file appears whole or not at all (a link of a file already
// holding the pid, which fails if it exists), and a stale one is removed
// only under `<file>.lock`, made exclusively ('wx'), and only while it still
// names the pid found stale — so of two started at once, exactly one wins.
export function claim(file, { owner, pid = process.pid }) {
  mkdirSync(dirname(file), { recursive: true });
  const mine = `${file}.${pid}`;
  writeFileSync(mine, `${pid}\n`);
  try {
    for (;;) {
      try { linkSync(mine, file); return { claimed: true }; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const held = pidIn(file);
      if (held === pid) return { claimed: true };
      if (held && owner(held)) return { claimed: false, pid: held };
      takeOver(file, held);
    }
  } finally {
    try { unlinkSync(mine); } catch { /* gone */ }
  }
}

// Removes `file`, found naming `stale`, under the lock; another doing the
// same holds the lock a moment, so this waits for it, and a lock whose maker
// died part-way (its pid inside gone) is removed.
function takeOver(file, stale) {
  const lock = `${file}.lock`;
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = pidIn(lock);
    if (holder && !alive(holder)) try { unlinkSync(lock); } catch { /* another removed it */ }
    else pause(10);
    return;
  }
  try {
    if (pidIn(file) === stale) unlinkSync(file);
  } catch { /* already gone */ } finally {
    unlinkSync(lock);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// release(file, pid) — removes `file` if it still names `pid` (this process
// by default): a claim since taken over by another is left to it.
export function release(file, pid = process.pid) {
  if (pidIn(file) !== pid) return;
  try { unlinkSync(file); } catch { /* already gone */ }
}
