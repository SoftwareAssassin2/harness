// The frame around every screen's body (ASS-201): the header — banner, health-check
// agents, project menu, sprint and its tiles — and the footer's three status lines (ASS-566; the platform boxes
// before) and the lines under them; the flow screens (S, B) take a one-line header and no footer lines
// (ASS-187). Every screen sizes itself against it, so it sits below them all.
import { kindOfAccount } from '../../agents/account.js';
import { providerOf, repoPath, commonOwner } from '../../agents/forge.js';
import { blockText } from '../font.js';
import { duration } from '../metrics.js';
import { visible, link, clip, pad } from '../text.js';
import { flattenSprint } from '../../control/rank.js';
import { spendRecords, daySpend, sprintSpend, spendText } from '../../control/spend.js';
import { cloudVmsOf } from '../../control/dev-environments.js';
import { planningFocusOn } from '../../control/planning-focus-file.js';
import { imageBuildFailed } from '../../control/substrate-config.js';
import { SUBSTRATE_STALE_MS, SUBSTRATE_TROUBLE, MEMORY_PROBLEMS, noGolden, snapshotTrouble, machineGroups } from '../machine-health.js';
import { BLOCK_AFTER } from '../../control/backoff.js';
import { ellipsis, refining, agentLine, projectAssignments, liveAssignments, viewedSprint, operatorNeeded, restartFixes, markDot, ICONS, indent, center, middle, color, green, red, gold, timestamp, sprintTickets, runsScript, gray, yellow } from './shared.js';
export { SUBSTRATE_STALE_MS };   // ASS-566: machine-health.js's now, read here by the tests

// Screens where space pauses and releases the agents.
export const PAUSABLE = new Set(['s', 'S', 'b', 'B', 'c', 'a', 'A']);

// The lines under the footer's status lines: the legend and, once data has loaded,
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
// setup failed (ASS-434), a Substrate cluster broken (ASS-533) and, ASS-539, its template with no golden snapshot,
// its Docker memory low and its snapshot disk use high, a sandbox image build failed, a sandbox that could not be set
// up, the glab login to renew, background work off
// (ASS-127), the focus on planning (ASS-531), the memory and disk holds (ASS-398: any project's
// memory-hold.json, the disk hold of ASS-288), the landed fixes a restart would
// load (ASS-393), then idleness (ASS-59), then the analytics' Jira API token
// rejected (ASS-475: the downloader's jira-token-rejected.json; it holds no
// work, but the Performance screen's numbers stop until it is fixed), the
// Atlassian token or acli login missing or failing (ASS-561: check-credentials'
// atlassian-needs.json; it holds no work either, but the analytics and the Jira
// sync are degraded until project:set-atlassian-token is run); then the
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
    ...substrateWarnings(warning, project, now, state.disk),
    ...sandboxImageWarnings(warning, project),   // ASS-539
    ...sandboxSetupWarnings(warning, project),   // ASS-539
    project?.glabReauthentication && warning('glab-login', "run 'glab auth login' asap", 'Run glab auth login in a terminal', { chip: true }),
    project?.backgroundWorkOff && warning('background-work-off', 'Background work off', 'Turn background work back on when you want it', { chip: true, operator: true }),
    // ASS-531: the operator's own switch, a reminder to turn it off before leaving the AI to build.
    planningFocusOn(project) && warning('planning-focus', 'Focus on planning', 'Press P on the sprint screen to turn it off when the planning is done', { chip: true, operator: true }),
    state.projects.some(p => p.memoryHold) && warning('out-of-memory', 'Out of memory', 'Free memory on the Mac: no new VM starts until there is enough', { chip: true, scope: 'harness' }),
    state.disk?.level === 'hold' && warning('out-of-disk-space', 'Out of disk space', `Free disk space: nothing new starts until ${state.disk['warn-bytes'] / 1e9} GB is free`, { chip: true, scope: 'harness' }),
    fixes.length > 0 && warning('restart', restartNotice(fixes.length), `Restart the harness to load ${fixes.join(', ')}`, { chip: true, scope: 'harness' }),
    idle(state) && warning('idle', 'No work in progress', 'No agent is working a sprint ticket: check the sprint', { chip: true, after: IDLE_AFTER_MS }),
    project?.jiraTokenRejected && warning('jira-token-rejected', 'Jira API token rejected', jiraTokenTodo(project.jiraTokenRejected, project.id), { chip: true }),
    atlassianNeeded(project) && warning('atlassian-token', `Atlassian sign-in: run './agent.sh project:set-atlassian-token ${project.id}'`, atlassianTodo(project), { chip: true }),
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
// ASS-561: the fix is project:set-atlassian-token, when the record's project is known.
export function jiraTokenTodo(record, project = null) {
  const source = record?.['work-source'] ? `the "${record['work-source']}" jira work source` : 'its jira work source';
  return `Jira rejects the analytics API token of ${source}${record?.since ? ` since ${String(record.since).replace('T', ' ').replace(/:\d\dZ$/, ' UTC')}` : ''}, so the analytics are not updated: create a new Atlassian API token, copy it, and run ./agent.sh project:set-atlassian-token ${project ?? '<project>'}`;
}

// atlassianNeeded(project), atlassianTodo(project) — ASS-561: whether project:check-credentials found the project's
// Atlassian API token or acli login missing or failing (atlassian-needs.json), and what to do, each problem named.
const atlassianNeeded = project => Boolean(project?.atlassianNeeds?.problems?.length);
function atlassianTodo(project) {
  const what = project.atlassianNeeds.problems.map(p => `${p.credential}: ${p.problem}`).join('; ');
  return `${what}. Copy the project's Atlassian API token (id.atlassian.com, Security, API tokens) and run ./agent.sh project:set-atlassian-token ${project.id}: the analytics and the Jira sync are degraded until then; agent work goes on`;
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
// substrateWarnings(warning, project, now, disk) — ASS-533 AC4, ASS-539 AC2: the chips for each of the project's
// Substrate clusters, from its substrate.json (control's last check, src/control/substrate.js; health's problems, each
// { what, why, repair }, on-machine/substrate.sh), each naming its machine and saying its fix — one per kind of trouble,
// each its own id, so each notifies once (src/notify/warnings.js) and a second trouble on the same machine notifies too:
// - cluster down (substrate:<machine>): broken, missing, Docker down or not checked for any problem but the three below
//   — "Substrate mac broken", "Substrate ada-dev cluster missing" — saying whether control restarts it (every problem
//   one substrate:up fixes: its `repair`) or what the operator must fix (Docker, a check that cannot run);
// - a template with no golden snapshot (substrate-template:<machine>): its `templates` problem a restart cannot fix,
//   with ate-api-server's reason (health reads it from its log), and the two fixes: a template too big for its worker
//   ("no worker has room for the actor": the cluster entry's worker-memory-gib), else the image (substrate:build-image);
// - memory low (substrate-memory:<machine>): Docker's memory under what the cluster needs, or its containers over 90% of
//   it ("docker memory": on the Mac Docker Desktop's VM — "Docker Desktop memory low", fixed in its Settings, Resources,
//   Memory), or a remote machine short of memory ("host memory");
// - snapshot disk use high (substrate-snapshots:<machine>): the disk its hibernation snapshots live on (the cluster
//   node's /var: Docker's disk) below the harness's disk warning level (disk-space.json's warn-bytes, harness.json's
//   disk-free-warn-gb, 50 GB) while the project has snapshots there, saying when one more sandbox's snapshot would take
//   it below the hold level (hold-bytes, 15 GB: no new seat for its sandboxes, ASS-537 AC3).
// A check older than SUBSTRATE_STALE_MS (nobody checks it now: the machine stopped, or control is down) shows none.
// (A nested Lima VM — Substrate's microVM path, ASS-532 — is not used: the harness runs its clusters on gVisor only, so
// there is no such VM to watch.)
const problemText = list => list.map(p => `${p.what}: ${p.why}`).join('; ');
function substrateWarnings(warning, project, now = Date.now(), disk = null) {
  const id = project?.id;
  return Object.entries(project?.substrate ?? {})
    .filter(([, e]) => e && now - Date.parse(e['checked-at'] ?? 0) < SUBSTRATE_STALE_MS)
    .flatMap(([machine, e]) => {
      const problems = Array.isArray(e.problems) ? e.problems : [];
      const templates = problems.filter(noGolden), memory = problems.filter(p => MEMORY_PROBLEMS.has(p.what));
      const rest = problems.filter(p => !noGolden(p) && !MEMORY_PROBLEMS.has(p.what));
      const out = [];
      if (SUBSTRATE_TROUBLE[e.state] && (e.state !== 'broken' || rest.length || !problems.length)) {
        const fixes = rest.filter(p => !p.repair);
        const todo = fixes.length
          ? `Fix the Substrate cluster on ${machine}: ${problemText(fixes)}`
          : `Control restarts the Substrate cluster on ${machine} (substrate:up ${id} ${machine}); if it stays ${e.state}: ${problemText(rest) || 'see control\'s log'}`;
        out.push(warning(`substrate:${machine}`, `Substrate ${machine} ${SUBSTRATE_TROUBLE[e.state]}`, todo, { chip: true }));
      }
      if (templates.length) {
        out.push(warning(`substrate-template:${machine}`, `Substrate ${machine} template: no golden snapshot`,
          `No sandbox can be made from it: ${templates.map(p => p.why).join('; ')}. If ate-api-server says no worker has room for the actor, raise worker-memory-gib in ${id}'s dev-environments.substrate.clusters entry for ${machine} and run ./agent.sh substrate:up ${id} ${machine}; else fix the sandbox image and rebuild it: ./agent.sh substrate:build-image ${id}`, { chip: true }));
      }
      if (memory.length) {
        const mac = machine === 'mac';
        out.push(warning(`substrate-memory:${machine}`, mac ? 'Docker Desktop memory low' : `${machine} Docker memory low`,
          `${mac ? 'Give Docker Desktop more memory (Settings, Resources, Memory, then Apply & restart)' : `Free memory on ${machine} (fewer tickets on it: its max-memory-percent), or give it more`}: ${problemText(memory)}`, { chip: true }));
      }
      const snap = snapshotTrouble(e, disk);
      if (snap) {
        out.push(warning(`substrate-snapshots:${machine}`, `Substrate ${machine} snapshot disk high`,
          `Its sandboxes' snapshots take ${gib(snap.bytes)} GiB of ${machine === 'mac' ? 'Docker Desktop\'s' : `${machine}'s Docker`} disk, which has ${gib(snap.free)} GiB free (below the ${snap.warn / 1e9} GB warning level)${snap.full ? `; no new seat for its sandboxes until it is above ${snap.hold / 1e9} GB with room for one more` : ''}: delete the sandboxes no ticket needs (./agent.sh substrate:sandbox-delete ${id} <KEY> <variation>), or give ${machine === 'mac' ? 'Docker Desktop more disk (Settings, Resources, Disk usage limit)' : `${machine} more disk`}`, { chip: true }));
      }
      return out;
    });
}

// sandboxImageWarnings(warning, project) — ASS-539 AC2: a chip for each architecture whose sandbox image's last build
// failed and has not been built since (substrate-config.js imageBuildFailed, from the files substrate:build-image writes),
// pointing at its log and the command that builds it again. No new sandbox gets the image meanwhile (those there keep
// the one they were made from).
function sandboxImageWarnings(warning, project) {
  return Object.entries(project?.sandboxImages ?? {}).filter(([, image]) => imageBuildFailed(image)).map(([arch, image]) =>
    warning(`sandbox-image:${arch}`, `Sandbox image ${arch} build failed`,
      `The last build of ${project.id}'s ${arch} sandbox image exited ${image.run['exit-code']} at ${String(image.run['ended-at']).replace('T', ' ').replace(/Z$/, ' UTC')}: read ${image.log}, fix what it says, then build it again: ./agent.sh substrate:build-image ${project.id} --arch ${arch}`, { chip: true }));
}

// sandboxSetupWarnings(warning, project) — ASS-539 AC2: a chip for each ticket variation whose sandbox could not be
// made or resumed (control's sandbox-failures.json, sandboxes.js recordSandboxFailures): its step waits meanwhile,
// control tries again with the step's backoff and sends the ticket to Blocked after BLOCK_AFTER failures in a row.
function sandboxSetupWarnings(warning, project) {
  return (project?.sandboxFailures ?? []).filter(f => f?.sandbox).map(f =>
    warning(`sandbox-setup:${f.sandbox}`, `Sandbox ${f.sandbox} setup failed`,
      `${f.key} ${f.variation}'s sandbox on ${f.machine} could not be ${f.what ?? 'made'} (${f.failures ?? 1} in a row; control tries again, and sends the ticket to Blocked after ${BLOCK_AFTER}): ${f.error || 'see control\'s log'}. Check ./agent.sh substrate:health ${project.id} ${f.machine} and control's log; ./agent.sh substrate:sandbox-up ${project.id} ${f.key} ${f.variation} ${f.machine} tries it by hand`, { chip: true }));
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

// The footer (ASS-566; a row of boxes before — control, models, queue, the machine boxes): three status lines above the
// legend, for the project on screen, and a blank line under them. The flow screens (S, B) take none (ASS-187).
// 1. control and accounts (controlSegments): control's state, uptime and pid — or, down, red, its exit code and its
//    restart countdown or "given up … press R" — then its Hindsight (hindsightLine), the forge provider and the account
//    its code pushes as (forgeLines), and the Claude account;
// 2. machine health (healthSegments): one summary per machine group the project has (machine-health.js machineGroups):
//    "local", "gcp workstations", "cloud VMs" — "healthy", or its healthy and unhealthy machines counted, the unhealthy
//    red with why;
// 3. usage and spend (usageSegments): Claude's 5-hour session and weekly use with their resets (red while rate limited),
//    or, billed by API key, the billing and the API budget's figures; the free disk; the repositories; today's and the
//    sprint's spend.
// Where the old boxes' other lines went: the machine boxes and the golden image to the compute network screen (n,
// network.js), with the agents per model; the queue to the sprint screen's q overlay (queue.js).
export function platform(state, columns, now) {
  if (state.screen === 'S' || state.screen === 'B') return []; // the flow screens give the diagram the room (ASS-187)
  const project = state.projects[state.project];
  if (!project) return [];
  return [controlSegments(state, project, now), healthSegments(state, project, now), usageSegments(state, project, now)]
    .map(segments => statusLine(segments, columns)).concat('');
}

// statusLine(segments, columns) — one footer line: the segments GAP columns apart, more (up to MAX_GAP) on a wider
// screen, centred, never wrapped. While they don't fit: GAP_MIN apart, then the segments marked to go first ({ text,
// short?, cut: n }, the lowest n first — the least telling: the repositories' group, the reset times, the accounts)
// take their short form when they have one (the repository count alone, the use without its reset, none for the
// provider), else are cut with
// an ellipsis to no less than MIN_PART, then the widest; what still doesn't fit is cut at the screen's edge.
const GAP = 3, GAP_MIN = 2, MAX_GAP = 6, MIN_PART = 14;
export function statusLine(segments, columns) {
  const list = segments.filter(Boolean).map(s => (typeof s === 'string' ? { text: s, cut: Infinity } : s)).filter(s => s.text);
  if (!list.length) return '';
  const parts = list.map(s => s.text);
  const width = () => parts.reduce((n, p) => n + visible(p), 0);
  const fits = width() + GAP * (parts.length - 1) <= columns;
  const room = () => columns - GAP_MIN * (parts.filter(Boolean).length - 1);
  const over = () => !fits && width() > room();
  const undo = [];   // each cut, [i, what it was], so what still fits afterwards is put back
  const cutTo = i => {
    undo.push([i, parts[i]]);
    if (list[i].short != null && parts[i] !== list[i].short) { parts[i] = list[i].short; return; }   // '' drops it
    const target = Math.max(MIN_PART, visible(parts[i]) - (width() - room()));
    if (target < visible(parts[i])) parts[i] = ellipsis(parts[i], target);
  };
  for (const i of list.map((s, i) => i).filter(i => Number.isFinite(list[i].cut)).toSorted((x, y) => list[x].cut - list[y].cut)) if (over()) cutTo(i);
  while (over()) {
    // The widest, a kept segment ({ keep: true }: control, Hindsight, the spend) only once every other is as short as it goes.
    const cuttable = parts.map((p, n) => n).filter(n => !list[n].keep && visible(parts[n]) > MIN_PART);
    const pool = cuttable.length ? cuttable : parts.map((p, n) => n);
    const i = pool.reduce((w, n) => (visible(parts[n]) > visible(parts[w]) ? n : w), pool[0]);
    const before = visible(parts[i]);
    cutTo(i);
    if (visible(parts[i]) >= before) break;
  }
  // A cut that turned out not to be needed (a later one freed enough) is put back, the last first.
  for (const [i, was] of undo.toReversed()) { const now = parts[i]; parts[i] = was; if (over()) parts[i] = now; }
  const shown = parts.filter(Boolean).length - 1;
  const gap = shown > 0 ? Math.min(MAX_GAP, Math.max(GAP_MIN, Math.floor((columns - width()) / shown))) : 0;
  const line = parts.filter(Boolean).join(' '.repeat(gap));
  return visible(line) > columns ? ellipsis(line, columns) : center(line, columns);
}

// controlSegments(state, project, now) — the first line: control, built from the control the dashboard started
// (state.controls, ASS-310) — "control: up (<uptime>, pid: <pid>)", "draining" while it drains, "restarting" through a
// restart, "waiting for its data" in red (ASS-457), 🤖 after "control" while an assignment has control true; a control
// that has ended (controlsDown, ASS-460) red: "control: DOWN (exit <code>, restart in <n>s, crash <n>)", "… given up
// after <n> crashes, press R", "… ended, press R" for one that exited 0 (its last line is the header's CONTROL DOWN
// line); none started yet a gray "not running". Then hindsightLine, the provider and push account (forgeLines), and
// the Claude account (claude-usage's email).
function controlSegments(state, project, now) {
  const control = state.controls?.[project.id];
  // ASS-460: a control started again after a crash is shown running, its outage kept until it is back (app.js controlBack).
  const down = state.controlsDown?.[project.id]?.restarted ? null : state.controlsDown?.[project.id];
  const label = projectAssignments(state).some(a => a.control === true) ? 'control 🤖' : 'control';
  let text;
  if (down) {
    const next = down.restartAt ? `restart in ${Math.max(0, Math.ceil((down.restartAt - now) / 1000))}s, crash ${down.crashes}`
      : down.gaveUp ? `given up after ${down.crashes} crashes, press R` : down.code === 0 ? 'ended, press R' : '';
    text = red(`${label}: DOWN (exit ${down.code ?? 'by signal'}${next ? `, ${next}` : ''})`);
  } else if (control) {
    const waiting = state.dataWaiting?.[project.id];
    const word = state.draining?.[project.id] != null ? 'draining' : state.restart ? 'restarting' : waiting ? 'waiting for its data' : 'up';
    const line = `${label}: ${word} (${duration(Math.max(0, now - new Date(control.startTime).getTime()))}, pid: ${control.pid})`;
    // ASS-573: coloured like Hindsight's — green up, amber while draining or restarting (passing), red waiting.
    text = waiting ? red(line) : word === 'up' ? green(line) : yellow(line);
  } else text = gray(`${label}: not running`);
  const forge = forgeLines(project);
  // When the line is full the provider goes first (its account names it too), then the Claude account is cut, then the push account.
  return [{ text, keep: true }, { text: hindsightLine(project, state.memoryHealth?.[project.id]), keep: true }, ...(forge ? [{ text: `provider: ${forge.provider}`, short: '', cut: 1 }, { text: forge.account, cut: 3 }] : []), { text: `claude account: ${project.claudeUsage?.email ?? '—'}`, cut: 2 }];
}

// healthSegments(state, project, now) — the second line: each machine group's health (machine-health.js), "local:
// healthy" or red "local: unhealthy (<why>)" for the Mac; "<group>: <n> healthy" for the remote groups, or with
// red "<n> unhealthy (<id> <why>; …)".
function healthSegments(state, project, now) {
  return machineGroups(state, project, now).map(({ name, machines }) => {
    const bad = machines.filter(m => m.troubles.length), good = machines.length - bad.length;
    if (name === 'local') return bad.length ? red(`local: unhealthy (${bad[0].troubles.join(', ')})`) : 'local: healthy';
    if (!bad.length) return `${name}: ${good} healthy`;
    return `${name}: ${good ? `${good} healthy, ` : ''}${red(`${bad.length} unhealthy (${bad.map(m => `${m.id} ${m.troubles.join(', ')}`).join('; ')})`)}`;
  });
}

// usageSegments(state, project, now) — the third line: billingSegments (red while the project is rate limited,
// limitFor), the free disk (diskSegment), the repositories (forgeLines' repo), today's and the sprint's spend (spendLines).
function usageSegments(state, project, now) {
  const limited = Boolean(limitFor(project, now).limit);
  return [...billingSegments(project, now, limited), diskSegment(state.disk), forgeLines(project) && { text: forgeLines(project).repo, short: forgeLines(project).repoShort, cut: 1 }, ...spendLines(state, now)];
}

// diskSegment(disk) — the disk's free space as control last read it (disk-space.json, ASS-288) in GiB, amber below
// the warning level as diskText's line, "unknown" never read.
function diskSegment(disk) {
  const free = disk?.['free-bytes'] == null ? 'disk free: unknown' : `disk free: ${gib(disk['free-bytes'])} GiB`;
  return disk?.level === 'warn' || disk?.level === 'hold' ? AMBER(free) : free;
}

// forgeLines(project) — ASS-307: the project's repository provider, its repository (or repository count) as a link,
// and the account its code pushes as (project.pushAccount, from data/projects/<p>/push-account.json, control's last
// check — see src/control/push-account.js), as { provider, repo, repoShort, account } for the footer's first and third lines
// (ASS-566). provider GitHub or GitLab (by the first repository url's host, github.com → GitHub, else GitLab,
// including a self-hosted GitLab); one repository → `repo: <owner>/<name>` linked to the repository; several →
// `repos: <N> in <owner>` linked to the urls' longest common group/owner page, or `repos: <N> in <host>` linked to the
// host when there is none; `<provider> account: <login>` plain, `<provider> account: <reason>` in red on failure,
// `… account: …` plain while the lookup has not run or its record is for another provider than the repositories'
// now. Every repository project.json lists is counted, Active or not; a malformed url is dropped from the count.
// null for a project with no repositories (or none whose url parses).
function forgeLines(project) {
  const urls = (project.repositories ?? []).map(r => { try { return new URL(r.url).href; } catch { return null; } }).filter(Boolean);
  if (!urls.length) return null;
  const { provider, host } = providerOf(urls[0]);
  const repo = urls.length === 1
    ? `repo: ${link(repoPath(urls[0]), urls[0])}`
    : (() => {
      const owner = commonOwner(urls);
      return owner
        ? `repos: ${link(`${urls.length} in ${owner}`, `https://${host}/${owner}`)}`
        : `repos: ${link(`${urls.length} in ${host}`, `https://${host}`)}`;
    })();
  const repoShort = urls.length === 1 ? undefined : `repos: ${urls.length}`;   // its short form, when the line is full
  const push = project.pushAccount;
  const account = !push || push.provider !== provider ? `${provider} account: …`
    : push.error ? red(`${provider} account: ${push.error}`)
    : `${provider} account: ${push.account}`;
  return { provider, repo, repoShort, account };
}

// hindsightLine(project, check) — the project's Hindsight as the dashboard
// last checked it itself (ASS-293: memoryHealth, tui/memory.js — live while
// control is down, so the footer shows it alike): "up (port <n>)"
// green when /health answered healthy, "down (port <n>) since <time>" red,
// since the first check that found it down; "checking" before the first check
// of its port; "none" for a project without a hindsight in project.json.
function hindsightLine(project, check) {
  const port = project?.hindsight?.port;
  if (port == null) return 'hindsight: none';
  if (check?.port !== port) return 'hindsight: checking';
  return check.healthy ? green(`hindsight: up (port ${port})`) : red(`hindsight: down (port ${port}) since ${timestamp(new Date(check.since))}`);
}

// spendLines(state, now) — the footer's spend (ASS-430; the header's Day
// Spend and Sprint Spend tiles before, ASS-216; the models box's until ASS-566): what the selected project
// spent on the day on show and over its sprint (the viewed one) through that
// day (shownAt) — its sprint's and backlog's dispatches, its ticket chats'
// turns, its chat-screen turns (ASS-271) and its Hindsight's Claude calls
// (spend.js daySpend, sprintSpend), in dollars to the cent, the total alone.
function spendLines(state, now) {
  const project = state.projects[state.project], sprint = viewedSprint(state), at = new Date(shownAt(state, now));
  const records = spendRecords([...flattenSprint(sprint ?? {}), ...(project?.backlog ?? [])], project?.collaborations, project?.chatSpend, project?.memorySpend ?? []);
  const dollars = usd => `$${usd.toFixed(2)}`;
  return [{ text: `day spend: ${dollars(daySpend(records, at))}`, keep: true }, { text: `sprint spend: ${dollars(sprintSpend(records, sprint?.start, at))}`, keep: true }];
}

// billingSegments(project, now, limited) — how the project is billed (ASS-221), by its login as control last read it
// (claude-usage's auth-method and org): an API-key login (kindOfAccount 'anthropic') bills to its org's API key —
// "billing: API key (<org>)", then its org's spend (apiCostLines) or "API spend: unknown for <org>" without a reading
// this month; any other its subscription's usage (usageLines, red while `limited`) with the project's org's spend, if
// any. The spend is always the project's own (loadProjects' apiCost), never another org's. (The account is the first
// line's.)
function billingSegments({ claudeUsage: usage, apiCost }, now, limited) {
  const spend = apiCostLines(apiCost, now);
  if (kindOfAccount({ authMethod: usage?.['auth-method'] }) !== 'anthropic') return [...usageLines(usage, now, limited ? red : undefined), ...spend];
  const org = usage.org ?? '—';
  return [`billing: API key (${org})`, ...(spend.length ? spend : [`API spend: unknown for ${org}`])];
}

// usageLines(usage, now) — ASS-47, ASS-65: from the project's claude-usage (control's last reading of its login): how
// much of the 5-hour session, then of the 7-day week (`weekly`, null on a plan with no weekly cap), is used, to the
// whole percent, and when each resets, counting down ("session: 21%, resets 1d 12h": compact, so the third line fits
// 120 columns). A dash for what it lacks. ASS-571: a window whose reset has passed shows a gray dash — the percent is
// of a window that is over, whatever it is now; a reading (`as-of`) more than USAGE_STALE_MS old adds its age in gray
// ("as of 2d ago"), and a recorded failure (control could not read it, usage.js: `failure.why`) a red "usage
// unreadable (<why, short>)" before it ("unreadable, read 2d ago" when the line is full) — so a reading that stopped
// is never shown as if it were current.
const USAGE_STALE_MS = 10 * 60e3;
function usageLines(usage, now, shade = text => text) {
  const used = (label, window, cut) => {
    const { percent, 'resets-at': at } = window ?? {};
    const left = Date.parse(at) - now;
    if (percent == null) return { text: shade(`${label}: —`), cut };
    if (left < 0) return { text: gray(`${label}: —`), cut };
    const resets = Number.isNaN(left) ? '' : `, resets ${duration(left)}`;
    return { text: shade(`${label}: ${Math.round(percent)}%${resets}`), short: shade(`${label}: ${Math.round(percent)}%`), cut };
  };
  const age = now - Date.parse(usage?.['as-of']);
  const old = age > USAGE_STALE_MS ? roughAge(age) : null;
  const why = usage?.failure?.why;
  // One segment, so a full line (120 columns) keeps both: the failure then its age, shortened together.
  const note = why ? { text: red(`usage unreadable (${unreadable(why)})`) + (old ? gray(`, as of ${old} ago`) : ''), short: red('unreadable') + (old ? gray(`, read ${old} ago`) : ''), cut: 4 }
    : old ? { text: gray(`as of ${old} ago`), cut: 4 } : null;
  return [used('session', usage?.session, 3), used('weekly', usage?.weekly, 2), note].filter(Boolean);
}

// roughAge(ms) — an age in its largest unit alone ("2d", "5h", "12m"): how old a reading is, not to the minute.
const roughAge = ms => (ms >= 864e5 ? `${Math.floor(ms / 864e5)}d` : ms >= 36e5 ? `${Math.floor(ms / 36e5)}h` : `${Math.floor(ms / 6e4)}m`);

// unreadable(why) — ASS-571: control's reason a usage reading failed (src/agents/usage.js, src/control/usage.js), as the
// footer's few words: "token expired", "token refused", "no token", "endpoint unreachable", "endpoint unavailable";
// anything else its first words.
function unreadable(why) {
  if (/expired/.test(why)) return 'token expired';
  if (/refused|401/.test(why)) return 'token refused';
  if (/no token/.test(why)) return 'no token';
  if (/unreachable/.test(why)) return 'endpoint unreachable';
  if (/unavailable/.test(why)) return 'endpoint unavailable';
  return ellipsis(why, 24);
}

// The API line (ASS-153), from apiCost (control's last reading
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

// ASS-526: the loop counter in the screen's bottom-right corner — the loops the
// selected project's control has finished since it started (its loop-count.json,
// src/control/loop-count.js; state.loopCounts by project id, main.js reading
// them each second), modulo 100: 0 before its first loop, 99 straight to 0.
// 0 for a project whose control has written none yet; a control that is down
// leaves its file, so its last value stays (its CONTROL DOWN box says why).
export const loopCount = state => {
  const loops = state.loopCounts?.[state.projects?.[state.project]?.id];
  return Number.isInteger(loops) && loops >= 0 ? loops % 100 : 0;
};
// withLoopCount(line, state, columns) — the bottom line with the counter at its
// right end, right-aligned in two columns so it never jumps; the line itself
// cut short should it reach that far. No line of its own: render passes the last.
export function withLoopCount(line, state, columns) {
  const count = String(loopCount(state)).padStart(2), room = Math.max(0, columns - count.length - 1);
  return `${pad(clip(line, room), room)}\x1b[0m ${gray(count)}`;
}
