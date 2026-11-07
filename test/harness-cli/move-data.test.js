// move-data (ASS-55) — the live cutover: the harness's data moved from the
// repo root into data/, on a temp checkout standing in for the live one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const HARNESS = join(import.meta.dirname, '..', '..', 'harness.sh');
const sha8 = text => createHash('sha256').update(text).digest('hex').slice(0, 8);
const enc = path => path.replace(/[^A-Za-z0-9]/g, '-');   // Claude Code's folder name for a working directory

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// A checkout as the live one is before the move: the tracked data (at the
// root when `merged` is false, under data/ — as a pull of the merged code
// leaves it — when true) and the untracked data at the root; a Lima home
// with a ticket VM mounting a ticket folder and a golden VM.
function checkout({ merged = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'move-data-')));
  const at = (...p) => join(root, ...p);
  const tracked = merged ? (...p) => at('data', ...p) : at;
  write(at('.gitignore'), '*.lock\n');
  write(tracked('agent-names.json'), '[{"name":"Hulk"}]\n');
  write(tracked('harness.json'), '{"max-agents":1}\n');
  write(tracked('agents', 'Hulk-20240606T000400Z', 'session.txt'), 'sample\n');
  write(tracked('projects', 'p', 'merge-request-considerations.md'), '# notes\n');
  write(tracked('projects', 'p', 'golden-image', 'template.yaml'), 'video: none\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  write(at('assignments.json'), '{"assignments":[]}\n'); write(at('assignments.json.lock'), '');
  write(at('harness.json.lock'), '');
  write(at('chats.json'), '{"chats":[]}\n');
  write(at('chats', 'c1', 'session.txt'), 'hello\n');
  write(at('last-model-used'), 'claude-opus-5');
  write(at('agent-names-last-used.json'), '{}\n');
  write(at('agents', 'Thor-20261026T000000Z', 'session.txt'), 'live\n');
  write(at('projects', 'p', 'project.json'), '{"name":"P"}\n');
  write(at('projects', 'p', 'work', 'ABC-1', 'notes.md'), 'n\n');
  write(at('projects', 'p', '.claude', '.claude.json'), '{}\n');
  write(at('projects', 'p', '.claude', 'projects', `${enc(at('projects', 'p'))}`, 's1.jsonl'), '{}\n');
  write(at('projects', 'p', '.claude', 'projects', '-Users-me-src-app', 's2.jsonl'), '{}\n');
  write(at('projects', 'p', '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: { installLocation: at('projects', 'p', '.claude', 'plugins', 'm') } }));
  write(at('projects', 'p', 'hindsight', '.pg0', 'instances', 'hindsight', 'instance.json'), JSON.stringify({ data_dir: at('projects', 'p', 'hindsight', '.pg0', 'instances', 'hindsight', 'data') }));
  symlinkSync('work/ABC-1', at('projects', 'p', 'latest'));
  const lima = mkdtempSync(join(tmpdir(), 'lima-'));
  write(join(lima, 'abc-1-a', 'lima.yaml'), `mounts:\n- location: ${at('projects', 'p', 'work', 'ABC-1')}\n  mountPoint: /mnt/ticket\n`);
  write(join(lima, 'golden-p', 'lima.yaml'), `mounts:\n- location: ${at('projects', 'p', 'golden-image')}\n`);
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const env = { ...process.env, HARNESS_ROOT: root, LIMA_HOME: lima, ZOT_DIR: join(home, 'zot') };
  const move = () => spawnSync(HARNESS, ['move-data'], { encoding: 'utf8', env });
  return { root, at, lima, env, move };
}

// Every file and link under the given top-level names of dir: { relative path: sha256 or link target }.
function contents(dir, names) {
  const out = {};
  const walk = path => {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) out[relative(dir, path)] = `-> ${readlinkSync(path)}`;
    else if (s.isDirectory()) readdirSync(path).forEach(n => walk(join(path, n)));
    else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  for (const n of names) { try { walk(join(dir, n)); } catch { /* not there */ } }
  return out;
}
const NAMES = ['agent-names.json', 'agent-names-last-used.json', 'assignments.json', 'assignments.json.lock', 'chats.json', 'harness.json', 'harness.json.lock', 'last-model-used', 'projects', 'agents', 'chats'];
const OLD_SESSIONS = (c) => enc(c.at('projects', 'p'));

test('move-data moves every data file and folder from the root into data/, the same content by checksum, the tracked ones as git renames; nothing is left at the root', () => {
  const c = checkout();
  const before = contents(c.root, NAMES);
  const r = c.move();
  assert.equal(r.status, 0, r.stderr);
  for (const n of NAMES) assert.equal(existsSync(join(c.root, n)), false, n);
  const after = contents(c.at('data'), NAMES);
  // The one session folder named after the old path is renamed (below); everything else is byte for byte as it was.
  const renamed = k => k.replace(OLD_SESSIONS(c), enc(c.at('data', 'projects', 'p')));
  assert.deepEqual(after, Object.fromEntries(Object.entries(before).map(([k, v]) => [renamed(k), k.includes('instance.json') || k.includes('known_marketplaces') ? after[renamed(k)] : v])));
  assert.match(r.stdout, /checksums match/);
  const status = git(c.root, 'status', '--porcelain');
  for (const f of ['agent-names.json', 'harness.json', 'projects/p/merge-request-considerations.md', 'agents/Hulk-20240606T000400Z/session.txt']) assert.match(status, new RegExp(`^R  ${f} -> data/${f}$`, 'm'), status);
});

test('after a pull of the merged code — the tracked data already under data/ — move-data moves the rest in beside it', () => {
  const c = checkout({ merged: true });
  const r = c.move();
  assert.equal(r.status, 0, r.stderr);
  for (const n of NAMES) assert.equal(existsSync(join(c.root, n)), false, n);
  for (const f of [['projects', 'p', 'merge-request-considerations.md'], ['projects', 'p', 'golden-image', 'template.yaml'], ['projects', 'p', 'project.json'], ['projects', 'p', 'work', 'ABC-1', 'notes.md'], ['agents', 'Hulk-20240606T000400Z', 'session.txt'], ['agents', 'Thor-20261026T000000Z', 'session.txt'], ['assignments.json']])
    assert.ok(existsSync(c.at('data', ...f)), f.join('/'));
  assert.equal(git(c.root, 'status', '--porcelain', '--untracked-files=no'), '');   // only the untracked data moved: nothing tracked changed
});

test('move-data is idempotent: run again, it moves and changes nothing', () => {
  const c = checkout();
  assert.equal(c.move().status, 0);
  const once = contents(c.at('data'), NAMES), lima = readFileSync(join(c.lima, 'abc-1-a', 'lima.yaml'), 'utf8');
  const r = c.move();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing to move/);
  assert.deepEqual(contents(c.at('data'), NAMES), once);
  assert.equal(readFileSync(join(c.lima, 'abc-1-a', 'lima.yaml'), 'utf8'), lima);
});

test('the paths the data holds of itself follow it: Hindsight\'s database instance, the Claude plugins\' install paths, the Claude sessions of the project folder, and a ticket VM\'s mount — never a golden VM\'s', () => {
  const c = checkout();
  assert.equal(c.move().status, 0);
  const pg = JSON.parse(readFileSync(c.at('data', 'projects', 'p', 'hindsight', '.pg0', 'instances', 'hindsight', 'instance.json'), 'utf8'));
  assert.equal(pg.data_dir, c.at('data', 'projects', 'p', 'hindsight', '.pg0', 'instances', 'hindsight', 'data'));
  assert.equal(JSON.parse(readFileSync(c.at('data', 'projects', 'p', '.claude', 'plugins', 'known_marketplaces.json'), 'utf8')).m.installLocation, c.at('data', 'projects', 'p', '.claude', 'plugins', 'm'));
  assert.deepEqual(readdirSync(c.at('data', 'projects', 'p', '.claude', 'projects')).toSorted(), ['-Users-me-src-app', enc(c.at('data', 'projects', 'p'))].toSorted());
  assert.match(readFileSync(join(c.lima, 'abc-1-a', 'lima.yaml'), 'utf8'), new RegExp(`location: ${c.at('data', 'projects', 'p', 'work', 'ABC-1')}\n`));
  assert.match(readFileSync(join(c.lima, 'golden-p', 'lima.yaml'), 'utf8'), new RegExp(`location: ${c.at('projects', 'p', 'golden-image')}\n`));
});

test('move-data prints each project\'s Claude keychain item, old and new — it never touches the keychain', () => {
  const c = checkout();
  const r = c.move();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Claude Code-credentials-${sha8(c.at('projects', 'p', '.claude'))}`), r.stdout);
  assert.ok(r.stdout.includes(`Claude Code-credentials-${sha8(c.at('data', 'projects', 'p', '.claude'))}`), r.stdout);
});

test('move-data refuses, moving nothing, while control, the dashboard or the downloader of this checkout runs', async t => {
  const c = checkout();
  for (const part of ['control', 'tui', 'downloader']) {
    write(c.at('src', part, 'main.js'), 'setInterval(() => {}, 1000);\n');
    const child = spawn('node', [c.at('src', part, 'main.js')], { stdio: 'ignore' });
    t.after(() => child.kill());
    await new Promise(resolve => setTimeout(resolve, 300));
    const r = c.move();
    child.kill();
    await new Promise(resolve => child.on('exit', resolve));
    assert.equal(r.status, 1, part);
    assert.match(r.stderr, new RegExp(`src/${part}/main\\.js.*running`), r.stderr);
    assert.ok(existsSync(c.at('assignments.json')) && !existsSync(c.at('data')), part);
  }
});

test('move-data refuses, moving nothing, while a project\'s Hindsight or zot runs, or a ticket VM mounting the old folder', () => {
  const c = checkout();
  write(c.at('projects', 'p', 'hindsight', 'hindsight.pid'), `${process.pid}\n`);
  let r = c.move();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /p's Hindsight .*running/);
  write(c.at('projects', 'p', 'hindsight', 'hindsight.pid'), '999999\n');
  write(join(c.env.ZOT_DIR, 'p.pid'), `${process.pid}\n`);
  r = c.move();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /p's zot .*running/);
  write(join(c.env.ZOT_DIR, 'p.pid'), '999999\n');
  write(join(c.lima, 'abc-1-a', 'ha.pid'), `${process.pid}\n`);
  r = c.move();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /abc-1-a.*running/);
  assert.ok(existsSync(c.at('assignments.json')) && !existsSync(c.at('data')));
});

test('move-data refuses, moving nothing, when a file is at both the old place and the new', () => {
  const c = checkout();
  write(c.at('data', 'projects', 'p', 'project.json'), '{"name":"other"}\n');
  const r = c.move();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /projects\/p\/project\.json/);
  assert.ok(existsSync(c.at('assignments.json')) && existsSync(c.at('projects', 'p', 'project.json')));
});
