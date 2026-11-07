// The dashboard's shut-down (Q): everything it started stopped, and nothing
// of the harness left running.

// shutDown({ children, agentPids, timeoutMs, alive, kill, log }) — stop()s
// every child ({ name, pid, stop, exited: a promise settled once it has
// ended } — control and the downloader, each its own process group) and
// waits for them all: control stops its agents itself (SIGTERM, SIGKILL after
// 5 seconds). One still running after timeoutMs has its group SIGKILLed.
// Then every agent process agentPids() still names (assignments.json's
// process-id, the leader of the agent's group) that alive() says is still an
// agent — left by a control that was killed, say — has its group SIGKILLed. Each kill is
// log()ged.
export async function shutDown({ children, agentPids, timeoutMs = 20000, alive, kill, log }) {
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
}

// ender(options, exit) — end(code): the first call shuts down (shutDown's
// options) and then exit(code)s; a later one — Q pressed, or a second control
// asking for a restart, meanwhile — has the same shut-down, so only one runs
// (ASS-193).
export function ender(options, exit) {
  let ending;
  return code => (ending ??= shutDown(options).then(() => exit(code)));
}

// stillNamed(request, running) — how many of the running controls' pids a
// restart request (harness:request-restart's restart-requested.json, or null)
// names: each drains its agents and exits on its own (ASS-200), so the
// dashboard waits for them before it stops the rest.
export const stillNamed = (request, running) => {
  const named = request?.['control-pids'] ?? [request?.['control-pid']];
  return running.filter(pid => named.includes(pid)).length;
};
