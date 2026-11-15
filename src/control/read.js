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
// `readText` (readFileSync's text) is the tests'.
export function readJson(file, delays = READ_RETRY_MS, readText = f => readFileSync(f, 'utf8')) {
  for (let tried = 0; ; tried++) {
    try { return JSON.parse(readText(file)); } catch (error) {
      if (error instanceof SyntaxError) error.file ??= file;
      const again = error instanceof SyntaxError || error.code === 'EIO' || error.code === 'ENXIO' || (error.code === 'ENOENT' && !existsSync(dirname(file)));
      if (!again || tried >= delays.length) throw error;
      pause(delays[tried]);
    }
  }
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
