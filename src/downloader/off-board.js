// The off-board adapter: the tickets of a project's off-board work source
// (src/off-board/<folder>/*.md, see off-board.sh ticket:list), in the ticket
// shape ticket:sync takes. The harness is their ticket system: the file's
// status is the ticket-system-status, its priority (ticket:update-priority)
// the ticket-system-priority, its points (ticket:update-points) the points,
// its file (file://) the url — src/off-board is gitignored, so no forge has
// it (ASS-86); there is no assignee. A fast-tracked one (ASS-83) keeps its
// fast-track: true.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// fetchTickets({ root, project }, run) → the project's off-board tickets, one
// `run(<root>/off-board.sh, ['ticket:list', project])`. Its "depends-on"
// (ticket:set-dependencies, ASS-194) becomes the dependencies, and its
// "overlaps-with" (ticket:set-overlaps, ASS-196) becomes the overlaps.
export async function fetchTickets({ root, project }, run) {
  const out = await run(join(root, 'off-board.sh'), ['ticket:list', project]);
  let list;
  try { list = JSON.parse(out); } catch { throw new Error(`off-board.sh printed no JSON: ${out.slice(0, 200)}`); }
  if (!Array.isArray(list)) throw new Error(`off-board.sh printed no list: ${out.slice(0, 200)}`);
  return list.map(t => ({
    key: t.key, title: t.title ?? '', description: t.description ?? '', url: t.file ? pathToFileURL(t.file).href : null,
    'ticket-system-status': t.status ?? null, 'ticket-system-priority': t.priority ?? null, 'ticket-system-assignment': null,
    points: t.points ?? null, 'issue-type': t.type ?? 'Story', dependencies: t['depends-on'] ?? [], overlaps: t['overlaps-with'] ?? [], 'sprint-tag': null,
    ...(t['fast-track'] === true ? { 'fast-track': true } : {}),
  }));
}

// fetchAnalyticsTickets({ root, project }, run) → the project's off-board
// tickets with their status histories (ASS-413), for the analytics step:
// [{ key, title, type, created, points, status, "status-changes": [{ at, from,
// to[, backfilled] }] }]. Two runs of <root>/off-board.sh: ticket:list and
// ticket:history (which backfills a ticket that has no history file yet). A
// ticket the history does not name has its changes empty.
export async function fetchAnalyticsTickets({ root, project }, run) {
  const list = parseList(await run(join(root, 'off-board.sh'), ['ticket:list', project]));
  const histories = new Map(parseList(await run(join(root, 'off-board.sh'), ['ticket:history', project]))
    .map(h => [String(h?.key ?? '').toUpperCase(), Array.isArray(h?.['status-changes']) ? h['status-changes'] : []]));
  return list.map(t => ({
    key: t.key, title: t.title ?? '', type: t.type ?? 'Story', created: t.created ?? null, points: t.points ?? null, status: t.status ?? null,
    'status-changes': histories.get(String(t.key).toUpperCase()) ?? [],
  }));
}

function parseList(out) {
  let list;
  try { list = JSON.parse(out); } catch { throw new Error(`off-board.sh printed no JSON: ${String(out).slice(0, 200)}`); }
  if (!Array.isArray(list)) throw new Error(`off-board.sh printed no list: ${String(out).slice(0, 200)}`);
  return list;
}
