// How control reads a JSON file, and tells a read that failed because the
// data could not be read just then from any other failure (ASS-460, ASS-457,
// ASS-458). The harness lives on an external drive that can drop out for a
// moment (ENOENT, EIO, ENXIO on everything under it), and a merge, checkout
// or rebase rewrites the checkout's files (engines/, prompts/) in place, so a
// read can find one empty or half-written. Control never takes such a read as
// "none": the tick that met it is skipped (tick.js), and control waits for its
// data, up to harness.json's data-unreadable-exit-seconds.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { parseEngine } from '../workflow/engine-file.js';

// The error codes that say a file or its folder could not be read (ASS-457).
export const UNREADABLE_CODES = new Set(['ENOENT', 'EIO', 'ENXIO', 'ENOTDIR', 'EACCES']);
// The delays before each read again: 50 ms, then 150 — at most 200 ms in all,
// well under a tick. The wait is synchronous, as loadState is.
export const READ_RETRY_MS = [50, 150];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// readJsonOnce(file) — the plain read: for a file whose absence or a bad
// read is ordinary and already handled where it is read.
export const readJsonOnce = file => JSON.parse(readFileSync(file, 'utf8'));

// readJson(file, delays) — the file parsed. A read whose content is empty or
// does not parse, or that fails with EIO or ENXIO, or ENOENT while the file's
// folder is gone too (the drive away: data is written atomically, so a file
// missing from a folder that is there is simply missing), is tried again after
// each of `delays`, then fails as it did; a SyntaxError carries the file
// (error.file), as an fs error carries its path. A file that parses is read
// once, as before; nothing is logged for one that parses on a second read.
// `readText` (readFileSync's text) is the tests'; `parse` (each try's read and
// parse) readJsonCached's (ASS-495).
const readUtf8 = f => readFileSync(f, 'utf8');
export function readJson(file, delays = READ_RETRY_MS, readText = readUtf8, parse = (f, read) => JSON.parse(read(f))) {
  for (let tried = 0; ; tried++) {
    try { return parse(file, readText); } catch (error) {
      if (error instanceof SyntaxError) error.file ??= file;
      const again = error instanceof SyntaxError || error.code === 'EIO' || error.code === 'ENXIO' || (error.code === 'ENOENT' && !existsSync(dirname(file)));
      if (!again || tried >= delays.length) throw error;
      pause(delays[tried]);
    }
  }
}

// ASS-495: control's loadState runs some 25 times a tick, and up to ~190
// more in runSteps, and each parsed every project's data afresh (about 10 MB,
// one sprint.json 6 MB). readJsonCached(file, delays) is readJson's, but
// a file whose identity — device, inode, size, mtime and ctime, both in ns
// (statSync bigint) — is the same as at its last parse is that parse again,
// not read. The harness writes by temp + rename, so a write is a new inode
// and always reads again; an in-place write (a merge rewriting engines/)
// moves mtime and ctime. The file is stat'ed BEFORE it is read, so content
// newer than the identity kept only costs one more parse next time, and a
// read that fails (empty, half-written, gone: readJson's retries and errors,
// ASS-457/458/460, all as before) is never kept, nor served in its place: its
// identity is not the kept one's. A stat that fails leaves the read to fail
// (or not) as readJson's own, so the same error, message and all.
//
// AC2: a parse handed out is shared between loads, so it is deep-frozen
// (deepFreeze) rather than copied: a copy (structuredClone) costs about what
// the parse does, and the audit of control's callers of ctx.load() found
// none that changes what it is given (they copy — { ...t }, toSorted — or
// assign to the per-load project object loadState builds afresh, never to a
// parse). Frozen, a future mutation throws a TypeError (ES modules are strict)
// in the tests rather than leaking into the next load.
//
// The cache holds what the last loadState read: sweepCached() (loadState's,
// after a load that read everything) drops the files not read since the
// previous sweep — an old sprint's sprint.json, a removed ticket's questions.
const parsed = new Map();   // file → { id, value, used }
let generation = 0;
// cacheStats — the parses and reuses so far (the tests count them).
export const cacheStats = { parses: 0, hits: 0 };

// deepFreeze(value) — value, it and everything under it frozen. One already
// frozen is taken as frozen throughout (deepFreeze freezes children first),
// so a derived piece over parses already frozen costs only its own objects.
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const identity = file => {
  const s = statSync(file, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

// ASS-524: `parse(text, file)` the file's parser — JSON's, or an engine's
// workflow.yaml (engine-file.js parseEngine, whose errors are SyntaxErrors
// too, so readJson tries them again as it does a JSON file caught half-written).
const parseJsonText = text => JSON.parse(text);
function parseCached(file, readText, parse = parseJsonText) {
  let id;
  try { id = identity(file); } catch { return deepFreeze(parse(readText(file), file)); }
  const kept = parsed.get(file);
  if (kept?.id === id) { kept.used = generation; cacheStats.hits++; return kept.value; }
  const value = deepFreeze(parse(readText(file), file));
  cacheStats.parses++;
  parsed.set(file, { id, value, used: generation });
  return value;
}

export const readJsonCached = (file, delays = READ_RETRY_MS, readText = readUtf8) => readJson(file, delays, readText, parseCached);

// readEngineCached(file, delays) — readJsonCached's, for an engine's
// workflow.yaml (ASS-524): the same retries, cache and freezing, parsed as YAML.
export const readEngineCached = (file, delays = READ_RETRY_MS, readText = readUtf8) => readJson(file, delays, readText, (f, read) => parseCached(f, read, parseEngine));

// sweepCached() — the files not read since the last sweep dropped from the cache.
export function sweepCached() {
  for (const [file, kept] of parsed) if (kept.used !== generation) parsed.delete(file);
  generation++;
}

// readKept(file) — readJson's, but a file of the checkout that a merge may be
// rewriting (ASS-458: a prompt's prompt.json) that fails to read is its last
// good parse in this process; without one it throws, as readJson does.
const kept = new Map();
export function readKept(file) {
  try {
    const value = readJson(file);
    kept.set(file, value);
    return value;
  } catch (error) {
    if (kept.has(file)) return kept.get(file);
    throw error;
  }
}

// The folders control's data and checkout files live in: a read failing under
// one of them is the data's, not something else's (a VM's, a token's).
const roots = ctx => (!ctx?.paths ? [] : [ctx.root, dirname(ctx.paths.assignments), dirname(ctx.paths.harness), ctx.paths.projects, ctx.paths.engines, ctx.paths.prompts, ctx.paths.agents].filter(Boolean));
const under = (ctx, file) => typeof file === 'string' && roots(ctx).some(root => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep));

// dataReachable(paths) — whether the data folder answers now: the projects
// folder lists and assignments.json is there.
export function dataReachable(paths) {
  try { readdirSync(paths.projects); statSync(paths.assignments); return true; } catch { return false; }
}

// troubleOf(ctx, error) — { file, reason } when `error` is the data failing to
// read, else null: one ctx.load met (error.dataTrouble: loadState reads only
// the data, so any fs error or SyntaxError there is); a file under the data or
// the checkout that would not parse, even read again (readJson's error.file);
// or, read elsewhere — by a phase itself, or an agent.sh command writing
// (ASS-457 AC4: its stderr names the code and path) — an fs error of
// UNREADABLE_CODES on a path under them while the data folder does not answer
// (dataReachable): a file simply missing with the folder there is that phase's
// own error, logged as before.
const CODE_IN_TEXT = /\b(?:ENOENT|EIO|ENXIO|ENOTDIR|EACCES)\b[^'\n]*'([^'\n]+)'/;
export function troubleOf(ctx, error) {
  if (error?.dataTrouble) return error.dataTrouble;
  if (error instanceof SyntaxError && under(ctx, error.file)) return { file: error.file, reason: error.message };
  const file = UNREADABLE_CODES.has(error?.code) ? error.path : String(error?.message ?? '').match(CODE_IN_TEXT)?.[1];
  return under(ctx, file) && !dataReachable(ctx.paths) ? { file, reason: error.message.split('\n')[0] } : null;
}
