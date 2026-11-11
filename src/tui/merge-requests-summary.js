// The open MRs screen's summary (ASS-366): the sprint's open merge requests,
// grouped by ticket, written as plain text to paste to teammates while they
// wait for approvals. From each ticket's recorded merge-request rows alone —
// no forge call. Plain text, paste-ready, every url written out in full; each
// ticket key linked to its ticket's url only for display, as on the updates
// screen (ASS-332). Pure; screens/open-mrs.js owns the screen. Since ASS-367
// only the merge requests ready for approval (isReady), each with how long it
// has waited.

import { link } from './text.js';
import { mrStatus } from './status.js';
import { repoName } from './screens/sprint.js';
import { timestamp } from './screens/shared.js';

// inPlay(t) — a ticket's variation in play: its first one not set aside (soft-deleted), or undefined.
export const inPlay = t => (t.variations ?? []).find(v => v['is-deleted'] !== true);

// An open merge request (ASS-366): status Open — one recorded before ASS-80,
// with none, is Open (mrStatus) — and a key, so opened on the forge; not one
// Merged, Closed or Not Created.
const isOpen = m => m?.key != null && mrStatus(m) === 'Open';
// Ready for approval (ASS-367): open and waiting on approvals alone, as
// merge-request:check records it in approval-wait-since (ASS-351) — set the
// first time it sees the row Open, set to auto-merge, with nothing for an agent
// to act on, cleared once not. Drafts, ones with feedback being acted on and
// ones not yet set to auto-merge have none. No step decides this.
const isReady = m => isOpen(m) && m['approval-wait-since'] != null;
const named = m => [repoName(m.repository), m.key].filter(Boolean).join(' ');

// openMergeRequests(tickets) — [{ key, url, title, mrs: [{ name, url, after, since }] }]
// (ASS-366): `tickets`, in the sprint's ticket order, each { key, title, url,
// variation } with the variation in play (inPlay; screens/open-mrs.js reads
// them from sprintTickets). Each ticket's merge requests ready for approval
// (isReady, ASS-367; was every open one, isOpen), in
// depends-on order — each placed once every open one of the ticket's it
// depends on is, in list order among those ready, a cycle's rest at the end;
// `name` "<repo> <key>" (repo the repository url's last path segment, as
// ASS-363's AWAITING MERGE line names it), `after` the names of the ticket's
// listed ones it depends on, in that order (one not ready is left unnamed,
// ASS-367), `since` its approval-wait-since. A ticket with none is left out.
export function openMergeRequests(tickets) {
  return tickets.flatMap(t => {
    const open = (t.variation?.['merge-request'] ?? []).filter(isReady);
    const byId = new Map();
    for (const m of open) if (m.id != null && !byId.has(m.id)) byId.set(m.id, m);
    const deps = m => [...new Set((m['depends-on'] ?? []).map(id => byId.get(id)).filter(d => d && d !== m))];
    const ordered = [];
    for (let rest = open; rest.length;) {
      const next = rest.find(m => deps(m).every(d => ordered.includes(d))) ?? rest[0];
      ordered.push(next);
      rest = rest.filter(m => m !== next);
    }
    const mrs = ordered.map(m => ({
      name: named(m), url: m.url ?? null,
      after: ordered.filter(d => deps(m).includes(d)).map(named),
      since: m['approval-wait-since'],
    }));
    return mrs.length ? [{ key: t.key, url: t.url ?? null, title: t.title ?? '', mrs }] : [];
  });
}

// openMergeRequestLines(groups, now) — the text as lines (ASS-366): a header
// counting the merge requests and giving `now`'s UTC date, a blank line, then
// each ticket's "<KEY>: <title>" over its merge requests ("  - <repo> <key>
// <url>  (after <repo> <key>, …)  waiting since <time>"), the time as the
// dashboard writes it (timestamp), a blank line between tickets; "No merge
// requests ready for approval." with none (ASS-367: the header and that read
// "ready for approval", each line ends with its wait). Never wrapped, so a url copies whole; the key
// linked to its ticket's url (display only: it copies as plain text) when
// `linked` and the ticket has one. No colour or icon.
export function openMergeRequestLines(groups, now, { linked = true } = {}) {
  const count = groups.reduce((n, g) => n + g.mrs.length, 0);
  if (!count) return ['No merge requests ready for approval.'];
  const date = new Date(now).toISOString().slice(0, 10);
  return [
    `Merge requests ready for approval (${count}), ${date}`,
    ...groups.flatMap(({ key, url, title, mrs }) => [
      '',
      `${linked && url ? link(key, url) : key}: ${title}`,
      ...mrs.map(m => `  - ${[m.name, m.url].filter(Boolean).join('  ')}${m.after.length ? `  (after ${m.after.join(', ')})` : ''}  waiting since ${timestamp(new Date(m.since))}`),
    ]),
  ];
}

// openMergeRequestText(groups, now) — the text as it is copied: the lines, plain, joined.
export const openMergeRequestText = (groups, now) => openMergeRequestLines(groups, now, { linked: false }).join('\n');
