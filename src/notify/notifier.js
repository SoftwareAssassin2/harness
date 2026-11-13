// The dashboard's Operator Needed notifications (ASS-383): a macOS
// notification, with the default sound, for each ticket that becomes Operator
// Needed (detect.js), carrying an AI-written line of what is needed and why
// (describe.js). Through terminal-notifier when it is on the PATH — grouped
// per ticket, and a click brings Ghostty, the dashboard's terminal, to the front and
// opens the ticket there (agent.sh notify:open-ticket, which writes the
// request file main.js watches) — else osascript's display notification, no
// click action. Every program is run with argv, never through a shell built
// from ticket text. ASS-412: the dashboard header's warnings notify through
// the same (headerWarningNotifier), never with their text in a shell string.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { configDir } from '../control/dispatch.js';
import { neededTickets, entered, keysOf, readSeen, writeSeen } from './detect.js';
import { describe, askClaude } from './describe.js';
import { liveWarnings, settled, HARNESS } from './warnings.js';

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
// null otherwise, so no click action. No ticket text is ever in it. ASS-412:
// with no key (null or undefined), notify:open-ticket <project> alone, which
// only selects the project — a header warning's click.
export const openCommand = (agentSh, project, key) => (PROJECT.test(project) && (key == null || KEY.test(key))
  ? [agentSh, 'notify:open-ticket', project, ...(key == null ? [] : [key])].map(quoted).join(' ') : null);

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
// poster({ kind, env, run, log, name }) — { exec, post(texts, label) }: exec
// runs a program with argv; post sends one notification (notification's
// argv) through `kind`, terminal-notifier exiting non-zero — 3 when macOS
// refuses it permission — logged once (under `name`), and that notification
// going through osascript instead. Shared by both notifiers (ASS-412).
function poster({ kind, env, run, log, name }) {
  let failedOnce = false;
  const exec = (file, args) => new Promise(done => run(file, args, { env }, error => done(error)));
  async function post(texts, label) {
    let error = await exec(...notification(kind, texts));
    if (error && kind === 'terminal-notifier') {
      if (!failedOnce) log(`${name}: terminal-notifier failed (${error.message.split('\n')[0]}); falling back to osascript`);
      failedOnce = true;
      error = await exec(...notification('osascript', texts));
    }
    if (error) log(`${name}: osascript failed for ${label}: ${error.message.split('\n')[0]}`);
  }
  return { exec, post };
}

// seenKeeper(seenFile, log) — { get, save }: the seen set in memory, written
// whole to `seenFile` (detect.js writeSeen) whenever it changes.
function seenKeeper(seenFile, log) {
  let seen = null;
  return {
    get: () => seen,
    save(next) {
      if (JSON.stringify(next) === JSON.stringify(seen)) return;
      seen = next;
      try { writeSeen(seenFile, seen); } catch (error) { log(`notifications: could not write ${seenFile}: ${error.message}`); }
    },
  };
}
// merged(a, b) — two seen sets ({ <scope>: [key] }) as one, each scope's keys once.
const merged = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).map(id => [id, [...new Set([...(a[id] ?? []), ...(b[id] ?? [])])]]));

export function operatorNeededNotifier({ seenFile, projectsDir, agentSh, env = process.env, ask = askClaude, run = execFile, log = () => {}, timeoutMs }) {
  const kind = onPath('terminal-notifier', env) ? 'terminal-notifier' : 'osascript';
  const pending = new Set();
  const { exec, post } = poster({ kind, env, run, log, name: 'Operator Needed notifications' });
  const keeper = seenKeeper(seenFile, log), save = keeper.save;
  async function send(project, ticket) {
    const record = (usd, billing) => exec(agentSh, ['chat:add-spend', project.id, SPEND_ID, String(usd), ...(billing ? [billing] : [])]);
    const message = await describe(ticket, { envs: loginEnvs(projectsDir, project, env), ask, record, ...(timeoutMs ? { timeoutMs } : {}) });
    await post({
      title: ticket.project ? `${project.name} needs you` : `${ticket.key} needs you`, subtitle: `${project.name} — ${ticket.title}`, message,
      // ASS-395: a project-level item (its credentials hold) opens no ticket.
      group: `${project.id}/${ticket.key}`, execute: ticket.project ? null : openCommand(agentSh, project.id, ticket.key), activate: GHOSTTY,
    }, ticket.key);
  }
  return {
    kind,
    check(state) {
      const now = neededTickets(state);
      if (keeper.get() == null) {
        log(kind === 'terminal-notifier' ? 'Operator Needed notifications: terminal-notifier (a click opens the ticket)' : 'Operator Needed notifications: osascript (brew install terminal-notifier for a click to open the ticket)');
        save(merged(readSeen(seenFile), keysOf(now)));
        return [];
      }
      const next = entered(keeper.get(), now);
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

// The subtitle of a harness-wide warning's notification (ASS-412): it is no one project's.
export const HARNESS_SUBTITLE = 'All projects';

// headerWarningNotifier({ seenFile, agentSh, env, run, log, clock }) — ASS-412:
// a macOS notification, through the same notification and fallback as the
// Operator Needed ones, for each dashboard header warning (frame.js
// headerWarnings, warnings.js liveWarnings: every project's, but those the
// operator caused) that appears: its text the title, the project's name the
// subtitle (HARNESS_SUBTITLE for a harness-wide one, sent once, not once per
// project), its `todo` the body; a click brings Ghostty forward and selects the
// project (notify:open-ticket with the project alone). check(state, now) after
// every state change: the first, the dashboard starting, takes every warning
// up as seen, with the seen file's, notifying none; each later one notifies
// each warning newly up (detect.js entered on the warnings' ids) once one with
// an `after` has stayed up that long (warnings.js settled) — the times they
// came up are kept in memory —, but not for a project whose project.json has
// operator-needed-notifications false (a harness-wide one goes to the first
// of its projects with them on, none when all are off). A warning notifies
// again only after it clears and comes back. due(now) — whether a warning
// with an `after` has stayed up long enough since the last check, so the
// dashboard's clock calls check without a state change. `sent` resolves once
// every notification started is out. `run` (execFile) is the tests'.
export function headerWarningNotifier({ seenFile, agentSh, env = process.env, run = execFile, log = () => {}, clock = Date.now }) {
  const kind = onPath('terminal-notifier', env) ? 'terminal-notifier' : 'osascript';
  const { post } = poster({ kind, env, run, log, name: 'Header warning notifications' });
  const keeper = seenKeeper(seenFile, log);
  const upSince = new Map();   // `<scope>/<id>` → the ms it was first seen up, while it stays up
  const pending = new Set();
  let waiting = [];            // the ms each warning up, unseen and with an `after`, may notify
  return {
    kind,
    check(state, now = clock()) {
      const live = liveWarnings(state, now);
      const up = new Set(Object.entries(live).flatMap(([scope, items]) => items.map(item => `${scope}/${item.key}`)));
      for (const id of upSince.keys()) if (!up.has(id)) upSince.delete(id);
      for (const id of up) if (!upSince.has(id)) upSince.set(id, now);
      if (keeper.get() == null) {
        keeper.save(merged(readSeen(seenFile), keysOf(live)));
        return [];
      }
      const next = entered(keeper.get(), settled(live, keeper.get(), upSince, now));
      keeper.save(next.seen);
      waiting = Object.entries(live).flatMap(([scope, items]) => items
        .filter(({ key, warning }) => warning.after && !(next.seen[scope] ?? []).includes(key))
        .map(({ key, warning }) => upSince.get(`${scope}/${key}`) + warning.after));
      const notified = next.entered.map(({ project: scope, ticket: item }) => ({
        scope, item, project: item.projects.map(id => state.projects.find(p => p.id === id)).find(p => p && p.notifications !== false),
      })).filter(({ project }) => project);
      for (const { scope, item, project } of notified) {
        const job = post({
          title: item.warning.text, subtitle: scope === HARNESS ? HARNESS_SUBTITLE : project.name, message: item.warning.todo,
          group: `warning/${scope === HARNESS ? 'harness' : project.id}/${item.key}`, execute: openCommand(agentSh, project.id), activate: GHOSTTY,
        }, item.key).catch(error => log(`notifications: ${item.key}: ${error.message}`));
        pending.add(job);
        job.finally(() => pending.delete(job));
      }
      return notified.map(({ scope, item, project }) => ({ scope, id: item.key, project: project.id }));
    },
    due: (now = clock()) => waiting.some(at => now >= at),
    sent: () => Promise.all([...pending]),
  };
}
