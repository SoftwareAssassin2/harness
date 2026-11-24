// The bash commands' cache of engines as JSON (ASS-548). Since ASS-524 an
// engine is a workflow.yaml, and a bash command (engine.bash engine_json,
// engines_by_name) jq's it, so each read started node (engine-cli.js) to turn
// the YAML into JSON: measured 15-80x the CPU and wall time of the jq read of
// a state-engine.json it replaced, and a command reads several engines
// (transient-state-engine:create ~22 with a real engine). So engine-cli.js,
// which parses the YAML anyway, leaves each engine it reads here as JSON, and
// engine.bash reads it back without node, then jq's it as before ASS-524.
//
// The folder: $ENGINE_CACHE_DIR, which engine.bash sets to the checkout's
// data/cache/engines (data/ is the harness's runtime state, gitignored, there
// in every checkout, worktree and fresh clone: data-folder.js). engine-cli.js
// writes no cache without it. Nothing else reads or writes it; it is never
// edited by hand nor committed, and deleting it (or any file in it) only costs
// the next reads a node start each.
//
// An entry is named by its YAML's content: `cksum`'s "<crc> <bytes>" as
// "<crc>-<bytes>" (POSIX cksum, computed by bash with the cksum command and
// here by cksum() below). So a copy of an engine (the tests' engines folders,
// another worktree's engines/) finds the entry the original made, and an
// edited file names another entry: there is no mtime to trust nor go stale.
// Its text:
//
//   harness-engine-cache 1 <the JSON's length in bytes>\n
//   <the engine as JSON, one line>\n
//   <the YAML, byte for byte as it was parsed>
//
// Beside it, a link named by the file's path ("path-" and the path, % as %25
// and / as %2F; none for a name over PATH_LINK_MAX bytes) points at the entry
// of the content last read there, so a read of a file it has read before costs
// bash no cksum (a process) either: it tries the link, then the content's
// entry, then node. Either way engine.bash takes an entry only when its YAML
// is the file's very text (so a stale link, or a crc two texts share, reads no
// wrong engine) and its header and JSON length check out (a damaged entry is a
// miss, and node writes it again).
//
// Entries and links are written to a temp file and renamed into place, so a
// reader (several agent.sh calls at once) sees a whole entry or none. Only a
// parse that succeeded is cached: a malformed workflow.yaml misses each time
// and node names its file, line and reason, as without a cache (ASS-524 AC4).
// An edited engine leaves its old entry behind, so each write removes the
// folder's files untouched for PRUNE_DAYS and any link whose entry is gone (an
// entry still in use is made again by its next read).
import { mkdirSync, writeFileSync, renameSync, readdirSync, lstatSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_HEADER = 'harness-engine-cache 1';
export const PRUNE_DAYS = 14;
export const PATH_LINK_MAX = 200;

// POSIX cksum's CRC (polynomial 0x04C11DB7, MSB first, the length appended).
const TABLE = new Uint32Array(256).map((_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

// cksum(bytes) — what `cksum` prints for these bytes on stdin: "<crc> <length>".
export function cksum(bytes) {
  let crc = 0;
  const step = byte => { crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0; };
  for (const byte of bytes) step(byte);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n % 256);
  return `${(~crc) >>> 0} ${bytes.length}`;
}

// cacheEntryName(bytes) — the entry's file name for a YAML of these bytes.
export const cacheEntryName = bytes => cksum(bytes).replace(' ', '-');

// pathLinkName(file) — the link's name for the path `file` as given (engine.bash
// builds the same), or null when it would be longer than PATH_LINK_MAX bytes.
export function pathLinkName(file) {
  const name = `path-${file.replaceAll('%', '%25').replaceAll('/', '%2F')}`;
  return Buffer.byteLength(name) <= PATH_LINK_MAX ? name : null;
}

// cacheEntry(bytes, engine) — the entry's text (a Buffer) for the YAML `bytes` that parsed as `engine`.
export function cacheEntry(bytes, engine) {
  const json = JSON.stringify(engine);
  return Buffer.concat([Buffer.from(`${CACHE_HEADER} ${Buffer.byteLength(json)}\n${json}\n`), bytes]);
}

const tmpName = file => `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;

// writeCacheEntry(dir, file, bytes, engine) — the entry for the YAML `bytes`
// (read from `file`, which parsed as `engine`) and the path link for `file`,
// each written atomically into `dir` (made when missing), then the folder
// pruned. Best effort: a cache that cannot be written (a read-only checkout, a
// sandboxed agent.sh) is no error.
export function writeCacheEntry(dir, file, bytes, engine, now = Date.now()) {
  try {
    mkdirSync(dir, { recursive: true });
    const name = cacheEntryName(bytes), entry = join(dir, name);
    let tmp = tmpName(entry);
    writeFileSync(tmp, cacheEntry(bytes, engine));
    renameSync(tmp, entry);
    const link = file && pathLinkName(file);
    if (link) {
      tmp = tmpName(join(dir, link));
      symlinkSync(name, tmp);
      renameSync(tmp, join(dir, link));
    }
    pruneCache(dir, now);
  } catch { /* best effort */ }
}

// pruneCache(dir, now) — removes the files in `dir` not modified for
// PRUNE_DAYS, and the links whose entry is gone.
export function pruneCache(dir, now = Date.now()) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      const old = now - lstatSync(file).mtimeMs > PRUNE_DAYS * 86400000;
      if (!old && name.startsWith('path-')) statSync(file);   // throws for a link whose entry is gone
      if (old) rmSync(file, { force: true });
    } catch { rmSync(file, { force: true }); }
  }
}
