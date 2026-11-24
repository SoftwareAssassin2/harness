// Reads the dashboard's data from the repo's JSON files.
import { readdirSync, readFileSync, existsSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { requiresReauthentication, loadCollaborations, loadChatSpend, loadMemorySpend, loadOutside } from '../control/state.js';
import { isLiveBacklogEntry } from '../control/rank.js';
import { defaultSpendLimit } from '../control/spend.js';
import { isHarnessProject } from '../control/harness-project.js';
import { mergedWindows } from '../agents/session-usage.js';
import { loadReviews } from './review.js';
import { dataDir } from '../data-folder.js';
import { withoutObsolete } from '../workflow/obsolete.js';
import { engineFileIn, parseEngine } from '../workflow/engine-file.js';
import { limaHome } from '../control/vm.js';
import { devEnvironments, devEnvironmentsErrors, usesWorkstations } from '../control/dev-environments.js';
import { loadWorkstations, expiredLogins } from '../control/workstation-connection.js';
import { loadSeats, SEATS_FILE } from '../control/seat-kinds.js';
import { projectRunTargets } from '../control/run-targets.js';
import { loadSeatQueue, SEAT_QUEUE_FILE } from '../control/seat-queue.js';
import { LOOP_COUNT_FILE } from '../control/loop-count.js';
import { SEAT_BUDGET_FILE, REMOTE_SEATS_FILE } from '../control/seat-budget-file.js';
import { loadBootWaits, BOOT_WAITS_FILE } from '../control/boot-waits.js';
import { loadPlanningFocus, PLANNING_FOCUS_FILE } from '../control/planning-focus-file.js';
import { loadSubstrate, substrateEntries, SUBSTRATE_FILE, loadSandboxFailures, SANDBOX_FAILURES_FILE, loadSandboxImages, sandboxImageFiles, SANDBOX_ARCHES } from '../control/substrate-config.js';

// A file's JSON, parsed again only once it has changed (its mtime or size), so
// reading everything again on every change costs only the files that did. An
// unchanged file gives back the very same objects: nothing may change them.
const parsed = new Map();
// ASS-524: `parse` an engine's workflow.yaml's (readEngineFile), JSON's for every other file.
const parseCached = (file, parse) => {
  const { mtimeMs, size } = statSync(file);
  const known = parsed.get(file);
  if (known?.mtimeMs === mtimeMs && known.size === size) return known.json;
  const json = parse(readFileSync(file, 'utf8'), file);
  parsed.set(file, { mtimeMs, size, json });
  return json;
};
const readJson = file => parseCached(file, text => JSON.parse(text));
const readEngineFile = file => parseCached(file, parseEngine);

// keepSame(prev, next) — `next`, keeping every part of `prev` still equal to
// it: prev itself when nothing changed, else a new value whose unchanged
// branches are prev's own. So a reload replaces only what changed.
export function keepSame(prev, next) {
  if (prev === next) return prev;
  const object = v => typeof v === 'object' && v !== null;
  if (!object(prev) || !object(next) || Array.isArray(prev) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prev).length;
  const out = Array.isArray(next) ? [] : {};
  for (const key of keys) {
    out[key] = keepSame(prev[key], next[key]);
    if (out[key] !== prev[key] || !Object.hasOwn(prev, key)) same = false;
  }
  return same ? prev : out;
}

// A ticket soft deleted (ASS-104, ticket:delete): the dashboard hides it.
const deleted = t => t['is-deleted'] === true;

// A sprint with its soft-deleted tickets and variations (is-deleted) left out,
// as though gone, and each ticket's manual-priority, once set, as its priority.
const asShown = sprint => sprint && Object.fromEntries(Object.entries(sprint).map(([list, tickets]) => [list,
  ['features', 'bugs', 'spikes'].includes(list) && Array.isArray(tickets)
    ? tickets.filter(t => !deleted(t)).map(t => ({
      ...t,
      ...(t['manual-priority'] != null ? { priority: t['manual-priority'] } : {}),
      ...(t.variations ? { variations: t.variations.filter(v => !v['is-deleted']) } : {}),
    }))
    : tickets]));

// One project per <dir>/<id>/project.json, sorted by display name.
// stateEngine names the engines/ folder of its execution state engine;
// switchedOffSteps its switched-off-steps (ASS-209, shared.js projectWorkflows);
// environments and repositories are its local-environments (no longer
// drawn as boxes, ASS-368) and repositories (its running control comes from the dashboard, not
// project.json — ASS-310); backlog its backlog.json tickets not in
// its active sprint, backlogOfSprint those in it (their refinement history,
// ASS-42); days its end-of-day sprint snapshots;
// questions its questions and answers (see loadQuestions); highlights its
// highlighted-tickets ([{ ticket, color }]); gcloudReauthentication whether
// the operator must run gcloud auth login: only for a project that checks for
// it (check-for-expired-gcloud-auth, ASS-28) and while its
// gcloud-requires-reauthentication file reads exactly `true` (ASS-58, see
// requiresReauthentication) — or, ASS-433, for one whose tickets run on
// workstations, which control flags so when a workstation's own gcloud login
// (its gcloud-config) has expired; gcloudLogins those workstations' logins,
// [{ ids, config, command }] (control/workstation-connection.js
// expiredLogins: the command with the CLOUDSDK_CONFIG it needs), [] for none;
// workstations its workstations.json, each workstation's state, connection and
// last connect error (loadWorkstations); glabReauthentication the same for glab auth
// login (check-for-expired-glab-auth, ASS-61); backgroundWorkOff whether its
// background work is switched off (background-work false, ASS-127);
// waitForDependencies whether a ticket of its waits for the tickets it
// depends on (wait-for-dependencies, ASS-195: at any step, ASS-355); outside
// its outside-tickets.json's tickets, the ones its tickets depend on that
// its sprint and backlog do not hold (loadOutside, ASS-355);
// limits the fields of its project.json and of harness.json control's
// planner reads (pickLimits, ASS-357: the sprint screen's seats);
// rateLimit its rate-limit.json (one entry per credential kind, ASS-215), or null (ASS-94); apiKey
// whether it has an API key to fall back to (hasApiKey, ASS-333); claudeUsage its
// claude-usage.json — its login's session and weekly (ASS-65) usage and account, as control last
// read them — or null (ASS-47); pushAccount its push-account.json — the
// account its VM token for its repositories' forge pushes as, as control last
// checked (ASS-307, src/control/push-account.js) — or null;
// collaborations each ticket's
// chat on its screen (see loadCollaborations); memorySpend what its Hindsight
// spent on Claude (see loadMemorySpend, ASS-269); demoPlans each variation's
// demo plan (see loadDemoPlans); commits each ticket variation's commit list (loadCommits, ASS-558); reviews what Human Review shows of each
// ticket (src/tui/review.js loadReviews, ASS-118); spendLimit its tickets'
// spending limit (ASS-191: control/spend.js defaultSpendLimit, harness.json the
// one in `dir`'s parent, the data folder), null for none; apiCost its org's
// API spend this month (see apiCostOf, ASS-221); golden its golden image (see
// loadGolden, ASS-292), looked for in `lima` (control/vm.js limaHome); devEnvironments where its tickets run,
// { mode, workstations } (control/dev-environments.js, ASS-431), null while its dev-environments is wrong; runTargets
// its run targets in order (ASS-540 projectRunTargets: its own list or its mode's; [] while its dev-environments is
// wrong), for the Mac's places (ASS-541; the n screen's Mac card since ASS-572). vms its
// vms.json's rows by VM name (loadVms, ASS-486). Sprints and snapshots come
// without their soft-deleted variations; sprints, snapshots, the backlog and
// the questions without soft-deleted tickets (ASS-104).
// substrateOf(project, live) — ASS-533: its substrate.json's entries for the machines its project.json still declares
// (dev-environments.substrate.clusters; {} while that is wrong), so a removed cluster's last check shows nothing.
function substrateOf(project, live) {
  let machines;
  try { machines = new Set(substrateEntries(project).map(e => e.machine)); } catch { return {}; }
  return Object.fromEntries(Object.entries(live ?? {}).filter(([m]) => machines.has(m)));
}
// substrateMachinesOf(project) — ASS-539 AC1: the machines its project.json declares a kind cluster on
// (dev-environments.substrate.clusters, in its order; a GKE entry, refused until approved, has none), [] while that is
// wrong — the n screen's machine cards (ASS-572) read it.
function substrateMachinesOf(project) {
  try { return substrateEntries(project).filter(e => e.kind === 'kind').map(e => e.machine); } catch { return []; }
}
export const loadProjects = (dir, lima = limaHome()) => readdirSync(dir)
  .filter(name => existsSync(join(dir, name, 'project.json')))
  .map(name => {
    const project = readJson(join(dir, name, 'project.json'));
    return {
      id: name,
      dir: join(dir, name),   // its folder, where the ticket screen finds a ticket's screenshots (ASS-244)
      name: project.name,
      stateEngine: project['execution-state-engine'],
      switchedOffSteps: project['switched-off-steps'] ?? [],
      environments: project['local-environments'] ?? [],
      repositories: project.repositories ?? [],
      sprint: asShown(activeSprint(join(dir, name))),
      backlog: backlogOf(join(dir, name), activeSprint(join(dir, name))),
      backlogOfSprint: backlogOf(join(dir, name), activeSprint(join(dir, name)), true),
      days: loadDays(join(dir, name, 'sprints', 'days')),
      questions: loadQuestions(join(dir, name)).filter(q => !deletedKeys(join(dir, name)).has(String(q['asked-on-ticket'] ?? '').toUpperCase())),
      highlights: project['highlighted-tickets'] ?? [],
      gcloudReauthentication: (project['check-for-expired-gcloud-auth'] === true || usesWorkstations(settingsOf(project)?.mode)) && requiresReauthentication(join(dir, name), 'gcloud'),
      gcloudLogins: expiredLogins(settingsOf(project), loadWorkstations(join(dir, name))),   // ASS-433: the workstations' gcloud logins to renew
      workstations: loadWorkstations(join(dir, name)),   // ASS-433: each workstation's state, connection and last connect error
      seats: loadSeats(join(dir, name)),   // ASS-469: control's seats.json, who holds a VM seat and who a workstation's
      seatQueue: loadSeatQueue(join(dir, name)),   // ASS-525: control's seat-queue.json, who gets the next free seat, in order (ASS-566: the sprint screen's q overlay; the footer's queue box before)
      planningSeats: loadSeats(join(dir, name), readJson, 'planning'),   // ASS-528: its planning seat holders (one pool)
      localSeats: loadSeats(join(dir, name), readJson, 'local'),   // ASS-541: its seatless holders on the Mac (ASS-540: local-worktree, local-workspace), for the n screen's Mac card (ASS-572)
      seatBudget: loadSeatBudgetFile(join(dir, name)),   // ASS-528: control's seat-budget.json, the Mac seats it may hold now and why
      planningFocus: loadPlanningFocus(join(dir, name)),   // ASS-531: its planning-focus.json, { on, by, at } or null (the sprint screen's P)
      bootWaits: loadBootWaits(join(dir, name)),   // ASS-575: control's boot-waits.json, each remote machine's boot wait (the planner's bootWaitOver, the n screen's cards)
      remoteBudget: loadSeatBudgetFile(join(dir, name), REMOTE_SEATS_FILE),   // ASS-529: control's remote-seats.json, each remote machine's seats
      substrate: substrateOf(project, loadSubstrate(join(dir, name))),   // ASS-533: its Substrate clusters' last checks (substrate.json), those it still declares
      substrateMachines: substrateMachinesOf(project),   // ASS-539: the machines it declares a kind cluster on (the n screen's cards, ASS-572)
      sandboxFailures: loadSandboxFailures(join(dir, name)),   // ASS-539: control's sandbox-failures.json, the sandboxes that could not be made or resumed (a header warning each)
      sandboxImages: loadSandboxImages(join(dir, name)),   // ASS-539: its sandbox images' labels and last builds, per architecture (a failed build is a header warning)
      vms: loadVms(join(dir, name)),   // ASS-486: its Lima VMs' vms.json rows by VM name (ticket, variation, state), for the local virtual machines box
      glabReauthentication: project['check-for-expired-glab-auth'] === true && requiresReauthentication(join(dir, name), 'glab'),
      backgroundWorkOff: project['background-work'] === false,
      notifications: project['operator-needed-notifications'] !== false,   // ASS-383: macOS notifications when a ticket becomes Operator Needed, on unless false
      waitForDependencies: project['wait-for-dependencies'] === true,   // ASS-195: a ticket waits for the tickets it depends on
      outside: loadOutside(join(dir, name), readJson),   // ASS-355: the tickets depended on that its sprint and backlog do not hold
      limits: { project: pickLimits(project), harness: pickLimits(harnessOf(dir)) },   // ASS-357: what the planner reads, for the sprint screen's seats

      rateLimit: existsSync(join(dir, name, 'rate-limit.json')) ? readJson(join(dir, name, 'rate-limit.json')) : null,
      claudeUsage: existsSync(join(dir, name, 'claude-usage.json')) ? readJson(join(dir, name, 'claude-usage.json')) : null,
      pushAccount: existsSync(join(dir, name, 'push-account.json')) ? readJson(join(dir, name, 'push-account.json')) : null,   // ASS-307: control's last push-account check
      memoryHold: loadMemoryHold(join(dir, name)),   // ASS-398: control holding its new VMs for want of memory
      memoryWait: loadMemoryHold(join(dir, name), 'memory-wait.json'),   // ASS-420: the variations control refused a seat for want of memory for their VMs (no Machine on the sprint screen, ASS-559)
      accountHold: project['account-hold'] ?? null,
      credentialsHold: existsSync(join(dir, name, 'credentials-hold.json')) ? readJson(join(dir, name, 'credentials-hold.json')) : null,   // ASS-395: control's credentials hold, { since, problems }
      jiraTokenRejected: existsSync(join(dir, name, 'jira-token-rejected.json')) ? readJson(join(dir, name, 'jira-token-rejected.json')) : null,   // ASS-475: the downloader's analytics sign-in rejected, { since, status, problem, work-source }
      apiCapHold: project['api-cap-hold'] ?? null,   // ASS-217: the API cap holding its fallback, control's
      apiKey: hasApiKey(join(dir, name)),   // ASS-333: whether its agents can fall back to an API key (see hasApiKey)
      hindsight: project.hindsight ?? null,   // its memory's server, for the memory screen (ASS-62)
      collaborations: loadCollaborations(join(dir, name), readJson),
      chatSpend: loadChatSpend(join(dir, name), readJson),   // ASS-271: the chat screen's turns, for the footer's spend (ASS-566; the models box's, ASS-430; the spend tiles before)
      memorySpend: loadMemorySpend(join(dir, name), readJson),   // ASS-269: its Hindsight's Claude spend, for the footer's spend (ASS-566; the models box's, ASS-430)
      demoPlans: loadDemoPlans(join(dir, name)),
      commits: loadCommits(join(dir, name)),   // ASS-558: each ticket variation's commit list, for the ticket screen's Commits tab
      reviews: loadReviews(join(dir, name)),
      spendLimit: defaultSpendLimit(harnessOf(dir), project),
      apiCost: apiCostOf(dir, name, project),
      golden: loadGolden(name, project, lima),
      devEnvironments: settingsOf(project),   // ASS-431: vm, vm+workstation or workstation, and its workstations
      runTargetPlan: projectRunTargets(project),   // ASS-572: the run targets as control's planner reads them (list, mode, pool choice), for the n screen's next-ticket headline
      runTargets: settingsOf(project) ? projectRunTargets(project).targets : [],   // ASS-541: its run targets, explicit or derived from its mode (ASS-540); none while its dev-environments is wrong
    };
  })
  .toSorted((a, b) => a.name.localeCompare(b.name));

// loadVms(folder) — ASS-486: the project's vms.json (src/agent-cli/vm.bash's
// inventory), one row per Lima VM keyed by its name, with its ticket,
// variation and state (Running or Stopped); {} without the file or while it
// can't be read.
const loadVms = folder => {
  try {
    const file = join(folder, 'vms.json'), json = existsSync(file) ? readJson(file) : null;
    return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  } catch { return {}; }
};

// settingsOf(json) — a project.json's dev-environments (ASS-431), null while it is wrong.
const settingsOf = json => (devEnvironmentsErrors(json).length ? null : devEnvironments(json));

// pickLimits(json) — the fields of a project.json or harness.json control's
// planner (control/plan.js planDispatch) reads: max-agents and the per-ticket
// spending limit (ASS-357, the sprint screen's seats; ASS-528: the seat counts
// are gone — the seats are the seat budget's, seat-budget.json).
const LIMIT_FIELDS = ['max-agents', 'max-spend-per-ticket-usd'];

// loadSeatBudgetFile(folder) — ASS-528: the project's seat-budget.json, or null (none, or caught half-written).
const loadSeatBudgetFile = (folder, file = SEAT_BUDGET_FILE) => {
  try { return existsSync(join(folder, file)) ? readJson(join(folder, file)) : null; } catch { return null; }
};
const pickLimits = json => Object.fromEntries(LIMIT_FIELDS.filter(name => json?.[name] != null).map(name => [name, json[name]]));

// hasApiKey(folder) — whether the project in `folder` has an API key to fall
// back to while its subscription is rate limited (ASS-333), as control's
// paymentFor (dispatch.js) reads "both": a host step's by its .claude-api
// (configDir), a VM step's by its VM's vms.json row recording credential-kind
// `both` (vm-lifecycle.js credentialKindOf). Read here, not by those helpers:
// they would pull control's dispatch into the dashboard. For the project, not
// a step, so any of them having one is enough.
const hasApiKey = folder => existsSync(join(folder, '.claude-api'))
  || (existsSync(join(folder, 'vms.json')) && Object.values(readJson(join(folder, 'vms.json'))).some(vm => vm?.['credential-kind'] === 'both'));

// apiCostOf(dir, id, project) — a project's org's API spend, as control last
// read it (ASS-221): the harness project's is the data folder's (loadApiCost,
// ASS-153); one whose project.json names its own org's admin key
// (api-cost-admin-keychain-service) its api-cost.json ({ month, usd, as-of })
// with budget, its api-monthly-budget-usd (null without); null without the
// file, or for any other project — never another org's number.
function apiCostOf(dir, id, project) {
  if (isHarnessProject(harnessOf(dir), id)) return loadApiCost(join(dir, '..'));
  const file = join(dir, id, 'api-cost.json');
  if (!project['api-cost-admin-keychain-service'] || !existsSync(file)) return null;
  return { ...readJson(file), budget: project['api-monthly-budget-usd'] ?? null };
}

// harnessOf(dir) — the harness.json beside the projects folder `dir`, {} without one.
const harnessOf = dir => (existsSync(join(dir, '..', 'harness.json')) ? readJson(join(dir, '..', 'harness.json')) : {});

// loadHarness(dir) — what harness.json (beside the projects folder `dir`) says
// about the dashboard itself: agentsGridColumns and agentsGridRows, how many
// tiles the agents grid holds (ASS-188, agents-grid-columns and
// agents-grid-rows) — 3 and 2 without the file or either key.
export const loadHarness = dir => {
  const harness = harnessOf(dir);
  return { agentsGridColumns: harness['agents-grid-columns'] ?? 3, agentsGridRows: harness['agents-grid-rows'] ?? 2 };
};

// loadDownloadInterval(dir) — harness.json's download-updates-interval-in-minutes
// (beside the projects folder `dir`), how often the downloader reads Jira and
// the merge requests, which the Performance screen's staleness is measured
// against (ASS-479); null without the file or a positive number, the screen
// then taking the downloader's own default.
export const loadDownloadInterval = dir => {
  const minutes = Number(harnessOf(dir)['download-updates-interval-in-minutes']);
  return minutes > 0 ? minutes : null;
};

// analyticsFiles(projectDir) — what loadAnalytics reads, to watch while the
// Performance screen is open (ASS-479), and the analytics folder itself, so
// its first files are seen even before it is there.
export const analyticsFiles = projectDir => [
  join(projectDir, 'analytics'), ...['tickets.json', 'sprints.json', 'merge-requests.json'].map(f => join(projectDir, 'analytics', f)),
  join(projectDir, 'team.json'), join(projectDir, 'ticket-system-account-id'),
];

// loadModelUsage(dir) — what the tiles' context % and cost need (ASS-190),
// `dir` the projects folder, as loadHarness's (unlike loadApiCost's data
// folder): prices, harness.json's model-prices, and windows, the learned
// context-windows.json beside it under harness.json's context-windows
// (mergedWindows) — {} for each without.
export function loadModelUsage(dir) {
  const harness = harnessOf(dir);
  const file = join(dir, '..', 'context-windows.json');
  return { prices: harness['model-prices'] ?? {}, windows: mergedWindows(harness, existsSync(file) ? readJson(file) : {}) };
}

// loadApiCost(dir) — the data folder's api-cost.json (ASS-153: the Anthropic
// API organization's month-to-date spend, { month, usd, as-of }, as control
// last read it) with budget, harness.json's optional api-monthly-budget-usd
// (null without); null without the file.
export function loadApiCost(dir) {
  const file = join(dir, 'api-cost.json');
  if (!existsSync(file)) return null;
  const harness = existsSync(join(dir, 'harness.json')) ? readJson(join(dir, 'harness.json')) : {};
  return { ...readJson(file), budget: harness['api-monthly-budget-usd'] ?? null };
}

// loadGolden(id, project, lima) — the project's golden image (ASS-292): the
// Lima instance golden-<id> in the Lima folder `lima`, which vm:build-golden
// builds from the folder project.json's "golden-image" names, as { name,
// built-at } — built-at from its golden-image.json, null when it has never
// been built (or the file is caught half-written); null for a project
// without a "golden-image".
export function loadGolden(id, project, lima) {
  if (!project?.['golden-image']) return null;
  const name = `golden-${id}`;
  try { return { name, 'built-at': readJson(join(lima, name, 'golden-image.json'))['built-at'] ?? null }; } catch { return { name, 'built-at': null }; }
}

// loadMemoryHold(dir, file) — the project folder's memory-hold.json (ASS-398:
// control's hold on its new VMs while the Mac is short of memory, src/control/host-memory.js),
// or `file` (ASS-420: memory-wait.json, src/control/seat-memory.js),
// or null without one, or one caught half-written.
export function loadMemoryHold(dir, file = 'memory-hold.json') {
  try { return existsSync(join(dir, file)) ? readJson(join(dir, file)) : null; } catch { return null; }
}

// loadDiskSpace(dir) — the data folder's disk-space.json (ASS-288: control's
// last reading of the free space on the volumes holding the VMs and the data,
// { level, free-bytes, warn-bytes, hold-bytes, … }, harness:check-disk-space);
// null without the file, or one caught half-written.
export function loadDiskSpace(dir) {
  try { return readJson(join(dir, 'disk-space.json')); } catch { return null; }
}

// The project's backlog.json tickets a backlog entry (ASS-202
// isLiveBacklogEntry) shows: not soft deleted, not Done, not in the active
// sprint. Given `ofSprint`, the kept entries of its active-sprint tickets
// instead — a sprint ticket's backlog entry, kept when it joined the sprint,
// holds its refinement history (ASS-42) and is shown there even once Done.
function backlogOf(projectDir, sprint, ofSprint = false) {
  const file = join(projectDir, 'backlog.json');
  if (!existsSync(file)) return [];
  const inSprint = new Set(['features', 'bugs', 'spikes'].flatMap(type => sprint?.[type] ?? []).map(t => t.key.toUpperCase()));
  return (readJson(file).tickets ?? []).filter(t => ofSprint ? !deleted(t) && inSprint.has(t.key.toUpperCase()) : isLiveBacklogEntry(t, inSprint));
}

// The keys, upper case, of the project's soft-deleted tickets: its active sprint's and backlog's.
function deletedKeys(projectDir) {
  const backlog = join(projectDir, 'backlog.json');
  const sprint = activeSprint(projectDir);
  return new Set([...['features', 'bugs', 'spikes'].flatMap(type => sprint?.[type] ?? []), ...(existsSync(backlog) ? readJson(backlog).tickets ?? [] : [])]
    .filter(deleted).map(t => t.key.toUpperCase()));
}

// The sprint marked is-active in sprints.json: its sprint.json's path, or null.
// Exported for the dashboard's Operator Needed notifications (ASS-383), which watch every project's.
export function activeSprintFile(projectDir) {
  const file = join(projectDir, 'sprints.json');
  const active = existsSync(file) && readJson(file).list?.find(s => s['is-active']);
  return active ? join(projectDir, 'sprints', `sprint-${active.number}`, 'sprint.json') : null;
}

// The active sprint, read from its sprint.json.
function activeSprint(projectDir) {
  const file = activeSprintFile(projectDir);
  return file && readJson(file);
}

// { 'YYYY-MM-DD': snapshot } from <dir>/YYYY-MM-DD.json, each the sprint.json
// captured at the end of that day.
function loadDays(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir)
    .filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map(file => [file.slice(0, -5), asShown(readJson(join(dir, file)))]));
}

// A project's questions: its global-questions-and-answers.json, then each
// work/<ticket>/questions-and-answers.json, each question tagged with its
// source ('global' or the ticket's folder) and its index in that file's list:
// what question:answer needs to find it. An empty file has no questions.
export function loadQuestions(dir) {
  const list = (file, source) => (existsSync(file) && readFileSync(file, 'utf8').trim() ? readJson(file).list ?? [] : [])
    .map((question, index) => ({ ...question, source, index }));
  const work = join(dir, 'work');
  return [
    ...list(join(dir, 'global-questions-and-answers.json'), 'global'),
    ...(existsSync(work) ? readdirSync(work).toSorted() : []).flatMap(ticket => list(join(work, ticket, 'questions-and-answers.json'), ticket)),
  ];
}

// A project's demo plans (ASS-76): each work/<KEY>/demo-plan-<variation>.json,
// as Write Test Plan wrote it — { KEY: { variation: plan } }, {} for none. One
// that is not JSON (being written) is left out; ticket:demo-plan checks the rest.
function loadDemoPlans(dir) {
  const work = join(dir, 'work');
  const plans = {};
  for (const ticket of existsSync(work) ? readdirSync(work).toSorted() : []) {
    for (const file of existsSync(join(work, ticket)) && statSync(join(work, ticket)).isDirectory() ? readdirSync(join(work, ticket)).toSorted() : []) {
      const variation = /^demo-plan-(.+)\.json$/.exec(file)?.[1];
      if (!variation) continue;
      try { const plan = readJson(join(work, ticket, file)); (plans[ticket] ??= {})[variation] = plan; } catch { /* not JSON yet */ }
    }
  }
  return plans;
}

// A project's commit lists (ASS-558): each work/<KEY>/commits-<variation>.json, as ticket:refresh-commits wrote it
// (src/control/ticket-commits.js) — { KEY: { variation: list } }, {} for none. One that is not JSON is left out.
export function loadCommits(dir) {
  const work = join(dir, 'work');
  const lists = {};
  for (const ticket of existsSync(work) ? readdirSync(work).toSorted() : []) {
    for (const file of existsSync(join(work, ticket)) && statSync(join(work, ticket)).isDirectory() ? readdirSync(join(work, ticket)).toSorted() : []) {
      const variation = /^commits-([A-Za-z]+)\.json$/.exec(file)?.[1];
      if (!variation) continue;
      try { (lists[ticket] ??= {})[variation] = readJson(join(work, ticket, file)); } catch { /* not JSON */ }
    }
  }
  return lists;
}

// One workflow per <dir>/<name>/workflow.yaml (ASS-524), steps in sequence order,
// and its *-steps lists by name (the sub-flowcharts follow them). With
// projectsDir, each project's own engines too (ASS-276, ASS-277: its
// <projectsDir>/<id>/engines/<name>/workflow.yaml, as control's loadState
// reads them), each with its project and file, ahead of engines/'s: a lookup
// by name finds a project's own first (shared.js projectWorkflows keeps the
// selected project's alone).
const workflowsIn = (dir, own = {}) => (existsSync(dir) ? readdirSync(dir).toSorted() : [])
  .filter(name => existsSync(engineFileIn(dir, name)))
  .map(name => {
    const engine = withoutObsolete(readEngineFile(engineFileIn(dir, name)));   // ASS-450: keys no longer read dropped, as control drops them
    return {
      name,
      steps: (engine.steps ?? []).toSorted((a, b) => a.sequence - b.sequence),
      lists: Object.fromEntries(Object.entries(engine).filter(([key, value]) => key.endsWith('-steps') && Array.isArray(value))),
      ...(own.project ? { project: own.project, file: engineFileIn(dir, name) } : {}),
    };
  });
export const loadWorkflows = (dir, projectsDir) => [
  ...(projectsDir && existsSync(projectsDir) ? readdirSync(projectsDir).toSorted() : [])
    .flatMap(id => workflowsIn(join(projectsDir, id, 'engines'), { project: id })),
  ...workflowsIn(dir),
];

// The pauses holding the agents, by kind (see assignments:pause); {} when none.
export const loadPauses = file => readJson(file).pauses ?? {};

// The self-healing under way (see self-healing:start) — { since, summary, ticket, ticket-url } — or null.
export const loadSelfHealing = file => readJson(file)['self-healing'] ?? {};
export const loadAssignments = file => readJson(file).assignments ?? [];
// The chat screen's chats (chats.json, ASS-33); [] before the first is made.
export const loadChats = file => (existsSync(file) ? readJson(file).chats ?? [] : []);
// The transient state engines control has running (the file's
// transient-state-engines); [] when none.
export const loadTransientEngines = file => readJson(file)['transient-state-engines'] ?? [];

// loadAnalytics(projectDir) — what the performance screen (ASS-411) works its
// grid out from, read when the screen opens or is refreshed rather than with
// the dashboard's other files, so the analytics (large, and needed by no other
// screen) never slow a reload: a promise of { tickets, sprints, mergeRequests,
// team, accountId } — analytics/tickets.json, sprints.json and
// merge-requests.json, team.json, each parsed ({} for one not there yet, but
// tickets.json), and the signed-in user's ticket-system-account-id, trimmed,
// or null for a project without one (an off-board project) — or of null when
// the project has no analytics/tickets.json yet. Read without blocking: the
// screen draws "loading" meanwhile and every other screen goes on as before.
export async function loadAnalytics(projectDir) {
  const read = async (file, missing) => {
    try { return await readFile(join(projectDir, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
  };
  const tickets = await read(join('analytics', 'tickets.json'), null);
  if (tickets == null) return null;
  const json = async file => JSON.parse(await read(file, '{}'));
  const [sprints, mergeRequests, team, account] = await Promise.all([
    json(join('analytics', 'sprints.json')), json(join('analytics', 'merge-requests.json')), json('team.json'), read('ticket-system-account-id', null),
  ]);
  return { tickets: JSON.parse(tickets), sprints, mergeRequests, team, accountId: account?.trim() || null };
}

// loadLoopCounts(dir, ids) — each project's control's finished loops since it
// started, { <id>: loops } (ASS-526: its data/projects/<id>/loop-count.json,
// src/control/loop-count.js, for the bottom-right counter); a project without
// a readable file left out. Read by main.js each second rather than watched,
// so a control's write every loop never sets off a full reload; readJson parses
// a file again only once it has changed.
export const loadLoopCounts = (dir, ids) => Object.fromEntries(ids.flatMap(id => {
  try { return [[id, readJson(join(dir, id, LOOP_COUNT_FILE)).loops]]; } catch { return []; }
}));

// watchFiles(files, onChange, { delay }) — onChange() once a burst of changes
// to any of `files` has been quiet for `delay` ms; { close } stops it. Each
// file is watched through its folder, not itself: the agent-cli writes by
// renaming a new file over the old, which a watch on the old one would not
// see. A file not there yet is seen once it is; a missing folder is skipped.
export function watchFiles(files, onChange, { delay = 50 } = {}) {
  const names = Map.groupBy(files, dirname);
  let timer;
  const watchers = [...names].filter(([dir]) => existsSync(dir)).map(([dir, list]) => {
    const wanted = new Set(list.map(f => basename(f)));
    return watch(dir, (_, name) => {
      if (name != null && !wanted.has(name)) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, delay);
    });
  });
  return { close: () => { clearTimeout(timer); watchers.forEach(w => w.close()); } };
}

// dataFiles(root, { projects, workflows, project, day }) — the files the
// dashboard reads, to watch: assignments.json, chats.json, api-cost.json,
// context-windows.json, harness.json (see loadApiCost and loadModelUsage) and disk-space.json (loadDiskSpace), each workflow's
// workflow.yaml (engines/'s, or a project's own), each project's project.json, gcloud- and glab-requires-reauthentication, rate-limit.json, claude-usage.json, push-account.json, api-cost.json, sprints.json, backlog.json, outside-tickets.json (ASS-355), questions
// files (see loadQuestions), ticket chats (see loadCollaborations) and chat-spend.json (see loadChatSpend) — and of the sprints only the one on show: the
// selected project's snapshot of the past `day`, or its active sprint.json;
// then each project's golden image (ASS-292: loadGolden) as its golden-<id>
// entry in the Lima folder `lima` — vm:build-golden builds a new one beside
// it and renames it into place, which a watch on the old folder's
// golden-image.json would never see.
export function dataFiles(root, { projects, workflows, project, day }, lima = limaHome()) {
  const dir = id => join(dataDir(root), 'projects', id);
  const work = id => join(dir(id), 'work');
  const shown = projects[project] && (day ? join(dir(projects[project].id), 'sprints', 'days', `${day}.json`) : activeSprintFile(dir(projects[project].id)));
  return [
    join(dataDir(root), 'assignments.json'),
    join(dataDir(root), 'chats.json'),
    join(dataDir(root), 'api-cost.json'),
    join(dataDir(root), 'context-windows.json'),
    join(dataDir(root), 'harness.json'),
    join(dataDir(root), 'disk-space.json'),
    ...workflows.map(w => w.file ?? engineFileIn(join(root, 'engines'), w.name)),   // a project's own at its file (ASS-277)
    ...projects.flatMap(({ id }) => [
      join(dir(id), 'project.json'), join(dir(id), 'gcloud-requires-reauthentication'), join(dir(id), 'glab-requires-reauthentication'), join(dir(id), 'rate-limit.json'), join(dir(id), 'claude-usage.json'), join(dir(id), 'push-account.json'), join(dir(id), 'credentials-hold.json'), join(dir(id), 'jira-token-rejected.json'), join(dir(id), 'api-cost.json'), join(dir(id), 'memory-spend.json'), join(dir(id), 'sprints.json'), join(dir(id), 'backlog.json'), join(dir(id), 'global-questions-and-answers.json'), join(dir(id), 'chat-spend.json'), join(dir(id), 'vms.json'), join(dir(id), 'outside-tickets.json'), join(dir(id), 'memory-hold.json'), join(dir(id), 'memory-wait.json'), join(dir(id), SEATS_FILE), join(dir(id), SEAT_QUEUE_FILE), join(dir(id), SEAT_BUDGET_FILE), join(dir(id), REMOTE_SEATS_FILE), join(dir(id), BOOT_WAITS_FILE), join(dir(id), PLANNING_FOCUS_FILE), join(dir(id), SUBSTRATE_FILE), join(dir(id), 'workstations.json'),   // substrate.json: ASS-533;
        // ASS-539: sandbox-failures.json, and each architecture's sandbox image label and last build's run;
        join(dir(id), SANDBOX_FAILURES_FILE), ...SANDBOX_ARCHES.flatMap(arch => { const f = sandboxImageFiles(dir(id), arch); return [f.label, f.run]; }),
        // planning-focus.json: ASS-531; seat-budget.json: ASS-528; jira-token-rejected.json: ASS-475; seats.json and workstations.json (whose seats are lost): ASS-469; seat-queue.json: ASS-525; memory-hold.json: ASS-398; memory-wait.json: ASS-420; vms.json: its VMs' credential kinds (ASS-333, hasApiKey) and the local virtual machines box (ASS-486); outside-tickets.json: ASS-355
      ...(existsSync(work(id)) ? readdirSync(work(id)).toSorted() : []).flatMap(ticket => ['questions-and-answers.json', 'collaboration.json'].map(file => join(work(id), ticket, file))),
    ]),
    ...(shown ? [shown] : []),
    ...projects.flatMap(({ golden }) => (golden ? [join(lima, golden.name)] : [])),
  ];
}

// projectsChanged(before, after) — the ids of the projects whose own data
// differs between two states ({ projects, assignments, transientEngines }):
// their project files (the project as loaded), or their records and runs in
// the shared assignments.json. Another project's change is never theirs.
export function projectsChanged(before, after) {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const own = (list, id) => (list ?? []).filter(item => item.project === id);
  const ids = [...new Set([...(before.projects ?? []), ...(after.projects ?? [])].map(p => p.id))];
  return ids.filter(id => !same((before.projects ?? []).find(p => p.id === id), (after.projects ?? []).find(p => p.id === id))
    || !same(own(before.assignments, id), own(after.assignments, id))
    || !same(own(before.transientEngines, id), own(after.transientEngines, id)));
}
