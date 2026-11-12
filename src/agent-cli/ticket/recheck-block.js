// ticket:recheck-block's choice (recheck-block.sh, ASS-390 AC4), in node to
// read the engines as control does (src/control/engine.js stepOf):
//
//   node recheck-block.js < input.json
//
// Input, gathered by the .sh: { project, ticket, variation (the variation's
// JSON), engine (the project's execution engine's name), engineFiles (every
// state-engine.json the project sees, engines/'s first, its own after) }.
//
// Prints { at, engine, step, command, argv } — the check to re-run: the step
// the variation was at when it was blocked, "/"-joined from the top level down
// as facts.js cameFrom says it ("build/automated-testing"), found from its
// latest top-level entry into a quarantine step (sequence 0: Blocked, Blocked
// for Human, a detour) from a step that is not one, so a stay that went
// through Blocked for Human and back (Have AI Try Again) still finds the step
// that failed. Beneath that step, the deepest change recorded within it
// before the entry: when that change ended its sub-engine's run (a done step:
// grouped-build's blocked, after max-visits) the step it left is the one that
// failed. Its command is that step's own, its placeholders filled as control
// fills a ticket step's (facts.js ticketValues: {project}, {ticket},
// {work-item}, {variation}). Or { at, why } when there is nothing to re-run:
// no such entry, an unknown engine or step, a step that is no script (an
// agent's: only Troubleshoot can tell), a command that names another
// placeholder (a run's own value, unknown here), one not run through
// ./agent.sh, or one that changes something outside the ticket when run
// (OUTWARD: a merge, a restart, a VM made, a merge request opened or marked)
// — re-running it is no check. Never fails: unreadable input is a why.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The commands whose run changes something beyond re-checking (merges, restarts, VMs, forge writes): never re-run as a check.
const OUTWARD = new Set(['merge-request:merge', 'merge-request:merge-in-turn', 'merge-request:ensure-auto-merge', 'merge-request:create', 'merge-request:create-fix', 'code:take-out-of-draft-mode',
  'code:update-workspace', 'harness:request-restart', 'vm:create', 'vm:mark-setup-complete', 'ticket:fast-track']);
const FILLED = ['project', 'ticket', 'work-item', 'variation'];

// engines(files) — { [name]: its JSON }, each file's folder its name, a later file over an earlier one.
function engines(files = []) {
  const all = {};
  for (const file of files) try { all[basename(dirname(file))] = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable: left out */ }
  return all;
}
const stepOf = (engine, id) => (engine?.steps ?? []).find(s => s.id === id);
const quarantine = (engine, id) => { const s = stepOf(engine, id); return s != null && (s.sequence === 0 || s['is-blocked-state'] === true || s['follow-return-to-state'] === true); };

export function recheckBlock({ project, ticket, variation = {}, engine: name, engineFiles = [] } = {}) {
  const all = engines(engineFiles), top = all[name];
  if (!top) return { at: null, why: `the project's engine ${name || '(none)'} could not be read` };
  const changes = variation['state-changes'] ?? [];
  const i = changes.findLastIndex(c => !c['sub-state-change'] && quarantine(top, c['to-state']) && c['from-state'] != null && !quarantine(top, c['from-state']));
  if (i < 0) return { at: null, why: 'its state changes do not say which step it was blocked at' };
  const from = changes[i]['from-state'];
  const levels = [{ engine: name, id: from }];
  const within = changes.slice(0, i).findLast(c => c['sub-state-change'] && c['to-state'] === from);
  for (let s = within?.['sub-state-change']; s; s = s['sub-state-change']) levels.push({ engine: s['state-engine'], id: s['to-state'], from: s['from-state'] });
  const last = levels.at(-1);
  // A change that ended the sub-engine's run (its done step): the step it left is the one that failed.
  if (levels.length > 1 && stepOf(all[last.engine], last.id)?.['is-done'] === true && last.from) last.id = last.from;
  const at = levels.map(l => l.id).join('/');
  const step = stepOf(all[last.engine], last.id);
  if (!step) return { at, why: `${last.id} is no step of ${last.engine ?? 'its engine'}` };
  if (step.action?.type !== 'script') return { at, why: `${at} is no script step (its action is ${step.action?.type ?? 'none'}): there is no check to re-run` };
  const command = String(step.action.command ?? '').trim(), words = command.split(/\s+/);
  const other = [...command.matchAll(/\{([\w-]+)\}/g)].map(m => m[1]).find(p => !FILLED.includes(p));
  if (other) return { at, why: `${at}'s command needs {${other}}, a value of the run it ran in` };
  if (words[0] !== './agent.sh' || !words[1]) return { at, why: `${at}'s command is not run through ./agent.sh` };
  if (OUTWARD.has(words[1]) || words.includes('--mark')) return { at, why: `${at}'s ${words[1]} changes something outside the ticket when run: it is no check to re-run` };
  const values = { project, ticket, 'work-item': ticket, variation: variation.name };
  const argv = words.map(w => w.replace(/\{([\w-]+)\}/g, (_, k) => String(values[k] ?? '')));
  return { at, engine: last.engine, step: last.id, command: argv.join(' '), argv };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out;
  try { out = recheckBlock(JSON.parse(readFileSync(0, 'utf8'))); } catch (error) { out = { at: null, why: `its input could not be read: ${error.message}` }; }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
