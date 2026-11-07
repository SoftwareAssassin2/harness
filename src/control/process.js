// Runs control for the supervisor: starts src/control/main.js in its own
// process group, hands back its output a line at a time, appends it to a log
// file, and stops the group.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const MAIN = join(import.meta.dirname, 'main.js');

// startControl({ onLine, onExit, logFile, env, args, script }) — onLine({ text,
// stream, at }) for each line on stdout or stderr, as it comes, and a last
// stderr line saying how control ended; then onExit(code, signal). With
// logFile, each of those lines is also appended to it as "<ISO time>
// [stderr] <text>" (no [stderr] for stdout), before it is handed on: the
// writes are synchronous, so a supervisor that exits at once loses none. The
// file is only ever appended to, by this process alone, and its folder is
// made if missing. `env` and `args` (main.js's) are for tests; the dashboard
// passes neither. `script` runs another long-lived child the same way (the
// dashboard starts the downloader, src/downloader/main.js, with it); its
// name in the messages is the script's folder. Returns { name, pid, exited,
// stop }: exited settles once it has ended (after onExit); stop
// logs "[supervisor] stopping control" and signals control's whole process
// group, so anything it started ends with it.
export function startControl({ onLine, onExit = () => {}, logFile, env, args = [], script = MAIN }) {
  const name = basename(dirname(script));
  let log = null;
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    log = openSync(logFile, 'a');
  }
  const write = (at, tag, text) => {
    if (log !== null) writeSync(log, `${at.toISOString()}  ${tag ? `[${tag}] ` : ''}${text}\n`);
  };
  const emit = (text, stream) => {
    const line = { text, stream, at: new Date() };
    write(line.at, stream === 'stderr' ? 'stderr' : '', text);
    onLine(line);
  };
  // Its own process group (detached), so stop can signal everything in it;
  // stdin stays a pipe from here, whose end tells control the supervisor is gone.
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  for (const stream of ['stdout', 'stderr'])
    createInterface({ input: child[stream] }).on('line', text => emit(text, stream));
  // 'close' comes once its output has all been read, so the exit line is last.
  let ended;
  const exited = new Promise(resolve => { ended = resolve; });
  child.once('close', (code, signal) => {
    emit(`${name} exited (${signal ?? `code ${code}`})`, 'stderr');
    if (log !== null) closeSync(log);
    log = null;
    onExit(code, signal);
    ended();
  });
  return {
    name, pid: child.pid, exited,
    stop() {
      write(new Date(), 'supervisor', `stopping ${name}`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    },
  };
}
