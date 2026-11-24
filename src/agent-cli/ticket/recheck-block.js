// ticket:recheck-block's choice (recheck-block.sh, ASS-390 AC4), in node to
// read the engines as control does (src/control/engine.js stepOf):
//
//   node recheck-block.js < input.json
//
// Input, gathered by the .sh: { project, ticket, variation (the variation's
// JSON), engine (the project's execution engine's name), engineFiles (every
// workflow.yaml the project sees (ASS-524: read by engine-file.js readEngine), engines/'s first, its own after) }.
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
//
// ASS-474: or { at, loop, check } when the block is a loop that ran out of
// visits: the step it left moved on (its exit's target) into a step already
// visited its max-visits times in that sub-engine's run, so control sent it
// to that step's on-max-visits — the done step it was blocked at — instead.
// Re-running the step it left is then no check: it passed, and resuming
// goes round the same loop again. `loop` names it: the step that ran out
// (ran-out, its visits and max-visits), the steps visited more than once in
// the run (steps, in sequence order), and the step that kept sending the
// ticket back (failing-step: the one most often moving back to an earlier
// step, or to itself; sent-back its count, sent-back-to where it sent it
// most). Its moves are the variation's sub-state-changes at that level since
// the run started (its entry, from-state null), as the run's own
// state-changes count its visits (control's runTransient, ASS-66). `check`
// is the failing step's own check, chosen as above ({ at, engine, step,
// command, argv }, or { at, why } when it is none to re-run). A block at the
// top level (no sub-engine) is never read as a loop here.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngine } from '../../workflow/engine-file.js';

// The commands whose run changes something beyond re-checking (merges, restarts, VMs, forge writes): never re-run as a check.
const OUTWARD = new Set(['merge-request:merge', 'merge-request:merge-in-turn', 'merge-request:ensure-auto-merge', 'merge-request:create', 'merge-request:create-fix', 'code:take-out-of-draft-mode',
  'code:update-workspace', 'harness:request-restart', 'vm:create', 'vm:mark-setup-complete', 'ticket:fast-track']);
const FILLED = ['project', 'ticket', 'work-item', 'variation'];

// engines(files) — { [name]: its JSON }, each file's folder its name, a later file over an earlier one.
function engines(files = []) {
  const all = {};
  for (const file of files) try { all[basename(dirname(file))] = readEngine(file); } catch { /* unreadable: left out */ }
  return all;
}
const stepOf = (engine, id) => (engine?.steps ?? []).find(s => s.id === id);
const quarantine = (engine, id) => { const s = stepOf(engine, id); return s != null && (s.sequence === 0 || s['is-blocked-state'] === true || s['follow-return-to-state'] === true); };

// checkOf(all, engineName, id, at, values) — the step's command to re-run as a check, { at, engine, step, command, argv }, or { at, why } when it is none.
function checkOf(all, engineName, id, at, values) {
  const step = stepOf(all[engineName], id);
  if (!step) return { at, why: `${id} is no step of ${engineName ?? 'its engine'}` };
  if (step.action?.type !== 'script') return { at, why: `${at} is no script step (its action is ${step.action?.type ?? 'none'}): there is no check to re-run` };
  const command = String(step.action.command ?? '').trim(), words = command.split(/\s+/);
  const other = [...command.matchAll(/\{([\w-]+)\}/g)].map(m => m[1]).find(p => !FILLED.includes(p));
  if (other) return { at, why: `${at}'s command needs {${other}}, a value of the run it ran in` };
  if (words[0] !== './agent.sh' || !words[1]) return { at, why: `${at}'s command is not run through ./agent.sh` };
  if (OUTWARD.has(words[1]) || words.includes('--mark')) return { at, why: `${at}'s ${words[1]} changes something outside the ticket when run: it is no check to re-run` };
  const argv = words.map(w => w.replace(/\{([\w-]+)\}/g, (_, k) => String(values[k] ?? '')));
  return { at, engine: engineName, step: id, command: argv.join(' '), argv };
}

// loopOf(all, levels, changes, i, doneId) — ASS-474: the loop the block is, or null (see the header).
// `levels` the variation's levels down to the step it left (the last), `changes` its state changes,
// `i` the index of its entry into Blocked, `doneId` the done step its sub-engine's run ended at.
function loopOf(all, levels, changes, i, doneId) {
  const depth = levels.length - 1, last = levels[depth], engine = all[last.engine];
  if (depth < 1 || !engine) return null;
  // The moves at the level, since the run's start (its entry: from-state null) in this stay at the top-level step.
  const enter = changes.slice(0, i).findLastIndex(c => !c['sub-state-change'] && c['to-state'] === levels[0].id);
  const moves = [];
  for (const c of changes.slice(enter + 1, i)) {
    let s = c['sub-state-change'];
    for (let k = 1; s && k < depth; k++) s = s['from-state'] === levels[k].id && s['to-state'] === levels[k].id ? s['sub-state-change'] : null;
    if (s && s['state-engine'] === last.engine) moves.push(s);
  }
  const run = moves.slice(Math.max(0, moves.findLastIndex(m => m['from-state'] == null)));
  const visits = id => run.filter(m => m['to-state'] === id).length;
  const left = stepOf(engine, last.id);
  const ranOut = [...new Set((left?.['exit-events'] ?? []).map(e => e['move-to-state']).filter(t => t != null && t !== doneId))]
    .map(id => stepOf(engine, id))
    .find(t => t?.['max-visits'] != null && t['on-max-visits'] === doneId && visits(t.id) >= t['max-visits']);
  if (!ranOut) return null;
  const seq = id => stepOf(engine, id)?.sequence ?? Infinity;
  const steps = [...new Set(run.map(m => m['to-state']))].filter(id => visits(id) > 1 && stepOf(engine, id)?.['is-done'] !== true).sort((a, b) => seq(a) - seq(b));
  // The step that kept failing: the one most often sending the ticket back (to an earlier step or itself); the latest on a tie.
  const back = run.filter(m => m['from-state'] != null && stepOf(engine, m['to-state'])?.['is-done'] !== true && seq(m['to-state']) <= seq(m['from-state']));
  const count = id => back.filter(m => m['from-state'] === id).length;
  const failing = back.map(m => m['from-state']).reduceRight((best, id) => (best == null || count(id) > count(best) ? id : best), null);
  const to = failing && Object.entries(Object.groupBy(back.filter(m => m['from-state'] === failing), m => m['to-state'])).sort((a, b) => b[1].length - a[1].length)[0][0];
  const prefix = levels.slice(0, depth).map(l => l.id).join('/');
  return {
    'ran-out': `${prefix}/${ranOut.id}`, visits: visits(ranOut.id), 'max-visits': ranOut['max-visits'],
    steps: steps.map(id => `${prefix}/${id}`),
    ...(failing ? { 'failing-step': `${prefix}/${failing}`, 'sent-back': count(failing), 'sent-back-to': `${prefix}/${to}` } : {}),
  };
}

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
  const values = { project, ticket, 'work-item': ticket, variation: variation.name };
  // A change that ended the sub-engine's run (its done step): the step it left is the one that failed.
  if (levels.length > 1 && stepOf(all[last.engine], last.id)?.['is-done'] === true && last.from) {
    const doneId = last.id;
    last.id = last.from;
    // ASS-474: unless it left that step for one that had run out of visits — a loop, whose failing step is the one to check.
    const loop = loopOf(all, levels, changes, i, doneId);
    if (loop) {
      const at = levels.map(l => l.id).join('/');
      const failing = loop['failing-step'];
      const check = failing ? checkOf(all, last.engine, failing.split('/').at(-1), failing, values) : { at: null, why: 'no step sent it back to an earlier one' };
      return { at, loop, check };
    }
  }
  const at = levels.map(l => l.id).join('/');
  return checkOf(all, last.engine, last.id, at, values);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out;
  try { out = recheckBlock(JSON.parse(readFileSync(0, 'utf8'))); } catch (error) { out = { at: null, why: `its input could not be read: ${error.message}` }; }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
