// What control reads, each tick, straight from the JSON files (reads are
// direct; every write goes through cli.js). Small readers of its own: the
// dashboard's loaders (src/tui/load.js) trim the sprints and read what control
// does not need.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { flattenSprint, isLiveBacklogEntry } from './rank.js';
import { dataDir } from '../data-folder.js';
import { switchOff, blocksTicket } from './engine.js';
import { switchedOffStepErrors } from '../workflow/validate.js';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// readDiskSpace(file) — disk-space.json (ASS-288), or null without it or caught half-written.
export const readDiskSpace = file => { try { return readJson(file); } catch { return null; } };

// requiresReauthentication(projectDir, tool) — whether the project's
// <tool>-requires-reauthentication file (gcloud, glab; written by
// project:set-<tool>-reauthentication, ASS-58) reads exactly `true`; missing
// or anything else is false. Control and the dashboard both read it here.
export const requiresReauthentication = (projectDir, tool) => {
  const file = join(projectDir, `${tool}-requires-reauthentication`);
  return existsSync(file) && readFileSync(file, 'utf8') === 'true';
};

// loadOutside(dir, read) — a project's outside-tickets.json tickets (ASS-355,
// from its folder `dir`): the Jira tickets its sprint and backlog tickets
// depend on that neither holds, read by key by the downloader (ticket:
// sync-outside) — each { key, title, url, ticket-system-status,
// ticket-system-assignment }; [] without the file, or when it cannot be read.
// Control and the dashboard both judge dependencies against them
// (dependencies.js).
export function loadOutside(dir, read = readJson) {
  try { return existsSync(join(dir, 'outside-tickets.json')) ? read(join(dir, 'outside-tickets.json')).tickets ?? [] : []; } catch { return []; }
}

// loadCollaborations(dir, read) — a project's ticket chats (ASS-35), from its folder
// `dir`: each work/<KEY>/collaboration.json — { session-id, briefed, turns } —
// by its ticket folder, parsed by `read` (the dashboard's caches); {} for
// none. The dashboard shows them; control sums their api turns against the
// project's API caps (ASS-217).
export function loadCollaborations(dir, read = readJson) {
  const work = join(dir, 'work');
  return Object.fromEntries((existsSync(work) ? readdirSync(work).toSorted() : [])
    .filter(ticket => existsSync(join(work, ticket, 'collaboration.json')))
    .map(ticket => [ticket, read(join(work, ticket, 'collaboration.json'))]));
}

// loadChatSpend(dir, read) — a project's chat-screen turns (ASS-271), from its
// folder `dir`: its chat-spend.json — { turns } (chat:add-spend's) — parsed by
// `read` (the dashboard's caches); null without one. Summed with its dispatches
// and ticket chats (spend.js spendRecords) for its Day and Sprint Spend and API caps.
export const loadChatSpend = (dir, read = readJson) => (existsSync(join(dir, 'chat-spend.json')) ? read(join(dir, 'chat-spend.json')) : null);

// loadMemorySpend(dir, read) — what a project's Hindsight has spent on Claude
// (ASS-269), from its folder `dir`: memory-spend.json's records, written by
// memory:record-spend; [] with none, or unreadable. Control sums them against
// the project's API caps, the dashboard into its spend tiles.
export function loadMemorySpend(dir, read = readJson) {
  try { return read(join(dir, 'memory-spend.json'))?.records ?? []; } catch { return []; }
}

// refinementOf(engine) — the backlog refinement engine an execution engine
// names: the engine its backlog-refinement-steps runs (ASS-144: a backlog
// ticket sits in it), or undefined.
export const refinementOf = engine => (engine?.['backlog-refinement-steps'] ?? []).map(s => s.action?.engine).find(Boolean);

// openBlocking(dir, tickets) — the tickets that wait on the operator for an
// answer (ASS-248): a Map from each key of `tickets` (sprint and backlog, live)
// not Done in the ticket system — a done ticket's unflagged questions hold
// nothing — to the open blocking questions (blocksTicket) in its
// work/<key>/questions-and-answers.json, kept only when there are any. A
// missing or unreadable file has none.
function openBlocking(dir, tickets) {
  const asking = new Map();
  for (const t of tickets) {
    if (t['ticket-system-status'] === 'Done') continue;
    const file = join(dir, 'work', t.key, 'questions-and-answers.json');
    if (!existsSync(file)) continue;
    let list;
    try { list = readJson(file).list ?? []; } catch { continue; }
    const open = list.filter(blocksTicket);
    if (open.length) asking.set(t.key, open.map(q => q.question ?? ''));
  }
  return asking;
}

// paths(root, env) — where the data is: assignments.json, harness.json and
// the projects and agents folders and context-windows.json (ASS-190) in root's
// data folder (data/: src/data-folder.js), the engines and prompts folders
// under `root`, each overridden by the env the agent-cli commands take
// (ASSIGNMENTS_FILE, HARNESS_FILE, ENGINES_DIR, PROJECTS_DIR, AGENTS_DIR,
// PROMPTS_DIR, CONTEXT_WINDOWS_FILE), so control and the commands it runs read
// the same files; and disk-space.json (ASS-288: harness:check-disk-space's
// record) beside harness.json, DISK_SPACE_FILE overriding it.
export const paths = (root, env = process.env) => ({
  assignments: env.ASSIGNMENTS_FILE ?? join(dataDir(root), 'assignments.json'),
  harness: env.HARNESS_FILE ?? join(dataDir(root), 'harness.json'),
  engines: env.ENGINES_DIR ?? join(root, 'engines'),
  projects: env.PROJECTS_DIR ?? join(dataDir(root), 'projects'),
  agents: env.AGENTS_DIR ?? join(dataDir(root), 'agents'),
  prompts: env.PROMPTS_DIR ?? join(root, 'prompts'),
  contextWindows: env.CONTEXT_WINDOWS_FILE ?? join(dataDir(root), 'context-windows.json'),
  diskSpace: env.DISK_SPACE_FILE ?? join(dirname(env.HARNESS_FILE ?? join(dataDir(root), 'harness.json')), 'disk-space.json'),
});

// A ticket not soft deleted (ASS-104, ticket:delete's is-deleted): control
// ignores a deleted one as though it were gone.
const live = t => t['is-deleted'] !== true;

// readEngines(dir) — { [name]: its state-engine.json } for each
// <dir>/<name>/state-engine.json; {} when there is no such folder.
export const readEngines = dir => (!existsSync(dir) ? {} : Object.fromEntries(readdirSync(dir)
  .filter(name => existsSync(join(dir, name, 'state-engine.json')))
  .map(name => [name, readJson(join(dir, name, 'state-engine.json'))])));

// loadState(paths) — everything as it is now: { harness, assignments (the
// records), transient (the state engine runs), pauses, selfHealing, engines
// (engines/'s, { [name]: its state-engine.json }), projects }. Each project is { id,
// json (its project.json), engineName (its execution-state-engine), engines
// (`engines` and its own — <project>/engines/<name>/state-engine.json, over
// engines/'s of the same name, ASS-276 — with its switched-off-steps switched
// off, ASS-209), switchedOffErrors
// (what is wrong with those entries; a bad one is not applied), engine
// (that engine's JSON from its engines, or undefined), sprintFile, sprint (its active
// sprint.json, or null), refinementName and refinement (its backlog
// refinement engine — the one its engine's backlog-refinement-steps runs,
// refinementOf — and its JSON; undefined without, ASS-144), tickets (the sprint's as flattenSprint lists them,
// [] without a sprint), backlog (backlog.json's tickets not in the sprint,
// [] without one) — both without soft-deleted tickets (live) — asking (those
// of them an open blocking question holds, each key to its questions:
// openBlocking, ASS-248), outside (its outside-tickets.json's tickets: loadOutside, ASS-355), gcloudRequiresReauthentication and
// glabRequiresReauthentication (see requiresReauthentication), rateLimit (its rate-limit.json —
// { <credential kind>: { since, type, resets-at }, … } (ASS-215) — or null, ASS-94), claudeUsage (its
// claude-usage.json — { email, session: { percent, resets-at }, weekly: { percent, resets-at } | null, as-of } — or
// null, ASS-47), credentialsHold (its credentials-hold.json — { since, problems } — or null, ASS-395), memoryHold (its
// memory-hold.json — control's hold on its new VMs for want of memory, the variations held — or null, ASS-404) }, in folder order, contextWindows (the learned
// context-windows.json — { <model>: tokens } — or {}, ASS-190) and diskSpace
// (disk-space.json — { level, free-bytes, … }, ASS-288 — or null; one caught
// half-written reads as null, the next tick reading it again).
export function loadState(paths) {
  const data = readJson(paths.assignments);
  const engines = readEngines(paths.engines);
  const projects = readdirSync(paths.projects).toSorted()
    .filter(id => existsSync(join(paths.projects, id, 'project.json')))
    .map(id => {
      const dir = join(paths.projects, id);
      const json = readJson(join(dir, 'project.json'));
      const engineName = json['execution-state-engine'];
      const active = existsSync(join(dir, 'sprints.json')) && readJson(join(dir, 'sprints.json')).list?.find(s => s['is-active']);
      const sprintFile = active ? join(dir, 'sprints', `sprint-${active.number}`, 'sprint.json') : null;
      const sprint = sprintFile && existsSync(sprintFile) ? readJson(sprintFile) : null;
      const listed = sprint ? flattenSprint(sprint) : [];
      const inSprint = new Set(listed.map(t => t.key.toUpperCase()));
      const tickets = listed.filter(live);
      const backlog = (existsSync(join(dir, 'backlog.json')) ? readJson(join(dir, 'backlog.json')).tickets ?? [] : []).filter(t => isLiveBacklogEntry(t, inSprint));
      const rateLimit = existsSync(join(dir, 'rate-limit.json')) ? readJson(join(dir, 'rate-limit.json')) : null;
      const claudeUsage = existsSync(join(dir, 'claude-usage.json')) ? readJson(join(dir, 'claude-usage.json')) : null;
      // ASS-395: its credentials hold (project:check-credentials' credentials-hold.json — { since, problems }), or null.
      const credentialsHold = existsSync(join(dir, 'credentials-hold.json')) ? readJson(join(dir, 'credentials-hold.json')) : null;
      // ASS-404: its memory hold (host-memory.js' memory-hold.json — { since, …, held: [{ key, variation, … }] }: plan.js frees the held variations' seats), or null; one caught half-written reads as null.
      let memoryHold = null;
      try { memoryHold = existsSync(join(dir, 'memory-hold.json')) ? readJson(join(dir, 'memory-hold.json')) : null; } catch { /* half-written: the next load reads it */ }
      // The engines it runs on: its own folder's over engines/'s (ASS-276).
      const seen = { ...engines, ...readEngines(join(dir, 'engines')) };
      // Its switched-off-steps (ASS-209): each valid entry's step switched off in its own engines; a bad one left on, its errors kept.
      const switchedOff = [].concat(json['switched-off-steps'] ?? []);
      const switchedOffErrors = switchedOff.flatMap(e => switchedOffStepErrors(e, seen));
      const own = switchOff(seen, switchedOff.filter(e => !switchedOffStepErrors(e, seen).length));
      const refinementName = refinementOf(own[engineName]);
      return { id, json, engineName, engines: own, switchedOffErrors, engine: own[engineName], refinementName, refinement: own[refinementName], sprintFile, sprint, tickets, backlog, asking: openBlocking(dir, [...tickets, ...backlog]), outside: loadOutside(dir),
        gcloudRequiresReauthentication: requiresReauthentication(dir, 'gcloud'), glabRequiresReauthentication: requiresReauthentication(dir, 'glab'), rateLimit, claudeUsage, credentialsHold, memoryHold };
    });
  return {
    harness: readJson(paths.harness),
    assignments: data.assignments ?? [],
    transient: data['transient-state-engines'] ?? [],
    pauses: data.pauses ?? {},
    selfHealing: data['self-healing'] ?? {},
    engines,
    projects,
    contextWindows: existsSync(paths.contextWindows) ? readJson(paths.contextWindows) : {},
    diskSpace: readDiskSpace(paths.diskSpace),
  };
}

// enginesFor(state, id) — the engines as project `id` runs them (its engines,
// its switched-off-steps applied, ASS-209); state's own without such a project.
// heldKinds(project, at) — the credential kinds (claude, anthropic) the
// project's rate-limit.json holds at `at` (ms since the epoch): those whose
// resets-at is after it (ASS-215). An entry without one (a flat file from
// before kinds) holds nothing.
export const heldKinds = (project, at) => Object.entries(project.rateLimit ?? {})
  .filter(([, e]) => Date.parse(e?.['resets-at']) > at).map(([kind]) => kind);

// payWith({ held, both, kind, capHold, weekly }) — dispatch's billing choice
// for an agent (ASS-217; dispatch.js paymentFor, shared with vm-lifecycle.js
// for ASS-400), or null while it waits. `held`: the project's kinds held
// (heldKinds); `both`: where it runs declares a subscription and an API key
// (a host step's project its .claude-api, a VM step's VM credential-kind
// `both`); `kind`: else the one credential kind it runs on (null for a VM
// recording none, held while any kind is); `capHold`: project.json's
// api-cap-hold; `weekly`: grooming or background work at the weekly usage
// limit (ASS-327), which skips the subscription. Both declared: {
// payment: 'subscription' } unless the claude kind is held (or `weekly`), else
// { payment: 'api' } unless the anthropic kind is held too or an API cap
// holds. One declared: { payment: null } unless its kind is held (or `weekly`).
export function payWith({ held = [], both = false, kind = null, capHold = null, weekly = false }) {
  if (!both) return weekly || (held.length && (!kind || held.includes(kind))) ? null : { payment: null };
  if (!weekly && !held.includes('claude')) return { payment: 'subscription' };
  return held.includes('anthropic') || capHold ? null : { payment: 'api' };
}

export const enginesFor = (state, id) => (state.allProjects ?? state.projects).find(p => p.id === id)?.engines ?? state.engines;
