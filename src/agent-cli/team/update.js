// team:update's working out (update.sh, ASS-409), in node to share
// src/analytics/team.js (and through it performance.js's reading of the
// engines) rather than restate it in jq:
//
//   node update.js < input.json
//
// Input, gathered by the .sh: { dir (data/projects/<project>), engineFiles
// (every state-engine.json the project runs), today (YYYY-MM-DD) }. Reads
// dir's team.json (missing: no members yet) and analytics/tickets.json and
// analytics/merge-requests.json (missing: nothing in them). Prints { team,
// changed, lines }: the team.json to write, whether it differs from the one
// read, and the log lines — one naming each member added, one for each git
// author linked to a ticket-system person, one when the earlier prototype's
// shape was rewritten. Fails, printing why on stderr, when team.json or an
// analytics file is there but not JSON, or team.json's members is not a list.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { updateTeam, memberName } from '../../analytics/team.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const read = (file, what) => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) {
    process.stderr.write(`team:update: ${what} is not JSON: ${err.message}\n`);
    process.exit(1);
  }
};
const team = read(join(input.dir, 'team.json'), 'team.json');
if (team !== null && !Array.isArray(team?.members)) {
  process.stderr.write('team:update: team.json is not { members: [ … ] }\n');
  process.exit(1);
}
const engines = (input.engineFiles ?? []).map(file => read(file, file)).filter(Boolean);
const result = updateTeam({
  team,
  tickets: read(join(input.dir, 'analytics', 'tickets.json'), 'analytics/tickets.json'),
  mergeRequests: read(join(input.dir, 'analytics', 'merge-requests.json'), 'analytics/merge-requests.json'),
  engines,
  today: input.today,
});

const git = m => (m['git-username'] ? `, git ${m['git-username']}` : '');
const lines = [
  ...(result.migrated ? ['team: team.json rewritten from the earlier jira-/gitlab- field names'] : []),
  ...result.added.map(m => `team: added ${memberName(m)} (${m.role}${git(m)}${m['matched-by'] ? `, linked by ${m['matched-by']}` : ''})`),
  ...result.linked.map(m => `team: linked git ${m['git-username']} to ${memberName(m)} by ${m['matched-by']}`),
];
process.stdout.write(JSON.stringify({ team: result.team, changed: JSON.stringify(result.team) !== JSON.stringify(team), lines }));
