// ASS-548: the bash commands' engine cache (src/workflow/engine-cache.js, engine.bash
// engine_json / engines_by_name): each engine read in bash started node to turn
// its workflow.yaml into JSON (ASS-524); a cached read starts none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync, statSync, chmodSync, readlinkSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cksum, cacheEntryName, cacheEntry, pathLinkName, pruneCache, PRUNE_DAYS } from '../../src/workflow/engine-cache.js';
import { readEngine, engineNamesIn, engineFileIn } from '../../src/workflow/engine-file.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ENGINE_BASH = join(ROOT, 'src', 'agent-cli', 'engine.bash');
const ENGINES = join(ROOT, 'engines');
const tmp = () => mkdtempSync(join(tmpdir(), 'engine-cache-'));
const put = (dir, name, text) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'workflow.yaml'), text); return join(dir, name, 'workflow.yaml'); };

// A PATH whose node fails, naming itself: a read that starts node then fails, so a passing read came from the cache.
function noNodePath(dir) {
  const bin = join(dir, 'no-node-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "node started" >&2\nexit 97\n');
  chmodSync(join(bin, 'node'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

// bash(script, { cache, env }) — runs `script` after sourcing engine.bash, the cache in `cache`.
function bash(script, { cache, env = {} } = {}) {
  return spawnSync('bash', ['-c', `source "${ENGINE_BASH}"\n${script}`], {
    encoding: 'utf8', env: { ...process.env, ENGINE_CACHE_DIR: cache, ...env },
  });
}
const json = (file, cache, env) => bash(`engine_json "$1"`.replace('$1', file), { cache, env });

test('AC2: cksum() is POSIX cksum, so bash (the cksum command) and node name an entry alike', () => {
  const samples = [Buffer.alloc(0), Buffer.from('a'), Buffer.from('steps: []\n'), Buffer.alloc(70000, 0x61), Buffer.from('é – ü\n')];
  for (const name of engineNamesIn(ENGINES)) samples.push(readFileSync(engineFileIn(ENGINES, name)));
  for (const bytes of samples) assert.equal(cksum(bytes), execFileSync('cksum', { input: bytes, encoding: 'utf8' }).trim().replace(/\s+/, ' '));
  assert.match(cacheEntryName(Buffer.from('x')), /^\d+-1$/);
});

test('AC2/AC3: a read misses once, writing its entry; the next reads come from the cache without node, the same JSON', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const file = engineFileIn(ENGINES, 'grouped-plan');
  const first = json(file, cache);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), readEngine(file));
  assert.deepEqual(readdirSync(cache).toSorted(), [cacheEntryName(readFileSync(file)), pathLinkName(file)].toSorted());
  const again = json(file, cache, { PATH: noNodePath(dir) });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, first.stdout);
});

test('AC2: a changed workflow.yaml is never read stale — even an edit keeping its size and mtime', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const file = put(dir, 'e', 'steps:\n  - id: aaa\n    sequence: 1\n');
  assert.equal(JSON.parse(json(file, cache).stdout).steps[0].id, 'aaa');
  const { atime, mtime } = statSync(file);
  writeFileSync(file, 'steps:\n  - id: bbb\n    sequence: 1\n');
  utimesSync(file, atime, mtime);
  assert.equal(JSON.parse(json(file, cache).stdout).steps[0].id, 'bbb');
  writeFileSync(file, 'steps:\n  - id: aaa\n    sequence: 1\n');   // back: the first entry serves again, without node
  assert.equal(JSON.parse(json(file, cache, { PATH: noNodePath(dir) }).stdout).steps[0].id, 'aaa');
});

test('AC2: a deleted, damaged or foreign cache entry is a miss and is written again; the cache folder itself may go', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const file = engineFileIn(ENGINES, 'grouped-build'), bytes = readFileSync(file);
  const want = `${JSON.stringify(readEngine(file))}\n`, entry = join(cache, cacheEntryName(bytes));
  assert.equal(json(file, cache).stdout, want);
  const good = readFileSync(entry), link = join(cache, pathLinkName(file));
  assert.equal(readlinkSync(link), cacheEntryName(bytes));   // the path's link points at the content's entry
  const damaged = [
    Buffer.from('garbage'),
    Buffer.alloc(0),
    good.subarray(0, good.length - 10),                                                      // cut short
    Buffer.from(good.toString().replace('harness-engine-cache 1', 'harness-engine-cache 9')),  // another format
    Buffer.from(good.toString().replace(/^(harness-engine-cache 1 )\d+/, '$11')),            // wrong JSON length
    Buffer.from(good.toString().replace('"steps":[{', '"steps":[{"x":1,')),                  // JSON edited, length off
    cacheEntry(Buffer.from('steps: []\n'), { steps: [] }),                                   // another YAML's (a crc collision)
  ];
  for (const text of damaged) {
    writeFileSync(entry, text);
    assert.equal(json(file, cache).stdout, want);
    assert.deepEqual(readFileSync(entry), good);
  }
  rmSync(entry);
  assert.equal(json(file, cache).stdout, want);
  rmSync(cache, { recursive: true });
  assert.equal(json(file, cache).stdout, want);
  assert.ok(existsSync(entry));
});

test('AC2: the default cache is the checkout\'s data/cache/engines, which git ignores', () => {
  const out = spawnSync('bash', ['-c', `unset ENGINE_CACHE_DIR; source "${ENGINE_BASH}"; echo "$engine_cache_dir"`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(execFileSync('realpath', [join(out, '..', '..')], { encoding: 'utf8' }).trim(), execFileSync('realpath', [join(ROOT, 'data')], { encoding: 'utf8' }).trim());
  assert.match(out, /\/data\/cache\/engines$/);
  const ignored = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', join('data', 'cache', 'engines', '123-45')]);
  assert.equal(ignored.status, 0, 'data/cache/engines/ is gitignored');
});

test('AC2: an empty ENGINE_CACHE_DIR turns the cache off: every read starts node and nothing is written', () => {
  const dir = tmp();
  const file = engineFileIn(ENGINES, 'grouped-plan');
  assert.equal(json(file, '').status, 0);
  assert.equal(json(file, '', { PATH: noNodePath(dir) }).status, 97);
});

test('AC2: concurrent readers never read a half-written entry — many at once on a miss, and while entries are rewritten', async () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const target = engineFileIn(ENGINES, 'grouped-build');
  const want = `${JSON.stringify(readEngine(target))}\n`;
  const run = () => new Promise(resolve => {
    const child = spawn('bash', ['-c', `source "${ENGINE_BASH}"; for i in 1 2 3; do engine_json "${target}"; done`], { env: { ...process.env, ENGINE_CACHE_DIR: cache } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', status => resolve({ status, out, err }));
  });
  // A writer rewriting the entry over and over (each write a temp file and a rename) while the readers read.
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeCacheEntry } from ${JSON.stringify(join(ROOT, 'src', 'workflow', 'engine-cache.js'))};
    import { readFileSync } from 'node:fs';
    import { readEngine } from ${JSON.stringify(join(ROOT, 'src', 'workflow', 'engine-file.js'))};
    const bytes = readFileSync(${JSON.stringify(target)}), engine = readEngine(${JSON.stringify(target)});
    const end = Date.now() + 4000;
    while (Date.now() < end) writeCacheEntry(${JSON.stringify(cache)}, ${JSON.stringify(target)}, bytes, engine);
  `]);
  const results = await Promise.all(Array.from({ length: 12 }, run));
  await new Promise(resolve => writer.on('close', resolve));
  for (const { status, out, err } of results) {
    assert.equal(status, 0, err);
    assert.equal(out, want.repeat(3));
  }
  assert.deepEqual(readdirSync(cache).toSorted(), [cacheEntryName(readFileSync(target)), pathLinkName(target)].toSorted(), 'no temp file left behind');
});

test('AC2: engines_by_name from the cache is what node\'s by-name gives — each engine named by its folder, a later one over an earlier — and starts no node', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const own = join(dir, 'own');
  const files = engineNamesIn(ENGINES).map(name => engineFileIn(ENGINES, name));
  files.push(put(own, 'grouped-plan', 'steps:\n  - id: own\n    sequence: 1\n'), join(own, 'gone', 'workflow.yaml'));
  const args = files.map(f => JSON.stringify(f)).join(' ');
  const direct = execFileSync('node', [join(ROOT, 'src', 'workflow', 'engine-cli.js'), 'by-name', ...files], { encoding: 'utf8' });
  const first = bash(`engines_by_name ${args}`, { cache });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, direct);
  const cached = bash(`engines_by_name ${args}`, { cache, env: { PATH: noNodePath(dir) } });
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(cached.stdout, direct);
  assert.deepEqual(JSON.parse(cached.stdout)['grouped-plan'].steps[0].id, 'own');
  assert.equal(bash('engines_by_name', { cache }).stdout, '{}\n');
});

test('AC4: a malformed workflow.yaml still fails naming its file, line and reason, each read, and is never cached', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const bad = put(dir, 'bad', 'steps:\n  - id: a\n    sequence: 1\n   name: wrong indent\n');
  for (const run of [() => json(bad, cache), () => json(bad, cache), () => bash(`engines_by_name "${bad}"`, { cache })]) {
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:4:\\d+: \\S`));
  }
  assert.ok(!existsSync(cache) || readdirSync(cache).length === 0);
});

test('AC2: each write prunes the entries untouched for PRUNE_DAYS and the links whose entry is gone (the cache is safe to delete, entry by entry)', () => {
  const cache = join(tmp(), 'cache');
  mkdirSync(cache);
  writeFileSync(join(cache, 'old'), 'x');
  writeFileSync(join(cache, 'new'), 'x');
  symlinkSync('new', join(cache, 'path-%2Fa'));
  symlinkSync('gone', join(cache, 'path-%2Fb'));
  const old = new Date(Date.now() - (PRUNE_DAYS + 1) * 86400000);
  utimesSync(join(cache, 'old'), old, old);
  pruneCache(cache);
  assert.deepEqual(readdirSync(cache).toSorted(), ['new', 'path-%2Fa']);
});

test('AC2/AC3: a copy of an engine at another path (another worktree, a test\'s folder) reads its content\'s entry without node; a path\'s stale link is passed over', () => {
  const dir = tmp(), cache = join(dir, 'cache');
  const file = engineFileIn(ENGINES, 'grouped-review');
  const want = json(file, cache).stdout;
  const copy = join(dir, 'engines', 'grouped-review', 'workflow.yaml');
  cpSync(file, copy);
  const viaContent = json(copy, cache, { PATH: noNodePath(dir) });
  assert.equal(viaContent.status, 0, viaContent.stderr);
  assert.equal(viaContent.stdout, want);
  // The copy edited: its path has no link, its content no entry: node reads it, and links the path to the new entry.
  writeFileSync(copy, 'steps:\n  - id: edited\n    sequence: 1\n');
  assert.equal(JSON.parse(json(copy, cache).stdout).steps[0].id, 'edited');
  assert.equal(readlinkSync(join(cache, pathLinkName(copy))), cacheEntryName(readFileSync(copy)));
  // Back to the original text: the link (to the edited entry) is stale, the content's entry serves, without node.
  cpSync(file, copy);
  assert.equal(json(copy, cache, { PATH: noNodePath(dir) }).stdout, want);
  assert.equal(pathLinkName(`/${'x'.repeat(300)}`), null, 'no link for a path too long for a file name');
});
