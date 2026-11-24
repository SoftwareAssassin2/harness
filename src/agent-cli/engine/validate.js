// engine:validate's working out (validate.sh, ASS-524):
//
//   node validate.js <root> <engines-dir> <own-engines-dir|""> [<engine>|""] [<project.json>]
//
// Each engine in <engines-dir> and <own-engines-dir> (the project's own over
// engines/'s of the same name), or only <engine>, validated as its
// workflow.yaml (validate.js validateEngineFile: a file that does not parse
// is its file, line and reason). Prints "<engine>: <error>" per error, or
// "<n> engines valid"; exits 1 when there is an error or no such engine.
//
// ASS-551: with the project's <project.json>, also the check control makes of
// the project (state.js → run-targets.js projectRunTargetProblems, logged by
// tick.js): each machine-using step its tickets can reach from its execution
// engine, its switched-off steps off as control switches them, that can run on
// none of its run targets — never started, so its tickets would wait there for
// ever. ASS-543 found engine:validate passing while control found Setup's
// Create VM and Blocked's Add the Missing Repository stranded on the projects
// switched to substrate targets alone. Each is "<engine>: step "<id>" can run
// on none of project <name>'s run targets: <why>" (with <engine>, only that
// engine's). A project.json whose dev-environments are wrong is said instead
// (dev-environments.js devEnvironmentsErrors, as control refuses it; ASS-556: and its work-mode rules, work-mode.js
// projectWorkModeErrors), and an
// engine that does not parse leaves the check out (its error is given above).
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { engineFileIn, engineNamesIn, readEngine } from '../../workflow/engine-file.js';
import { validateEngineFile, switchedOffStepErrors } from '../../workflow/validate.js';
import { withoutObsolete } from '../../workflow/obsolete.js';
import { switchOff } from '../../control/engine.js';
import { devEnvironmentsErrors } from '../../control/dev-environments.js';
import { projectRunTargetProblems } from '../../control/run-targets.js';
import { projectWorkModeErrors } from '../../control/work-mode.js';

const [root, shared, own, only, projectFile] = process.argv.slice(2);
const files = new Map();
for (const dir of [shared, own].filter(Boolean)) for (const name of engineNamesIn(dir)) files.set(name, engineFileIn(dir, name));
if (only && !files.has(only)) { process.stderr.write(`engine:validate: no state engine ${only}\n`); process.exit(1); }
const names = only ? [only] : [...files.keys()].toSorted();
const errors = names.flatMap(name => validateEngineFile(files.get(name), root, name, own && existsSync(own) ? own : undefined).map(e => `${name}: ${e}`));
if (projectFile) errors.push(...projectErrors(projectFile));
for (const e of errors) process.stdout.write(`${e}\n`);
if (!errors.length) process.stdout.write(`${names.length} engine${names.length === 1 ? '' : 's'} valid\n`);
process.exit(errors.length ? 1 : 0);

// projectErrors(file) — the project's steps no run target can take (see the module comment), as lines.
function projectErrors(file) {
  const json = JSON.parse(readFileSync(file, 'utf8')), id = basename(dirname(file));
  // ASS-556: its work-mode rules (work-mode.js projectWorkModeErrors) beside its dev-environments.
  const dev = [...devEnvironmentsErrors(json), ...projectWorkModeErrors(json)];
  if (dev.length) return dev.map(e => `project ${id}: ${e}`);
  const engines = {};
  for (const [name, path] of files) {
    try { engines[name] = withoutObsolete(readEngine(path)); } catch { return []; }
  }
  const entries = [].concat(json['switched-off-steps'] ?? []).filter(e => !switchedOffStepErrors(e, engines).length);
  return projectRunTargetProblems(json, switchOff(engines, entries), json['execution-state-engine'])
    .filter(p => !only || p.engine === only)
    .map(p => `${p.engine}: step "${p.step}" can run on none of project ${id}'s run targets: ${p.why}`);
}
