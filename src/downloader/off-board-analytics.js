// The downloader cycle's analytics step for an off-board work source
// (ASS-413, cycle.js step 5b′): the project's off-board tickets with their
// status histories (off-board.js fetchAnalyticsTickets: ticket:list and
// ticket:history) and the project's own sprints, handed to ASS-406's
// analytics:sync-tickets and analytics:sync-sprints in exactly the shape the
// Jira step gives them, so the performance screen (src/analytics/
// performance.js) reads an off-board project as it reads a Jira one. A status
// is passed on as the ticket file names it: its meaning comes from the
// project's engines' paired-ticket-system-status, as a Jira status's does, so
// nothing here names one.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The fixed member every off-board ticket is assigned to: the operator works
// them all (off-board tickets have no assignee).
export const OPERATOR_ID = 'operator';

// The last thing syncOffBoardAnalytics logged that stays until it changes, by
// projects folder and project, and by part (tickets, sprints).
const notes = new Map();

// syncOffBoardAnalytics({ key, root, projectDir, project, hasJira, call, offBoard, run, log, env })
// — key the projects folder and project (for the once-logged notes); root the
// repo root (off-board.sh, and the git config the operator's name is read
// from); projectDir data/projects/<project>; hasJira true when the project has
// a jira work source too; call(args, payload) cycle.js's agent.sh call;
// offBoard the off-board.js adapter; run(file, args) → stdout.
//
// Every off-board ticket is sent each cycle (they are local files, cheap to
// read): `analytics:sync-tickets <project> <file>` with { fetched-through
// (the time just before the read), tickets: [{ key, title, type, created,
// points (the front matter's), assignee: the operator, status, sprints,
// status-changes (the history file's { at, from, to }, by null; a backfilled
// mark is not passed on), assignee-changes: [] }] },
// each replacing its entry. The operator is { id: "operator", name: `git
// config user.name` in the repo, else $USER }, the assignee from the ticket's
// creation, so it has no assignee change. A ticket's sprints are the numbers
// of the sprints whose sprint.json lists it (features, bugs or spikes, not
// soft deleted). Then `analytics:sync-sprints <project> <file>` with {
// sprints: [{ id: <number>, name: "Sprint <number>", state: "active" for
// sprints.json's is-active entry else "closed", start, end }] } — start the
// sprint's first day from 00:00 UTC, end its last day to 23:59:59.999 UTC
// (sprint.json keeps dates; its end is the sprint's last day).
//
// A project with a jira work source too (none today) keeps Jira's analytics:
// the board's sprints stay the only ones written, a ticket's sprints are its
// sprints' jira-sprint-id (one without is left out), and fetched-through
// stays as Jira's read left it (the epoch when there is none), so Jira's next
// read starts where it would have.
//
// A read or write that fails is logged once until that changes, the file it
// would have written stays as it was, and the cycle goes on.
export async function syncOffBoardAnalytics({ key, root, projectDir, project, hasJira = false, call, offBoard, run, log = () => {}, env = process.env }) {
  const note = (part, text) => {
    const at = `${key}\0${part}`;
    if (text === null) return void notes.delete(at);
    if (notes.get(at) !== text) log(text);
    notes.set(at, text);
  };
  const reason = err => String(err?.message ?? err).split('\n')[0];
  const sprints = readSprints(projectDir);
  const id = s => (hasJira ? s.jiraId : s.number);
  const byTicket = new Map();
  for (const s of sprints) {
    if (id(s) === undefined || id(s) === null) continue;
    for (const k of s.keys) byTicket.set(k, [...(byTicket.get(k) ?? []), id(s)]);
  }

  try {
    const fetchedThrough = hasJira ? recordedThrough(projectDir) : new Date().toISOString();
    const operator = { id: OPERATOR_ID, name: await operatorName(root, run, env) };
    const read = await offBoard.fetchAnalyticsTickets({ root, project }, run);
    const tickets = read.map(t => ({
      key: t.key, title: t.title, type: t.type, created: t.created, points: t.points ?? null,
      assignee: operator, status: t.status,
      sprints: byTicket.get(String(t.key).toUpperCase()) ?? [],
      'status-changes': (t['status-changes'] ?? []).map(c => ({ at: c.at ?? null, from: c.from ?? null, to: c.to ?? null, by: null })),
      'assignee-changes': [],
    }));
    log(`analytics: ${tickets.length} off-board tickets`);
    await call(['analytics:sync-tickets', project], { 'fetched-through': fetchedThrough, tickets });
    note('tickets', null);
  } catch (err) {
    note('tickets', `analytics: the off-board tickets could not be read; tickets.json stays as it is: ${reason(err)}`);
  }

  if (hasJira) return;
  try {
    await call(['analytics:sync-sprints', project], { sprints: sprints.map(s => ({ id: s.number, name: `Sprint ${s.number}`, state: s.active ? 'active' : 'closed', start: s.start, end: s.end })) });
    note('sprints', null);
  } catch (err) {
    note('sprints', `analytics: the project's sprints could not be written; sprints.json stays as it is: ${reason(err)}`);
  }
}

// readSprints(projectDir) → [{ number, active, jiraId, start, end, keys: Set
// of upper-cased ticket keys }], one per sprints.json entry with a number; a
// sprint whose sprint.json is missing or unreadable has no dates and no keys.
export function readSprints(projectDir) {
  let list = [];
  try { list = JSON.parse(readFileSync(join(projectDir, 'sprints.json'), 'utf8')).list ?? []; } catch { /* no sprints yet */ }
  return list.filter(e => Number.isInteger(e?.number)).map(e => {
    let data = {};
    const file = join(projectDir, 'sprints', `sprint-${e.number}`, 'sprint.json');
    try { if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { /* unreadable: no dates, no tickets */ }
    const keys = new Set(['features', 'bugs', 'spikes'].flatMap(a => (Array.isArray(data[a]) ? data[a] : []))
      .filter(t => t?.key && t['is-deleted'] !== true).map(t => String(t.key).toUpperCase()));
    return { number: e.number, active: e['is-active'] === true, jiraId: e['jira-sprint-id'], start: day(data.start, 'T00:00:00.000Z'), end: day(data.end, 'T23:59:59.999Z'), keys };
  });
}

// A sprint.json date (YYYY-MM-DD) as an ISO time at that moment of the day;
// one already a time is kept; anything else null.
function day(value, time) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return `${value}${time}`;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

// The operator's name: `git config user.name` in the repo, else $USER.
async function operatorName(root, run, env) {
  try {
    const name = String(await run('git', ['-C', root, 'config', 'user.name']) ?? '').trim();
    if (name) return name;
  } catch { /* no git name set */ }
  return env.USER || OPERATOR_ID;
}

// The fetched-through tickets.json already holds (Jira's), else the epoch.
function recordedThrough(projectDir) {
  try {
    const through = JSON.parse(readFileSync(join(projectDir, 'analytics', 'tickets.json'), 'utf8'))['fetched-through'];
    if (typeof through === 'string' && !Number.isNaN(Date.parse(through))) return through;
  } catch { /* none yet */ }
  return new Date(0).toISOString();
}
