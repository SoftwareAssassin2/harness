// The one loader of a state engine's file (ASS-524): engines/<name>/workflow.yaml,
// or a project's own at data/projects/<project>/engines/<name>/workflow.yaml
// (ASS-276). An engine was a state-engine.json until ASS-524; its content —
// field names, structure, key order — is unchanged, only the file is YAML, so
// an engine can carry comments explaining its steps and reads without JSON's
// quoting and brackets. Every reader goes through here: control (state.js
// readEngines, through read.js's cache), the dashboard (tui/load.js),
// validation (validate.js), analytics (team/update.js) and the agent CLI —
// its node commands read engines with readEngine, and its bash commands, which
// jq an engine, get it as JSON from engine-cli.js (engine.bash engine_json,
// `./agent.sh engine:show`).
//
// YAML is read with the `yaml` package (eemeli/yaml, the harness's first npm
// dependency, pinned in package.json and package-lock.json: `npm ci`), as
// YAML 1.2's core schema: `yes`, `no`, `on` and dates stay strings, as they
// were in JSON. A JSON file is valid YAML, so an engine written as JSON in a
// workflow.yaml (the tests' fixtures) reads as it always did. A key given twice
// is an error, as it never silently was the last one's.
//
// A file that does not parse throws a SyntaxError "<file>:<line>:<column>:
// <reason>" (error.file, error.line, error.column), as a bad state-engine.json
// threw JSON.parse's SyntaxError: read.js's readJson tries such a read again
// (a merge caught rewriting the file), then control keeps the last good copy
// (ASS-460), and validation names the file, line and reason (AC4). An empty
// file, or one that is not a mapping at its top, is such an error too.
//
// The one-off migration (convertEngines, `./agent.sh engine:convert-to-yaml`)
// writes each <dir>/<name>/state-engine.json as the workflow.yaml beside it and
// removes the JSON, once the YAML reads back as the very same engine, key
// order included; it is idempotent (a folder already converted is left as it
// is) and never overwrites a workflow.yaml that differs from the JSON.
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The yaml package, or a clear way to get it: a checkout without node_modules
// (a fresh clone before `npm ci`) would otherwise fail with node's bare
// ERR_MODULE_NOT_FOUND from deep inside whichever command first read an engine.
let YAML;
try { YAML = await import('yaml'); } catch (error) {
  throw new Error(`the yaml package is missing (${error.code ?? error.message}): run \`npm ci\` in the harness folder (ASS-524)`);
}

export const ENGINE_FILE = 'workflow.yaml';
// The file an engine was before ASS-524, read only by the migration.
export const LEGACY_ENGINE_FILE = 'state-engine.json';

// engineFileIn(dir, name) — engine `name`'s file in an engines folder `dir`.
export const engineFileIn = (dir, name) => join(dir, name, ENGINE_FILE);

// engineNamesIn(dir) — the engines in folder `dir` (each subfolder holding a
// workflow.yaml), in readdir's order; [] when there is no such folder.
export const engineNamesIn = dir => (existsSync(dir) ? readdirSync(dir).filter(name => existsSync(engineFileIn(dir, name))) : []);

// syntaxError(file, line, column, reason) — the error a file that does not parse throws.
function syntaxError(file, line, column, reason) {
  const error = new SyntaxError(`${file}:${line}:${column}: ${reason}`);
  Object.assign(error, { file, line, column, reason });
  return error;
}

// parseEngine(text, file) — the engine the YAML `text` holds, `file` naming it
// in an error. Throws syntaxError's SyntaxError for text that does not parse,
// is empty, or is not a mapping.
export function parseEngine(text, file = ENGINE_FILE) {
  if (!text.trim()) throw syntaxError(file, 1, 1, 'the file is empty');
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true, version: '1.2', schema: 'core' });
  const [error] = doc.errors;
  if (error) {
    const { line = 1, col = 1 } = error.linePos?.[0] ?? {};
    throw syntaxError(file, line, col, error.message.replace(/ at line \d+, column \d+:[\s\S]*$/, '').trim());
  }
  const engine = doc.toJS({ maxAliasCount: 100 });
  if (engine === null || typeof engine !== 'object' || Array.isArray(engine)) throw syntaxError(file, 1, 1, 'an engine is a mapping (steps: …), not a list or a single value');
  return engine;
}

// readEngine(file) — the engine in `file` (a workflow.yaml); fs errors as readFileSync throws them.
export const readEngine = file => parseEngine(readFileSync(file, 'utf8'), file);

// stringifyEngine(engine) — the engine as workflow.yaml text: block style, keys
// in the engine's order, no line folding (a long description stays one line,
// so a diff shows the sentence changed), no anchors or aliases.
export const stringifyEngine = engine => YAML.stringify(engine, { lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false, version: '1.2' });

// sameEngine(a, b) — the same engine, key order included (JSON.stringify keeps it).
const sameEngine = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// writeAtomically(file, text) — temp file and rename, so control never reads it half-written.
function writeAtomically(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// convertEngine(folder, { dryRun }) — one engine folder's state-engine.json
// written as its workflow.yaml, the JSON removed. Returns { folder, status,
// detail }: status "converted" (or "would-convert" on a dry run), "removed-json"
// (a workflow.yaml holding the same engine was there already: only the JSON
// goes), "already" (only a workflow.yaml), "none" (neither file), or "error"
// (the JSON does not parse, the YAML would not read back the same, or a
// different workflow.yaml is there; nothing changed).
export function convertEngine(folder, { dryRun = false } = {}) {
  const json = join(folder, LEGACY_ENGINE_FILE), yaml = join(folder, ENGINE_FILE);
  if (!existsSync(json)) return { folder, status: existsSync(yaml) ? 'already' : 'none' };
  let engine;
  try { engine = JSON.parse(readFileSync(json, 'utf8')); } catch (error) { return { folder, status: 'error', detail: `${json} is not JSON: ${error.message}` }; }
  if (existsSync(yaml)) {
    let theirs;
    try { theirs = readEngine(yaml); } catch (error) { return { folder, status: 'error', detail: `${yaml} is there already and does not read: ${error.message}` }; }
    if (!sameEngine(theirs, engine)) return { folder, status: 'error', detail: `${yaml} is there already and differs from ${json}; left both as they are` };
    if (!dryRun) rmSync(json);
    return { folder, status: 'removed-json' };
  }
  const text = stringifyEngine(engine);
  let back;
  try { back = parseEngine(text, yaml); } catch (error) { return { folder, status: 'error', detail: `its YAML would not read back: ${error.message}` }; }
  if (!sameEngine(back, engine)) return { folder, status: 'error', detail: `its YAML would not read back as the same engine; ${json} left as it is` };
  if (dryRun) return { folder, status: 'would-convert' };
  writeAtomically(yaml, text);
  rmSync(json);
  return { folder, status: 'converted' };
}

// convertEngines(dir, options) — convertEngine for every subfolder of the
// engines folder `dir` that holds either file, in name order; [] without the folder.
export const convertEngines = (dir, options) => (existsSync(dir) ? readdirSync(dir).toSorted() : [])
  .filter(name => existsSync(join(dir, name, LEGACY_ENGINE_FILE)) || existsSync(join(dir, name, ENGINE_FILE)))
  .map(name => convertEngine(join(dir, name), options));
