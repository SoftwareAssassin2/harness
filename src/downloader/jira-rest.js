// The Jira REST reader for analytics (ASS-406): every ticket of a board's Jira
// project, whoever holds it, with its full changelog, and the board's sprints.
// acli (jira.js) returns only the signed-in user's tickets and never a
// ticket's history, so these read Jira's REST API directly, with basic auth
// from the jira work source's api-email and api-token. `fetchFn` is Node's
// global fetch in the downloader, a fake in tests.
//
// The calls (verified against a live site 2026-11):
//   GET /rest/api/3/search/jql?jql=…&fields=…&expand=changelog&maxResults=100[&nextPageToken=…]
//     → { issues: [{ key, fields, changelog: { total, histories } }], nextPageToken?, isLast }
//     paged until isLast or no nextPageToken.
//   GET /rest/api/3/issue/<key>/changelog?startAt=&maxResults=100
//     → { values: [history…], isLast } — for an issue whose search changelog
//     is truncated (changelog.total > histories.length).
//   GET /rest/agile/1.0/board/<id>/sprint?state=active,closed,future&startAt=&maxResults=50
//     → { values: [{ id, name, state, startDate, endDate }], isLast }
// A response that is not ok throws `HTTP <status> …` naming the path (never
// the credentials); a network failure throws as fetch does.

const NO_SUBTASKS = 'issuetype not in subTaskIssueTypes()';
const DEFAULT_STORY_POINTS_FIELD = 'customfield_10016';
const DEFAULT_SPRINT_FIELD = 'customfield_10020';
const PAGE = 100, SPRINT_PAGE = 50;

// get({ site, email, token }, path, params, fetchFn) → the parsed JSON body.
async function get({ site, email, token }, path, params, fetchFn) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const res = await fetchFn(`${site}${path}?${query}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${path}`);
  return res.json();
}

// fetchAnalyticsTickets({ site, projectKey, email, token, storyPointsField?,
// sprintField?, since?, now? }, fetchFn) → the project's tickets (sub-tasks
// left out), each mapped by analyticsTicket. With since (an ISO time) only
// those updated at or after it: JQL `updated >= "-<n>m"`, n the whole minutes
// from since to now (Date.now() unless given), rounded up — a time relative to
// Jira's own clock, so the Jira user's time zone, which an absolute JQL date
// is read in, cannot shift it. Without since, or an unreadable one, all.
export async function fetchAnalyticsTickets({ site, projectKey, email, token, storyPointsField, sprintField, since, now = Date.now() }, fetchFn) {
  const auth = { site, email, token };
  const points = storyPointsField || DEFAULT_STORY_POINTS_FIELD, sprints = sprintField || DEFAULT_SPRINT_FIELD;
  const from = since ? Date.parse(since) : NaN;
  const updated = Number.isNaN(from) ? '' : ` AND updated >= "-${Math.max(1, Math.ceil((now - from) / 60_000))}m"`;
  const jql = `project = "${projectKey}" AND ${NO_SUBTASKS}${updated} ORDER BY created ASC`;
  const fields = ['summary', 'status', 'assignee', 'issuetype', 'created', points, sprints].join(',');
  const issues = [];
  let nextPageToken;
  for (;;) {
    const page = await get(auth, '/rest/api/3/search/jql', { jql, fields, expand: 'changelog', maxResults: PAGE, nextPageToken }, fetchFn);
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || page.isLast) break;
  }
  // A changelog the search cut short is read whole, page by page.
  for (const issue of issues) {
    const log = issue.changelog ?? {};
    if ((log.total ?? 0) <= (log.histories ?? []).length) continue;
    const histories = [];
    for (let startAt = 0; ;) {
      const page = await get(auth, `/rest/api/3/issue/${encodeURIComponent(issue.key)}/changelog`, { startAt, maxResults: PAGE }, fetchFn);
      const values = page.values ?? [];
      histories.push(...values);
      startAt += values.length;
      if (done(page, values, startAt)) break;
    }
    issue.changelog = { ...log, histories };
  }
  return issues.map(i => analyticsTicket(i, points, sprints));
}

// fetchBoardSprints({ site, boardId, email, token }, fetchFn) → the board's
// sprints of every state, [{ id, name, state, start, end }], start and end ISO
// times (null when Jira gives none, a future sprint's), in start order (those
// without a start last, by id).
export async function fetchBoardSprints({ site, boardId, email, token }, fetchFn) {
  const sprints = [];
  for (let startAt = 0; ;) {
    const page = await get({ site, email, token }, `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`, { state: 'active,closed,future', startAt, maxResults: SPRINT_PAGE }, fetchFn);
    const values = page.values ?? [];
    sprints.push(...values.map(s => ({ id: s.id, name: s.name ?? '', state: s.state ?? null, start: iso(s.startDate), end: iso(s.endDate) })));
    startAt += values.length;
    if (done(page, values, startAt)) break;
  }
  return sprints.sort(byStart);
}

// done(page, values, read) — a startAt-paged list ends at isLast, an empty page, or (no isLast) its total read.
const done = (page, values, read) => page.isLast === true || !values.length || (page.isLast === undefined && typeof page.total === 'number' && read >= page.total);

const byStart = (a, b) => (a.start === null) - (b.start === null) || (a.start ?? '').localeCompare(b.start ?? '') || a.id - b.id;

// analyticsTicket(issue, storyPointsField, sprintField) → { key, title, type,
// created, points, assignee, status, sprints, status-changes,
// assignee-changes }: a person is { id (accountId), name (displayName) } or
// null; times are ISO (UTC); the changes come from the changelog's status and
// assignee items, in time order (ties in the changelog's own order).
export function analyticsTicket(issue, storyPointsField = DEFAULT_STORY_POINTS_FIELD, sprintField = DEFAULT_SPRINT_FIELD) {
  const f = issue.fields ?? {};
  const changes = (issue.changelog?.histories ?? [])
    .flatMap(h => (h.items ?? []).map(item => ({ at: iso(h.created), by: person(h.author), item })))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const is = (item, name) => item.fieldId === name || (item.fieldId === undefined && String(item.field ?? '').toLowerCase() === name);
  return {
    key: issue.key,
    title: f.summary ?? '',
    type: f.issuetype?.name ?? null,
    created: iso(f.created),
    points: typeof f[storyPointsField] === 'number' ? f[storyPointsField] : null,
    assignee: person(f.assignee),
    status: f.status?.name ?? null,
    sprints: (Array.isArray(f[sprintField]) ? f[sprintField] : []).map(s => (typeof s === 'object' && s !== null ? s.id : s)).filter(id => id !== undefined && id !== null),
    'status-changes': changes.filter(c => is(c.item, 'status')).map(c => ({ at: c.at, from: field(c.item, 'fromString'), to: field(c.item, 'toString'), by: c.by })),
    'assignee-changes': changes.filter(c => is(c.item, 'assignee')).map(c => ({ at: c.at, from: side(c.item, 'from'), to: side(c.item, 'to') })),
  };
}

// An item's own field, null when absent (an item's toString is Jira's field, never Object's method).
const field = (item, name) => (Object.hasOwn(item, name) ? item[name] ?? null : null);
// One side of an assignee item, { id, name } or null for unassigned.
const side = (item, from) => {
  const id = field(item, from), name = field(item, `${from}String`);
  return id || name ? { id, name } : null;
};

// A Jira user as { id, name }, or null for none.
function person(u) {
  return u && (u.accountId || u.displayName) ? { id: u.accountId ?? null, name: u.displayName ?? null } : null;
}

// A Jira time (e.g. 2026-11-01T10:00:00.000+0000) as an ISO UTC time; null for none or an unreadable one.
function iso(t) {
  if (typeof t !== 'string' || !t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
