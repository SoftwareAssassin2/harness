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
import { usesVms, usesWorkstations, cloudVmsOf, workstationsOf } from '../../control/dev-environments.js';
import { workstationState, cloudVmState } from '../../control/workstation-machines.js';
import { lostWhy, seatCapacity } from '../../control/seat-kinds.js';
import { ellipsis, refining, agentLine, projectAssignments, liveAssignments, viewedSprint, operatorNeeded, restartFixes, markDot, ICONS, since, indent, center, middle, color, green, red, gold, timestamp, sprintTickets, runsScript, GLYPHS, gray, seatPlan } from './shared.js';

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
// work-item) and backlog refinement are not sprint work. ASS-511: nor is it
// idle while a ticket of the sprint runs a script — runsScript over the rows
// the sprint screen shows (sprintTickets), the 💻 icon's rule, so a script
// step held at a gate or paused is no work.
function idle(state) {
  const sprint = state.projects[state.project]?.sprint;
  if (state.day || !sprint) return false;
  const keys = new Set(Object.keys(ICONS).flatMap(type => sprint[type] ?? []).map(t => t.key.toLowerCase()));
  if (liveAssignments(state).some(a => !refining(state, a) && keys.has(String(a['work-item']).toLowerCase()))) return false;
  return !sprintTickets(state).tickets.some(t => runsScript(state, t));
}
// ASS-412: the selected project's warnings, one list for the header and the
// Mac notifications (src/notify/warnings.js evaluates it for every project,
// each selected on its live sprint). Each is { id, text, scope, operator, chip,
// todo, after? }: `id` stable whatever the text's numbers; `text` as the header
// says it; `scope` 'harness' for one the whole harness shares (the memory and
// disk holds, the disk low, the landed fixes, a pause of every project), else
// 'project'; `operator` for one the operator caused (background work off, the
// human's pause), which never notifies; `chip` for one the sprint header shows
// in a white-on-red box — the rest are the banner's and the disk line's, which
// render from the same helpers (banner, diskLines); `todo` the one line saying
// what to do; `after` the ms it must stay up before it notifies (No work in
// progress: IDLE_AFTER_MS). The chips, in the order they show: the project held
// by its credentials (ASS-395), the gcloud login to renew, a workstation whose
// setup failed (ASS-434), the glab login to renew, background work off
// (ASS-127), the memory and disk holds (ASS-398: any project's
// memory-hold.json, the disk hold of ASS-288), the landed fixes a restart would
// load (ASS-393), then idleness (ASS-59), then the analytics' Jira API token
// rejected (ASS-475: the downloader's jira-token-rejected.json; it holds no
// work, but the Performance screen's numbers stop until it is fixed); then the
// banner's: the disk low (ASS-288), the account hold, the rate limit,
// self-healing and the human's pause.
export const IDLE_AFTER_MS = 5 * 60e3;
export function headerWarnings(state, now = Date.now()) {
  const project = state.projects[state.project];
  const warning = (id, text, todo, { scope = 'project', operator = false, chip = false, after } = {}) => ({ id, text, scope, operator, chip, todo, ...(after ? { after } : {}) });
  const fixes = [...restartFixes(state)];
  const firstFix = project?.credentialsHold?.problems?.[0];
  const { limit } = limitFor(project, now);
  const healing = healingFor(state), account = project?.accountHold ?? null, { human, everyone } = holding(state);
  return [
    project?.credentialsHold && warning('credentials', 'Project blocked by credentials', firstFix?.fix ? `Run ${firstFix.fix}` : 'Fix the credentials the dashboard lists for this project', { chip: true }),
    project?.gcloudReauthentication && gcloudWarning(warning, project.gcloudLogins),
    ...setupWarnings(warning, project),
    project?.glabReauthentication && warning('glab-login', "run 'glab auth login' asap", 'Run glab auth login in a terminal', { chip: true }),
    project?.backgroundWorkOff && warning('background-work-off', 'Background work off', 'Turn background work back on when you want it', { chip: true, operator: true }),
    state.projects.some(p => p.memoryHold) && warning('out-of-memory', 'Out of memory', 'Free memory on the Mac: no new VM starts until there is enough', { chip: true, scope: 'harness' }),
    state.disk?.level === 'hold' && warning('out-of-disk-space', 'Out of disk space', `Free disk space: nothing new starts until ${state.disk['warn-bytes'] / 1e9} GB is free`, { chip: true, scope: 'harness' }),
    fixes.length > 0 && warning('restart', restartNotice(fixes.length), `Restart the harness to load ${fixes.join(', ')}`, { chip: true, scope: 'harness' }),
    idle(state) && warning('idle', 'No work in progress', 'No agent is working a sprint ticket: check the sprint', { chip: true, after: IDLE_AFTER_MS }),
    project?.jiraTokenRejected && warning('jira-token-rejected', 'Jira API token rejected', jiraTokenTodo(project.jiraTokenRejected), { chip: true }),
    state.disk?.level === 'warn' && warning('disk-low', 'Disk low', `Free disk space: ${gib(state.disk['free-bytes'])} GiB free, below the ${state.disk['warn-bytes'] / 1e9} GB warning level`, { scope: 'harness' }),
    account && warning('sign-in', 'Sign in', `Sign in: ${account['config-dir'] ? `CLAUDE_CONFIG_DIR=${account['config-dir']} ` : ''}claude, then /login as ${account.expected}`),
    limit && warning('rate-limited', 'Rate limited', `Wait: control sends its ${limit.kinds.join(' and ')} agents nothing until it resets ${resetText(limit['resets-at'], now)}`),
    healing && warning('self-healing', 'Self healing', `Control is fixing ${healing.summary}`),
    human && warning('paused-by-human', 'Paused by human', 'Press space to release it', { operator: true, scope: everyone ? 'harness' : 'project' }),
    // ASS-460, ASS-457: every project's control down, and this one's waiting for its data (controlTroubles: the red header lines).
    ...controlTroubles(state, now).filter(t => t.scope === 'harness' || t.project === project?.id).map(t => warning(t.id, t.text, t.todo, { scope: t.scope, ...(t.after ? { after: t.after } : {}) })),
  ].filter(Boolean);
}

// jiraTokenTodo(record) — ASS-475: what to do about the analytics' rejected
// Jira API token, as the header warning's notification and the Performance
// screen say it.
export function jiraTokenTodo(record) {
  const source = record?.['work-source'] ? `the "${record['work-source']}" jira work source` : 'its jira work source';
  return `Jira rejects the analytics API token of ${source}${record?.since ? ` since ${String(record.since).replace('T', ' ').replace(/:\d\dZ$/, ' UTC')}` : ''}, so the analytics are not updated: create a new Atlassian API token and put it in project.json as the api-token of ${source}`;
}

// controlTroubles(state, now) — ASS-460, ASS-457: a red line under the banner
// for each project whose control is down (app.js controlsDown: crashed and
// waiting to be started again, given up, or ended by itself; until it is back,
// app.js controlBack) — every project's, whichever is selected — saying the
// project, what happens next and its last line (the error, its time cut); and
// for each control waiting for its data (app.js dataWaiting, the data folder
// unreadable or a file not parsing). Each { id, project, scope, text, todo,
// line, after? } also stands as a header warning, so it notifies once per
// outage (src/notify/): a control down harness-wide, its id the project's, so
// it is sent once, not once per project; one waiting for its data the
// project's, once it has waited a minute.
const DATA_WAIT_NOTIFY_MS = 60e3;
const clock = ms => new Date(ms).toISOString().slice(11, 19);
export function controlTroubles(state, now = Date.now()) {
  const nameOf = id => state.projects.find(p => p.id === id)?.name ?? id;
  const down = Object.entries(state.controlsDown ?? {}).map(([id, d]) => {
    const error = String(d.line ?? '').replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '') || `exited with code ${d.code}`;
    const next = d.restarted ? `started again at ${clock(d.restarted)} UTC`
      : d.gaveUp ? `crashed ${d.crashes} times in ${GIVE_UP_MINUTES} minutes, not started again: press R on the control screen (c) to start it`
        : d.restartAt ? `starting again in ${Math.max(0, Math.ceil((d.restartAt - now) / 1000))}s (crash ${d.crashes})`
          : 'ended by itself, not started again: press R on the control screen (c) to start it';
    const text = `Control ${nameOf(id)} down: ${ellipsis(error, 60)}`;
    return { id: `control-down:${id}`, project: id, scope: 'harness', text, todo: next[0].toUpperCase() + next.slice(1), line: `CONTROL DOWN — ${nameOf(id)} — ${next} — last: ${error}` };
  });
  const waiting = Object.entries(state.dataWaiting ?? {}).filter(([id]) => !state.controlsDown?.[id]).map(([id, w]) => ({
    id: 'control-data-wait', project: id, scope: 'project', text: 'Control waiting for its data', after: DATA_WAIT_NOTIFY_MS,
    todo: `Control ${nameOf(id)} ${w.text}: its ticks are skipped until it reads (is the drive there?)`,
    line: `CONTROL ${nameOf(id).toUpperCase()} WAITING FOR ITS DATA since ${clock(new Date(w.since).getTime())} UTC — ${w.text}`,
  }));
  return [...down, ...waiting];
}
const GIVE_UP_MINUTES = 10;
// gcloudWarning(warning, logins) — the gcloud login chip: run 'gcloud auth
// login'; ASS-433: for a workstation whose own login expired, with the
// CLOUDSDK_CONFIG it needs (control/workstation-connection.js loginCommand),
// each login so when they are more than one.
function gcloudWarning(warning, logins = []) {
  const commands = logins.length ? logins.map(l => l.command) : ['gcloud auth login'];
  return warning('gcloud-login', `run ${commands.map(c => `'${c}'`).join(' and ')} asap`, `Run ${commands.join(', then ')} in a terminal`, { chip: true });
}
// setupWarnings(warning, project) — ASS-434: a chip for each of the
// project's workstations whose last setup (workstation:setup, the live data's
// setup) failed, saying what failed: control dispatches nothing to it until
// a setup works.
// ASS-481: a cloud VM's says "Cloud VM <id>".
function setupWarnings(warning, project) {
  const cloud = new Set(cloudVmsOf(project?.devEnvironments).map(w => w.id));
  return Object.entries(project?.workstations ?? {}).filter(([, e]) => e?.setup?.ok === false)
    .map(([id, e]) => {
      const what = cloud.has(id) ? 'Cloud VM' : 'Workstation';
      return warning(`workstation-setup:${id}`, `${what} ${id} setup failed`, `Fix ${what.toLowerCase()} ${id}'s setup (nothing is dispatched to it meanwhile): ${e.setup.error ?? 'see control\'s log'}`, { chip: true });
    });
}
// The sprint header's white-on-red boxes (sprintLines): headerWarnings' chips' texts, in its order (ASS-412).
const warnings = (state, now) => headerWarnings(state, now).filter(w => w.chip).map(w => w.text);
// ASS-393: one notice for every landed harness fix the running control has not loaded (restartFixes), never one per ticket.
const restartNotice = n => `Restart to load ${n} landed fix${n === 1 ? '' : 'es'}`;

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
  const chips = heldTitles(holding(state), healingFor(state), limitFor(project, now).limit, project?.accountHold ?? null)
    .map(title => color('41;97')(` ${title} `)).join(' ');
  const info = sprint
    ? `${name} — sprint ${sprint.number} — ${state.focus === 'day' ? `\x1b[7m${dayOf}\x1b[0m` : dayOf} — ${ends}`
    : `${name} — no active sprint`;
  const disk = diskText(state.disk);
  return [
    ...(state.menuHidden ? [] : [...menu(state).map(line => center(line, columns)), '']),
    // Five lines, the info on the third, so all four tile rows hang beside them (besideRight).
    ...besideRight(['', '', [info, chips, disk].filter(Boolean).join('  '), '', ''], metricTiles(state), columns),
    '',
  ];
}

// Everything above the screen body: banner, the disk when it is low (diskLines, ASS-288), the health-check agents (which
// watch the whole system, so from every project) as "🤖 name - status
// update" lines, project menu (unless hidden), sprint with the project's name
// beside its day box and its metric tiles at the right. The flow screens take
// the compact header above instead.
export const headerLines = (state, columns, now) => (state.screen === 'S' || state.screen === 'B' ? compactHeader(state, columns, now) : [
  ...banner(holding(state), healingFor(state), limitFor(state.projects[state.project], now), columns, PAUSABLE.has(state.screen), now, state.projects[state.project]?.accountHold ?? null),
  ...diskLines(state.disk, columns),
  ...controlTroubles(state, now).map(t => center(red(ellipsis(t.line, columns)), columns)),
  ...state.assignments.filter(a => a['health-check'] === true)
    .map(a => center(agentLine(a), columns)),
  '',
  ...(state.menuHidden ? [] : [...menu(state).map(line => center(line, columns)), '']),
  // A past day is seen as it was captured, at the end of that day (shownAt).
  // The project's name and the warnings are about now, so they show whatever the day.
  ...besideRight(sprintLines(viewedSprint(state), shownAt(state, now), state.focus === 'day',
    state.projects[state.project], warnings(state, now)), metricTiles(state), columns),
  '',
]);

// The platform boxes above the legend, and a blank line under them: the
// selected project's control process, then its models. Each box is titled
// and lists its fields as "field: value"; control adds 🤖 to the title when
// an assignment has control true. ASS-368: project.json's local-environments
// (local-pc, dev-container) get no box — tickets run in VMs now.
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
// assignments use, most first, then (ASS-469, vm+workstation mode) its VM
// seats used of its VM seats (vmSeatLines), then what the project spent (spendLines,
// ASS-430: moved here from the header's tiles), then how the project is
// billed (billingLines, ASS-221), ending with the account. ASS-436: then, in
// vm+workstation or workstation mode, the gcp workstations box
// (workstationLines); ASS-481: then the cloud virtual machines box
// (cloudVmBox); ASS-486: then, rightmost, in vm or vm+workstation mode, the
// local virtual machines box (localVmBox; ASS-491: its build and planning seats). Each box is one entry of `boxes`,
// so another goes in as one more entry.
export function platform(state, columns, now) {
  if (state.screen === 'S' || state.screen === 'B') return []; // the flow screens give the diagram the room (ASS-187)
  const project = state.projects[state.project];
  const control = state.controls?.[project?.id];
  const models = Map.groupBy(projectAssignments(state), a => a.model);
  const box = (title, fields) => [title, ...Object.entries(fields).map(([field, value]) => `${field}: ${value}`)];
  const status = state.draining?.[project?.id] != null ? 'Draining' : state.restart ? 'Restarting' : state.dataWaiting?.[project?.id] ? red('Waiting for its data') : 'Online';
  // ASS-460: a control started again after a crash is shown running, its outage kept until it is back (app.js controlBack).
  const down = state.controlsDown?.[project?.id]?.restarted ? null : state.controlsDown?.[project?.id];
  const restartLine = d => (d.restartAt ? [`restart: in ${Math.max(0, Math.ceil((d.restartAt - now) / 1000))}s (crash ${d.crashes})`] : d.gaveUp ? [red(`restart: given up after ${d.crashes} crashes`), 'press R to start it'] : d.code === 0 ? ['press R to start it'] : []);
  const boxes = [
    ...(down ? [[red('control DOWN'), `exited: code ${down.code}`, `last: ${ellipsis(down.line, 60)}`, ...restartLine(down), ...machineLines(state.disk, project, state.memoryHealth)]] : []),
    ...(control && !down ? [[...box(projectAssignments(state).some(a => a.control === true) ? 'control 🤖' : 'control', { status, 'process-id': control.pid, uptime: since(control.startTime, now) }), ...forgeLines(project), ...machineLines(state.disk, project, state.memoryHealth)]] : []),
    ...(project ? [['models', ...[...models]
      .toSorted(([a, x], [b, y]) => y.length - x.length || String(a).localeCompare(String(b)))
      .map(([model, list]) => `${model} 🤖x${list.length}`), ...vmSeatLines(project), ...spendLines(state, now), ...billingLines(project, now)]] : []),
    ...workstationBox(state, project),
  ];
  // ASS-481 AC5: the cloud virtual machines box directly after them, and (ASS-486 AC1/AC5) the local virtual machines
  // box after it, rightmost — each on the row before it while that row still fits the screen, else starting a row of its
  // own under it, so the footer fits the TUI's minimum width (120 columns) with all five boxes.
  const rows = [boxes];
  for (const tail of [...cloudVmBox(state, project), ...localVmBox(state, project)]) {
    const last = rows.at(-1);
    if (!last.length || visible(boxRow([...last, tail], columns)[0]) <= columns) last.push(tail);
    else rows.push([tail]);
  }
  const row = rows.flatMap(r => boxRow(r, columns));
  return row.length ? [...row, ''] : row;
}

// workstationBox(state, project) — ASS-436: the "gcp workstations" box, after
// models, while the project's dev-environments (load.js devEnvironments,
// ASS-431) run tickets on workstations (usesWorkstations: vm+workstation or
// workstation mode) and list at least one; none in vm mode, with an empty
// list or while the setting is wrong (null), so the footer is as before. One
// line per workstation, in the list's order, built by remoteLine and
// machineLine (ASS-485 AC6). An id longer than WS_ID is cut to it with an
// ellipsis, so the box stays narrow beside control and models: the longest
// line, WS_ID + "🤖x99 💻 sign in needed seat lost", fits the footer's 120
// columns with both.
// ASS-481: the pool's cloud VMs are not workstations: workstationsOf leaves
// them to cloudVmBox, so a project listing cloud VMs alone has no
// "gcp workstations" box.
const WS_ID = 20;
function workstationBox(state, project) {
  const settings = project?.devEnvironments;
  const list = workstationsOf(settings);
  if (!settings || !usesWorkstations(settings.mode) || !list.length) return [];
  return [['gcp workstations', ...list.map(remoteLine(state, project, workstationState))]];
}

// machineLine({ id, agents, script, state, lost }) — ASS-485 AC6: the one line
// builder of the footer's machine boxes (gcp workstations, cloud virtual
// machines and, ASS-486, local virtual machines): "<id> <activity> <state>", then
// "seat lost" in red when `lost`. The id is cut to WS_ID with an ellipsis;
// activity is "🤖x<agents>" only when agents > 0, then GLYPHS.script (💻) only
// when `script`, nothing when idle; the state word running in green, sign in
// needed, setup failed and start timed out in red. No seat count.
// e.g. "ws-1 💻 running", "harness-vm-1 🤖x1 running", "ws-1 running".
const RED_STATES = new Set(['sign in needed', 'setup failed', 'start timed out']);
export function machineLine({ id, agents = 0, script = false, state, lost = false }) {
  const shade = state === 'running' ? green : RED_STATES.has(state) ? red : text => text;
  const activity = [agents > 0 ? `🤖x${agents}` : '', script ? GLYPHS.script : ''].filter(Boolean);
  return [ellipsis(String(id), WS_ID), ...activity, shade(state), ...(lost ? [red('seat lost')] : [])].join(' ');
}

// remoteLine(state, project, stateOf) — machineLine's facts for the remote
// { id } of the gcp workstations box or (ASS-481) the cloud virtual machines
// box, from its live data (project.workstations[id]):
// - agents and script: the activity (variationActivity) of the variation its
//   holder holds, none with no holder;
// - state: `stateOf`'s word (workstationState, cloudVmState; 'stopped' with
//   no live data yet);
// - lost: while it can't be used (seat-kinds.js lostWhy, ASS-469 AC5).
const sameKey = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
const remoteLine = (state, project, stateOf) => {
  const activity = variationActivity(state);
  return ({ id }) => {
    const entry = project.workstations?.[id], holder = entry?.holder;
    const { agents, script } = holder ? activity(holder.ticket, holder.variation) : { agents: 0, script: false };
    return machineLine({ id, agents, script, state: stateOf(entry), lost: Boolean(lostWhy(entry)) });
  };
};

// variationActivity(state)(ticket, variation) — what a machine's variation is
// doing, for machineLine (ASS-485; ASS-486 the local VMs too):
// - agents: the project's assignments (projectAssignments, as the models box
//   counts them) on the variation (ASS-435: same ticket, case-insensitive,
//   and variation);
// - script (ASS-485 AC1-AC3): the ticket in the sprint on show, found as the
//   sprint screen finds it (sprintTickets) and matched as the agent count
//   matches it, runs a script step by runsScript — the sprint screen's own
//   rule: none at a gate, held, on an agent step, or on a past day.
const variationActivity = state => {
  const assignments = projectAssignments(state);
  const { tickets } = sprintTickets(state);
  return (ticket, variation) => ({
    agents: assignments.filter(a => sameKey(a['work-item'], ticket) && a.variation === variation).length,
    script: tickets.some(t => sameKey(t.key, ticket) && t.variation?.name === variation && runsScript(state, t)),
  });
};

// cloudVmBox(state, project) — ASS-481 AC5: the "cloud virtual machines" box
// (ASS-485 AC7: retitled from "virtual machines"), directly after the gcp
// workstations box (after models without one), while the project's
// dev-environments run tickets on its remote pool (vm+workstation or
// workstation mode) and list at least one cloud VM; none in vm mode, with no
// cloud VMs, or while the setting is wrong. One line per cloud VM, in list
// order, built by remoteLine and machineLine as the workstations' are
// (ASS-485 AC6), its state cloudVmState's word — running, stopped, starting,
// connecting, sign in needed, setup failed, start timed out. Its id is cut to
// WS_ID: the longest line, WS_ID + "🤖x99 💻 start timed out seat lost", fits
// the footer's 120 columns beside control, models and gcp workstations.
function cloudVmBox(state, project) {
  const settings = project?.devEnvironments;
  const list = cloudVmsOf(settings);
  if (!settings || !usesWorkstations(settings.mode) || !list.length) return [];
  return [['cloud virtual machines', ...list.map(remoteLine(state, project, cloudVmState))]];
}

// localVmBox(state, project) — ASS-486, ASS-489, ASS-491: the "local virtual
// machines" box, the footer's rightmost (ASS-489 AC5, ASS-491 AC5), while the
// project runs tickets on Lima VMs (vm or vm+workstation mode, usesVms); none
// in workstation mode, where tickets have no VMs, or while the setting is
// wrong (ASS-491 AC4). One line per seat that uses a local VM (ASS-491 AC1):
// - the in-progress VM seats first, as ASS-489 has them (ASS-491 AC4): their
//   holders, control's seats.json rows of kind 'vm' (project.seats), in their
//   order (oldest first), never more lines than seats; then a gray "free build
//   seat" (ASS-491 AC3) per VM seat left, up to the VM seat count
//   (seatCapacity, as vmSeatLines counts it); with no limit (∞) only the holders;
// - then the planning seats, every one a local VM's (planning always runs on
//   Lima VMs, ASS-469), from seatPlan — the sprint screen's 💺 source, so the
//   two agree: its `planning` holders ("<key> <variation>") in its order, then
//   a gray "free planning seat" per free.planning (none with no planning
//   limit, so only the holders).
// A holder's line is machineLine's (ASS-491 AC2): the VM the vms.json row
// (project.vms) with its ticket (case-insensitive) and variation, its name the
// row's key cut to WS_ID (AC5), its activity variationActivity's, its state the
// VM's own lowercased, "running" in green; with no row yet (still being
// created) its expected name, lowercased key-variation (e.g. vm-1-a),
// "creating" in gray (ASS-489 AC4). No lines at all: one gray "none". A VM
// whose ticket holds no seat — at a gate, blocked, or in a workstation or
// cloud-vm seat — is not listed (ASS-489 AC3).
function localVmBox(state, project) {
  const settings = project?.devEnvironments;
  if (!settings || !usesVms(settings.mode)) return [];
  const activity = variationActivity(state);
  const vms = Object.entries(project.vms ?? {});
  const holderLine = (key, variation) => {
    const [id, vm] = vms.find(([, v]) => sameKey(v?.ticket, key) && v?.variation === variation) ?? [];
    const { agents, script } = activity(key, variation);
    if (!vm) return machineLine({ id: `${key}-${variation}`.toLowerCase(), agents, script, state: gray('creating') });
    return machineLine({ id, agents, script, state: String(vm.state ?? 'stopped').toLowerCase() });
  };
  const holders = (project.seats ?? []).filter(s => s?.kind === 'vm').map(seat => holderLine(seat.key, seat.variation));
  const { vm: seats } = seatCapacity({ json: project.limits?.project ?? {}, devEnvironments: settings, workstations: project.workstations });
  const free = Number.isFinite(seats) ? Array.from({ length: Math.max(0, seats - holders.length) }, () => gray('free build seat')) : [];
  const build = [...(Number.isFinite(seats) ? holders.slice(0, seats) : holders), ...free];
  const plan = seatPlan(state);
  const planning = [
    ...plan.planning.map(name => { const at = name.indexOf(' '); return holderLine(name.slice(0, at), name.slice(at + 1)); }),
    ...Array.from({ length: plan.free.planning }, () => gray('free planning seat')),
  ];
  const lines = [...build, ...planning];
  return [['local virtual machines', ...(lines.length ? lines : [gray('none')])]];
}

// vmSeatLines(project) — ASS-469: in the models box, in vm+workstation mode (where a ticket in progress sits in a VM
// seat or a workstation seat), "vm seats: <used>/<project.json's max-tickets-in-progress>" — "∞" for no limit — as
// control's seats.json records them; none in other modes (vm: every seat is a VM seat, the sprint's empty seat rows
// show them, ASS-451; workstation: no VM seats).
function vmSeatLines(project) {
  if (project?.devEnvironments?.mode !== 'vm+workstation' || !project.devEnvironments.workstations?.length) return [];
  const { vm } = seatCapacity({ json: project.limits?.project ?? {}, devEnvironments: project.devEnvironments, workstations: project.workstations });
  return [`vm seats: ${(project.seats ?? []).filter(r => r.kind === 'vm').length}/${Number.isFinite(vm) ? vm : '∞'}`];
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

// spendLines(state, now) — the models box's spend (ASS-430; the header's Day
// Spend and Sprint Spend tiles before, ASS-216): what the selected project
// spent on the day on show and over its sprint (the viewed one) through that
// day (shownAt) — its sprint's and backlog's dispatches, its ticket chats'
// turns, its chat-screen turns (ASS-271) and its Hindsight's Claude calls
// (spend.js daySpend, sprintSpend), in dollars to the cent, the total alone.
function spendLines(state, now) {
  const project = state.projects[state.project], sprint = viewedSprint(state), at = new Date(shownAt(state, now));
  const records = spendRecords([...flattenSprint(sprint ?? {}), ...(project?.backlog ?? [])], project?.collaborations, project?.chatSpend, project?.memorySpend ?? []);
  const dollars = usd => `$${usd.toFixed(2)}`;
  return [`Day Spend: ${dollars(daySpend(records, at))}`, `Sprint Spend: ${dollars(sprintSpend(records, sprint?.start, at))}`];
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
// The paused banner keeps its height either way. Running while its API key
// stands in for its rate-limited subscription (limitFor's onApiKey), a line
// beneath says so, with when the subscription's limit resets (ASS-333).
const WINDOWS = { five_hour: '5-hour window', seven_day: '7-day window' };
// limitFor(project, now) — the project's rate limits for the banner and the
// chips (ASS-215: its rate-limit.json holds one per credential kind), as
// { limit, onApiKey }, read as control's paymentFor (dispatch.js) reads them
// (ASS-333). limit: whether its agents are held — with no API key to fall back
// to (apiKey, load.js hasApiKey) while any kind is; with one, while its claude
// kind is and its anthropic kind is too or an API cap holds (api-cap-hold,
// ASS-217) — as the entry that lifts the hold first, { since, type, resets-at },
// with kinds (every kind held, sorted) and cap (the api-cap-hold, or null);
// else null. onApiKey: the claude kind's entry while the API key carries the
// work in its place, else null.
function limitFor(project, now) {
  const limits = Object.fromEntries(Object.entries(project?.rateLimit ?? {}).filter(([, e]) => e?.['resets-at']));
  const kinds = Object.keys(limits).toSorted(), cap = project?.apiCapHold ?? null, { claude, anthropic } = limits;
  // When an entry lifts: its reset; never for one without (a sprint's cap, till the next sprint).
  const lifts = entry => (entry['resets-at'] ? Date.parse(entry['resets-at']) : Infinity);
  const held = entry => ({ limit: { ...entry, kinds, cap }, onApiKey: null });
  if (!kinds.length || (project.apiKey && !claude)) return { limit: null, onApiKey: null };
  if (!project.apiKey) return held(Object.values(limits).reduce((a, b) => (lifts(b) < lifts(a) ? b : a)));
  if (!anthropic && !cap) return { limit: null, onApiKey: claude };
  // Held on both: the subscription frees it at its reset, the API key once its
  // kind resets and its cap lifts — a day's at the next midnight UTC, as
  // spend.js daySpend counts the day — whichever comes first.
  const day = new Date(now), midnight = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString();
  const api = [anthropic, cap && { ...claude, 'resets-at': cap.cap === 'day' ? midnight : null }].filter(Boolean).reduce((a, b) => (lifts(b) > lifts(a) ? b : a));
  return held(lifts(api) < lifts(claude) ? api : claude);
}
// resetText(at, now) — when a limit resets, counting down: "<time> — in 2h 0m", or "— 1m 0s ago" once past.
const resetText = (at, now) => {
  const left = Date.parse(at) - now;
  return `${timestamp(new Date(at))} — ${left >= 0 ? `in ${duration(left)}` : `${duration(-left)} ago`}`;
};
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

function banner({ human, ai, humanHolds, aiHolds, name, mine, everyone }, healing, { limit, onApiKey }, columns, pausable, now, account = null) {
  const keys = held => `press space to ${mine ? 'release' : 'pause'} ${name}${!mine && held ? ' too' : ''} — ! to ${everyone ? 'release' : 'pause'} every project`;
  if (!human && !ai && !healing && !limit && !account) return [
    center(`${green('RUNNING')}  agents are working${pausable ? ` — ${keys(false)}` : ''}`, columns),
    // ASS-333: the subscription limited, its API key carrying the work.
    ...(onApiKey ? [center(`Subscription rate limited — agents are on the API key until it resets ${resetText(onApiKey['resets-at'], now)}`, columns)] : []),
  ];
  const [title, ...also] = heldTitles({ human, ai }, healing, limit, account);
  const block = blockText(title);
  const pad = indent(block[0].length, columns);
  const left = Date.parse(ai?.eta) - now;
  const hint = `${keys(Boolean(human || ai || limit))}${limit ? ' — the limit lifts on its own' : ai ? ' — only the AI can release its pause' : ''}`;
  return [
    ...block.map((line, i) => (also[i] ? `${pad}${red(line)}  ${red(`+ ${also[i]}`)}` : pad + red(line.trimEnd()))),
    '',
    center(`${red(title)} — ${limit ? `control sends its ${limit.kinds.join(' and ')} agents nothing until it resets` : title === 'SIGN IN' ? `control starts none of ${name}'s agents: it expects ${account.expected}, ${account.actual ? `logged in as ${account.actual}` : 'not logged in'}` : title === 'SELF HEALING' ? 'control pauses only the tickets the fix holds' : `control is asking ${title === 'PAUSED BY AI' ? aiHolds : humanHolds} to commit and stop`}`, columns),
    ...(title === 'SIGN IN' ? [center(`Sign in: ${account['config-dir'] ? `CLAUDE_CONFIG_DIR=${account['config-dir']} ` : ''}claude, then /login as ${account.expected}`, columns)] : []),
    ...(limit ? [
      center(`Limit: ${WINDOWS[limit.type] ?? limit.type}${capText(limit.cap)}`, columns),
      center(`Resets: ${resetText(limit['resets-at'], now)}`, columns),
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
// ("🤖x3") centered on the line beneath it. ASS-370: a red ● (markDot, the
// tickets' needs-you red since ASS-430) just before the name of each project with tickets waiting on
// the operator — operatorNeeded, the Operator Needed Tickets tile's rule, with
// that project selected on its live sprint (day null), so a past day on show
// never changes the dots. The dot sits inside the name's width, so the count
// stays centred under it; with no dots the menu is as before. ASS-438: the dot
// is MARK_COLORS needed's red, through markDot, never a copied code; markDot
// ends in a full reset, which also turned the selected project's highlight off
// after the dot, so the mark is put back after every reset inside the label
// and the whole label — blank, dot and name — is highlighted, the dot red in
// it. Only escape codes are added, so the widths and the counts' centring stay.
function menu(state) {
  const { projects, project, assignments, focus } = state;
  const items = projects.map((p, i) => {
    const dot = operatorNeeded({ ...state, project: i, day: null }).size > 0 ? `${markDot('●', 'needed')} ` : '';
    const name = ` ${dot}${p.name} `;
    const count = `🤖x${assignments.filter(a => a.project === p.id).length}`;
    const width = Math.max(visible(name), visible(count));
    const mark = focus === 'menu' ? '\x1b[7m' : '\x1b[4m';
    const label = middle(name, width);
    return [i === project ? `${mark}${label.replaceAll('\x1b[0m', `\x1b[0m${mark}`)}\x1b[0m` : label, middle(count, width)];
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
// operator (operatorNeeded), the sprint's alone, never the backlog's (ASS-254),
// each once whatever its variations — filled while there are any (ASS-242;
// neededFill) — then the tickets delivered (any variation in the engine's last
// state) and their points; each a value boxed, as wide as its label or value,
// with its label beneath. ASS-430: ticket counts alone — the Day Spend and
// Sprint Spend tiles (ASS-216) moved to the models box (spendLines).
function metricTiles(state) {
  const { tickets, done, steps } = sprintTickets(state);
  const unique = list => [...new Map(list.map(t => [t.key, t])).values()];
  const needed = operatorNeeded(state, tickets).size;
  const delivered = unique(tickets.filter(t => t.step?.sequence === done));
  return [
    [needed, 'Operator Needed Tickets', needed > 0 && neededFill(steps)],
    [delivered.length, 'Delivered Tickets'],
    [delivered.reduce((sum, t) => sum + (t.points ?? 0), 0), 'Delivered Points'],
  ].map(([value, label, fill]) => {
    const width = Math.max(label.length, String(value).length) + 2;
    const inside = middle(String(value), width);
    return [`┌${'─'.repeat(width)}┐`, `│${fill ? color(fill)(inside) : inside}│`, `└${'─'.repeat(width)}┘`, middle(label, width + 2)];
  });
}

// neededFill(steps) — the Operator Needed Tickets tile's fill (ASS-430; blue,
// 44;97, before): the red the Blocked for Human state is drawn in, its own
// `color` ("#rrggbb", as stateColor reads it) among the viewed project's
// execution state engine's top-level `steps` (sprintTickets'), as a 24-bit
// background under white text, or black text on a light color, so the count
// stays readable; a plain red fill (41;97) with no such state or color.
function neededFill(steps) {
  const hex = steps.find(s => s.name === 'Blocked for Human')?.color;
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return '41;97';
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const light = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150;
  return `48;2;${rgb.join(';')};${light ? '30' : '97'}`;
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
