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
