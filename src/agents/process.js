// Runs an agent for the supervisor: one long-lived headless Claude process,
// every prompt written to its stdin, and all
// it is sent and prints appended to its session log (see session.js). Prompts
// from other processes (agent:dispatch, agent-interaction:resume-thread)
// arrive in the session's inbox.jsonl, one {"prompt": …} a line, and are sent
// from here.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openSync, writeSync, closeSync, mkdirSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, eventLines } from './session.js';
import { initialUsage, foldUsage, toUsageJson, writeUsage, billingOf } from './session-usage.js';
import { machineCommand, machinePaths, newMarker, stopMarked } from '../control/machine.js';

const INBOX_MS = 200;
const BYPASS = '--dangerously-skip-permissions';
export const CLAUDE = ['claude', '-p', BYPASS, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
// An agent not confined keeps no sandbox its folder's own .claude/settings.json
// turns on — the harness repo's, there for interactive sessions (ASS-108),
// which its worktrees and VM checkouts carry: --settings outranks it.
const UNSANDBOXED = JSON.stringify({ sandbox: { enabled: false } });

// agentCommand({ command, model, jsonSchema, mcpConfig, resume, confinedBy, container, cwd }) — the
// argv to start an agent with: `command` (Claude by default) with `--model
// <model>`, `--json-schema <json>`, `--mcp-config <json>` (its project's
// memory, ASS-62: memory.js), `--resume <session-id>` (a chat's
// ended session, continued) and `--append-system-prompt <systemPrompt>` (a
// chat's rules: chats.js) when given, then `--settings`: confinedBy, the
// settings file of a confined host agent (confinement.js), which then runs
// without --dangerously-skip-permissions, its settings deciding what it may
// do; else, ASS-555, `sandbox` — the settings object of an agent on a
// worktree run target (worktree-sandbox.js sandboxSettings), inline, the
// agent keeping --dangerously-skip-permissions (the settings' strict
// allowlist and allowUnsandboxedCommands: false hold in that mode too), with
// `--add-dir <dir>` for each of `addDirs` (more working directories its file
// tools may write: blockWritesOutsideWorkingDirectories); else UNSANDBOXED.
// Never docker exec: an agent runs on
// the host whatever it works in — one working in the dev container is told
// the container and its folder there in its prompt (control's dispatch.js).
export function agentCommand({ command = CLAUDE, model, jsonSchema, mcpConfig, resume, systemPrompt, confinedBy, sandbox, addDirs = [] } = {}) {
  const settings = confinedBy ?? (sandbox ? JSON.stringify(sandbox) : UNSANDBOXED);
  return [...(confinedBy ? command.filter(a => a !== BYPASS) : command), ...(model ? ['--model', model] : []), ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : []),
    ...(mcpConfig ? ['--mcp-config', JSON.stringify(mcpConfig)] : []), ...(resume ? ['--resume', resume] : []),
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []), ...(sandbox && !confinedBy ? addDirs.flatMap(d => ['--add-dir', d]) : []), '--settings', settings];
}

// billingOf(init) — what a session is billed to (ASS-216), from its init
// event: session-usage.js's, which writes it to usage.json too (ASS-268).
export { billingOf };

// billed(agent, usd) — what `usd` of the agent's total_cost_usd really cost:
// 0 on a subscription, which reports a cost it never charges; else `usd`, as
// for an agent whose session never said (no init event).
export const billed = (agent, usd) => (agent.billing === 'subscription' ? 0 : usd);

// startAgent({ name, root, dir, cwd, vm, command, model, jsonSchema, mcpConfig, resume, systemPrompt, confinedBy, sandbox, addDirs, sandboxed, startTime, env,
// usage, onEvent, onResult, onExit }) — starts agentCommand(…) in `cwd`, in its own
// process group, with `env` (this process's by default), and its session log at
// `dir` when given, else sessionDir(root, name, startTime) — `startTime` the assignment record's,
// so the inbox agent:dispatch queued there is the one read; now when not
// given. ASS-555: with `sandbox` (and `addDirs`, agentCommand's) a copy of the
// settings it starts with is kept as <dir>/sandbox-settings.json (no secret is
// ever in them), what the agent was allowed, for whoever looks later. ASS-564: with `sandboxed` ({ sandboxed, why?,
// target, machine }: whether a worktree agent runs in Claude Code's sandbox, and why not) that is kept as
// <dir>/sandbox.json (session.js readSandboxed), which the dashboard shows. With `usage` ({ prices, windows }: session-usage.js's foldUsage) each
// assistant and result event also rewrites <dir>/usage.json. onEvent(event)
// for each JSON line it prints; onResult(event) for each `result` event, before lastTotalCost moves on to its total_cost_usd,
// so the turn's own cost is event.total_cost_usd - agent.lastTotalCost
// inside it; onExit(code, signal) once it has ended and its output is all
// logged. Log writes are synchronous, so a supervisor that exits at once
// loses none. A command that cannot start is logged, and onExit comes.
// Returns { pid, startTime (ISO, to the second), dir, sessionId (from the
// init event; null until then), billing (billingOf the init event; null until
// then), lastTotalCost, send(text), stop() }: send logs
// "> <text>" and writes it to the agent as a user message; stop signals its
// whole process group. With `vm` (a VM's name, ASS-74; a machine, ASS-432:
// a GCP workstation's too, ASS-435) it runs in that VM
// instead, `cwd` a folder there (its repos folder, /repos/ in a VM, by default: machinePaths), through the machine
// layer (machine.js machineCommand, ASS-432: limactl shell for a VM) under a
// marker of its own (`marker`, returned too); stop then also ends it in the VM,
// which the local signal never reaches. Each complete line appended to <dir>/inbox.jsonl is
// sent as send sends it, checked for every INBOX_MS.
// ASS-504: an inbox line { prompt, interrupt: true } (machine:restart-imminent)
// is sent by interrupt(prompt) instead: the stream-json interrupt control
// request — { type: control_request, request_id, request: { subtype:
// interrupt } }, which Claude Code 2.1.326 answers with a control_response and,
// when a turn is under way, ends it at once, a running tool call stopped, with
// a result (error_during_execution); idle, it ends nothing and says no result —
// then the prompt, run as the next turn. The interrupted turn's result is not
// a turn ending for the caller: onEvent sees it, onResult does not, and
// lastTotalCost stays, so the next turn's cost includes it. `interrupted` (the
// ISO time of the last interrupt, else null) says one came;
// onInterrupt(prompt) is called with it, before the prompt is sent.
export function startAgent({ name, root, dir: given, cwd, vm, command, model, jsonSchema, mcpConfig, resume, systemPrompt, confinedBy, sandbox, addDirs, sandboxed, startTime = new Date().toISOString(), env = process.env, usage, onEvent = () => {}, onResult = () => {}, onInterrupt = () => {}, onExit = () => {} }) {
  startTime = startTime.replace(/\.\d+Z$/, 'Z');
  const dir = given ?? sessionDir(root, name, startTime);
  mkdirSync(dir, { recursive: true });
  let log = openSync(join(dir, 'session.txt'), 'a');
  const write = lines => { if (log !== null) writeSync(log, lines.map(l => `${l}\n`).join('')); };
  const marker = vm ? newMarker() : undefined;
  if (sandbox && !confinedBy) writeFileSync(join(dir, 'sandbox-settings.json'), `${JSON.stringify(sandbox, null, 2)}\n`);
  if (sandboxed && !confinedBy) writeFileSync(join(dir, 'sandbox.json'), `${JSON.stringify(sandboxed)}\n`);
  const argv = agentCommand({ command, model, jsonSchema, mcpConfig, resume, systemPrompt, confinedBy, sandbox, addDirs });
  const run = vm ? machineCommand(vm, argv, { cwd: cwd ?? machinePaths(vm).repos, marker, env }) : { argv, env };
  const [file, ...args] = run.argv;
  const child = spawn(file, args, { cwd: vm ? undefined : cwd, env: run.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const agent = { pid: child.pid, startTime, dir, sessionId: null, billing: null, lastTotalCost: 0, interrupted: null, marker, send, interrupt, stop };
  let used = initialUsage();
  // busy: a message sent and its turn's result not yet seen; swallow: results still to come of turns interrupted.
  let busy = false, swallow = 0, requests = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    write(eventLines(line));
    let event;
    try { event = JSON.parse(line); } catch { return; }   // not an event
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) agent.sessionId = event.session_id;
      agent.billing = billingOf(event);
    }
    const next = usage && foldUsage(used, event, usage);
    if (next) writeUsage(dir, toUsageJson(used = next));
    onEvent(event);
    if (event.type === 'result') {
      busy = false;
      if (swallow > 0) { swallow--; write(['[the interrupted turn ended]']); return; }
      onResult(event);
      agent.lastTotalCost = event.total_cost_usd ?? agent.lastTotalCost;
    }
  });
  createInterface({ input: child.stderr }).on('line', line => write([`[stderr] ${line}`]));
  child.stdin.on('error', () => {});   // gone already: its exit says so
  child.on('error', error => write([`[agent could not start: ${error.message}]`]));
  function send(text) {
    write(text.split('\n').map((l, i) => (i ? '  ' : '> ') + l));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    busy = true;
  }
  function interrupt(text) {
    write([`[interrupt${busy ? '' : ': no turn under way'}]`]);
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `interrupt-${++requests}`, request: { subtype: 'interrupt' } })}\n`);
    if (busy) swallow++;
    agent.interrupted = new Date().toISOString();
    onInterrupt(text);
    send(text);
  }
  function stop() {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    if (vm) stopMarked(vm, marker, env);
  }
  // The inbox, read from where the last check stopped; a line not yet ended
  // waits for the rest of it, kept as bytes so a character split between
  // checks stays whole.
  const inbox = openSync(join(dir, 'inbox.jsonl'), 'a+');
  let read = 0, partial = Buffer.alloc(0);
  const poll = setInterval(() => {
    const size = fstatSync(inbox).size;
    if (size <= read) return;
    const chunk = Buffer.alloc(size - read);
    read += readSync(inbox, chunk, 0, chunk.length, read);
    const bytes = Buffer.concat([partial, chunk]);
    const end = bytes.lastIndexOf(0x0a) + 1;
    partial = bytes.subarray(end);
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
      let queued;
      try { queued = JSON.parse(line); } catch { queued = null; }
      if (typeof queued?.prompt !== 'string') write([`[inbox] not a prompt: ${line}`]);
      else if (queued.interrupt === true) interrupt(queued.prompt);
      else send(queued.prompt);
    }
  }, INBOX_MS);
  child.once('close', (code, signal) => {
    clearInterval(poll);
    closeSync(inbox);
    write([`[agent exited (${signal ?? `code ${code}`})]`]);
    closeSync(log);
    log = null;
    onExit(code, signal);
  });
  return agent;
}
