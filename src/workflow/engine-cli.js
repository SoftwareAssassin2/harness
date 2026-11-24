// The engine loader (engine-file.js, ASS-524) for the bash commands, which jq
// an engine and jq cannot read YAML:
//
//   node engine-cli.js json <file>                 # the engine as JSON, on one line
//   node engine-cli.js by-name <file>…             # { "<engine>": its JSON, … }, each named by its folder, a later file over an earlier
//   node engine-cli.js convert [--dry-run] <dir>…  # the migration: each <dir>/<name>/state-engine.json as its workflow.yaml (convertEngines)
//   node engine-cli.js rename <file> <old> <new>   # every `engine: <old>` in the file (an action's) made `engine: <new>`, comments and layout kept
//
// json and by-name leave each engine they read in the bash commands' cache
// when $ENGINE_CACHE_DIR names one (engine-cache.js, ASS-548), which
// engine.bash reads without starting node. They fail (exit 1) naming the file,
// line and reason when a file does not parse (engine-file.js parseEngine);
// by-name leaves out a file that is gone. convert prints one line per engine
// folder, "<status> <folder>[: <detail>]", and fails when any is an error (the
// others converted all the same). rename (export-project's --engine-prefix,
// ASS-280) changes only those values' text, so a project's comments and layout
// travel in its bundle.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readEngine, parseEngine, convertEngines } from './engine-file.js';
import { writeCacheEntry } from './engine-cache.js';

const [command, ...args] = process.argv.slice(2);
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1); };

// read(file) — the engine in `file`, left in the bash commands' cache
// ($ENGINE_CACHE_DIR, set by engine.bash; engine-cache.js) when there is one:
// parsed from the very bytes the entry keeps, so the entry is what they read as.
const cacheDir = process.env.ENGINE_CACHE_DIR;
function read(file) {
  if (!cacheDir) return readEngine(file);
  const bytes = readFileSync(file);
  const engine = parseEngine(bytes.toString('utf8'), file);
  writeCacheEntry(cacheDir, file, bytes, engine);
  return engine;
}

try {
  if (command === 'json') {
    if (args.length !== 1) fail('usage: engine-cli.js json <file>');
    process.stdout.write(`${JSON.stringify(read(args[0]))}\n`);
  } else if (command === 'by-name') {
    const all = {};
    for (const file of args) if (existsSync(file)) all[basename(dirname(file))] = read(file);
    process.stdout.write(`${JSON.stringify(all)}\n`);
  } else if (command === 'convert') {
    const dryRun = args[0] === '--dry-run';
    const dirs = dryRun ? args.slice(1) : args;
    if (!dirs.length) fail('usage: engine-cli.js convert [--dry-run] <dir>…');
    let failed = false;
    for (const dir of dirs) for (const { folder, status, detail } of convertEngines(dir, { dryRun })) {
      if (status === 'error') failed = true;
      process.stdout.write(`${status} ${folder}${detail ? `: ${detail}` : ''}\n`);
    }
    process.exit(failed ? 1 : 0);
  } else if (command === 'rename') {
    if (args.length !== 3) fail('usage: engine-cli.js rename <file> <old> <new>');
    const [file, from, to] = args;
    readEngine(file);   // a file that does not parse fails here, naming its line
    const YAML = await import('yaml');
    const text = readFileSync(file, 'utf8');
    const doc = YAML.parseDocument(text, { version: '1.2' });
    // Each `engine: <old>` value's own source range, the name swapped inside
    // it (its quotes kept), last first: every other byte stays as it was.
    const ranges = [];
    YAML.visit(doc, { Pair(_, pair) { if (YAML.isScalar(pair.key) && pair.key.value === 'engine' && YAML.isScalar(pair.value) && pair.value.value === from && pair.value.range) ranges.push(pair.value.range); } });
    let out = text;
    for (const [start, end] of ranges.toSorted((a, b) => b[0] - a[0])) out = out.slice(0, start) + out.slice(start, end).replace(from, to) + out.slice(end);
    writeFileSync(file, out);
  } else fail('usage: engine-cli.js json|by-name|convert|rename …');
} catch (error) {
  fail(error.message);
}
