// The dashboard's shut-down (Q): everything it started stopped, and nothing
// of the harness left running — on a quit its VMs too (ASS-417).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// shutDown({ children, agentPids, timeoutMs, alive, kill, log }) — stop()s
// every child ({ name, pid, stop, exited: a promise settled once it has
// ended } — control and the downloader, each its own process group) and
// waits for them all: control stops its agents itself (SIGTERM, SIGKILL after
// 5 seconds). One still running after timeoutMs has its group SIGKILLed.
// Then every agent process agentPids() still names (assignments.json's
// process-id, the leader of the agent's group) that alive() says is still an
// agent — left by a control that was killed, say — has its group SIGKILLed. Each kill is
// log()ged.
// ASS-417: on a quit (restart false) — and only then, so a restart's VMs stay
// up — every golden image build goldenBuilds() names is interrupted, then
// vms.run() stops the VMs (vmStopper): both only now, once control and the
// downloader have ended, so no agent or VM job is running.
export async function shutDown({ children, agentPids, timeoutMs = 20000, alive, kill, log, restart = false, goldenBuilds = () => [], vms }) {
  const ended = new Set();
  for (const c of children) c.exited.then(() => ended.add(c));
  for (const c of children) c.stop();
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.all(children.map(c => c.exited)), late]);
  clearTimeout(timer);
  for (const c of children.filter(c => !ended.has(c))) {
    try { kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
    log(`${c.name} did not stop in time: killed`);
  }
  for (const pid of agentPids().filter(pid => pid != null && alive(pid))) {
    try { kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    log(`agent process ${pid} was still running: killed`);
  }
  if (restart) return;
  for (const { project, pid } of goldenBuilds()) {
    try { kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    log(`golden image build of ${project} interrupted (process ${pid} killed): it is left failed, as a crash leaves it, and the next build starts over`);
  }
  await vms?.run();
}

// ender(options, exit) — end(code): the first call shuts down (shutDown's
// options) and then exit(code)s; a later one — Q pressed, or a second control
// asking for a restart, meanwhile — has the same shut-down, so only one runs
// (ASS-193). A first code of 75 is a restart: its VMs are left running
// (ASS-417). end.force() — Q pressed again — force-stops the VMs still
// stopping (options.vms, vmStopper's force).
export function ender(options, exit) {
  let ending;
  const end = code => (ending ??= shutDown({ ...options, restart: code === 75 }).then(() => exit(code)));
  end.force = () => options.vms?.force();
  return end;
}

// ASS-417: the harness's VMs stopped on a quit.
// limactl(args, env, options) — its run, settled (never rejected) with { error, stdout }.
// list and stop -f get LIMACTL_LIMIT, not the graceful stop's time limit.
const LIMACTL_LIMIT = 30000;
const limactl = (args, env, options = {}) => new Promise(resolve =>
  execFile('limactl', args, { env, killSignal: 'SIGKILL', ...options }, (error, stdout) => resolve({ error, stdout })));

// vmStopper({ env, timeoutMs, log, counted }) — { run, force }: run() stops
// every Running Lima instance under env's LIMA_HOME (env must carry it:
// src/control/vm.js limaEnv) and only there, all at once, each with a
// graceful `limactl stop` given timeoutMs; one not stopped by then — or that
// failed, or every one still stopping once force() is called (Q again) — is
// force-stopped (`limactl stop -f`). Nothing is deleted: the disks stay.
// counted(n) is told how many are still stopping, as each ends (0 at the
// end); each is log()ged, and how it stopped. No LIMA_HOME folder: no VMs,
// and limactl is not run.
export function vmStopper({ env, timeoutMs = 60000, log, counted = () => {} }) {
  let forced = false;
  const stopping = new Set();
  const stopOne = async name => {
    const graceful = new AbortController();
    stopping.add(graceful);
    const r = forced ? { error: { forced: true } } : await limactl(['stop', name], env, { timeout: timeoutMs, signal: graceful.signal });
    stopping.delete(graceful);
    if (!r.error) return log(`VM ${name} stopped`);
    const why = forced ? 'Q pressed again' : r.error.killed ? `not stopped after ${timeoutMs / 1000} s` : `limactl stop failed: ${r.error.message.trim()}`;
    const f = await limactl(['stop', '-f', name], env, { timeout: LIMACTL_LIMIT });
    log(f.error ? `VM ${name} would not stop (${why}), and limactl stop -f failed: ${f.error.message.trim()}` : `VM ${name} force-stopped (${why})`);
  };
  return {
    async run() {
      if (!env.LIMA_HOME || !existsSync(env.LIMA_HOME)) return;
      const { error, stdout } = await limactl(['list', '--format', '{{.Name}}\t{{.Status}}'], env, { timeout: LIMACTL_LIMIT });
      if (error) return log(`limactl list failed, so no VM was stopped: ${error.message.trim()}`);
      const names = stdout.split('\n').map(line => line.split('\t')).filter(([name, status]) => name && status === 'Running').map(([name]) => name);
      if (!names.length) return;
      let left = names.length;
      log(`stopping ${left} VM${left === 1 ? '' : 's'} under ${env.LIMA_HOME}: ${names.join(', ')}`);
      counted(left);
      await Promise.all(names.map(name => stopOne(name).then(() => counted(--left))));
    },
    force() {
      forced = true;
      for (const graceful of stopping) graceful.abort();
    },
  };
}

// goldenBuilds(projectsDir, isBuild) — the golden image builds still running
// (ASS-417): each project's golden-build-run.json (vm:build-golden-start's
// record, golden.bash) whose run has written no golden-build-run.exit and
// whose pid isBuild() still — the leader of the build's own session, so its
// group is the whole build. Killed, the build ends as a crash ends it:
// golden_status "failed", exit-code null, and vm:build-golden deletes its
// left golden-<project>-build as the next one starts.
export function goldenBuilds(projectsDir, isBuild) {
  let ids = [];
  try { ids = readdirSync(projectsDir); } catch { return []; }
  return ids.flatMap(project => {
    const dir = join(projectsDir, project);
    if (existsSync(join(dir, 'golden-build-run.exit'))) return [];
    let pid;
    try { pid = JSON.parse(readFileSync(join(dir, 'golden-build-run.json'), 'utf8')).pid; } catch { return []; }
    return Number.isInteger(pid) && isBuild(pid) ? [{ project, pid }] : [];
  });
}

// stillNamed(request, running) — how many of the running controls' pids a
// restart request (harness:request-restart's restart-requested.json, or null)
// names: each drains its agents and exits on its own (ASS-200), so the
// dashboard waits for them before it stops the rest.
export const stillNamed = (request, running) => {
  const named = request?.['control-pids'] ?? [request?.['control-pid']];
  return running.filter(pid => named.includes(pid)).length;
};
