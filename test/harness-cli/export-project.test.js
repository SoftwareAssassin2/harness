// export-project (ASS-274) — a project's setup as a private preset bundle: a
// temp data folder (PROJECTS_DIR), engines folder (ENGINES_DIR) and HOME with
// ~/.harness/vm-credentials.json stand in for the real ones; the keychain is
// never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const HARNESS = join(import.meta.dirname, '..', '..', 'harness.sh');
const write = (file, content) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const API_KEY = 'sk-ant-api03-' + 'x'.repeat(40);

// A project p as the live one keeps it: setup fields among runtime state, an
// email, a machine path and keychain service names; engines dev -> build ->
// test and dev's check-health-steps -> health; credentials for p and for q.
// Each engine named in `own` is written to the project's own engines folder
// (data/projects/p/engines/<name>, ASS-276) instead of engines/. `key` names
// the project's folder (and its credentials) in place of p (ASS-280).
function setup({ key = 'p', project = {}, engines = ['dev', 'build', 'test', 'health'], own = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-project-')));
  const at = (...p) => join(dir, ...p);
  write(at('projects', key, 'project.json'), {
    name: 'Acme',
    'execution-state-engine': 'dev',
    'dev-container': 'acme-devcontainer',
    'uses-points': true,
    'merge-request-area-of-interest': '',
    'highlighted-tickets': [{ ticket: 'ACME-1', color: '#ffff00' }],
    'local-environments': [
      { name: 'local-pc', type: 'local-pc', folder: '/Users/someone/src/acme', 'active-branch': 'main', 'ai-feedback-short': 'Healthy', 'ai-feedback-long': 'All good.', 'return-to': null },
      { name: 'dev-container', type: 'dev-container', status: 'Online', 'ai-feedback-short': 'Healthy', 'ai-feedback-long': 'Running.' },
    ],
    'work-sources': [{ name: 'Acme', type: 'jira', url: 'https://acme.atlassian.net/jira/software/c/projects/ACME/boards/1', 'story-points-field': 'customfield_1' }],
    repositories: [{
      url: 'https://gitlab.com/acme/app', description: 'The app.', status: 'Active', 'ai-feedback-short': 'Healthy', 'ai-feedback-long': 'Green.',
      'work-space': { 'server-name': null, branch: 'master', folder: null },
      'dev-container': { status: 'Stable', 'needs-rebuilt': false, 'server-name': null, 'base-image': null },
    }],
    'worktree-setup': 'pnpm install --frozen-lockfile',
    'max-tickets-in-progress': 4,
    'max-agents': 5,
    'expected-account': 'someone@acme.example',
    'check-for-expired-gcloud-auth': true,
    'check-for-expired-glab-auth': true,
    'dev-container-env': { HOST_PROJECT_PATH: '{folder}' },
    registry: { 'storage-path': 'projects/p/registry', 'max-size-gb': 60, port: 5102, upstream: { host: 'us-central1-docker.pkg.dev', credentials: 'gcloud' } },
    hindsight: { port: 8892, 'llm-api-key-keychain-service': 'Hindsight Key (Acme)' },
    'golden-image': { folder: 'projects/p/golden-image', tools: ['pnpm', 'go'] },
    'story-point-scale': [1, 2, 3, 5, 8],
    'raised-bug-priority': 'Critical',
    'max-spend-per-ticket-usd': 100,
    'merge-request-title': 'conventional',
    'vm-full-checks': 'Run bash scripts/validate.sh from /repos/<repo>/.',
    'background-work': [{ some: 'runtime' }],
    ...project,
  });
  write(at('projects', key, 'golden-image', 'template.yaml'), 'video: none\n');
  write(at('projects', key, 'golden-image', 'provision.sh'), '#!/usr/bin/env bash\necho provision\n');
  write(at('projects', key, 'merge-request-area-of-interest.md'), '# Merge Requests\n');
  write(at('projects', key, 'merge-request-considerations.md'), '# Considerations\n');
  write(at('projects', key, 'backlog.json'), '{"tickets":[]}\n');
  write(at('projects', key, 'hindsight', 'hindsight.pid'), '123\n');
  const step = (id, engine) => ({ id, sequence: 1, 'is-done': null, action: { type: 'state-engine', engine } });
  const all = {
    dev: { steps: [step('build', 'build'), { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }], 'check-health-steps': [step('check', 'health')] },
    build: { steps: [step('test', 'test')] },
    test: { steps: [{ id: 'test', sequence: 1, 'is-done': null, action: { type: 'prompt', prompt: 'test' } }] },
    health: { steps: [step('back', 'dev')] },
  };
  for (const name of engines) write(at('engines', name, 'state-engine.json'), all[name]);
  for (const name of own) write(at('projects', key, 'engines', name, 'state-engine.json'), all[name]);
  write(at('engines', 'unused', 'state-engine.json'), { steps: [] });
  write(at('home', '.harness', 'vm-credentials.json'), {
    [key]: {
      gitlab: { 'keychain-service': 'GitLab PAT (Acme)', host: 'gitlab.com', 'npm-registries': { '@acme': '123' } },
      atlassian: { 'keychain-service': 'Atlassian Key (Acme)', site: 'acme.atlassian.net', email: 'someone@acme.example' },
      anthropic: { 'keychain-service': 'Anthropic Key (Acme)' },
      git: { 'user-name': 'Some One', 'user-email': 'someone@acme.example' },
    },
    q: { github: { 'keychain-service': 'GitHub PAT (Other)' } },
  });
  mkdirSync(at('out'));
  const env = { ...process.env, PROJECTS_DIR: at('projects'), ENGINES_DIR: at('engines'), HOME: at('home') };
  const exportProject = (...args) => spawnSync(HARNESS, ['export-project', ...args], { cwd: at('out'), env, encoding: 'utf8' });
  // unpack <tarball> — the bundle's files (relative paths) and a reader for them.
  const unpack = tarball => {
    const to = mkdtempSync(join(tmpdir(), 'export-project-bundle-'));
    execFileSync('tar', ['-xzf', tarball, '-C', to]);
    const files = [];
    const walk = d => readdirSync(d).forEach(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : files.push(relative(to, join(d, n)))));
    walk(to);
    return { files: files.sort(), text: f => readFileSync(join(to, f), 'utf8'), json: f => JSON.parse(readFileSync(join(to, f), 'utf8')), mode: f => statSync(join(to, f)).mode };
  };
  return { dir, at, exportProject, unpack };
}

test('export-project writes the bundle to the given file, printing its path', () => {
  const s = setup();
  const out = s.at('out', 'acme.tar.gz');
  const r = s.exportProject('p', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), out);
  const b = s.unpack(out);
  assert.deepEqual(b.files, [
    'golden-image/provision.sh', 'golden-image/template.yaml', 'manifest.json',
    'merge-request-area-of-interest.md', 'merge-request-considerations.md', 'project.json', 'vm-credentials.template.json',
  ]);
  assert.equal(b.text('golden-image/template.yaml'), 'video: none\n');
  assert.equal(b.text('merge-request-area-of-interest.md'), '# Merge Requests\n');
  // tar entries carry no owner name of the exporting machine.
  assert.doesNotMatch(execFileSync('tar', ['-tvzf', out], { encoding: 'utf8' }), new RegExp(process.env.USER || 'no-user-set'));
});

test('export-project defaults the bundle to ./<project>-preset.tar.gz', () => {
  const s = setup();
  const r = s.exportProject('p');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), s.at('out', 'p-preset.tar.gz'));
  assert.ok(existsSync(s.at('out', 'p-preset.tar.gz')));
});

test('the exported project.json keeps only the setup fields: no runtime state, machine path, email or keychain service name', () => {
  const s = setup();
  assert.equal(s.exportProject('p', 'b.tar.gz').status, 0);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.json('project.json'), {
    name: 'Acme',
    'execution-state-engine': 'dev',
    'dev-container': 'acme-devcontainer',
    'uses-points': true,
    'merge-request-area-of-interest': '',
    'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: '{project-root}' }, { name: 'dev-container', type: 'dev-container' }],
    'work-sources': [{ name: 'Acme', type: 'jira', url: 'https://acme.atlassian.net/jira/software/c/projects/ACME/boards/1', 'story-points-field': 'customfield_1' }],
    repositories: [{ url: 'https://gitlab.com/acme/app', description: 'The app.', 'work-space': { branch: 'master' } }],
    'worktree-setup': 'pnpm install --frozen-lockfile',
    'max-tickets-in-progress': 4,
    'max-agents': 5,
    'check-for-expired-gcloud-auth': true,
    'check-for-expired-glab-auth': true,
    'dev-container-env': { HOST_PROJECT_PATH: '{folder}' },
    registry: { 'max-size-gb': 60, port: 5102, upstream: { host: 'us-central1-docker.pkg.dev', credentials: 'gcloud' } },
    hindsight: { port: 8892 },
    'golden-image': { tools: ['pnpm', 'go'] },
    'story-point-scale': [1, 2, 3, 5, 8],
    'raised-bug-priority': 'Critical',
    'max-spend-per-ticket-usd': 100,
    'merge-request-title': 'conventional',
    'vm-full-checks': 'Run bash scripts/validate.sh from /repos/<repo>/.',
  });
});

test("the credentials template keeps each kind's shape, its keychain service names, user names and emails as placeholders", () => {
  const s = setup();
  assert.equal(s.exportProject('p', 'b.tar.gz').status, 0);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.json('vm-credentials.template.json'), {
    gitlab: { 'keychain-service': '{gitlab-keychain-service}', host: 'gitlab.com', 'npm-registries': { '@acme': '123' } },
    atlassian: { 'keychain-service': '{atlassian-keychain-service}', site: 'acme.atlassian.net', email: '{atlassian-email}' },
    anthropic: { 'keychain-service': '{anthropic-keychain-service}' },
    git: { 'user-name': '{git-user-name}', 'user-email': '{git-user-email}' },
  });
});

test('the manifest names the format, project, engines, harness commit, placeholders and setup steps', () => {
  const s = setup();
  assert.equal(s.exportProject('p', 'b.tar.gz').status, 0);
  const m = s.unpack(s.at('out', 'b.tar.gz')).json('manifest.json');
  assert.equal(m.format, 1);
  assert.equal(m.project, 'p');
  assert.equal(m['execution-state-engine'], 'dev');
  assert.deepEqual(m['state-engines'], ['build', 'dev', 'health', 'test']);
  assert.deepEqual(m['project-engines'], []);   // none of its own: no engines/ in the bundle (ASS-276)
  assert.equal(m['harness-commit'], execFileSync('git', ['-C', join(import.meta.dirname, '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.match(m['exported-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(Object.keys(m.placeholders).sort(), [
    '{anthropic-keychain-service}', '{atlassian-email}', '{atlassian-keychain-service}', '{git-user-email}', '{git-user-name}',
    '{gitlab-keychain-service}', '{project-root}',
  ]);
  assert.deepEqual(m.setup.map(step => step.step), [
    'keychain-item', 'keychain-item', 'keychain-item', 'keychain-item', 'gcloud-login', 'glab-login', 'registry-up', 'golden-build', 'memory-up',
  ]);
  assert.deepEqual(m.setup.filter(step => step.step === 'keychain-item').map(step => step.for), ['gitlab', 'atlassian', 'anthropic', 'hindsight']);
  assert.deepEqual(m.setup.find(step => step.step === 'golden-build').command, './agent.sh vm:build-golden p');
  assert.deepEqual(m.setup.find(step => step.step === 'memory-up').command, './agent.sh memory:up p');
});

test('a project with no credentials, golden image, registry, hindsight or auth checks needs no setup steps', () => {
  const s = setup({ project: { registry: undefined, hindsight: undefined, 'golden-image': undefined, 'check-for-expired-gcloud-auth': false, 'check-for-expired-glab-auth': false } });
  writeFileSync(s.at('home', '.harness', 'vm-credentials.json'), '{}');
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.json('vm-credentials.template.json'), {});
  assert.deepEqual(b.json('manifest.json').setup, []);
  assert.ok(b.files.includes('golden-image/template.yaml'));   // the folder is copied whenever the project has one
});

test('a Hindsight API key in project.json is never copied or printed', () => {
  const s = setup({ project: { hindsight: { port: 8892, 'llm-api-key': API_KEY } } });
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(API_KEY));
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  for (const f of b.files) assert.ok(!b.text(f).includes(API_KEY), f);
  assert.deepEqual(b.json('project.json').hindsight, { port: 8892 });
  assert.ok(b.json('manifest.json').setup.some(step => step.for === 'hindsight'));
});

// fails <s> <pattern> — the export fails matching pattern, writing no bundle.
const fails = (s, pattern) => {
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, pattern);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(s.at('out')), []);
};

test('export-project fails, writing nothing, for a missing project', () => {
  const s = setup();
  const r = s.exportProject('nope', 'b.tar.gz');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no project nope/);
  assert.deepEqual(readdirSync(s.at('out')), []);
});

test('export-project fails, writing nothing, when an engine the project uses is not in engines/', () => {
  fails(setup({ engines: ['dev', 'build', 'health'] }), /state engine test, which is not in engines\//);
  fails(setup({ engines: [] }), /state engine dev, which is not in engines\//);
});

test('export-project fails, writing nothing, naming the file, when the bundle holds a token-shaped string', () => {
  for (const token of ['glpat-' + 'a'.repeat(20), 'ghp_' + 'A'.repeat(36), 'github_pat_' + 'B'.repeat(30), API_KEY, 'AIza' + 'C'.repeat(35), '-----BEGIN OPENSSH PRIVATE KEY-----']) {
    const s = setup();
    write(s.at('projects', 'p', 'golden-image', 'provision.sh'), `#!/usr/bin/env bash\nTOKEN=${token}\n`);
    fails(s, /golden-image\/provision\.sh/);
  }
  const s = setup({ project: { 'worktree-setup': `TOKEN=glpat-${'z'.repeat(20)} pnpm install` } });
  fails(s, /project\.json/);
});

test('export-project fails, writing nothing, when a kept field holds an email or machine path, or a file a keychain service name', () => {
  fails(setup({ project: { 'worktree-setup': 'git config user.email someone@acme.example' } }), /project\.json.*email/);
  fails(setup({ project: { 'vm-full-checks': 'cd /Volumes/Disk/acme && make' } }), /project\.json.*machine path/);
  const s = setup();
  write(s.at('projects', 'p', 'merge-request-considerations.md'), 'Read with the GitLab PAT (Acme) item.\n');
  fails(s, /merge-request-considerations\.md.*keychain/);
});

// ASS-276 AC2: the project's own engines folder travels in the bundle as
// engines/…, the manifest naming the engines in it; the engine check finds an
// engine there or in engines/.
test('ASS-276 AC2: export-project bundles data/projects/<project>/engines/ as engines/ and lists its engines as project-engines', () => {
  const s = setup({ engines: ['dev', 'build'], own: ['test', 'health'] });
  write(s.at('projects', 'p', 'engines', 'notes.md'), '# Our engines\n');
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.files.filter(f => f.startsWith('engines/')), ['engines/health/state-engine.json', 'engines/notes.md', 'engines/test/state-engine.json']);
  assert.deepEqual(b.json('engines/test/state-engine.json'), { steps: [{ id: 'test', sequence: 1, 'is-done': null, action: { type: 'prompt', prompt: 'test' } }] });
  assert.equal(b.text('engines/notes.md'), '# Our engines\n');
  const m = b.json('manifest.json');
  assert.equal(m.format, 1);
  assert.deepEqual(m['state-engines'], ['build', 'dev', 'health', 'test']);
  assert.deepEqual(m['project-engines'], ['health', 'test']);
  assert.ok(m.files.includes('engines/test/state-engine.json'));
});

test('ASS-276 AC2: the engine walk follows a grouped engine into a sub-engine only the project has, its own copy of a shared engine winning', () => {
  const s = setup({ engines: ['dev', 'build', 'test', 'health'], own: ['build'] });
  rmSync(s.at('engines', 'test'), { recursive: true });
  write(s.at('projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [] });
  write(s.at('projects', 'p', 'engines', 'build', 'state-engine.json'), { steps: [{ id: 'own', sequence: 1, 'is-done': null, action: { type: 'state-engine', engine: 'test' } }] });
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.json('manifest.json')['state-engines'], ['build', 'dev', 'health', 'test']);
  assert.deepEqual(b.json('manifest.json')['project-engines'], ['build', 'test']);
  assert.equal(b.json('engines/build/state-engine.json').steps[0].id, 'own');
});

test('ASS-276 AC2: the execution engine itself may be the project\'s own; one in neither place still fails the export', () => {
  const s = setup({ engines: [], own: ['dev', 'build', 'test', 'health'] });
  const r = s.exportProject('p', 'b.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.unpack(s.at('out', 'b.tar.gz')).json('manifest.json')['project-engines'], ['build', 'dev', 'health', 'test']);
  fails(setup({ engines: ['dev'], own: ['build', 'health'] }), /state engine test, which is not in engines\/ or data\/projects\/p\/engines\//);
});

test('ASS-276 AC2: the scan covers the project\'s engines too', () => {
  const s = setup({ engines: ['dev', 'build', 'health'], own: ['test'] });
  write(s.at('projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [], note: 'see /Users/someone/notes' });
  fails(s, /engines\/test\/state-engine\.json.*machine path/);
});

// ASS-280: --as <key> and --name <display name> export the project under
// another name, in the bundle only. Every whole-word occurrence of the source
// key in the bundle's text files is replaced: a word being a run of a key's
// own characters (letters, digits, _ and -), so acme-shop's and
// data/projects/acme-shop/ change while acmeshop-app and acme-shop-app, other
// identifiers that only contain the key, are kept.
const GOLDEN = '# The acme-shop golden VM: ./agent.sh vm:build-golden acme-shop\n'
  + '# built from data/projects/acme-shop/golden-image; acme-shop\'s repos are acmeshop-app and acme-shop-app.\n'
  + 'docker network create acmeshop\n';
const renamed = s => {
  write(s.at('projects', 'acme-shop', 'golden-image', 'template.yaml'), GOLDEN);
  write(s.at('projects', 'acme-shop', 'merge-request-considerations.md'), 'Every acme-shop merge request runs acmeshop-ci.\n');
  return s;
};

test('ASS-280 AC1: --as and --name rename the project in the bundle, written to ./<new key>-preset.tar.gz by default', () => {
  const s = renamed(setup({ key: 'acme-shop' }));
  const r = s.exportProject('acme-shop', '--as', 'engineering', '--name', 'Engineering');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), s.at('out', 'engineering-preset.tar.gz'));
  const b = s.unpack(s.at('out', 'engineering-preset.tar.gz'));
  const m = b.json('manifest.json');
  assert.equal(m.project, 'engineering');
  assert.equal(m.setup.find(step => step.step === 'registry-up').command, './agent.sh registry:up engineering');
  assert.equal(m.setup.find(step => step.step === 'golden-build').command, './agent.sh vm:build-golden engineering');
  assert.equal(m.setup.find(step => step.step === 'memory-up').command, './agent.sh memory:up engineering');
  assert.equal(b.json('project.json').name, 'Engineering');
  assert.equal(b.text('golden-image/template.yaml'), '# The engineering golden VM: ./agent.sh vm:build-golden engineering\n'
    + '# built from data/projects/engineering/golden-image; engineering\'s repos are acmeshop-app and acme-shop-app.\n'
    + 'docker network create acmeshop\n');
  assert.equal(b.text('merge-request-considerations.md'), 'Every engineering merge request runs acmeshop-ci.\n');
  // the files keep their modes; the operator's own project is untouched.
  assert.equal(b.mode('golden-image/provision.sh') & 0o777, statSync(s.at('projects', 'acme-shop', 'golden-image', 'provision.sh')).mode & 0o777);
  assert.equal(readFileSync(s.at('projects', 'acme-shop', 'golden-image', 'template.yaml'), 'utf8'), GOLDEN);
  assert.equal(JSON.parse(readFileSync(s.at('projects', 'acme-shop', 'project.json'), 'utf8')).name, 'Acme');
});

test('ASS-280 AC1: --name defaults to the current name, and the options may come after the out-file', () => {
  const s = renamed(setup({ key: 'acme-shop' }));
  const r = s.exportProject('acme-shop', 'b.tar.gz', '--as', 'engineering');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), s.at('out', 'b.tar.gz'));
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.equal(b.json('manifest.json').project, 'engineering');
  assert.equal(b.json('project.json').name, 'Acme');
  const named = s.exportProject('acme-shop', 'c.tar.gz', '--name', 'Engineering');   // a new name alone keeps the key
  assert.equal(named.status, 0, named.stderr);
  const c = s.unpack(s.at('out', 'c.tar.gz'));
  assert.equal(c.json('manifest.json').project, 'acme-shop');
  assert.equal(c.json('project.json').name, 'Engineering');
});

// prefixed — a project acme-shop whose own engines are acme-dev (steps ->
// acme-build, check-health-steps -> health) and acme-build (-> the shared
// test, review-steps -> acme-dev), formatted as an operator writes them, with
// the shared engines test and health in engines/.
const prefixed = () => {
  const s = setup({ key: 'acme-shop', engines: ['test'], project: { 'execution-state-engine': 'acme-dev' } });
  write(s.at('engines', 'health', 'state-engine.json'), { steps: [] });
  const engine = (name, text) => write(s.at('projects', 'acme-shop', 'engines', name, 'state-engine.json'), text);
  engine('acme-dev', '{\n    "steps": [{ "id": "build", "action": { "type": "state-engine", "engine": "acme-build" } }],\n'
    + '    "check-health-steps": [{ "id": "check", "action": {"type":"state-engine","engine":"health"} }],\n'
    + '    "note": "acme-dev runs acme-build"\n}\n');
  engine('acme-build', '{ "steps": [ { "id": "test", "action": { "type": "state-engine", "engine" : "test" } } ],\n'
    + '  "review-steps": [ { "id": "again", "action": { "type": "state-engine", "engine": "acme-dev" } } ] }\n');
  return s;
};

test('ASS-280 AC2: --engine-prefix renames the bundle\'s own engines with that prefix, folders and every reference', () => {
  const s = prefixed();
  const r = s.exportProject('acme-shop', 'b.tar.gz', '--as', 'engineering', '--engine-prefix', 'acme=engineering');
  assert.equal(r.status, 0, r.stderr);
  const b = s.unpack(s.at('out', 'b.tar.gz'));
  assert.deepEqual(b.files.filter(f => f.startsWith('engines/')), ['engines/engineering-build/state-engine.json', 'engines/engineering-dev/state-engine.json']);
  const m = b.json('manifest.json');
  assert.equal(m['execution-state-engine'], 'engineering-dev');
  assert.deepEqual(m['state-engines'], ['engineering-build', 'engineering-dev', 'health', 'test']);
  assert.deepEqual(m['project-engines'], ['engineering-build', 'engineering-dev']);
  assert.ok(m.files.includes('engines/engineering-dev/state-engine.json'));
  assert.equal(b.json('project.json')['execution-state-engine'], 'engineering-dev');
  // only the references change, the rest of each engine's text as it was
  // (a mention of an engine's name in prose is not a reference).
  assert.equal(b.text('engines/engineering-dev/state-engine.json'),
    '{\n    "steps": [{ "id": "build", "action": { "type": "state-engine", "engine": "engineering-build" } }],\n'
    + '    "check-health-steps": [{ "id": "check", "action": {"type":"state-engine","engine":"health"} }],\n'
    + '    "note": "acme-dev runs acme-build"\n}\n');
  assert.equal(b.text('engines/engineering-build/state-engine.json'),
    '{ "steps": [ { "id": "test", "action": { "type": "state-engine", "engine" : "test" } } ],\n'
    + '  "review-steps": [ { "id": "again", "action": { "type": "state-engine", "engine": "engineering-dev" } } ] }\n');
  // the operator's own engines keep their names and content.
  assert.deepEqual(readdirSync(s.at('projects', 'acme-shop', 'engines')).sort(), ['acme-build', 'acme-dev']);
  assert.match(readFileSync(s.at('projects', 'acme-shop', 'engines', 'acme-dev', 'state-engine.json'), 'utf8'), /"engine": "acme-build"/);
  assert.equal(JSON.parse(readFileSync(s.at('projects', 'acme-shop', 'project.json'), 'utf8'))['execution-state-engine'], 'acme-dev');
});

test('ASS-280 AC2: the renamed bundle, installed as data/projects/<new key>/, resolves its engines', () => {
  const s = prefixed();
  assert.equal(s.exportProject('acme-shop', 'b.tar.gz', '--as', 'engineering', '--engine-prefix', 'acme=engineering').status, 0);
  // install-project (ASS-275) unpacks the bundle as the project's folder; the
  // engine walk of a second export then finds every engine it names.
  mkdirSync(s.at('projects', 'engineering'));
  execFileSync('tar', ['-xzf', s.at('out', 'b.tar.gz'), '-C', s.at('projects', 'engineering')]);
  const r = s.exportProject('engineering', 'again.tar.gz');
  assert.equal(r.status, 0, r.stderr);
  const m = s.unpack(s.at('out', 'again.tar.gz')).json('manifest.json');
  assert.deepEqual(m['state-engines'], ['engineering-build', 'engineering-dev', 'health', 'test']);
  assert.deepEqual(m['project-engines'], ['engineering-build', 'engineering-dev']);
});

// failsWith <s> <args> <pattern> — export-project <args…> fails matching
// pattern, writing nothing.
const failsWith = (s, args, pattern) => {
  const r = s.exportProject(...args);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, pattern);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(s.at('out')), []);
};

test('ASS-280 AC3: an invalid --as key, --engine-prefix or option fails, writing nothing', () => {
  const s = prefixed();
  for (const key of ['bad key', '../x', '', 'a/b']) failsWith(s, ['acme-shop', 'b.tar.gz', '--as', key], /invalid --as key/);
  failsWith(s, ['acme-shop', 'b.tar.gz', '--name', ''], /--name/);
  for (const prefix of ['acme', 'acme=', '=engineering', 'acme=bad prefix']) failsWith(s, ['acme-shop', 'b.tar.gz', '--engine-prefix', prefix], /invalid --engine-prefix/);
  failsWith(s, ['acme-shop', 'b.tar.gz', '--as'], /usage/);
  failsWith(s, ['acme-shop', 'b.tar.gz', '--bogus'], /usage/);
});

test('ASS-280 AC3: an --engine-prefix that would rename a shared engine, or one a shared engine names, fails, writing nothing', () => {
  const t = prefixed();
  rmSync(t.at('engines', 'test'), { recursive: true });
  write(t.at('engines', 'acme-test', 'state-engine.json'), { steps: [] });
  write(t.at('projects', 'acme-shop', 'engines', 'acme-build', 'state-engine.json'), { steps: [{ id: 'test', action: { type: 'state-engine', engine: 'acme-test' } }] });
  failsWith(t, ['acme-shop', 'b.tar.gz', '--engine-prefix', 'acme=engineering'], /shared engine acme-test/);
  // a shared engine naming one of the project's engines would lose it.
  const u = prefixed();
  write(u.at('engines', 'health', 'state-engine.json'), { steps: [{ id: 'back', action: { type: 'state-engine', engine: 'acme-dev' } }] });
  failsWith(u, ['acme-shop', 'b.tar.gz', '--engine-prefix', 'acme=engineering'], /shared engine health names acme-dev/);
});

test('ASS-280 AC3: an --engine-prefix whose new name collides with an existing engine fails, writing nothing', () => {
  const s = prefixed();
  write(s.at('engines', 'engineering-dev', 'state-engine.json'), { steps: [] });   // unused, but the installing harness has it
  failsWith(s, ['acme-shop', 'b.tar.gz', '--engine-prefix', 'acme=engineering'], /engineering-dev.*already/);
  const t = prefixed();
  write(t.at('projects', 'acme-shop', 'engines', 'engineering-build', 'state-engine.json'), { steps: [] });   // the project's own
  failsWith(t, ['acme-shop', 'b.tar.gz', '--engine-prefix', 'acme=engineering'], /engineering-build.*already/);
});
