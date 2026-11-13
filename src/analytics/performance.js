// Each developer's performance over a time span (ASS-410), worked out from the
// analytics data: analytics/tickets.json and sprints.json (ASS-406),
// analytics/merge-requests.json (ASS-408) and team.json (ASS-409). Every value
// carries the figures it was worked out from, so the P screen (ASS-411) can
// show them and anyone can check the sum.
//
// A ticket-system status means only what the engine steps paired with it
// (`paired-ticket-system-status`) say: no status name is ever compared here.
// Pure: the caller reads the files and passes them in, with "now".

const RANK = { planning: 0, 'in-progress': 1, qa: 2, done: 3 };
const DAY = 24 * 60 * 60 * 1000;
const DASH = '–';

// The P screen's columns in order: each cell key and its heading.
export const COLUMNS = [
  { key: 'ticketsPerDay', title: 'Tickets/day' },
  { key: 'pointsPerDay', title: 'Pts/day' },
  { key: 'mrsPerDay', title: 'MRs/day' },
  { key: 'firstPass', title: 'First pass' },
  { key: 'devTime', title: 'Dev time' },
  { key: 'testTime', title: 'Test time' },
  { key: 'inProgressNow', title: 'In progress now' },
  { key: 'mainLayer', title: 'Main layer' },
];

// statusCategories(engines) — { [status]: 'planning' | 'in-progress' | 'qa' |
// 'done' } from the project's engines, each a state-engine.json (or just its
// steps array) (ASS-410 AC1). A step paired with a status makes it done
// (is-done), qa (is-qa), planning (is-planning-stage) or in-progress (any other
// step). A step in the quarantine area (blocked, self-healing) is ignored, so a
// status paired only with such steps has no category. A status paired with
// steps of several categories takes the most advanced: planning < in-progress
// < qa < done.
export function statusCategories(engines) {
  const categories = {};
  for (const engine of engines ?? []) {
    for (const step of (Array.isArray(engine) ? engine : engine?.steps) ?? []) {
      const status = step['paired-ticket-system-status'];
      if (!status || step.area === 'quarantine') continue;
      const category = step['is-done'] ? 'done' : step['is-qa'] ? 'qa' : step['is-planning-stage'] ? 'planning' : 'in-progress';
      if (!(status in categories) || RANK[category] > RANK[categories[status]]) categories[status] = category;
    }
  }
  return categories;
}

// dateIn(moment, timeZone) — the calendar date (YYYY-MM-DD) of a moment (ISO
// string, Date or ms) in the time zone.
export function dateIn(moment, timeZone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(moment)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const dayNumber = date => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY;

// activeSprint(sprints) — the board's active sprint (the latest started when
// several are), or null.
export function activeSprint(sprints) {
  const active = (sprints?.sprints ?? []).filter(s => s.state === 'active');
  return active.sort((a, b) => Date.parse(b.start ?? 0) - Date.parse(a.start ?? 0))[0] ?? null;
}

// workOutSpan({ start, end }, sprints, now, timeZone) — { start, end, days,
// label, sprint } (ASS-410 AC2). start and end are dates (YYYY-MM-DD), both in
// the span; days is the calendar days in it, weekends included. Without a start
// and end, the board's active sprint from its start date to today, or to its
// end when that is earlier. The sprint's start date is its UTC date, the date
// Jira shows for it (as the prototype did); today and its end are dates in
// `timeZone`. With no active sprint, the span is today alone.
export function workOutSpan(given, sprints, now, timeZone = 'UTC') {
  const today = dateIn(now, timeZone);
  const sprint = activeSprint(sprints);
  if (given?.start && given?.end) {
    const { start, end } = given;
    return { start, end, days: Math.max(0, dayNumber(end) - dayNumber(start) + 1), label: `${start} → ${end}`, sprint: null };
  }
  if (!sprint?.start) return { start: today, end: today, days: 1, label: `${today} → ${today}`, sprint: null };
  const start = dateIn(sprint.start, 'UTC');
  const ends = sprint.end ? dateIn(sprint.end, timeZone) : today;
  const end = ends < today ? ends : today;
  return {
    start, end, days: Math.max(0, dayNumber(end) - dayNumber(start) + 1),
    label: `${sprint.name}: ${start} → ${end}`, sprint: { id: sprint.id, name: sprint.name },
  };
}

// Formatting. A number shows at most two decimals, trailing zeros dropped
// (10, 0.5, 0.71); a time in days one decimal and " d".
export const formatNumber = n => String(Math.round(n * 100) / 100);
const formatDays = d => `${d.toFixed(1)} d`;
const percent = (n, of) => `${Math.round(100 * n / of)}%`;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// A cell: value, the display line (the "–" of AC5 when there is nothing to
// divide by); number, the raw figure behind it (null with "–") for sorting;
// more, further value lines (only Main layer's top repositories); variables,
// the [label, value] pairs it was worked out from, each value display-ready.
const cell = (value, number, variables, more = []) => ({ value, number, more, variables });

// cellLines(cell) — the cell as the screen shows it: its value line(s), then
// "label: value" for each variable.
export function cellLines(c) {
  return [c.value, ...c.more, ...c.variables.map(([label, value]) => `${label}: ${value}`)];
}

const rate = (n, days, variables) => cell(days ? formatNumber(n / days) : DASH, days ? n / days : null, variables);
const timeCell = xs => xs.length
  ? cell(formatDays(median(xs)), median(xs), [['tickets', xs.length], ['range', `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)} d`]])
  : cell(DASH, null, [['tickets', 0], ['range', DASH]]);

// The last path segment of a repository (group/sub/app → app), as the screen
// names it.
const repoName = repo => String(repo).split('/').filter(Boolean).pop() ?? String(repo);

// assigneeBefore(ticket, at) — the ticket's assignee ({ id, name } or null) just
// before the moment `at` (ms): the assignee before its first assignee change,
// then each change made before `at` (ASS-410 AC3). team.js credits a ticket's
// developer the same way (ASS-409).
export function assigneeBefore(ticket, at) {
  const changes = ticket['assignee-changes'] ?? [];
  let who = changes.length ? changes[0].from : ticket.assignee;
  for (const change of changes) if (Date.parse(change.at) < at) who = change.to;
  return who ?? null;
}

// ticketFacts(ticket, categories) — the moments (ms) of its first change into a
// done status, its first change into a QA status at or before that, and its
// first change into an in-progress status before that; and whether it went
// back to a planning or in-progress status between that QA change and done.
export function ticketFacts(ticket, categories) {
  const changes = (ticket['status-changes'] ?? []).map(c => ({ at: Date.parse(c.at), category: categories[c.to] }))
    .sort((a, b) => a.at - b.at);
  const done = changes.find(c => c.category === 'done')?.at ?? null;
  if (done == null) return { done: null, qa: null, inProgress: null, sentBack: false };
  const qa = changes.find(c => c.category === 'qa' && c.at <= done)?.at ?? null;
  const inProgress = qa == null ? null : changes.find(c => c.category === 'in-progress' && c.at < qa)?.at ?? null;
  const sentBack = qa != null && changes.some(c => c.at > qa && c.at <= done && (c.category === 'planning' || c.category === 'in-progress'));
  return { done, qa, inProgress, sentBack };
}

const memberName = m => m['ticket-system-name'] ?? m['git-name'] ?? m['git-username'] ?? m['ticket-system-id'] ?? '?';

// performance({ tickets, sprints, mergeRequests, team, engines, span, now,
// timeZone, includeIdle }) — each developer's performance over the span.
//   tickets        analytics/tickets.json, parsed ({ tickets: { KEY: … } })
//   sprints        analytics/sprints.json, parsed ({ sprints: [ … ] })
//   mergeRequests  analytics/merge-requests.json, parsed ({ 'merge-requests': { … } })
//   team           team.json, parsed ({ members: [ … ] })
//   engines        the project's state engines (state-engine.json objects or their steps arrays)
//   span           { start, end } dates (YYYY-MM-DD), optional: the active sprint by default
//   now            the current moment (Date, ms or ISO)
//   timeZone       the zone whose calendar days make the span (default UTC)
//   includeIdle    also give a row to developers with nothing in the span or now
// Returns { span: { start, end, days, label, sprint }, categories, rows: [ {
// member: { id, name, gitUsername }, cells: { ticketsPerDay, pointsPerDay,
// mrsPerDay, firstPass, devTime, testTime, inProgressNow, mainLayer } } ],
// newMembers: [ { name, role, firstSeen } ], unknownAuthors: [ { username,
// name, mrs } ] }. Rows are team members with role developer (AC3), those with
// tickets done, merge requests merged or work in progress now unless
// includeIdle, most tickets done first, then by name.
export function performance({ tickets, sprints, mergeRequests, team, engines, span: given, now = Date.now(), timeZone = 'UTC', includeIdle = false }) {
  const categories = statusCategories(engines);
  const span = workOutSpan(given, sprints, now, timeZone);
  const inSpan = moment => { const d = dateIn(moment, timeZone); return d >= span.start && d <= span.end; };
  const members = team?.members ?? [];
  const developers = members.filter(m => m.role === 'developer');
  const byTicketId = new Map(developers.filter(m => m['ticket-system-id']).map(m => [m['ticket-system-id'], m]));
  const byGitUsername = new Map(developers.filter(m => m['git-username']).map(m => [m['git-username'], m]));
  const known = new Set(members.map(m => m['git-username']).filter(Boolean));

  const tallies = new Map(developers.map(m => [m, {
    done: 0, points: 0, unpointed: 0, viaQa: 0, firstPass: 0, dev: [], test: [], planning: 0, inProgress: 0, repos: new Map(),
  }]));

  const sprintId = activeSprint(sprints)?.id;
  for (const ticket of Object.values(tickets?.tickets ?? {})) {
    // In progress now: the active sprint's tickets, by current assignee.
    const current = categories[ticket.status];
    const holder = byTicketId.get(ticket.assignee?.id);
    if (holder && sprintId != null && (ticket.sprints ?? []).includes(sprintId)) {
      if (current === 'planning') tallies.get(holder).planning++;
      if (current === 'in-progress') tallies.get(holder).inProgress++;
    }
    // Moved to Done in the span, credited to its developer.
    const facts = ticketFacts(ticket, categories);
    if (facts.done == null || !inSpan(facts.done)) continue;
    const developer = byTicketId.get(assigneeBefore(ticket, facts.qa ?? facts.done)?.id);
    if (!developer) continue;
    const t = tallies.get(developer);
    t.done++;
    if (typeof ticket.points === 'number') t.points += ticket.points; else t.unpointed++;
    if (facts.qa == null) continue;
    t.viaQa++;
    if (!facts.sentBack) t.firstPass++;
    if (facts.inProgress != null) t.dev.push((facts.qa - facts.inProgress) / DAY);
    t.test.push((facts.done - facts.qa) / DAY);
  }

  const unknown = new Map();
  for (const mr of Object.values(mergeRequests?.['merge-requests'] ?? {})) {
    if (!mr['merged-at'] || !inSpan(mr['merged-at'])) continue;
    const username = mr.author?.username;
    if (!known.has(username)) {
      const entry = unknown.get(username) ?? { username, name: mr.author?.name ?? null, mrs: 0 };
      entry.mrs++;
      unknown.set(username, entry);
    }
    const developer = byGitUsername.get(username);
    if (!developer) continue;
    const repos = tallies.get(developer).repos;
    repos.set(mr.repo, (repos.get(mr.repo) ?? 0) + 1);
  }

  const { days } = span;
  const rows = [...tallies].map(([m, t]) => {
    const mrs = [...t.repos.values()].reduce((a, b) => a + b, 0);
    const top = [...t.repos].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 5)
      .map(([repo, n]) => `${repoName(repo)} ${percent(n, mrs)} (${n})`);
    return {
      member: { id: m['ticket-system-id'] ?? null, name: memberName(m), gitUsername: m['git-username'] ?? null },
      idle: !t.done && !mrs && !(t.planning + t.inProgress),
      done: t.done,
      cells: {
        ticketsPerDay: rate(t.done, days, [['tickets', t.done], ['days', days]]),
        pointsPerDay: rate(t.points, days, [['points', formatNumber(t.points)], ['days', days], ['unpointed', t.unpointed]]),
        mrsPerDay: rate(mrs, days, [['MRs', mrs], ['days', days]]),
        firstPass: t.viaQa
          ? cell(percent(t.firstPass, t.viaQa), t.firstPass / t.viaQa, [['first pass', t.firstPass], ['done via QA', t.viaQa]])
          : cell(DASH, null, [['first pass', t.firstPass], ['done via QA', 0]]),
        devTime: timeCell(t.dev),
        testTime: timeCell(t.test),
        inProgressNow: cell(String(t.planning + t.inProgress), t.planning + t.inProgress, [['planning', t.planning], ['in progress', t.inProgress]]),
        mainLayer: mrs ? cell(top[0], mrs, [['MRs', mrs]], top.slice(1)) : cell(DASH, null, [['MRs', 0]]),
      },
    };
  }).filter(r => includeIdle || !r.idle)
    .sort((a, b) => b.done - a.done || a.member.name.localeCompare(b.member.name))
    .map(({ member, cells }) => ({ member, cells }));

  // first-seen is a date; a full time is taken as its date in the zone.
  const seenOn = seen => /^\d{4}-\d{2}-\d{2}$/.test(seen) ? seen : dateIn(seen, timeZone);
  const newMembers = members.filter(m => m['first-seen'] && seenOn(m['first-seen']) >= span.start && seenOn(m['first-seen']) <= span.end)
    .map(m => ({ name: memberName(m), role: m.role ?? null, firstSeen: m['first-seen'] }));
  const unknownAuthors = [...unknown.values()].sort((a, b) => b.mrs - a.mrs || String(a.username).localeCompare(String(b.username)));

  return { span, categories, rows, newMembers, unknownAuthors };
}
