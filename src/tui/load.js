// Reads the dashboard's data from the repo's JSON files.
import { readdirSync, readFileSync, existsSync, statSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { requiresReauthentication, loadCollaborations, loadChatSpend, loadMemorySpend, loadOutside } from '../control/state.js';
import { isLiveBacklogEntry } from '../control/rank.js';
import { defaultSpendLimit } from '../control/spend.js';
import { isHarnessProject } from '../control/harness-project.js';
import { mergedWindows } from '../agents/session-usage.js';
import { loadReviews } from './review.js';
import { dataDir } from '../data-folder.js';
import { limaHome } from '../control/vm.js';

// A file's JSON, parsed again only once it has changed (its mtime or size), so
// reading everything again on every change costs only the files that did. An
// unchanged file gives back the very same objects: nothing may change them.
const parsed = new Map();
const readJson = file => {
  const { mtimeMs, size } = statSync(file);
  const known = parsed.get(file);
  if (known?.mtimeMs === mtimeMs && known.size === size) return known.json;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  parsed.set(file, { mtimeMs, size, json });
  return json;
};

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
// requiresReauthentication); glabReauthentication the same for glab auth
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
// demo plan (see loadDemoPlans); reviews what Human Review shows of each
// ticket (src/tui/review.js loadReviews, ASS-118); spendLimit its tickets'
// spending limit (ASS-191: control/spend.js defaultSpendLimit, harness.json the
// one in `dir`'s parent, the data folder), null for none; apiCost its org's
// API spend this month (see apiCostOf, ASS-221); golden its golden image (see
// loadGolden, ASS-292), looked for in `lima` (control/vm.js limaHome). Sprints and snapshots come
// without their soft-deleted variations; sprints, snapshots, the backlog and
// the questions without soft-deleted tickets (ASS-104).
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
      gcloudReauthentication: project['check-for-expired-gcloud-auth'] === true && requiresReauthentication(join(dir, name), 'gcloud'),
      glabReauthentication: project['check-for-expired-glab-auth'] === true && requiresReauthentication(join(dir, name), 'glab'),
      backgroundWorkOff: project['background-work'] === false,
      waitForDependencies: project['wait-for-dependencies'] === true,   // ASS-195: a ticket waits for the tickets it depends on
      outside: loadOutside(join(dir, name), readJson),   // ASS-355: the tickets depended on that its sprint and backlog do not hold
      limits: { project: pickLimits(project), harness: pickLimits(harnessOf(dir)) },   // ASS-357: what the planner reads, for the sprint screen's seats

      rateLimit: existsSync(join(dir, name, 'rate-limit.json')) ? readJson(join(dir, name, 'rate-limit.json')) : null,
      claudeUsage: existsSync(join(dir, name, 'claude-usage.json')) ? readJson(join(dir, name, 'claude-usage.json')) : null,
      pushAccount: existsSync(join(dir, name, 'push-account.json')) ? readJson(join(dir, name, 'push-account.json')) : null,   // ASS-307: control's last push-account check
      accountHold: project['account-hold'] ?? null,
      apiCapHold: project['api-cap-hold'] ?? null,   // ASS-217: the API cap holding its fallback, control's
      apiKey: hasApiKey(join(dir, name)),   // ASS-333: whether its agents can fall back to an API key (see hasApiKey)
      hindsight: project.hindsight ?? null,   // its memory's server, for the memory screen (ASS-62)
      collaborations: loadCollaborations(join(dir, name), readJson),
      chatSpend: loadChatSpend(join(dir, name), readJson),   // ASS-271: the chat screen's turns, for the spend tiles
      memorySpend: loadMemorySpend(join(dir, name), readJson),   // ASS-269: its Hindsight's Claude spend, for the spend tiles
      demoPlans: loadDemoPlans(join(dir, name)),
      reviews: loadReviews(join(dir, name)),
      spendLimit: defaultSpendLimit(harnessOf(dir), project),
      apiCost: apiCostOf(dir, name, project),
      golden: loadGolden(name, project, lima),
    };
  })
  .toSorted((a, b) => a.name.localeCompare(b.name));

// pickLimits(json) — the fields of a project.json or harness.json control's
// planner (control/plan.js planDispatch) reads: the ticket limits, max-agents
// and the per-ticket spending limit (ASS-357, the sprint screen's seats).
const LIMIT_FIELDS = ['max-tickets-in-progress', 'max-tickets-in-planning', 'max-agents', 'max-spend-per-ticket-usd'];
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
function activeSprintFile(projectDir) {
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

// One workflow per <dir>/<name>/state-engine.json, steps in sequence order,
// and its *-steps lists by name (the sub-flowcharts follow them). With
// projectsDir, each project's own engines too (ASS-276, ASS-277: its
// <projectsDir>/<id>/engines/<name>/state-engine.json, as control's loadState
// reads them), each with its project and file, ahead of engines/'s: a lookup
// by name finds a project's own first (shared.js projectWorkflows keeps the
// selected project's alone).
const workflowsIn = (dir, own = {}) => (existsSync(dir) ? readdirSync(dir).toSorted() : [])
  .filter(name => existsSync(join(dir, name, 'state-engine.json')))
  .map(name => {
    const engine = readJson(join(dir, name, 'state-engine.json'));
    return {
      name,
      steps: (engine.steps ?? []).toSorted((a, b) => a.sequence - b.sequence),
      lists: Object.fromEntries(Object.entries(engine).filter(([key, value]) => key.endsWith('-steps') && Array.isArray(value))),
      ...(own.project ? { project: own.project, file: join(dir, name, 'state-engine.json') } : {}),
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
// state-engine.json (engines/'s, or a project's own), each project's project.json, gcloud- and glab-requires-reauthentication, rate-limit.json, claude-usage.json, push-account.json, api-cost.json, sprints.json, backlog.json, outside-tickets.json (ASS-355), questions
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
    ...workflows.map(w => w.file ?? join(root, 'engines', w.name, 'state-engine.json')),   // a project's own at its file (ASS-277)
    ...projects.flatMap(({ id }) => [
      join(dir(id), 'project.json'), join(dir(id), 'gcloud-requires-reauthentication'), join(dir(id), 'glab-requires-reauthentication'), join(dir(id), 'rate-limit.json'), join(dir(id), 'claude-usage.json'), join(dir(id), 'push-account.json'), join(dir(id), 'api-cost.json'), join(dir(id), 'memory-spend.json'), join(dir(id), 'sprints.json'), join(dir(id), 'backlog.json'), join(dir(id), 'global-questions-and-answers.json'), join(dir(id), 'chat-spend.json'), join(dir(id), 'vms.json'), join(dir(id), 'outside-tickets.json'),   // vms.json: its VMs' credential kinds (ASS-333, hasApiKey); outside-tickets.json: ASS-355
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
