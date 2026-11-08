// The frame around every screen's body (ASS-201): the header — banner, health-check
// agents, project menu, sprint and its tiles — and the platform boxes and the lines
// under them; the flow screens (S, B) take a one-line header and no platform boxes
// (ASS-187). Every screen sizes itself against it, so it sits below them all.
import { boxRow } from '../boxes.js';
import { kindOfAccount } from '../../agents/account.js';
import { providerOf, repoPath, commonOwner } from '../../agents/forge.js';
import { blockText } from '../font.js';
import { duration } from '../metrics.js';
import { visible, link } from '../text.js';
import { utcDate } from '../../downloader/cycle.js';
import { flattenSprint } from '../../control/rank.js';
import { spendRecords, daySpend, sprintSpend, spendText } from '../../control/spend.js';
import { ellipsis, refining, agentLine, projectAssignments, liveAssignments, viewedSprint, operatorNeeded, ICONS, since, indent, center, middle, color, green, red, gold, timestamp, sprintTickets } from './shared.js';

// Screens where space pauses and releases the agents.
export const PAUSABLE = new Set(['s', 'S', 'b', 'B', 'c', 'a', 'A']);

// The lines under the platform boxes: the legend and, once data has loaded,
// when the selected project's data last changed (updatedAt, ms by project;
// a single ms, from before ASS-10, for every project).
export const updatedOf = state => (typeof state.updatedAt === 'object' && state.updatedAt ? state.updatedAt[state.projects[state.project]?.id] : state.updatedAt);
export const below = state => (updatedOf(state) ? 2 : 1);

// The sprint's days are UTC days (ASS-294; this computer's from ASS-216), as
// the end-of-day snapshot names them (utcDate): dayNumber(ms) the number of
// the UTC day of `ms`, a sprint's YYYY-MM-DD dates numbered alike; shownAt(state,
// now) the moment on show — a past day is seen as it was captured, at 23:59 UTC that day.
const dayNumber = ms => Math.floor(ms / 864e5);   // whole UTC days since the epoch: utcDate's day, numbered
const sprintDay = date => Date.parse(date) / 864e5;
const shownAt = (state, now) => (state.day ? Date.parse(`${state.day}T23:59:00Z`) : now);

// Whether no agent of the selected project works a ticket of its active
// sprint (ASS-59), whatever its status or variation: only today, since
// assignments describe it, and only with an active sprint. Health checks (no
// work-item) and backlog refinement are not sprint work.
function idle(state) {
  const sprint = state.projects[state.project]?.sprint;
  if (state.day || !sprint) return false;
  const keys = new Set(Object.keys(ICONS).flatMap(type => sprint[type] ?? []).map(t => t.key.toLowerCase()));
  return !liveAssignments(state).some(a => !refining(state, a) && keys.has(String(a['work-item']).toLowerCase()));
}
// The sprint header's warnings, in the order they show: the logins to renew, background work off (ASS-127), then idleness.
const warnings = state => [
  state.projects[state.project]?.gcloudReauthentication && "run 'gcloud auth login' asap",
  state.projects[state.project]?.glabReauthentication && "run 'glab auth login' asap",
  state.projects[state.project]?.backgroundWorkOff && 'Background work off',
  idle(state) && 'No work in progress',
].filter(Boolean);

// The disk (ASS-288), harness-wide, as control last read it (disk-space.json,
// state.disk): below disk-free-warn-gb the free space in amber — never red,
// it is a warning — and below disk-free-hold-gb, while work is held, the hold
// in black on amber, stronger; at or above the warn level, or never read,
// nothing. GiB free (2^30), the levels in harness.json's GB (10^9).
const AMBER = color('38;2;255;176;0');
const AMBER_CHIP = color('1;30;48;2;255;176;0');
const gib = bytes => (bytes / 2 ** 30).toFixed(1);
export function diskText(disk) {
  if (disk?.level === 'hold') return AMBER_CHIP(` Disk nearly full — work held (${gib(disk['free-bytes'])} GiB free): nothing new starts until ${disk['warn-bytes'] / 1e9} GB is free `);
  if (disk?.level === 'warn') return AMBER(`Disk low: ${gib(disk['free-bytes'])} GiB free, below the ${disk['warn-bytes'] / 1e9} GB warning level — control deletes stopped VMs no ticket needs`);
  return null;
}
// The disk's line under the banner, clipped to the screen; none when it is fine.
const diskLines = (disk, columns) => { const text = diskText(disk); return text ? [center(visible(text) > columns ? ellipsis(text, columns) : text, columns)] : []; };

// The flow screens' header (ASS-187): the diagram wants the room, so S and B
// get the project menu (unless hidden) and a single info line — the project,
// its sprint, the day on show (in reverse video while focused) and the time
// left, or "<project> — no active sprint" — followed by a white-on-red chip
// for each state that holds the agents, strongest first and none while they
// run. The metric tiles hang beside it, the info line on their value row. No
// banner, health-check lines or SPRINT letters, and no platform boxes.
function compactHeader(state, columns, now) {
  const project = state.projects[state.project];
  const sprint = viewedSprint(state);
  const today = dayNumber(shownAt(state, now));
  const left = sprint ? sprintDay(sprint.end) - today : 0;
  const dayOf = sprint ? `day ${today - sprintDay(sprint.start) + 1} of ${sprintDay(sprint.end) - sprintDay(sprint.start) + 1}` : '';
  const ends = left === 0 ? 'sprint ends today' : left > 0 ? `sprint ends in ${left} day${left > 1 ? 's' : ''}` : 'sprint ended';
  const name = project?.name ?? 'this project';
  const chips = heldTitles(holding(state), healingFor(state), limitFor(project), project?.accountHold ?? null)
    .map(title => color('41;97')(` ${title} `)).join(' ');
  const info = sprint
    ? `${name} — sprint ${sprint.number} — ${state.focus === 'day' ? `\x1b[7m${dayOf}\x1b[0m` : dayOf} — ${ends}`
    : `${name} — no active sprint`;
  const disk = diskText(state.disk);
  return [
    ...(state.menuHidden ? [] : [...menu(state).map(line => center(line, columns)), '']),
    // Five lines, the info on the third, so all four tile rows hang beside them (besideRight).
    ...besideRight(['', '', [info, chips, disk].filter(Boolean).join('  '), '', ''], metricTiles(state, now), columns),
    '',
  ];
}

// Everything above the screen body: banner, the disk when it is low (diskLines, ASS-288), the health-check agents (which
// watch the whole system, so from every project) as "🤖 name - status
// update" lines, project menu (unless hidden), sprint with the project's name
// beside its day box and its metric tiles at the right. The flow screens take
// the compact header above instead.
export const headerLines = (state, columns, now) => (state.screen === 'S' || state.screen === 'B' ? compactHeader(state, columns, now) : [
  ...banner(holding(state), healingFor(state), limitFor(state.projects[state.project]), columns, PAUSABLE.has(state.screen), now, state.projects[state.project]?.accountHold ?? null),
  ...diskLines(state.disk, columns),
  ...state.assignments.filter(a => a['health-check'] === true)
    .map(a => center(agentLine(a), columns)),
  '',
  ...(state.menuHidden ? [] : [...menu(state).map(line => center(line, columns)), '']),
  // A past day is seen as it was captured, at the end of that day (shownAt).
  // The project's name and the warnings are about now, so they show whatever the day.
  ...besideRight(sprintLines(viewedSprint(state), shownAt(state, now), state.focus === 'day',
    state.projects[state.project], warnings(state)), metricTiles(state, now), columns),
  '',
]);

// The platform boxes above the legend, and a blank line under them: the
// selected project's control process, one per local environment, then its
// models. Each box is titled and lists its fields as "field: value";
// environments leave out type; control and environments add 🤖 to the title
// when an assignment has control true or a local-environment naming them.
// The control box is built from the control the dashboard started
// (state.controls, ASS-310): its status — Draining while it drains,
// Restarting through a restart, else Online — its process id and its uptime,
// so it shows for as long as that control runs; it then shows where the
// project's code goes — its repository provider, repository and push account
// (forgeLines, ASS-307); the DOWN box has neither. A control that has ended
// (controlsDown) is a red "control DOWN" box with its exit code and the line
// before it. Either ends with the machine's lines and the project's
// Hindsight (machineLines, ASS-292, ASS-293). The models
// box, always there for a project, has a "model 🤖xN" line per model its
// assignments use, most first, then how the project is billed (billingLines,
// ASS-221), ending with the account.
export function platform(state, columns, now) {
  if (state.screen === 'S' || state.screen === 'B') return []; // the flow screens give the diagram the room (ASS-187)
  const project = state.projects[state.project];
  const { environments = [] } = project ?? {};
  const control = state.controls?.[project?.id];
  const models = Map.groupBy(projectAssignments(state), a => a.model);
  const watched = new Set(projectAssignments(state).map(a => a['local-environment']));
  const box = (title, fields) => [title, ...Object.entries(fields).map(([field, value]) => `${field}: ${value}`)];
  const status = state.draining?.[project?.id] != null ? 'Draining' : state.restart ? 'Restarting' : 'Online';
  const down = state.controlsDown?.[project?.id];
  const boxes = [
    ...(down ? [[red('control DOWN'), `exited: code ${down.code}`, `last: ${ellipsis(down.line, 60)}`, ...machineLines(state.disk, project, state.memoryHealth)]] : []),
    ...(control && !down ? [[...box(projectAssignments(state).some(a => a.control === true) ? 'control 🤖' : 'control', { status, 'process-id': control.pid, uptime: since(control.startTime, now) }), ...forgeLines(project), ...machineLines(state.disk, project, state.memoryHealth)]] : []),
    ...environments.map(({ name, type, ...fields }) => box(watched.has(name) ? `${name} 🤖` : name, fields)),
    ...(project ? [['models', ...[...models]
      .toSorted(([a, x], [b, y]) => y.length - x.length || String(a).localeCompare(String(b)))
      .map(([model, list]) => `${model} 🤖x${list.length}`), ...billingLines(project, now)]] : []),
  ];
  const row = boxRow(boxes, columns);
  return row.length ? [...row, ''] : row;
}

// forgeLines(project) — ASS-307: in the control (not control DOWN) box, the
// project's repository provider, its repository (or repository count) as a
// link, and the account its code pushes as (project.pushAccount, from
// data/projects/<p>/push-account.json, control's last check — see
// src/control/push-account.js). `provider: GitHub`/`GitLab` (by the first
// repository url's host, github.com → GitHub, else GitLab, including a
// self-hosted GitLab); one repository → `repo: <owner>/<name>` linked to the
// repository; several → `repos: <N> in <owner>` linked to the urls' longest
// common group/owner page, or `repos: <N> in <host>` linked to the host when
// there is none; `account: <login>` plain, `account: <reason>` in red on
// failure, `account: …` plain while the lookup has not run or its record is
// for another provider than the repositories' now. Every repository
// project.json lists is counted, Active or not; a malformed url is dropped
// from the count. Nothing — no provider, repo or account line — for a project
// with no repositories (or none whose url parses).
function forgeLines(project) {
  const urls = (project.repositories ?? []).map(r => { try { return new URL(r.url).href; } catch { return null; } }).filter(Boolean);
  if (!urls.length) return [];
  const { provider, host } = providerOf(urls[0]);
  const repoLine = urls.length === 1
    ? `repo: ${link(repoPath(urls[0]), urls[0])}`
    : (() => {
      const owner = commonOwner(urls);
      return owner
        ? `repos: ${link(`${urls.length} in ${owner}`, `https://${host}/${owner}`)}`
        : `repos: ${link(`${urls.length} in ${host}`, `https://${host}`)}`;
    })();
  const push = project.pushAccount;
  const accountLine = !push || push.provider !== provider ? 'account: …'
    : push.error ? red(`account: ${push.error}`)
    : `account: ${push.account}`;
  return [`provider: ${provider}`, repoLine, accountLine];
}

// machineLines(disk, project, health) — what the control box ends with (ASS-292): the
// disk's free space as control last read it (disk-space.json, ASS-288) in
// GiB, amber below the warning level as diskText's line, "unknown" never
// read; then the project's golden image (load.js loadGolden), its name and
// the UTC day it was built, saying UTC (ASS-294: "built 2026-11-07 UTC"),
// "(not built)" never, or "none" without one;
// then its Hindsight (hindsightLine, ASS-293).
function machineLines(disk, project, health) {
  const free = disk?.['free-bytes'] == null ? 'disk free: unknown' : `disk free: ${gib(disk['free-bytes'])} GiB`;
  const golden = project?.golden;
  return [
    disk?.level === 'warn' || disk?.level === 'hold' ? AMBER(free) : free,
    golden ? `golden image: ${golden.name} (${golden['built-at'] ? `built ${utcDate(new Date(golden['built-at']))} UTC` : 'not built'})` : 'golden image: none',
    hindsightLine(project, health?.[project?.id]),
  ];
}

// hindsightLine(project, check) — the project's Hindsight as the dashboard
// last checked it itself (ASS-293: memoryHealth, tui/memory.js — live while
// control is down, so the control DOWN box shows it alike): "up (port <n>)"
// green when /health answered healthy, "down (port <n>) since <time>" red,
// since the first check that found it down; "checking" before the first check
// of its port; "none" for a project without a hindsight in project.json.
function hindsightLine(project, check) {
  const port = project?.hindsight?.port;
  if (port == null) return 'hindsight: none';
  if (check?.port !== port) return 'hindsight: checking';
  return check.healthy ? green(`hindsight: up (port ${port})`) : red(`hindsight: down (port ${port}) since ${timestamp(new Date(check.since))}`);
}

// The models box's billing lines (ASS-221), by the project's login as control
// last read it (claude-usage's auth-method and org): an API-key login
// (kindOfAccount 'anthropic') bills to its org's API key — "billing: API key
// (<org>)", its org's spend (apiCostLines) or "API spend: unknown for <org>"
// without a reading this month, then the account; any other its
// subscription's usage (usageLines) with the project's org's spend, if any,
// before the account. The spend is always the project's own (loadProjects'
// apiCost), never another org's.
function billingLines({ claudeUsage: usage, apiCost }, now) {
  const spend = apiCostLines(apiCost, now);
  if (kindOfAccount({ authMethod: usage?.['auth-method'] }) !== 'anthropic') return usageLines(usage, now).toSpliced(-1, 0, ...spend);
  const org = usage.org ?? '—';
  return [`billing: API key (${org})`, ...(spend.length ? spend : [`API spend: unknown for ${org}`]), `account: ${usage.email ?? '—'}`];
}

// The models box's last three lines (ASS-47, ASS-65), from the project's
// claude-usage (control's last reading of its login): how much of the 5-hour
// session, then of the 7-day week (`weekly`, null on a plan with no weekly
// cap), is used, to the whole percent, and when each resets, counting down
// (`… ago` once passed); and the account it is logged in to. A dash for what
// it lacks.
function usageLines(usage, now) {
  const used = window => {
    const { percent, 'resets-at': at } = window ?? {};
    const left = Date.parse(at) - now;
    const resets = Number.isNaN(left) ? '' : `, resets ${timestamp(new Date(at))} (${left >= 0 ? `in ${duration(left)}` : `${duration(-left)} ago`})`;
    return percent == null ? '—' : `${Math.round(percent)}% used${resets}`;
  };
  return [`session: ${used(usage?.session)}`, `weekly: ${used(usage?.weekly)}`, `account: ${usage?.email ?? '—'}`];
}

// The models box's API line (ASS-153), from apiCost (control's last reading
// of the project's API organization's spend, with its budget; see
// loadProjects' apiCost): "API $12.34 this
// month", or with a budget "API $12.34 / $50 this month", gold from 80% of
// it and red once it is reached. None without a reading, or with one of
// another month than now's (UTC): not this month's spend.
function apiCostLines(apiCost, now) {
  if (!apiCost || apiCost.month !== new Date(now).toISOString().slice(0, 7)) return [];
  const { usd, budget } = apiCost;
  const dollars = n => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  if (!budget) return [`API $${usd.toFixed(2)} this month`];
  const shade = usd >= budget ? red : usd >= 0.8 * budget ? gold : text => text;
  return [shade(`API $${usd.toFixed(2)} / ${dollars(budget)} this month`)];
}

// The agents' status: every reason they are held, strongest first — RATE
// LIMITED (`limit`, the selected project's rate-limit, limitFor: control
// sends the held kinds' agents nothing until it resets), SELF HEALING
// (`healing`, in place of PAUSED BY AI; it holds only the tickets it paused),
// PAUSED BY AI, PAUSED BY HUMAN. The
// first in block letters, centered; each further one queued beside the block's
// right, one per line, as `+ <reason>` in plain text. Beneath: the first
// reason again and what control does; for a rate limit its window and when it
// resets, counting down; for self-healing what is being fixed, the ticket
// (linked) and the tickets it paused, else for an AI's pause why; an AI's ETA; and where space works
// (`pausable`), what it does — it holds and releases the human's pause alone.
// The paused banner keeps its height either way.
const WINDOWS = { five_hour: '5-hour window', seven_day: '7-day window' };
// limitFor(project) — the project's rate limit for the banner (ASS-215: its
// rate-limit.json holds one per credential kind): the entry resetting last,
// { since, type, resets-at }, with kinds (every kind held, sorted) and cap (its api-cap-hold, ASS-217, or null); null when
// it holds none.
function limitFor(project) {
  const entries = Object.entries(project?.rateLimit ?? {}).filter(([, e]) => e?.['resets-at']);
  if (!entries.length) return null;
  const [, latest] = entries.reduce((a, b) => (Date.parse(b[1]['resets-at']) > Date.parse(a[1]['resets-at']) ? b : a));
  return { ...latest, kinds: entries.map(([kind]) => kind).toSorted(), cap: project.apiCapHold ?? null };
}
// capText(cap) — the API cap holding the project's fallback to its API key
// (ASS-217: project.json api-cap-hold), as the Limit line ends with it; '' for none.
const capText = cap => (cap ? ` — no agent starts on the API key: its ${cap.cap} cap is reached (${spendText(cap['spend-usd'], cap['limit-usd'])})` : '');
// holding(state) — the pauses that hold the selected project (assignments.json
// pauses: all agents', and its own), for the banner: the human's and the AI's
// — all's first — whose agents each holds, and which the human holds where.
export function holding(state) {
  const project = state.projects[state.project];
  const all = state.pauses.all ?? {}, own = (project && state.pauses[project.id]) ?? {};
  const whose = scoped => (scoped === all ? 'every agent' : `${project?.name}'s agents`);
  return {
    human: all.human ?? own.human, humanHolds: whose(all.human ? all : own),
    ai: all.ai ?? own.ai, aiHolds: whose(all.ai ? all : own),
    name: project?.name ?? 'this project', mine: Boolean(own.human), everyone: Boolean(all.human),
  };
}

// healingFor(state) — the self-healing fixes holding the selected project
// (assignments.json self-healing, one record per fix ticket): those for it or
// that paused any of its tickets, as one — their summaries, tickets and
// paused tickets — or null when none does.
function healingFor(state) {
  const id = state.projects[state.project]?.id;
  const fixes = Object.values(state.selfHealing ?? {}).filter(f => f.project === id || (f.paused ?? []).some(p => p.project === id));
  if (!fixes.length) return null;
  return { summary: fixes.map(f => f.summary).join('; '), tickets: fixes.map(f => ({ ticket: f.ticket, url: f['ticket-url'] })), paused: fixes.flatMap(f => f.paused ?? []) };
}

// The titles of the states holding the agents, strongest first, shared by the
// banner and the flow screens' chips (ASS-187) so the order and SELF HEALING
// standing in for PAUSED BY AI are said once. Empty while they run.
export const heldTitles = ({ human, ai }, healing, limit, account) =>
  [limit && 'RATE LIMITED', account && 'SIGN IN', healing ? 'SELF HEALING' : ai && 'PAUSED BY AI', human && 'PAUSED BY HUMAN'].filter(Boolean);

function banner({ human, ai, humanHolds, aiHolds, name, mine, everyone }, healing, limit, columns, pausable, now, account = null) {
  const keys = held => `press space to ${mine ? 'release' : 'pause'} ${name}${!mine && held ? ' too' : ''} — ! to ${everyone ? 'release' : 'pause'} every project`;
  if (!human && !ai && !healing && !limit && !account) return [center(`${green('RUNNING')}  agents are working${pausable ? ` — ${keys(false)}` : ''}`, columns)];
  const [title, ...also] = heldTitles({ human, ai }, healing, limit, account);
  const block = blockText(title);
  const pad = indent(block[0].length, columns);
  const left = Date.parse(ai?.eta) - now;
  const reset = Date.parse(limit?.['resets-at']) - now;
  const hint = `${keys(Boolean(human || ai || limit))}${limit ? ' — the limit lifts on its own' : ai ? ' — only the AI can release its pause' : ''}`;
  return [
    ...block.map((line, i) => (also[i] ? `${pad}${red(line)}  ${red(`+ ${also[i]}`)}` : pad + red(line.trimEnd()))),
    '',
    center(`${red(title)} — ${limit ? `control sends its ${limit.kinds.join(' and ')} agents nothing until it resets` : title === 'SIGN IN' ? `control starts none of ${name}'s agents: it expects ${account.expected}, ${account.actual ? `logged in as ${account.actual}` : 'not logged in'}` : title === 'SELF HEALING' ? 'control pauses only the tickets the fix holds' : `control is asking ${title === 'PAUSED BY AI' ? aiHolds : humanHolds} to commit and stop`}`, columns),
    ...(title === 'SIGN IN' ? [center(`Sign in: ${account['config-dir'] ? `CLAUDE_CONFIG_DIR=${account['config-dir']} ` : ''}claude, then /login as ${account.expected}`, columns)] : []),
    ...(limit ? [
      center(`Limit: ${WINDOWS[limit.type] ?? limit.type}${capText(limit.cap)}`, columns),
      center(`Resets: ${timestamp(new Date(limit['resets-at']))} — ${reset >= 0 ? `in ${duration(reset)}` : `${duration(-reset)} ago`}`, columns),
    ] : []),
    ...(healing ? [
      center(`Fixing: ${healing.summary}`, columns),
      center(`Ticket: ${healing.tickets.map(t => (t.url ? link(t.ticket, t.url) : t.ticket)).join(', ')}`, columns),
      center(`Paused: ${[...new Set(healing.paused.map(p => `${p.ticket}${p.project ? ` (${p.project})` : ''}`))].join(', ') || 'none'}`, columns),
    ] : ai ? [center(`Why: ${ai.reason}`, columns)] : []),
    ...(ai ? [center(`ETA: ${timestamp(new Date(ai.eta))} — ${left >= 0 ? `in ${duration(left)}` : `${duration(-left)} overdue`}`, columns)] : []),
    pausable ? center(hint, columns) : '',
  ];
}

// Projects side by side, the selected one in reverse video while the menu has
// focus and underlined otherwise, each with the count of its assignments
// ("🤖x3") centered on the line beneath it.
function menu({ projects, project, assignments, focus }) {
  const items = projects.map((p, i) => {
    const name = ` ${p.name} `;
    const count = `🤖x${assignments.filter(a => a.project === p.id).length}`;
    const width = Math.max(visible(name), visible(count));
    const mark = focus === 'menu' ? '\x1b[7m' : '\x1b[4m';
    return [i === project ? `${mark}${middle(name, width)}\x1b[0m` : middle(name, width), middle(count, width)];
  });
  // Both lines the same width, so centering keeps each count under its name.
  return [items.map(item => item[0]).join('  '), items.map(item => item[1]).join('  ')];
}

// SPRINT <n> in block letters, and twelve columns beside it a box with the
// day (in reverse video when `focused`), time left, the time and how to change
// the day, each centered. The box is a line taller than the letters.
// Each of `warnings` shows in its own white-on-red box to the right of the day
// box, on its middle line, in list order, a space between.
function sprintLines(sprint, now, focused, project, warnings) {
  const name = project?.name ? `     ${project.name}` : '';
  if (!sprint) return [`No active sprint${name}`];
  const today = dayNumber(now);
  const left = sprintDay(sprint.end) - today;
  const dayOf = `day ${today - sprintDay(sprint.start) + 1} of ${sprintDay(sprint.end) - sprintDay(sprint.start) + 1}`;
  const info = [
    focused ? `\x1b[7m${dayOf}\x1b[0m` : dayOf,
    left === 0 ? 'sprint ends today' : left > 0 ? `sprint ends in ${left} day${left > 1 ? 's' : ''}` : 'sprint ended',
    timestamp(now),
    'press the left and right arrows to change the day',
  ];
  const width = Math.max(...info.map(visible)) + 2;
  const box = [`┌${'─'.repeat(width)}┐`, ...info.map(text => `│${middle(text, width)}│`), `└${'─'.repeat(width)}┘`];
  const block = blockText(`SPRINT ${sprint.number}`);
  // The project's name on the box's second line, the warnings right under it.
  const aside = i => (i === 1 ? name : warnings.length && i === 2 ? `    ${warnings.map(w => color('41;97')(` ${w} `)).join(' ')}` : '');
  return box.map((line, i) => `${block[i] ?? ' '.repeat(block[0].length)}${' '.repeat(12)}${line}${aside(i)}`);
}

// Tiles for the sprint work on show, in order: the tickets waiting on the
// operator (operatorNeeded), the sprint's alone, never the backlog's (ASS-254), each once whatever its variations — on blue when there are any (ASS-242) — the tickets
// delivered (any variation in the engine's last state) and their points, and
// what the project spent (ASS-216) on the day on show and over its sprint
// through that day: its sprint's and backlog's dispatches, its ticket chats'
// turns, its chat-screen turns (ASS-271) and its Hindsight's Claude calls
// (spend.js), in dollars to the cent, the total alone; each a value boxed, as
// wide as its label or value, with its label beneath.
function metricTiles(state, now) {
  const { tickets, done } = sprintTickets(state);
  const unique = list => [...new Map(list.map(t => [t.key, t])).values()];
  const needed = operatorNeeded(state, tickets).size;
  const delivered = unique(tickets.filter(t => t.step?.sequence === done));
  const project = state.projects[state.project], sprint = viewedSprint(state), at = new Date(shownAt(state, now));
  const records = spendRecords([...flattenSprint(sprint ?? {}), ...(project?.backlog ?? [])], project?.collaborations, project?.chatSpend, project?.memorySpend ?? []);
  const dollars = usd => `$${usd.toFixed(2)}`;
  return [
    [needed, 'Operator Needed Tickets', needed > 0 && '44;97'],
    [delivered.length, 'Delivered Tickets'],
    [delivered.reduce((sum, t) => sum + (t.points ?? 0), 0), 'Delivered Points'],
    [dollars(daySpend(records, at)), 'Day Spend'],
    [dollars(sprintSpend(records, sprint?.start, at)), 'Sprint Spend'],
  ].map(([value, label, fill]) => {
    const width = Math.max(label.length, String(value).length) + 2;
    const inside = middle(String(value), width);
    return [`┌${'─'.repeat(width)}┐`, `│${fill ? color(fill)(inside) : inside}│`, `└${'─'.repeat(width)}┘`, middle(label, width + 2)];
  });
}

// The most of `tiles` (each four lines), from the first, laid side by side
// four columns apart over `lines` from their second line, flush with the right
// edge, that fit beside them at least four columns away; else `lines` alone.
function besideRight(lines, tiles, columns) {
  const room = columns - 4 - Math.max(...lines.map(visible));
  const join = list => list[0].map((_, i) => list.map(tile => tile[i]).join('    '));
  const fits = tiles.map((_, n) => join(tiles.slice(0, n + 1))).filter(right => visible(right[0]) <= room);
  const right = fits.at(-1);
  if (lines.length < 2 || !right) return lines;
  const width = visible(right[0]);
  return lines.map((line, i) => (right[i - 1] == null ? line : line + ' '.repeat(columns - visible(line) - width) + right[i - 1]));
}
