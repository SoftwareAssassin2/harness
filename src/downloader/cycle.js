// One downloader cycle for one project: keep the previous day's last sprint
// data, fetch the sprint's tickets and merge requests and the backlog's
// tickets (and, on a comment cycle, their Jira comments), and hand them to the
// agent-cli. It writes no JSON itself: every mutation is an agent.sh call
// (ticket:snapshot-day, ticket:sync, ticket:sync-outside, ticket:sync-jira-comments,
// project:set-ticket-system-account-id, analytics:sync-tickets (Jira's and,
// ASS-413, the off-board tickets'),
// analytics:sync-sprints, analytics:sync-merge-requests, team:update,
// project:set-last-data-download), so the file rules live in one place.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoardUrl } from './jira.js';
import { scanMergeRequests } from './merge-requests.js';
import { syncMergedMergeRequests } from './merged-merge-requests.js';
import { syncOffBoardAnalytics } from './off-board-analytics.js';
import { dataDir } from '../data-folder.js';

// runCycle({ root, project, now, adapters, exec, fetch, comments, lookups, dryRun, log }) — root is the
// repo root (agent.sh is under it and, unless PROJECTS_DIR says otherwise,
// data/projects/); now the time of this cycle; adapters { jira, gitlab, github,
// offBoard, jiraRest, mergedMergeRequests, team } the modules of this folder, or fakes; fetch the HTTP
// fetch jiraRest's reads go through (Node's global one unless given: tests
// pass a fake); lookups, on a lookup cycle
// (main.js: the comment cycles), the merge-request scan's direct fetches and targeted lookups; exec(file, args) runs a command and
// resolves to its stdout, rejecting with the exit status as `code`; log(text)
// takes one line per action; comments, given on a comment cycle (main.js:
// every 15th), the Set of keys whose comments last failed to download, kept
// by the caller across cycles. With dryRun, the data is fetched but every
// agent.sh call is only printed, with the file it would get.
//
// 1. Snapshot: when the local date of now is after the local date of
//    the project folder's last-data-download file, `ticket:snapshot-day <project> <that
//    date>` first, so the day's last data is kept before it changes; a day
//    already kept (exit 2) is fine. No last download, no snapshot. Then, for
//    a project with only an off-board work source, `sprint:advance <project>
//    <today>` (ASS-142), its line, when it advances, logged. For a project
//    with a jira work source whose active entry pins a jira-sprint-id, every
//    cycle (ASS-165): when the board's active sprints (adapters.jira.
//    fetchActiveSprints) do not include it and one is active, `sprint:advance
//    <project> <today> --jira-sprint <id> <name> [<start> <end>]` with the
//    first, so the sprint below is the board's, with Jira's dates; when they
//    include it but its dates differ from the sprint file's (edited in Jira),
//    the same call with it brings them over. None active, or the board
//    unreadable, the sprint stays as it is, logged once until the board's
//    answer changes. The project's pause (assignments:pause) is not read: a
//    paused project's sprint follows Jira all the same (the TUI's "day N of
//    M" reads those dates).
//    Then, for a project with a jira work source, the signed-in user's account
//    id (adapters.jira.fetchSignedInAccountId, ASS-344), once a cycle and
//    before any sync: `project:set-ticket-system-account-id <project> <id>`
//    when it differs from the project folder's ticket-system-account-id file,
//    so ticket:sync and control can compare a ticket's
//    ticket-system-assignment-id with it. Unreadable (it throws or gives
//    null), the file stays as it is, logged once until the answer changes.
// 2. Sprint: the active sprint's tickets (Jira) and the merge-request scan of
//    every Active repository (merge-requests.js: none when one cannot be read,
//    so every record is kept) — `ticket:sync <project> sprint <file>`. No
//    active sprint, no sprint sync.
// 3. Backlog: `ticket:sync <project> backlog <file>`.
// 3b. Reassigned tickets (ASS-344): the searches return only the signed-in
//    user's tickets. The Jira tickets (keys of the board's project) the
//    sprint file or backlog.json holds, not soft deleted, that neither search
//    returned — but for a backlog.json entry already Done, which no search
//    returns — are read by key (adapters.jira.fetchTicketsByKey), whoever
//    holds them: those in the sprint file to a second `ticket:sync <project>
//    sprint` (no merge requests: those stay as the first sync left them;
//    sprint-tag, unread, the sprint's name), the others to a second
//    `ticket:sync <project> backlog`. A ticket the read does not return
//    (deleted in Jira, or not visible) is left as it is; a read that fails is
//    logged and the cycle goes on. Nothing missing, no read and no sync.
// 3c. Outside dependencies (ASS-355): every key the sprint file's and
//    backlog.json's tickets (not soft deleted, as the syncs above left them)
//    depend on that neither holds — a ticket assigned to a teammate, say —
//    read by key (adapters.jira.fetchTicketsByKey, batched, views false: its
//    status and assignee alone are wanted) whoever holds it, to `ticket:
//    sync-outside <project> <file>` with { fetched-at, keys, tickets: [{ key,
//    title, url, ticket-system-status, ticket-system-assignment }] }, which
//    keeps data/projects/<p>/outside-tickets.json (control judges the
//    dependencies against it). Nothing wanted, no read — and no write unless
//    the file still lists some, emptied then. A read that fails is logged
//    and the file kept as it is.
// 4. The off-board tickets (adapters.offBoard, off-board.js), when the project
//    has an off-board work source: at Backlog to the backlog, the rest to the
//    sprint with their own scan, the same two calls — but a Done one not
//    already in the active sprint, left in an old one, to neither (ASS-142),
//    unless backlog.json lists it not yet Done: to the backlog (ASS-296).
// 5. Comments (ASS-37), on a comment cycle: for each Jira sprint and backlog
//    ticket, its comments (adapters.jira.fetchComments) — `ticket:sync-jira-
//    comments <project> <key> <file>`. One that fails keeps what it had and
//    the cycle goes on; it is logged only when it starts failing.
// 5b. Analytics (ASS-406), every cycle, for a project whose jira work source
//    has api-email and api-token (Jira REST's basic auth), when adapters.
//    jiraRest is given: every ticket of the board's Jira project (sub-tasks
//    left out), whoever holds it, with its full changelog (jiraRest.
//    fetchAnalyticsTickets) — those updated since ANALYTICS_OVERLAP_MS before
//    analytics/tickets.json's fetched-through, all of them when there is none
//    — to `analytics:sync-tickets <project> <file>` with { fetched-through
//    (the time just before the read), tickets: [...] }; then the board's
//    sprints of every state (jiraRest.fetchBoardSprints) to `analytics:
//    sync-sprints <project> <file>` with { sprints: [...] }. Neither touches
//    the sprint files or backlog.json. No credentials, or a read (or its
//    write) that fails, is logged once until that changes, the file it would
//    have written stays as it was, and the cycle goes on.
// 5b′. Off-board analytics (ASS-413), every cycle, for a project with an
//    off-board work source, when adapters.offBoard has fetchAnalyticsTickets:
//    every off-board ticket with its status history (ticket:history) and the
//    project's own sprints, in 5b's shapes, to the same `analytics:sync-
//    tickets` and `analytics:sync-sprints` (off-board-analytics.js), the
//    operator their one assignee. Its failures are logged once, never the
//    cycle's.
// 5c. Analytics' merged merge requests (ASS-408), every cycle, when adapters
//    has mergedMergeRequests (merged-merge-requests.js): for each GitLab or
//    GitHub repository in project.json's `repositories`, by its url's host
//    (one on another host skipped, logged once), its merged merge requests
//    or pull requests updated since a few minutes before its fetched-through
//    time in analytics/merge-requests.json (all of them the first time), page
//    by page — `analytics:sync-merge-requests <project> <file>`. One whose read fails is logged once until that
//    changes, and its fetched-through stays; the others still go. Separate
//    from step 2's scan, which stays as it is.
// 5d. The team (ASS-409), every cycle, after the analytics syncs, when
//    adapters has team (team.js) and the project has analytics/tickets.json
//    or analytics/merge-requests.json: `team:update <project>`, which keeps
//    team.json under its lock, each line it prints (a member added or
//    linked) logged. One that fails is logged once until the reason changes,
//    and the cycle goes on.
// 6. `project:set-last-data-download <project> <now>`.
// Each ticket list is stamped with when it was read ("fetched-at", the time
// just before the read): a status control sets on a sprint ticket while the
// merge requests are looked up is newer than the list, and ticket:sync keeps
// it (ASS-128).
// The Jira steps (2, 3, 3b, 3c, 5, 5b) only for a project with a jira work source; one with
// only an off-board source (the harness's own) syncs those tickets alone.
// Fails before anything runs when the project has neither.
export async function runCycle({ root, project, now = new Date(), adapters, exec, fetch: fetchFn = globalThis.fetch, comments, lookups = false, dryRun = false, log = () => {} }) {
  const projects = process.env.PROJECTS_DIR ?? join(dataDir(root), 'projects');
  const read = file => JSON.parse(readFileSync(join(projects, project, file), 'utf8'));
  const config = read('project.json');
  const source = (config['work-sources'] ?? []).find(s => s.type === 'jira' && s.url);
  const offBoard = (config['work-sources'] ?? []).find(s => s.type === 'off-board');
  if (!source && !offBoard) throw new Error(`${project}: no jira or off-board work source in project.json`);
  const board = source && { ...parseBoardUrl(source.url), storyPointsField: source['story-points-field'] };
  const repos = (config.repositories ?? []).filter(r => r.status === 'Active' && r.url).map(r => r.url);

  const agent = join(root, 'agent.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'downloader-'));
  // call(args, payload?) — one agent.sh command, its JSON payload written to a file passed as the last argument.
  const call = async (args, payload) => {
    const file = payload === undefined ? null : join(tmp, `${args[2] ?? args[0].split(':').pop()}.json`);
    if (file) writeFileSync(file, JSON.stringify(payload, null, 2));
    if (dryRun) {
      log(`would run: agent.sh ${args.join(' ')}${file ? ` ${file}` : ''}`);
      if (file) log(JSON.stringify(payload));
      return '';
    }
    return exec(agent, file ? [...args, file] : args);
  };

  try {
    const lastFile = join(projects, project, 'last-data-download');
    const last = existsSync(lastFile) ? readFileSync(lastFile, 'utf8').trim() : null;
    if (last) {
      const lastDate = utcDate(new Date(last)), today = utcDate(now);
      if (today > lastDate) {
        log(`snapshot of ${lastDate}`);
        try { await call(['ticket:snapshot-day', project, lastDate]); } catch (err) {
          if (err.code !== 2) throw err;
          log(`snapshot of ${lastDate} already kept`);
        }
        // An off-board project's sprint past its last day gives way to the next (ASS-142); a Jira one's comes from Jira.
        if (offBoard && !source) {
          const out = (await call(['sprint:advance', project, today]))?.trim();
          if (out) log(out);
        }
      }
    }

    if (source) await recordAccount({ key: join(projects, project), project, file: join(projects, project, 'ticket-system-account-id'), call, jira: adapters.jira, exec, log });
    if (source) await followBoard({ key: join(projects, project), project, read: file => existsSync(join(projects, project, file)) ? read(file) : {}, board, today: utcDate(now), call, jira: adapters.jira, exec, log });

    const active = (existsSync(join(projects, project, 'sprints.json')) ? read('sprints.json') : {}).list?.find(s => s['is-active']);   // no sprints file: no active sprint
    const sprint = active?.number;
    const sprintFile = join('sprints', `sprint-${sprint}`, 'sprint.json');
    const sprintData = sprint !== undefined && existsSync(join(projects, project, sprintFile)) ? read(sprintFile) : {};
    // Each sprint ticket's recorded merge-request urls (its variations not deleted, as ticket:sync refreshes), by its lower-cased key.
    const recorded = new Map(['features', 'bugs', 'spikes'].flatMap(a => sprintData[a] ?? []).map(t => [t.key.toLowerCase(),
      (t.variations ?? []).filter(v => !v['is-deleted']).flatMap(v => Array.isArray(v['merge-request']) ? v['merge-request'] : []).map(m => m.url).filter(Boolean)]));
    const scan = keys => scanMergeRequests({ repos, keys, recorded, lookups, log }, adapters, exec);
    const jiraKeys = [];
    if (!source) {
      log('no jira work source; Jira skipped');
    } else if (sprint === undefined) {
      log('no active sprint; sprint sync skipped');
    } else {
      // The Jira sprint is the entry's jira-sprint-id (else the open one); its name, from the sprint file, tags the tickets.
      const sprintName = sprintData.name;
      const fetchedAt = new Date().toISOString();
      const tickets = await adapters.jira.fetchSprintTickets({ ...board, ...(active['jira-sprint-id'] === undefined ? {} : { sprintId: active['jira-sprint-id'] }), ...(sprintName ? { sprintName } : {}) }, exec);
      const keys = tickets.map(t => t.key);
      jiraKeys.push(...keys);
      const mrs = await scan(keys);
      log(`sprint ${sprint}: ${tickets.length} tickets, ${mrs.filter(m => m.ticket).length} of their merge requests from ${repos.length} repositories`);
      await call(['ticket:sync', project, 'sprint'], { 'fetched-at': fetchedAt, tickets, 'merge-requests': mrs });
    }

    if (source) {
      const fetchedAt = new Date().toISOString();
      const backlog = await adapters.jira.fetchBacklogTickets(board, exec);
      jiraKeys.push(...backlog.map(t => t.key));
      log(`backlog: ${backlog.length} tickets`);
      await call(['ticket:sync', project, 'backlog'], { 'fetched-at': fetchedAt, tickets: backlog });
      await refetchMissing({ project, board, sprint, sprintName: sprintData.name, sprintData, backlogData: existsSync(join(projects, project, 'backlog.json')) ? read('backlog.json') : {}, fetched: jiraKeys, call, jira: adapters.jira, exec, log });
      const current = file => (existsSync(join(projects, project, file)) ? read(file) : {});   // as the syncs above left it
      await syncOutside({ project, board, tickets: [...(sprint === undefined ? [] : ['features', 'bugs', 'spikes'].flatMap(a => current(sprintFile)[a] ?? [])), ...(current('backlog.json').tickets ?? [])], recorded: current('outside-tickets.json').tickets ?? [], call, jira: adapters.jira, exec, log });
    }

    // 4. The off-board tickets (src/off-board, the harness's own): at Backlog
    // to the backlog, any other status to the sprint — the same ticket:sync.
    if (offBoard && adapters.offBoard) {
      const fetchedAt = new Date().toISOString();
      const tickets = await adapters.offBoard.fetchTickets({ root, project }, exec);
      // A Done ticket joins no sprint it is not already in: one finished stays in its old sprint (ASS-142).
      const done = t => t['ticket-system-status'] === 'Done' && !recorded.has(t.key.toLowerCase());
      // But one closed straight from Backlog, still listed in backlog.json at another status, goes to the backlog sync
      // (ASS-296), which takes a ticket fetched Done (ASS-202), so its entry becomes Done; one Done there, or in neither file, is left out.
      const listed = new Map((existsSync(join(projects, project, 'backlog.json')) ? read('backlog.json') : {}).tickets?.map(t => [t.key.toLowerCase(), t['ticket-system-status']]) ?? []);
      const closed = tickets.filter(t => done(t) && listed.has(t.key.toLowerCase()) && listed.get(t.key.toLowerCase()) !== 'Done');
      const taken = tickets.filter(t => t['ticket-system-status'] !== 'Backlog' && !done(t)), waiting = tickets.filter(t => t['ticket-system-status'] === 'Backlog');
      log(`off-board: ${tickets.length} tickets, ${taken.length} in the sprint, ${waiting.length} in the backlog${tickets.some(done) ? `, ${tickets.filter(done).length} Done outside it` : ''}${closed.length ? `, ${closed.length} Done in the backlog` : ''}`);
      if (taken.length && sprint !== undefined) await call(['ticket:sync', project, 'sprint'], { 'fetched-at': fetchedAt, tickets: taken, 'merge-requests': await scan(taken.map(t => t.key)) });
      if (waiting.length || closed.length) await call(['ticket:sync', project, 'backlog'], { 'fetched-at': fetchedAt, tickets: [...waiting, ...closed] });
    }

    // 5. Comments: a ticket that fails is logged once, until it works again.
    if (comments && jiraKeys.length) {
      for (const key of jiraKeys) {
        try {
          await call(['ticket:sync-jira-comments', project, key], { comments: await adapters.jira.fetchComments({ key }, exec) });
          comments.delete(key);
        } catch (err) {
          if (!comments.has(key)) log(`${key}: comments skipped: ${String(err.message ?? err).split('\n')[0]}`);
          comments.add(key);
        }
      }
      log(`comments: ${jiraKeys.length} tickets`);
    }

    // 5b. Analytics (ASS-406): its own failures logged, never the cycle's.
    if (source && adapters.jiraRest) {
      await syncAnalytics({ key: join(projects, project), project, source, board, tickets: join(projects, project, 'analytics', 'tickets.json'), call, rest: adapters.jiraRest, fetchFn, log });
    }

    // 5b′. Off-board analytics (ASS-413): the off-board tickets' status histories and the project's own sprints.
    if (offBoard && adapters.offBoard?.fetchAnalyticsTickets) {
      await syncOffBoardAnalytics({ key: join(projects, project), root, projectDir: join(projects, project), project, hasJira: Boolean(source), call, offBoard: adapters.offBoard, run: exec, log });
    }

    // 5c. Analytics: every merged merge request (ASS-408).
    if (adapters.mergedMergeRequests) {
      const file = join(projects, project, 'analytics', 'merge-requests.json');
      let recorded = {};
      try { recorded = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) ?? {} : {}; } catch { /* unreadable: read every repository from the start */ }
      const readers = { gitlab: adapters.mergedMergeRequests.fetchMergedMergeRequests, github: adapters.mergedMergeRequests.fetchMergedPullRequests };
      await syncMergedMergeRequests({ key: join(projects, project), project, repositories: config.repositories ?? [], recorded, call, readers, run: exec, log });
    }

    // 5d. The team, from the analytics data (ASS-409).
    if (adapters.team && ['tickets.json', 'merge-requests.json'].some(f => existsSync(join(projects, project, 'analytics', f)))) {
      await adapters.team.updateTeam({ key: join(projects, project), project, call, log });
    }

    await call(['project:set-last-data-download', project, now.toISOString()]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// refetchMissing: step 3b (ASS-344).
async function refetchMissing({ project, board, sprint, sprintName, sprintData, backlogData, fetched, call, jira, exec, log }) {
  const lc = k => String(k ?? '').toLowerCase();
  const seen = new Set(fetched.map(lc));
  const own = new RegExp(`^${board.projectKey}-\\d+$`, 'i');
  const missing = t => t?.key && own.test(t.key) && !t['is-deleted'] && !seen.has(lc(t.key));
  const inSprint = sprint === undefined ? [] : ['features', 'bugs', 'spikes'].flatMap(a => sprintData[a] ?? []).filter(missing).map(t => t.key);
  const sprintKeys = new Set(inSprint.map(lc));
  const inBacklog = (backlogData.tickets ?? []).filter(t => missing(t) && t['ticket-system-status'] !== 'Done' && !sprintKeys.has(lc(t.key))).map(t => t.key);
  if (!inSprint.length && !inBacklog.length) return;
  const fetchedAt = new Date().toISOString();
  let tickets;
  try {
    tickets = await jira.fetchTicketsByKey({ site: board.site, storyPointsField: board.storyPointsField, keys: [...inSprint, ...inBacklog] }, exec);
  } catch (err) {
    return log(`by key: ${inSprint.length + inBacklog.length} tickets not in the searches could not be read: ${String(err.message ?? err).split('\n')[0]}`);
  }
  const toSprint = tickets.filter(t => sprintKeys.has(lc(t.key))).map(t => ({ ...t, 'sprint-tag': t['sprint-tag'] ?? sprintName ?? null }));
  const toBacklog = tickets.filter(t => !sprintKeys.has(lc(t.key)));
  const unread = inSprint.length + inBacklog.length - toSprint.length - toBacklog.length;
  log(`by key: ${inSprint.length + inBacklog.length} tickets not in the searches, ${tickets.length} read${unread ? `, ${unread} left as they are` : ''}`);
  if (toSprint.length) await call(['ticket:sync', project, 'sprint'], { 'fetched-at': fetchedAt, tickets: toSprint, 'merge-requests': [] });
  if (toBacklog.length) await call(['ticket:sync', project, 'backlog'], { 'fetched-at': fetchedAt, tickets: toBacklog });
}

// syncOutside: step 3c (ASS-355).
async function syncOutside({ project, board, tickets, recorded, call, jira, exec, log }) {
  const up = k => String(k ?? '').toUpperCase();
  const live = tickets.filter(t => t?.key && t['is-deleted'] !== true);
  const held = new Set(live.map(t => up(t.key)));
  const keys = [...new Set(live.flatMap(t => t.dependencies ?? []).map(up))].filter(k => k && !held.has(k));
  const fetchedAt = new Date().toISOString();
  if (!keys.length) {
    if (recorded.length) await call(['ticket:sync-outside', project], { 'fetched-at': fetchedAt, keys: [], tickets: [] });
    return;
  }
  let read;
  try {
    read = await jira.fetchTicketsByKey({ site: board.site, storyPointsField: board.storyPointsField, keys, views: false }, exec);
  } catch (err) {
    return log(`outside dependencies: ${keys.length} could not be read: ${String(err.message ?? err).split('\n')[0]}`);
  }
  log(`outside dependencies: ${keys.length} depended on, ${read.length} read`);
  const fields = t => ({ key: t.key, title: t.title ?? '', url: t.url ?? null, 'ticket-system-status': t['ticket-system-status'] ?? null, 'ticket-system-assignment': t['ticket-system-assignment'] ?? null });
  await call(['ticket:sync-outside', project], { 'fetched-at': fetchedAt, keys, tickets: read.map(fields) });
}

// How far before the last analytics read's fetched-through the next one
// starts (ASS-406), so a ticket updated while that read was under way, or
// stamped by a Jira clock a little behind this one, is not missed.
export const ANALYTICS_OVERLAP_MS = 5 * 60_000;

// The last thing syncAnalytics logged that stays until it changes, by
// projects folder and project, and by part (credentials, tickets, sprints).
const analyticsNotes = new Map();

// syncAnalytics: step 5b (ASS-406).
async function syncAnalytics({ key, project, source, board, tickets, call, rest, fetchFn, log }) {
  const note = (part, text) => {
    const at = `${key}\0${part}`;
    if (text === null) return void analyticsNotes.delete(at);
    if (analyticsNotes.get(at) !== text) log(text);
    analyticsNotes.set(at, text);
  };
  const email = source['api-email'], token = source['api-token'];
  if (!email || !token) return note('credentials', 'analytics skipped: the jira work source has no api-email and api-token');
  note('credentials', null);
  const auth = { site: board.site, email, token };
  const reason = err => String(err?.message ?? err).split('\n')[0];

  let since = null;
  try {
    const through = Date.parse(JSON.parse(readFileSync(tickets, 'utf8'))['fetched-through']);
    if (!Number.isNaN(through)) since = new Date(through - ANALYTICS_OVERLAP_MS).toISOString();
  } catch { /* no tickets.json yet, or unreadable: the first read, all of them */ }
  try {
    const fetchedThrough = new Date().toISOString();
    const read = await rest.fetchAnalyticsTickets({ ...auth, projectKey: board.projectKey, storyPointsField: source['story-points-field'], sprintField: source['sprint-field'], since }, fetchFn);
    log(`analytics: ${read.length} tickets ${since ? `updated since ${since}` : 'read, all of them'}`);
    await call(['analytics:sync-tickets', project], { 'fetched-through': fetchedThrough, tickets: read });
    note('tickets', null);
  } catch (err) {
    note('tickets', `analytics: the tickets could not be read; tickets.json stays as it is: ${reason(err)}`);
  }
  try {
    const sprints = await rest.fetchBoardSprints({ ...auth, boardId: board.boardId }, fetchFn);
    await call(['analytics:sync-sprints', project], { sprints });
    note('sprints', null);
  } catch (err) {
    note('sprints', `analytics: the board's sprints could not be read; sprints.json stays as it is: ${reason(err)}`);
  }
}

// The last thing recordAccount logged, by projects folder and project: a
// failure logged once, until the answer changes.
const accountNotes = new Map();

// recordAccount: step 1's signed-in account id (ASS-344). An adapter without
// fetchSignedInAccountId (an older caller) records nothing.
async function recordAccount({ key, project, file, call, jira, exec, log }) {
  if (typeof jira.fetchSignedInAccountId !== 'function') return;
  const note = text => { if (accountNotes.get(key) !== text) log(text); accountNotes.set(key, text); };
  let id;
  try { id = await jira.fetchSignedInAccountId(exec); } catch (err) {
    return note(`the signed-in Jira account could not be read; ticket-system-account-id stays as it is: ${String(err.message ?? err).split('\n')[0]}`);
  }
  if (!id) return note('the signed-in Jira account could not be told; ticket-system-account-id stays as it is');
  accountNotes.delete(key);
  const recorded = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  if (recorded === id) return;
  log(`signed-in Jira account ${id}`);
  await call(['project:set-ticket-system-account-id', project, id]);
}

// The last thing followBoard logged that stays until the board changes, by
// projects folder and project: logged once, not every cycle.
const boardNotes = new Map();

// followBoard: step 1's Jira sprint check (ASS-165).
async function followBoard({ key, project, read, board, today, call, jira, exec, log }) {
  const active = read('sprints.json').list?.find(s => s['is-active']), pinned = active?.['jira-sprint-id'];
  if (pinned === undefined) return;
  const note = text => { if (boardNotes.get(key) !== text) log(text); boardNotes.set(key, text); };
  let open;
  try { open = await jira.fetchActiveSprints(board, exec); } catch (err) {
    return note(`the board's sprints could not be read; sprint ${active.number} stays on Jira sprint ${pinned}: ${String(err.message ?? err).split('\n')[0]}`);
  }
  const advance = async s => {
    const out = (await call(['sprint:advance', project, today, '--jira-sprint', String(s.id), s.name, ...(s.start && s.end ? [s.start, s.end] : [])]))?.trim();
    if (out) log(out);
  };
  const current = open.find(s => String(s.id) === String(pinned));
  if (current) {
    boardNotes.delete(key);
    const file = read(join('sprints', `sprint-${active.number}`, 'sprint.json'));
    if (current.start && current.end && (file.start !== current.start || file.end !== current.end)) await advance(current);
    return;
  }
  if (!open.length) return note(`no active sprint on the board; sprint ${active.number} stays on Jira sprint ${pinned}`);
  boardNotes.delete(key);
  const [next] = open;
  log(`the board's active sprint is ${next.name} (${next.id}), not ${pinned}`);
  await advance(next);
}

// The UTC date of a moment, YYYY-MM-DD (ASS-294: every day the harness
// counts is a UTC day — the end-of-day snapshot's, sprint advance's today, the
// sprint box's day and Day Spend — so they agree with each other and with the
// UTC clock the dashboard shows; was localDate, this computer's day, ASS-216).
// Null for an invalid moment, which is then on no day, rather than throwing.
export function utcDate(d) {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
