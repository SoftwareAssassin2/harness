// The forwarder (ASS-74): how an agent in a ticket variation's VM runs
// agent.sh. One HTTP server for every VM, run by control on the Mac's
// 127.0.0.1 at harness.json's forwarder-port; a VM reaches it at
// http://host.lima.internal:<port> (Lima maps that to the Mac's loopback, and
// nothing else there is let through: vm:start's sandbox). Every caller
// appears as 127.0.0.1, so the token alone says who calls: vm:start issues
// each VM one at every start, keeps only its SHA-256 and the VM's binding —
// { project, ticket, variation, ticket-folder } — in
// $HARNESS_HOME/vm-tokens.json (0600, never sprint.json), and puts the token
// on the VM's tmpfs, /run/harness/agent-token. The VM's agent.sh
// (src/agent-cli/vm/in-vm/agent.sh) POSTs /run { token, argv, stdin? } and gets
// NDJSON back: { o | e: base64 } chunks of stdout and
// stderr, then { exit }; a refusal is 403 { refused }. stdin, base64, is sent
// only for the commands that read it (work:write, work:append; ASS-181;
// automated-tests:record, ticket:set-demo-plan; ASS-180; and, as "-", the
// three that once took a file in /mnt/ticket, which is read-only: ASS-182;
// merge-request:update and :upload-image: ASS-238; merge-request:reply:
// ASS-239), at most STDIN_CAP bytes.
//
// ASS-435: a GCP workstation's agents reach it the same way, at
// http://127.0.0.1:<port> on the workstation — the forwarder's port
// reverse-forwarded there by the workstation's connection (ASS-433) — with a
// token vm:start put in the setup's runtime folder and bound, in
// vm-tokens.json, under the variation's machine
// (workstation:<project>:<id>:<folder>; since ASS-468 <folder> is the
// workstation's shared root, and the binding is its current holder's alone:
// workstation:claim writes it for a step, workstation:release drops it), so
// every call is authorized against the binding as a VM's is. A workstation
// has no mount of the ticket folder, only a read-only copy under the root
// (<folder>/ticket, the holder's ticket's), so after
// each call the forwarder runs for such a binding — every one: a call's
// writes are not known beforehand — the copy is brought up to date
// (machine-workstation.js syncTicketCopy: rsync over the connection) before
// the call's exit is sent (AC4): an agent reads its own writes there as soon
// as agent.sh returns. A copy that fails is said on the call's stderr, the
// exit code the command's own.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flattenSprint } from './rank.js';
import { syncTicketCopy } from './machine-workstation.js';
import { remoteName } from './machine.js';
import { dataDir } from '../data-folder.js';

const ALLOW = JSON.parse(readFileSync(join(import.meta.dirname, 'forwarder-allowlist.json'), 'utf8'));
export const STDIN_CAP = 1 << 20;
const sha = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// authorize(tokens, assignments, token, argv, fastTracked) — whether a VM's call may run:
// { vm, binding, argv } — or
// { refuse: why } (and the vm, once the token is known). `tokens` vm-tokens.json's bindings, `assignments`
// assignments.json's records. The token must be one issued; the command on
// the allowlist (forwarder-allowlist.json); each argument it names as a
// project, ticket (in any case) or variation the binding's; each it names
// as an agent one assigned to the binding's ticket variation (agents change
// from step to step; the VM, and its token, stay); each it names as stdin
// "-", the content on stdin (ASS-182: never a path, of the VM's or the Mac's);
// and no more arguments than its "max-args" allows (ASS-298, ASS-428: the
// optional trailing file path of work:write, work:append and the others is
// the Mac's alone).
// A command whose rule says "fast-track": true
// (ASS-151: vm:build-golden-start, vm:golden-status — a golden-image rebuild
// ticket's work on the Mac) runs only for a binding fastTracked(binding)
// says is fast-tracked (none, unless given).
// ASS-504: a rule with "from-binding": true (machine:restart-imminent, the
// restart watcher's call, which knows no ticket) has the binding's project,
// ticket and variation and the VM's machine name appended to its arguments
// (max-args 0: the VM gives none), so a VM only ever names its own; with
// "logged": true (`logged` in the result) the forwarder writes the command's
// stdout lines to control's log.
export function authorize(tokens, assignments, token, argv, fastTracked = () => false) {
  if (typeof token !== 'string' || !token) return { refuse: 'no token' };
  const hash = sha(token);
  const [vm, binding] = Object.entries(tokens).find(([, b]) => same(b['token-sha256'], hash)) ?? [];
  if (!binding) return { refuse: 'unknown token' };
  const [command, ...args] = argv;
  const rule = typeof command === 'string' && !command.startsWith('_') && Object.hasOwn(ALLOW, command) ? ALLOW[command] : null;
  if (!rule) return { vm, refuse: `command not allowed: ${command}` };
  if (typeof rule['max-args'] === 'number' && args.length > rule['max-args']) return { vm, refuse: `${command} takes at most ${rule['max-args']} arguments` };
  if (rule['fast-track'] === true && !fastTracked(binding)) return { vm, refuse: `${binding.ticket} is not fast-tracked` };
  for (const field of ['project', 'ticket', 'variation']) {
    if (!(field in rule)) continue;
    const given = args[rule[field]];
    if (field === 'ticket' ? given?.toUpperCase() !== binding.ticket.toUpperCase() : given !== binding[field]) return { vm, refuse: `${field} ${JSON.stringify(given ?? null)} is not this VM's ${binding[field]}` };
  }
  for (const i of rule.agent ?? []) {
    const ours = a => a['agent-name'] === args[i] && a.project === binding.project && a['work-item']?.toUpperCase() === binding.ticket.toUpperCase() && a.variation === binding.variation;
    if (!assignments.some(ours)) return { vm, refuse: `agent ${JSON.stringify(args[i] ?? null)} has no assignment on ${binding.ticket} ${binding.variation}` };
  }
  for (const i of rule.stdin ?? []) if (args[i] !== '-') return { vm, refuse: `${JSON.stringify(args[i] ?? null)} must be "-": the content goes on stdin` };
  const appended = rule['from-binding'] === true ? [binding.project, binding.ticket, binding.variation, vm] : [];
  return { vm, binding, argv: [command, ...args, ...appended], logged: rule.logged === true };
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

// isFastTracked(projects, binding) — the binding's ticket, in its project's
// active sprint under `projects`, is fast-tracked (fast-track: true, ASS-83);
// false when it cannot be read.
function isFastTracked(projects, binding) {
  const dir = join(projects, binding.project);
  const active = readJson(join(dir, 'sprints.json'), {}).list?.find(s => s['is-active']);
  const sprint = active ? readJson(join(dir, 'sprints', `sprint-${active.number}`, 'sprint.json'), null) : null;
  return Boolean(sprint) && flattenSprint(sprint).some(t => t.key?.toUpperCase() === binding.ticket.toUpperCase() && t['fast-track'] === true);
}

// startForwarder({ root, env, port, log }) — the server, listening on
// 127.0.0.1:<port> (0: any free one, for tests); resolves once it listens.
// Each call is authorized against vm-tokens.json ($HARNESS_HOME, ~/.harness by
// default) and assignments.json (ASSIGNMENTS_FILE, else <root>/data's) as they
// are then — and, for a command only a fast-tracked ticket may call, its
// sprint (PROJECTS_DIR, else <root>/data's projects; isFastTracked) — logged under "forwarder" as RUN or REFUSE with the VM and argv
// (never the token, nor stdin) — and, for a "logged" rule (ASS-504), each line
// of the command's stdout — and run as `<root>/agent.sh <argv>` with `env`, in the
// ticket's folder, its stdin the call's stdin decoded (refused over
// STDIN_CAP), else none (ignored, as before ASS-181); a call whose client goes away is
// SIGTERMed. Rejects when the port cannot be bound.
// ASS-509: the commands that bring a ticket branch's base in before they run (automated-tests:verify-success,
// ci-checks:verify: rebase or merge, then push) do so only when told CATCH_UP_BASE=1. Through the forwarder that
// is control's own run of the step — the grouped Build's Automated Testing and CI Checks are vm steps, so their
// command comes here too — told apart from an agent's call by there being no agent of the variation at work: while
// Generate Solution or Address Merge Request Feedback runs, the call stays read-only (no push of the agent's
// unpushed commits, no pipeline started, no approval reset beneath it). Every other call never has it.
const CATCH_UP = new Set(['automated-tests:verify-success', 'ci-checks:verify']);
// forwardedEnv(env, argv, binding, assignments) — the env a forwarded call runs with.
export function forwardedEnv(env, argv, binding, assignments = []) {
  const { CATCH_UP_BASE: _, ...rest } = env;
  const busy = assignments.some(x => x?.project === binding?.project && String(x?.['work-item'] ?? '').toLowerCase() === String(binding?.ticket ?? '').toLowerCase() && x?.variation === binding?.variation);
  return CATCH_UP.has(argv?.[0]) && !busy ? { ...rest, CATCH_UP_BASE: '1' } : rest;
}

export function startForwarder({ root, env = process.env, port, log = () => {} }) {
  const tokensFile = join(env.HARNESS_HOME ?? join(homedir(), '.harness'), 'vm-tokens.json');
  const assignmentsFile = env.ASSIGNMENTS_FILE ?? join(dataDir(root), 'assignments.json');
  const projects = env.PROJECTS_DIR ?? join(dataDir(root), 'projects');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/run') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16 << 20) req.destroy(); });
    req.on('end', () => {
      let call;
      try { call = JSON.parse(body); } catch { res.writeHead(400).end('{"refused":"bad json"}\n'); return; }
      const argv = Array.isArray(call.argv) ? call.argv.map(String) : [];
      const stdin = call.stdin === undefined ? null : typeof call.stdin === 'string' ? Buffer.from(call.stdin, 'base64') : undefined;
      const assigned = readJson(assignmentsFile, {}).assignments ?? [];
      const a = stdin === undefined ? { refuse: 'stdin is not base64 text' } : stdin?.length > STDIN_CAP ? { refuse: 'stdin is over 1 MB' } : authorize(readJson(tokensFile, {}), assigned, call.token, argv, binding => isFastTracked(projects, binding));
      if (a.refuse) {
        log('forwarder', `REFUSE ${a.vm ?? 'unknown'} ${JSON.stringify(argv)}: ${a.refuse}`);
        res.writeHead(403, { 'content-type': 'application/x-ndjson' }).end(`${JSON.stringify({ refused: a.refuse })}\n`);
        return;
      }
      log('forwarder', `RUN ${a.vm} ${JSON.stringify(argv)}`);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const child = spawn(join(root, 'agent.sh'), a.argv, { cwd: a.binding['ticket-folder'], env: forwardedEnv(env, a.argv, a.binding, Array.isArray(assigned) ? assigned : []), stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
      const send = key => data => res.write(`${JSON.stringify({ [key]: data.toString('base64') })}\n`);
      child.stdout.on('data', send('o'));
      if (a.logged) createInterface({ input: child.stdout }).on('line', line => log('forwarder', `${a.vm}: ${line}`));
      child.stderr.on('data', send('e'));
      child.on('error', error => res.end(`${JSON.stringify({ e: Buffer.from(`${error.message}\n`).toString('base64'), exit: 127 })}\n`));
      const exit = (code, signal) => `${JSON.stringify({ exit: code ?? (signal === 'SIGKILL' ? 137 : 143) })}\n`;
      child.on('close', (code, signal) => {
        // ASS-481: a cloud VM's machine (cloud-vm:…) has its ticket copy as a workstation's has.
        if (!remoteName(a.vm)) { res.end(exit(code, signal)); return; }
        syncTicketCopy(remoteName(a.vm), a.binding['ticket-folder'], { env })
          .catch(error => { log('forwarder', `SYNC ${a.vm} failed: ${error.message}`); send('e')(Buffer.from(`agent.sh: the ticket folder's copy on the workstation could not be brought up to date: ${(error.stderr || error.message).trim()}\n`)); })
          .finally(() => res.end(exit(code, signal)));
      });
      res.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server); });
  });
}
