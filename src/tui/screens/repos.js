// The repos screen (r): the project's repositories (ASS-201: moved from app.js).
import { boxTable } from '../table.js';
import { link } from '../text.js';
import { below, headerLines, platform } from './frame.js';
import { NONE, cell, feedback, agentLines, projectAssignments, move, repoName } from './shared.js';

const REPO_HEADERS = ['Repository', 'Branch', 'Folder', 'Server', 'Dev Container', 'Needs Rebuilt', 'Container Server', 'Base Image', 'Health', 'Agents'];

// The repos screen's grid: its rows and the lines its body may take, all that
// is left under the header and above the legend with the platform boxes, or a
// blank line, over it. Repositories are as project.json has them now, whatever
// the day on show.
function repoLayout(state, { columns = 0, rows = Infinity }) {
  const bottom = below(state) + Math.max(1, platform(state, columns, 0).length);
  const free = rows - headerLines(state, columns, 0).length - bottom;
  return { rows: repoRows(state.projects[state.project]?.repositories ?? [], projectAssignments(state)), bodyHeight: free - 4 };
}

// One row per Active project.json repository: its name (the url's last segment)
// linked to its url, then its work-space and dev-container fields, its
// ai-feedback-short as Health, and the assignments whose repo is that name as Agents.
function repoRows(repositories, assignments) {
  return repositories.filter(r => r.status === 'Active').map(({ url, 'work-space': ws = {}, 'dev-container': dc = {}, 'ai-feedback-short': health }) => {
    const name = repoName(url);
    return [
      link(name, url),
      cell(ws.branch),
      cell(ws.folder),
      cell(ws['server-name']),
      cell(dc.status),
      dc['needs-rebuilt'] == null ? NONE : dc['needs-rebuilt'] ? 'yes' : 'no',
      cell(dc['server-name']),
      cell(dc['base-image']),
      feedback(health),
      agentLines(assignments.filter(a => a.repo === name)),
    ];
  });
}

export function view(state, size) {
  const repos = repoLayout(state, size);
  return boxTable(REPO_HEADERS, repos.rows.length ? repos.rows : [['No repositories']], {
    columns: size.columns, stretch: 0, height: repos.bodyHeight + 4, scroll: state.repoScroll,
    selected: state.focus === 'repos' && repos.rows.length ? state.repoSelected : undefined,
  });
}

// Its keys: ↑/↓ move the grid's selection.
export function onKey(state, key, size, { step, sideways }) {
  if (step && !sideways && state.focus === 'repos') {
    const [repoSelected, repoScroll] = move(repoLayout(state, size), state.repoSelected, state.repoScroll, step);
    return { ...state, repoSelected, repoScroll };
  }
}
