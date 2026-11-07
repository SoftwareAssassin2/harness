// ticket:renumber-backlog's ranking (renumber-backlog.sh), in node to share
// control's rankBacklog rather than restate it in jq:
//
//   node renumber-backlog.js <project folder>
//
// prints { key: priority } (backlogPriorities) for the tickets of its
// backlog.json control ranks: not soft deleted, not Done, not in the active
// sprint (as src/control/state.js loads the backlog, via the shared
// isLiveBacklogEntry predicate, ASS-202).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { backlogPriorities, isLiveBacklogEntry } from '../../control/rank.js';

const dir = process.argv[2];
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const active = existsSync(join(dir, 'sprints.json')) ? read(join(dir, 'sprints.json')).list?.find(s => s['is-active']) : null;
const sprintFile = active ? join(dir, 'sprints', `sprint-${active.number}`, 'sprint.json') : null;
const sprint = sprintFile && existsSync(sprintFile) ? read(sprintFile) : {};
const inSprint = new Set(['features', 'bugs', 'spikes'].flatMap(list => sprint[list] ?? []).map(t => t.key.toUpperCase()));
const ranked = (read(join(dir, 'backlog.json')).tickets ?? []).filter(t => isLiveBacklogEntry(t, inSprint));
process.stdout.write(JSON.stringify(backlogPriorities(ranked)));
