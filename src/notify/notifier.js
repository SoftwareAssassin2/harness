// The dashboard's Operator Needed notifications (ASS-383): a macOS
// notification, with the default sound, for each ticket that becomes Operator
// Needed (detect.js), carrying an AI-written line of what is needed and why
// (describe.js). Through terminal-notifier when it is on the PATH — grouped
// per ticket, and a click brings Ghostty, the dashboard's terminal, to the front and
// opens the ticket there (agent.sh notify:open-ticket, which writes the
// request file main.js watches) — else osascript's display notification, no
// click action. Every program is run with argv, never through a shell built
// from ticket text.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { configDir } from '../control/dispatch.js';
import { neededTickets, entered, keysOf, readSeen, writeSeen } from './detect.js';
import { describe, askClaude } from './describe.js';

// The chat id the descriptions' cost is recorded under in the project's
// chat-spend.json (chat:add-spend), beside the chat screen's turns.
export const SPEND_ID = 'operator-needed-notifications';

// onPath(name, env) — whether an executable `name` is in one of env.PATH's folders.
export function onPath(name, env = process.env) {
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some(dir => {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
}

// The terminal a click brings to the front (terminal-notifier's -activate):
// Ghostty, which the dashboard runs in. Never Terminal.app, which does not
// show the dashboard's links.
export const GHOSTTY = 'com.mitchellh.ghostty';

// A project id and a ticket key safe to stand as shell words, as the agent-cli takes them.
const PROJECT = /^[A-Za-z0-9_-]+$/, KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// One shell word, single-quoted.
const quoted = word => `'${String(word).replaceAll("'", `'\\''`)}'`;
// openCommand(agentSh, project, key) — the line terminal-notifier's -execute
// runs (it takes a shell command): agent.sh notify:open-ticket <project> <key>,
// each word quoted, and only for a project id and key of plain characters —
// null otherwise, so no click action. No ticket text is ever in it.
export const openCommand = (agentSh, project, key) => (PROJECT.test(project) && KEY.test(key) ? [agentSh, 'notify:open-ticket', project, key].map(quoted).join(' ') : null);

// A notification's text never starts with "-": terminal-notifier would read it as an option.
const plain = text => String(text ?? '').replace(/^[\s-]+/, '');

// notification(kind, { title, subtitle, message, group, execute, activate }) —
// [program, argv] posting it with the default sound: terminal-notifier's own
// options; osascript's script reads the texts from its argv (on run argv), so
// none of them is ever part of the AppleScript.
export function notification(kind, { title, subtitle, message, group, execute, activate }) {
  if (kind === 'terminal-notifier') {
    return ['terminal-notifier', ['-title', plain(title), '-subtitle', plain(subtitle), '-message', plain(message) || ' ', '-sound', 'default', '-group', group,
      ...(activate ? ['-activate', activate] : []), ...(execute ? ['-execute', execute] : [])]];
  }
  return ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name "default"', '-e', 'end run',
    String(message ?? ''), String(title ?? ''), String(subtitle ?? '')]];
}

// loginEnvs(projectsDir, project, env) — the environments the description is
// asked in, in turn, as dispatch.js's paymentFor pays a host agent: the
// project's own login (configDir: its .claude, else the shared ~/.claude) — the
// subscription first —, then its API key's .claude-api, when it has one and no
// API cap holds it (project.json api-cap-hold).
export function loginEnvs(projectsDir, project, env = process.env) {
  const ctx = { paths: { projects: projectsDir } };
  const own = configDir(ctx, project), api = configDir(ctx, project, 'api');
  return [own ? { ...env, CLAUDE_CONFIG_DIR: own } : env, ...(api && !project.apiCapHold ? [{ ...env, CLAUDE_CONFIG_DIR: api }] : [])];
}

// operatorNeededNotifier({ seenFile, projectsDir, agentSh, env, ask, run, log }) —
// check(state) after every state change: the first, the dashboard starting,
// takes every ticket in the set as seen, with the seen file's (a ticket seen
// before a restart, gone from the set at start, drops out at the next
// check), notifying none, and logs which notifier it uses; each later one notifies each ticket
// newly in its project's set (detect.js entered), but in a project whose
// project.json has operator-needed-notifications false (notifications,
// load.js). The seen keys are written to `seenFile` whenever they change.
// Each notification is sent in the background — its description first
// (describe, its cost recorded by chat:add-spend under the project) —, so
// check never waits for one; `sent` resolves once all those started are out.
// `ask` (askClaude) and `run` (execFile) are the tests'.
export function operatorNeededNotifier({ seenFile, projectsDir, agentSh, env = process.env, ask = askClaude, run = execFile, log = () => {}, timeoutMs }) {
  const kind = onPath('terminal-notifier', env) ? 'terminal-notifier' : 'osascript';
  let seen = null, failedOnce = false;
  const pending = new Set();
  const exec = (file, args) => new Promise(done => run(file, args, { env }, error => done(error)));
  const save = next => {
    if (JSON.stringify(next) === JSON.stringify(seen)) return;
    seen = next;
    try { writeSeen(seenFile, seen); } catch (error) { log(`notifications: could not write ${seenFile}: ${error.message}`); }
  };
  async function send(project, ticket) {
    const record = (usd, billing) => exec(agentSh, ['chat:add-spend', project.id, SPEND_ID, String(usd), ...(billing ? [billing] : [])]);
    const message = await describe(ticket, { envs: loginEnvs(projectsDir, project, env), ask, record, ...(timeoutMs ? { timeoutMs } : {}) });
    const texts = {
      title: `${ticket.key} needs you`, subtitle: `${project.name} — ${ticket.title}`, message,
      group: `${project.id}/${ticket.key}`, execute: openCommand(agentSh, project.id, ticket.key), activate: GHOSTTY,
    };
    let error = await exec(...notification(kind, texts));
    // terminal-notifier exiting non-zero — 3 when macOS refuses it permission —
    // is logged once, and that notification goes through osascript instead.
    if (error && kind === 'terminal-notifier') {
      if (!failedOnce) log(`Operator Needed notifications: terminal-notifier failed (${error.message.split('\n')[0]}); falling back to osascript`);
      failedOnce = true;
      error = await exec(...notification('osascript', texts));
    }
    if (error) log(`Operator Needed notifications: osascript failed for ${ticket.key}: ${error.message.split('\n')[0]}`);
  }
  return {
    kind,
    check(state) {
      const now = neededTickets(state);
      if (seen == null) {
        const before = readSeen(seenFile), started = keysOf(now);
        log(kind === 'terminal-notifier' ? 'Operator Needed notifications: terminal-notifier (a click opens the ticket)' : 'Operator Needed notifications: osascript (brew install terminal-notifier for a click to open the ticket)');
        seen = before;
        save(Object.fromEntries(Object.keys({ ...before, ...started }).map(id => [id, [...new Set([...(before[id] ?? []), ...(started[id] ?? [])])]])));
        return [];
      }
      const next = entered(seen, now);
      save(next.seen);
      const notified = next.entered.filter(({ project }) => state.projects.find(p => p.id === project)?.notifications !== false);
      for (const { project, ticket } of notified) {
        const job = send(state.projects.find(p => p.id === project), ticket).catch(error => log(`notifications: ${ticket.key}: ${error.message}`));
        pending.add(job);
        job.finally(() => pending.delete(job));
      }
      return notified;
    },
    sent: () => Promise.all([...pending]),
  };
}
