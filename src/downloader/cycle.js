// One downloader cycle for one project: keep the previous day's last sprint
// data, fetch the sprint's tickets and merge requests and the backlog's
// tickets (and, on a comment cycle, their Jira comments), and hand them to the
// agent-cli. It writes no JSON itself: every mutation is an agent.sh call
// (ticket:snapshot-day, ticket:sync, ticket:sync-jira-comments,
// project:set-last-data-download), so the file rules live in one place.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoardUrl } from './jira.js';
import { scanMergeRequests } from './merge-requests.js';
import { dataDir } from '../data-folder.js';

// runCycle({ root, project, now, adapters, exec, comments, lookups, dryRun, log }) — root is the
// repo root (agent.sh is under it and, unless PROJECTS_DIR says otherwise,
// data/projects/); now the time of this cycle; adapters { jira, gitlab, github,
// offBoard } the modules of this folder, or fakes; lookups, on a lookup cycle
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
// 2. Sprint: the active sprint's tickets (Jira) and the merge-request scan of
//    every Active repository (merge-requests.js: none when one cannot be read,
//    so every record is kept) — `ticket:sync <project> sprint <file>`. No
//    active sprint, no sprint sync.
// 3. Backlog: `ticket:sync <project> backlog <file>`.
// 4. The off-board tickets (adapters.offBoard, off-board.js), when the project
//    has an off-board work source: at Backlog to the backlog, the rest to the
//    sprint with their own scan, the same two calls — but a Done one not
//    already in the active sprint, left in an old one, to neither (ASS-142),
//    unless backlog.json lists it not yet Done: to the backlog (ASS-296).
// 5. Comments (ASS-37), on a comment cycle: for each Jira sprint and backlog
//    ticket, its comments (adapters.jira.fetchComments) — `ticket:sync-jira-
//    comments <project> <key> <file>`. One that fails keeps what it had and
//    the cycle goes on; it is logged only when it starts failing.
// 6. `project:set-last-data-download <project> <now>`.
// Each ticket list is stamped with when it was read ("fetched-at", the time
// just before the read): a status control sets on a sprint ticket while the
// merge requests are looked up is newer than the list, and ticket:sync keeps
// it (ASS-128).
// The Jira steps (2, 3, 5) only for a project with a jira work source; one with
// only an off-board source (the harness's own) syncs those tickets alone.
// Fails before anything runs when the project has neither.
export async function runCycle({ root, project, now = new Date(), adapters, exec, comments, lookups = false, dryRun = false, log = () => {} }) {
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
    const file = payload === undefined ? null : join(tmp, `${args[2]}.json`);
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
      const lastDate = localDate(new Date(last)), today = localDate(now);
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

    if (source) await followBoard({ key: join(projects, project), project, read: file => existsSync(join(projects, project, file)) ? read(file) : {}, board, today: localDate(now), call, jira: adapters.jira, exec, log });

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

    await call(['project:set-last-data-download', project, now.toISOString()]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

// The date of a moment in this computer's time zone, YYYY-MM-DD.
export function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
