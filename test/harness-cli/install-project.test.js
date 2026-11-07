// install-project (ASS-275) — a preset bundle from export-project (ASS-274)
// installed into a harness: the exporting side is one temp data folder
// (PROJECTS_DIR), engines folder (ENGINES_DIR) and HOME, the installing side
// another, with its own harness.json (HARNESS_FILE), harness.local.json
// (HARNESS_LOCAL_FILE, ASS-281) and HOME holding
// ~/.harness/vm-credentials.json; the keychain is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const HARNESS = join(ROOT, 'harness.sh');
const write = (file, content) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// The exported project p: a local-pc folder, a registry, Hindsight and a golden
// image, engines dev -> build -> test, test its own (data/projects/p/engines,
// ASS-276), and credentials for gitlab and git. The installing harness has
// engines/ with dev and build (and a test that p's own shadows), a
// harness.json with other settings, credentials for another project q, and a
// project checkout at work/acme.
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-project-')));
  const at = (...p) => join(dir, ...p);
  write(at('from', 'projects', 'p', 'project.json'), {
    name: 'Acme',
    'execution-state-engine': 'dev',
    'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: '/somewhere/acme', 'active-branch': 'main' }, { name: 'dev-container', type: 'dev-container' }],
    repositories: [{ url: 'https://gitlab.com/acme/app', description: 'The app.', 'work-space': { branch: 'master' } }],
    'check-for-expired-glab-auth': true,
    registry: { 'storage-path': 'projects/p/registry', port: 5102 },
    hindsight: { port: 8892, 'llm-api-key-keychain-service': 'Hindsight Key (Acme)' },
    'golden-image': { folder: 'projects/p/golden-image', tools: ['pnpm'] },
  });
  write(at('from', 'projects', 'p', 'golden-image', 'template.yaml'), 'video: none\n');
  write(at('from', 'projects', 'p', 'merge-request-considerations.md'), '# Considerations\n');
  write(at('from', 'projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [{ id: 'own', sequence: 1, 'is-done': null, action: { type: 'none' } }] });
  const step = (id, engine) => ({ id, sequence: 1, 'is-done': null, action: { type: 'state-engine', engine } });
  for (const side of ['from', 'to']) {
    write(at(side, 'engines', 'dev', 'state-engine.json'), { steps: [step('build', 'build')] });
    write(at(side, 'engines', 'build', 'state-engine.json'), { steps: [step('test', 'test')] });
  }
  write(at('to', 'engines', 'test', 'state-engine.json'), { steps: [{ id: 'shared', sequence: 1, 'is-done': null, action: { type: 'none' } }] });
  write(at('from', 'home', '.harness', 'vm-credentials.json'), {
    p: { gitlab: { 'keychain-service': 'GitLab PAT (Acme)', host: 'gitlab.com' }, git: { 'user-name': 'Some One', 'user-email': 'someone@acme.example' } },
  });
  mkdirSync(at('out'));
  const r = spawnSync(HARNESS, ['export-project', 'p', at('out', 'p.tar.gz')], {
    env: { ...process.env, PROJECTS_DIR: at('from', 'projects'), ENGINES_DIR: at('from', 'engines'), HOME: at('from', 'home') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  mkdirSync(at('to', 'projects'), { recursive: true });
  write(at('to', 'harness.json'), { 'max-agents': 3, 'vm-disk-limit-gb': 120 });
  write(at('to', 'home', '.harness', 'vm-credentials.json'), { q: { github: { 'keychain-service': 'GitHub PAT (Other)' } } });
  mkdirSync(at('work', 'acme'), { recursive: true });
  git(at('work', 'acme'), 'init', '-q');
  mkdirSync(at('work', 'plain'));
  const env = { ...process.env, PROJECTS_DIR: at('to', 'projects'), ENGINES_DIR: at('to', 'engines'), HARNESS_FILE: at('to', 'harness.json'), HARNESS_LOCAL_FILE: at('to', 'harness.local.json'), HOME: at('to', 'home') };
  delete env.LIMA_HOME;
  const install = (...args) => spawnSync(HARNESS, ['install-project', ...args], { cwd: at('out'), env, encoding: 'utf8' });
  return { dir, at, env, install, bundle: at('out', 'p.tar.gz') };
}

// repack <s> <change> — the bundle unpacked, changed by change(folder), packed again; its path.
function repack(s, change) {
  const to = mkdtempSync(join(tmpdir(), 'install-project-bundle-'));
  execFileSync('tar', ['-xzf', s.bundle, '-C', to]);
  change(to);
  const out = s.at('out', 'changed.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', to, ...readdirSync(to)]);
  return out;
}

// snapshot <folder> — every file under it and its content, so a failed install can be shown to change nothing.
function snapshot(folder) {
  const files = {};
  const walk = d => readdirSync(d).forEach(n => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { files[relative(folder, p) + '/'] = ''; walk(p); } else files[relative(folder, p)] = readFileSync(p, 'utf8');
  });
  walk(folder);
  return files;
}

test('AC1: install-project makes data/projects/<project>/ with project.json, the golden image and the notes, sets lima-home in harness.local.json and merges the credentials', () => {
  const s = setup();
  const before = readFileSync(s.at('to', 'home', '.harness', 'vm-credentials.json'), 'utf8');
  const r = s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima'));
  assert.equal(r.status, 0, r.stderr);
  const p = json(s.at('to', 'projects', 'p', 'project.json'));
  assert.deepEqual(p['local-environments'], [{ name: 'local-pc', type: 'local-pc', folder: s.at('work', 'acme') }, { name: 'dev-container', type: 'dev-container' }]);
  assert.deepEqual(p.registry, { port: 5102, 'storage-path': 'projects/p/registry' });
  assert.deepEqual(p['golden-image'], { tools: ['pnpm'], folder: 'projects/p/golden-image' });
  assert.deepEqual(p.hindsight, { port: 8892 });
  assert.equal(readFileSync(s.at('to', 'projects', 'p', 'golden-image', 'template.yaml'), 'utf8'), 'video: none\n');
  assert.equal(readFileSync(s.at('to', 'projects', 'p', 'merge-request-considerations.md'), 'utf8'), '# Considerations\n');
  // The bundle's own files stay behind: no manifest or template in the project folder.
  assert.ok(!existsSync(s.at('to', 'projects', 'p', 'manifest.json')));
  assert.ok(!existsSync(s.at('to', 'projects', 'p', 'vm-credentials.template.json')));
  // The machine's Lima folder goes in the untracked harness.local.json; the tracked harness.json is untouched (ASS-281).
  assert.deepEqual(json(s.at('to', 'harness.local.json')), { 'lima-home': s.at('lima') });
  assert.equal(readFileSync(s.at('to', 'harness.json'), 'utf8'), JSON.stringify({ 'max-agents': 3, 'vm-disk-limit-gb': 120 }, null, 2));
  assert.deepEqual(json(s.at('to', 'home', '.harness', 'vm-credentials.json')), {
    q: { github: { 'keychain-service': 'GitHub PAT (Other)' } },
    p: { gitlab: { 'keychain-service': '{gitlab-keychain-service}', host: 'gitlab.com' }, git: { 'user-name': '{git-user-name}', 'user-email': '{git-user-email}' } },
  });
  const backups = readdirSync(s.at('to', 'home', '.harness')).filter(f => f.startsWith('vm-credentials.json.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(s.at('to', 'home', '.harness', backups[0]), 'utf8'), before);
});

test('AC1: it prints the remaining setup steps from the manifest and the placeholders still to fill', () => {
  const s = setup();
  const r = s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima'));
  assert.equal(r.status, 0, r.stderr);
  for (const text of ['{gitlab-keychain-service}', '{git-user-name}', '{git-user-email}', 'glab auth login', './agent.sh registry:up p', './agent.sh vm:build-golden p', './agent.sh memory:up p', 'hindsight.llm-api-key-keychain-service'])
    assert.ok(r.stdout.includes(text), `${text} in:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('{project-root}'));   // filled by the install
  assert.ok(r.stdout.indexOf('glab auth login') < r.stdout.indexOf('vm:build-golden'));   // in the manifest's order
});

test('AC6: the bundle\'s engines are unpacked into data/projects/<project>/engines/ and every engine the project uses resolves, its own first', () => {
  const s = setup();
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima')).status, 0);
  assert.deepEqual(json(s.at('to', 'projects', 'p', 'engines', 'test', 'state-engine.json')).steps[0].id, 'own');
  const resolve = engine => execFileSync('bash', ['-c', `source "${join(ROOT, 'src', 'agent-cli', 'engine.bash')}" && engine_path "$1" p`, '-', engine], { env: s.env, encoding: 'utf8' }).trim();
  assert.equal(resolve('dev'), s.at('to', 'engines', 'dev', 'state-engine.json'));
  assert.equal(resolve('build'), s.at('to', 'engines', 'build', 'state-engine.json'));
  assert.equal(resolve('test'), s.at('to', 'projects', 'p', 'engines', 'test', 'state-engine.json'));
});

test('without a vm-credentials.json it makes one holding the project, backing nothing up', () => {
  const s = setup();
  rmSync(s.at('to', 'home', '.harness'), { recursive: true });
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima')).status, 0);
  assert.deepEqual(Object.keys(json(s.at('to', 'home', '.harness', 'vm-credentials.json'))), ['p']);
  assert.deepEqual(readdirSync(s.at('to', 'home', '.harness')), ['vm-credentials.json']);
});

test('a project already in vm-credentials.json keeps its entry, saying so, unless --force', () => {
  const s = setup();
  const filled = { gitlab: { 'keychain-service': 'Mine', host: 'gitlab.com' } };
  write(s.at('to', 'home', '.harness', 'vm-credentials.json'), { p: filled });
  const r = s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /already declares.*p.*kept/);
  assert.deepEqual(json(s.at('to', 'home', '.harness', 'vm-credentials.json')), { p: filled });
  assert.ok(!r.stdout.includes('{gitlab-keychain-service}'));   // nothing left to fill in the kept entry
  const f = s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima'), '--force');
  assert.equal(f.status, 0, f.stderr);
  assert.equal(json(s.at('to', 'home', '.harness', 'vm-credentials.json')).p.gitlab['keychain-service'], '{gitlab-keychain-service}');
});

test('--force reinstalls over an installed project, replacing its golden image and engines and keeping its other files', () => {
  const s = setup();
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima')).status, 0);
  write(s.at('to', 'projects', 'p', 'golden-image', 'stale.sh'), 'old\n');
  write(s.at('to', 'projects', 'p', 'engines', 'stale', 'state-engine.json'), '{}');
  write(s.at('to', 'projects', 'p', 'backlog.json'), '{"tickets":[]}\n');
  const r = s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima'), '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(s.at('to', 'projects', 'p', 'golden-image', 'stale.sh')));
  assert.ok(!existsSync(s.at('to', 'projects', 'p', 'engines', 'stale')));
  assert.ok(existsSync(s.at('to', 'projects', 'p', 'golden-image', 'template.yaml')));
  assert.equal(readFileSync(s.at('to', 'projects', 'p', 'backlog.json'), 'utf8'), '{"tickets":[]}\n');
});

test('lima-home is written to harness.local.json as an absolute path; without --lima-home an absolute one already set there or in harness.json is kept, else ~/.lima (ASS-281)', () => {
  const s = setup();
  const tracked = readFileSync(s.at('to', 'harness.json'), 'utf8');
  mkdirSync(s.at('out', 'vms'));
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--lima-home', 'vms').status, 0);
  assert.equal(json(s.at('to', 'harness.local.json'))['lima-home'], s.at('out', 'vms'));
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--force').status, 0);
  assert.equal(json(s.at('to', 'harness.local.json'))['lima-home'], s.at('out', 'vms'));
  write(s.at('to', 'harness.local.json'), { other: 1 });
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--force').status, 0);
  assert.deepEqual(json(s.at('to', 'harness.local.json')), { other: 1, 'lima-home': s.at('to', 'home', '.lima') });
  assert.equal(readFileSync(s.at('to', 'harness.json'), 'utf8'), tracked);
  // An older install's lima-home in harness.json is carried over to harness.local.json, harness.json left as it is.
  rmSync(s.at('to', 'harness.local.json'));
  write(s.at('to', 'harness.json'), { 'max-agents': 3, 'lima-home': s.at('old') });
  assert.equal(s.install(s.bundle, '--project-root', s.at('work', 'acme'), '--force').status, 0);
  assert.deepEqual(json(s.at('to', 'harness.local.json')), { 'lima-home': s.at('old') });
  assert.deepEqual(json(s.at('to', 'harness.json')), { 'max-agents': 3, 'lima-home': s.at('old') });
});

test('a harness.local.json that is not a JSON object fails the install, changing nothing (ASS-281)', () => {
  const s = setup();
  write(s.at('to', 'harness.local.json'), '[]');
  fails(s, [s.bundle, ...root(s)], /harness\.local\.json is not a JSON object/);
});

// fails <s> <args> <pattern> — the install fails matching pattern, changing nothing on the installing side.
function fails(s, args, pattern) {
  const before = snapshot(s.at('to'));
  const r = s.install(...args);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, pattern);
  assert.deepEqual(snapshot(s.at('to')), before);
}
const root = s => ['--project-root', s.at('work', 'acme'), '--lima-home', s.at('lima')];

test('AC2: it fails, changing nothing, for a missing bundle or one that is not a bundle', () => {
  const s = setup();
  fails(s, [s.at('out', 'nope.tar.gz'), ...root(s)], /no bundle/);
  write(s.at('out', 'junk.tar.gz'), 'not a tarball');
  fails(s, [s.at('out', 'junk.tar.gz'), ...root(s)], /not a preset bundle/);
  fails(s, [repack(s, d => rmSync(join(d, 'manifest.json'))), ...root(s)], /no manifest\.json/);
  fails(s, [repack(s, d => writeFileSync(join(d, 'manifest.json'), '{not json')), ...root(s)], /manifest\.json/);
});

test('AC2: it fails, changing nothing, for an unknown manifest format', () => {
  const s = setup();
  for (const format of [2, null, '1']) {
    const bundle = repack(s, d => write(join(d, 'manifest.json'), { ...json(join(d, 'manifest.json')), format }));
    fails(s, [bundle, ...root(s)], /format/);
  }
});

test('AC2: it fails, changing nothing, when a file the manifest lists is missing from the bundle', () => {
  const s = setup();
  fails(s, [repack(s, d => rmSync(join(d, 'golden-image', 'template.yaml'))), ...root(s)], /golden-image\/template\.yaml/);
  fails(s, [repack(s, d => rmSync(join(d, 'project.json'))), ...root(s)], /project\.json/);
});

test('AC2: it fails, changing nothing, when a state engine is neither in the bundle nor in this harness\'s engines/', () => {
  const s = setup();
  rmSync(s.at('to', 'engines', 'build'), { recursive: true });
  fails(s, [s.bundle, ...root(s)], /state engine build/);
  const t = setup();
  fails(t, [repack(t, d => rmSync(join(d, 'engines'), { recursive: true })), ...root(t)], /engines\/test\/state-engine\.json/);
});

test('AC2: it fails, changing nothing, for a project root that is missing or not a git checkout', () => {
  const s = setup();
  fails(s, [s.bundle, '--project-root', s.at('work', 'gone'), '--lima-home', s.at('lima')], /no folder/);
  fails(s, [s.bundle, '--project-root', s.at('work', 'plain'), '--lima-home', s.at('lima')], /not a git checkout/);
  fails(s, [s.bundle, '--lima-home', s.at('lima')], /usage/);
});

test('AC2: it fails, changing nothing, for an installed project without --force', () => {
  const s = setup();
  assert.equal(s.install(s.bundle, ...root(s)).status, 0);
  fails(s, [s.bundle, ...root(s)], /p is already installed.*--force/);
});

test('it fails, changing nothing, for a bundle entry outside the bundle, or a project name that is not a folder name', () => {
  const s = setup();
  const link = repack(s, d => execFileSync('ln', ['-s', '/etc/hosts', join(d, 'golden-image', 'hosts')]));
  fails(s, [link, ...root(s)], /link/);
  const name = repack(s, d => write(join(d, 'manifest.json'), { ...json(join(d, 'manifest.json')), project: '../x' }));
  fails(s, [name, ...root(s)], /project/);
});
