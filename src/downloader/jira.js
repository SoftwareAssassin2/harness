// The Jira adapter: tickets of a sprint or the backlog, fetched with acli
// (Atlassian's CLI, signed in on this machine) and mapped to the sprint's
// ticket shape, minus the harness's fields; and a ticket's comments.
// `run(cmd, args)` runs a command and resolves to its stdout; the downloader
// passes execFile, tests a fake.
//
// acli invocation (verified live 2026-10-11, acli --json prints the REST
// search shape, an array of issues with key + fields):
//   acli jira workitem search --jql "<jql>" --fields <list> --paginate --json
// acli's search allows only a fixed field list — no sprint, issuelinks,
// custom (story-points) or date fields — so dependencies are empty unless a
// site's acli returns them, and the sprint tag comes from the sprint name the
// caller gives. Points (ASS-152): a ticket whose search result lacks the
// story-points field has it read on its own, one call a ticket, in turn
// (verified live 2026-10-26, a site whose field is customfield_10024):
//   acli jira workitem view <KEY> --fields <field> --json
// A view that fails leaves the ticket's points out (unread, not null), so
// ticket:sync keeps the points the harness has. The same per-ticket view also
// reads issuelinks (one call, both fields), so a ticket's "is blocked by"
// dependencies — which acli's search never returns — come from it too; a view
// that fails (throws, or prints no JSON) leaves both out, unread (ASS-322).
// (Open: acli's `view --fields a,b` multi-field list and its --json issuelinks
// shape are verified for search/single-field, not for this combined view.)

const FIELDS = ['key', 'summary', 'description', 'status', 'priority', 'assignee', 'issuetype'];
const DEFAULT_STORY_POINTS_FIELD = 'customfield_10016';
const NO_SUBTASKS = 'issuetype not in subTaskIssueTypes()';
// Only the tickets assigned to whoever acli is signed in as: the board shows
// one person's work, and the agents take only that.
const MINE = 'assignee = currentUser()';
const TYPES = { Story: 'Story', Bug: 'Bug', Spike: 'Spike' };

// parseBoardUrl(url) → { site, projectKey, boardId } from a board url such as
// https://<site>/jira/software/c/projects/<KEY>/boards/<id> (with or without
// the company-managed `c/`). Throws on anything else.
export function parseBoardUrl(url) {
  const m = /^(https?:\/\/[^/]+)\/jira\/software\/(?:c\/)?projects\/([A-Za-z][A-Za-z0-9_]*)\/boards\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!m) throw new Error(`not a Jira board url: ${url}`);
  return { site: m[1], projectKey: m[2], boardId: Number(m[3]) };
}

// fetchSprintTickets({ site, projectKey, sprintId?, sprintName?, storyPointsField? }, run)
// → the tickets assigned to the signed-in acli user (MINE; sub-tasks left
// out) of the Jira sprint with that id, or of the project's open sprint
// without one; each tagged with sprintName when
// acli gives no sprint. storyPointsField is the site's story-points custom
// field (default customfield_10016).
export function fetchSprintTickets({ site, projectKey, sprintId, sprintName, storyPointsField }, run) {
  const jql = sprintId === undefined ? `project = ${projectKey} AND ${MINE} AND sprint in openSprints() AND ${NO_SUBTASKS}` : `sprint = ${sprintId} AND ${MINE} AND ${NO_SUBTASKS}`;
  return search({ site, storyPointsField, sprintName, jql }, run);
}

// fetchBacklogTickets({ site, projectKey, storyPointsField? }, run) → the
// signed-in user's tickets not done and in no current sprint.
export function fetchBacklogTickets({ site, projectKey, storyPointsField }, run) {
  return search({ site, storyPointsField, jql: `project = ${projectKey} AND ${MINE} AND statusCategory != Done AND (sprint in futureSprints() OR sprint is EMPTY)` }, run);
}

// fetchComments({ key }, run) → the ticket's comments, every page (ASS-37):
// [{ id, author, created, updated, body }], the body plain text. acli's
// --json is taken to print the REST comment shape (id, author.displayName,
// body in ADF, created, updated), bare or wrapped in { comments }; a string
// author or body is taken as is, anything missing as null.
//   acli jira workitem comment list --key <KEY> --paginate --json
export async function fetchComments({ key }, run) {
  const out = await run('acli', ['jira', 'workitem', 'comment', 'list', '--key', key, '--paginate', '--json']);
  return listed(out, 'comments').map(c => ({
    id: String(c.id),
    author: typeof c.author === 'string' ? c.author : c.author?.displayName ?? null,
    created: c.created ?? null,
    updated: c.updated ?? null,
    body: text(c.body),
  }));
}

// fetchActiveSprints({ boardId }, run) → the board's active sprints, [{ id,
// name, start, end }], [] for none (ASS-165): start and end Jira's startDate
// and endDate as YYYY-MM-DD (their UTC date), null when it gives none. acli
// prints [{ id, name, state, startDate, endDate }] (verified live 2026-10-27):
//   acli jira board list-sprints --id <board> --state active --json
export async function fetchActiveSprints({ boardId }, run) {
  const out = await run('acli', ['jira', 'board', 'list-sprints', '--id', String(boardId), '--state', 'active', '--json']);
  const date = d => typeof d === 'string' && /^\d{4}-\d\d-\d\d/.test(d) ? d.slice(0, 10) : null;
  return listed(out, 'sprints').map(s => ({ id: s.id, name: s.name, start: date(s.startDate), end: date(s.endDate) }));
}

async function search({ site, storyPointsField = DEFAULT_STORY_POINTS_FIELD, sprintName = null, jql }, run) {
  const out = await run('acli', ['jira', 'workitem', 'search', '--jql', jql, '--fields', FIELDS.join(','), '--paginate', '--json']);
  const tickets = [];
  for (const issue of listed(out, 'issues')) {
    const t = ticket(issue, site, storyPointsField, sprintName);
    const f = issue.fields ?? {};
    const needPoints = f[storyPointsField] === undefined;
    const needLinks = f.issuelinks === undefined;
    if (needPoints || needLinks) {
      const fields = await viewFields(issue.key, storyPointsField, run);
      if (fields === undefined) {
        if (needPoints) delete t.points;
        if (needLinks) delete t.dependencies;
      } else {
        if (needPoints) t.points = typeof fields[storyPointsField] === 'number' ? fields[storyPointsField] : null;
        if (needLinks) t.dependencies = dependenciesOf(fields.issuelinks);
      }
    }
    tickets.push(t);
  }
  return tickets;
}

// viewFields(key, field, run) → the ticket's `fields` object as acli's view
// prints it (the REST shape, key + fields; or a list holding it), carrying the
// story-points field and issuelinks (one call). `{}` when the view prints a
// value without those fields; undefined when the view fails or prints no JSON,
// so the caller leaves the missing fields unread.
async function viewFields(key, field, run) {
  try {
    const values = jsonValues(await run('acli', ['jira', 'workitem', 'view', key, '--fields', `${field},issuelinks`, '--json']));
    if (values.length === 0) return undefined;   // empty / no JSON: unread, not {}
    const [data] = values;
    const issue = Array.isArray(data) ? data.find(i => i?.key === key) : data;
    return issue?.fields ?? {};
  } catch {
    return undefined;
  }
}

// dependenciesOf(links) → the keys an inward "is blocked by" link points at,
// from acli's REST issuelinks shape; outward "blocks" and other link types
// (e.g. "relates to") are not dependencies.
function dependenciesOf(links) {
  return (links ?? []).filter(l => l.inwardIssue && l.type?.inward === 'is blocked by').map(l => l.inwardIssue.key);
}

// The items in acli's output: an array, or { <field> }, or nothing at all.
// With --paginate acli prints one such value per page, back to back, and
// leaves raw control characters (newlines, tabs) inside strings (checked live
// 2026-10-14): every page's items, in order.
function listed(out, field) {
  if (out.trim() === '') return [];
  let pages;
  try { pages = jsonValues(out); } catch { throw new Error(`acli did not print JSON: ${out.slice(0, 200)}`); }
  return pages.flatMap(data => {
    const list = Array.isArray(data) ? data : data?.[field];
    if (!Array.isArray(list)) throw new Error(`acli printed no ${field}: ${out.slice(0, 200)}`);
    return list;
  });
}

// jsonValues(text) → the JSON values printed back to back in text, a control
// character inside a string escaped first. Throws on anything else.
function jsonValues(text) {
  const values = [];
  let start = -1, depth = 0, inString = false, escaped = false, value = '';
  for (const ch of text) {
    if (start < 0) { if (/\s/.test(ch)) continue; start = 0; }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      value += ch < ' ' ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch;
      continue;
    }
    value += ch;
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (depth === 0) { values.push(JSON.parse(value)); value = ''; start = -1; }
  }
  if (value.trim() !== '') values.push(JSON.parse(value));
  return values;
}

function ticket({ key, fields: f = {} }, site, storyPointsField, sprintName) {
  const sprint = Array.isArray(f.sprint) ? f.sprint[f.sprint.length - 1] : f.sprint;
  return {
    key,
    title: f.summary ?? '',
    description: text(f.description),
    url: `${site}/browse/${key}`,
    'ticket-system-status': f.status?.name ?? null,
    'ticket-system-priority': f.priority?.name ?? null,
    'ticket-system-assignment': f.assignee?.displayName ?? null,
    points: typeof f[storyPointsField] === 'number' ? f[storyPointsField] : null,
    'issue-type': TYPES[f.issuetype?.name] ?? 'Story',
    dependencies: dependenciesOf(f.issuelinks),
    'sprint-tag': sprint?.name ?? sprintName,
  };
}

// A description (or comment body) as plain text: a string as is; an Atlassian Document Format
// tree as its text nodes, one line per top-level block.
function text(description) {
  if (typeof description === 'string') return description;
  if (!description || typeof description !== 'object') return '';
  const nodes = node => node.type === 'text' ? [node.text ?? ''] : (node.content ?? []).flatMap(nodes);
  return (description.content ?? []).map(block => nodes(block).join('')).filter(line => line !== '').join('\n');
}
