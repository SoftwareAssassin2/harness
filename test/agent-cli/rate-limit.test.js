// project:set-rate-limit / project:clear-rate-limit — the rate limit an agent
// hit, recorded in projects/<p>/rate-limit.json (ASS-94; never project.json)
// for the dashboard and control's hold, one entry per credential kind (ASS-215).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'rl-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const read = dir => JSON.parse(readFileSync(join(dir, 'p', 'project.json'), 'utf8'));

const limitFile = dir => join(dir, 'p', 'rate-limit.json');
const limit = dir => existsSync(limitFile(dir)) ? JSON.parse(readFileSync(limitFile(dir), 'utf8')) : undefined;

test('project:set-rate-limit <project> <kind> writes { <kind>: { since, type, resets-at } } to rate-limit.json, project.json untouched; setting it again keeps since; clear deletes the file (ASS-215)', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await cli(dir, 'project:set-rate-limit', 'p', 'claude', 'five_hour', '2026-10-11T13:00:00Z');
  const first = limit(dir).claude;
  assert.match(first.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(limit(dir), { claude: { since: first.since, type: 'five_hour', 'resets-at': '2026-10-11T13:00:00Z' } });
  await new Promise(r => setTimeout(r, 1100));                        // a later second: since must still be the first
  await cli(dir, 'project:set-rate-limit', 'p', 'claude', 'seven_day', '2026-10-18T13:00:00Z');
  assert.deepEqual(limit(dir), { claude: { since: first.since, type: 'seven_day', 'resets-at': '2026-10-18T13:00:00Z' } });
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  await cli(dir, 'project:clear-rate-limit', 'p', 'claude');
  assert.equal(limit(dir), undefined);
  await cli(dir, 'project:clear-rate-limit', 'p', 'claude');           // nothing to clear: still fine
  assert.equal(limit(dir), undefined);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
});

test('ASS-215 AC3: two kinds in one file each keep their own since; clearing one leaves the other, a kind never set is a no-op, and the file goes only with the last kind', async () => {
  const dir = projects();
  await cli(dir, 'project:set-rate-limit', 'p', 'claude', 'five_hour', '2026-10-11T13:00:00Z');
  const claude = limit(dir).claude;
  await new Promise(r => setTimeout(r, 1100));
  await cli(dir, 'project:set-rate-limit', 'p', 'anthropic', 'seven_day', '2026-10-18T13:00:00Z');
  const both = limit(dir);
  assert.deepEqual(Object.keys(both).sort(), ['anthropic', 'claude']);
  assert.deepEqual(both.claude, claude);
  assert.notEqual(both.anthropic.since, claude.since);
  assert.deepEqual({ ...both.anthropic, since: 'now' }, { since: 'now', type: 'seven_day', 'resets-at': '2026-10-18T13:00:00Z' });
  await cli(dir, 'project:clear-rate-limit', 'p', 'claude');
  assert.deepEqual(limit(dir), { anthropic: both.anthropic });
  await cli(dir, 'project:clear-rate-limit', 'p', 'claude');           // never set now: the file untouched
  assert.deepEqual(limit(dir), { anthropic: both.anthropic });
  await cli(dir, 'project:clear-rate-limit', 'p', 'anthropic');
  assert.equal(limit(dir), undefined);
});

test('ASS-215 AC3: a flat rate-limit.json from before kinds is replaced, not merged, when a kind is set on it', async () => {
  const dir = projects();
  writeFileSync(limitFile(dir), JSON.stringify({ since: '2026-10-01T00:00:00Z', type: 'five_hour', 'resets-at': '2026-10-01T05:00:00Z' }));
  await cli(dir, 'project:set-rate-limit', 'p', 'anthropic', 'seven_day', '2026-10-18T13:00:00Z');
  const now = limit(dir);
  assert.deepEqual(Object.keys(now), ['anthropic']);
  assert.notEqual(now.anthropic.since, '2026-10-01T00:00:00Z');
});

test('project:set-rate-limit run many times at once keeps one since — the first writer creates the file under the lock', async () => {
  const dir = projects();
  await Promise.all(Array.from({ length: 10 }, (_, i) => cli(dir, 'project:set-rate-limit', 'p', 'claude', `t${i}`, '2026-10-11T13:00:00Z')));
  assert.match(limit(dir).claude.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(limit(dir).claude.type, /^t\d$/);
});

test('both fail, writing nothing, on a bad time, type, kind, project or usage', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'p', 'claude', 'five_hour', 'soon'), /ISO/);
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'p', 'claude', 'five hour', '2026-10-11T13:00:00Z'), /type/);
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'p', 'openai', 'five_hour', '2026-10-11T13:00:00Z'), /kind/);
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'p', 'five_hour', '2026-10-11T13:00:00Z'), /usage/);   // the kind left out
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'p'), /usage/);
  await assert.rejects(cli(dir, 'project:set-rate-limit', '../p', 'claude', 'five_hour', '2026-10-11T13:00:00Z'), /invalid project/);
  await assert.rejects(cli(dir, 'project:set-rate-limit', 'q', 'claude', 'five_hour', '2026-10-11T13:00:00Z'), /no project q/);
  await assert.rejects(cli(dir, 'project:clear-rate-limit'), /usage/);
  await assert.rejects(cli(dir, 'project:clear-rate-limit', 'p'), /usage/);                                     // the kind left out
  await assert.rejects(cli(dir, 'project:clear-rate-limit', 'p', 'openai'), /kind/);
  await assert.rejects(cli(dir, 'project:clear-rate-limit', 'q', 'claude'), /no project q/);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, 'p')), ['project.json']);
  assert.equal(existsSync(join(dir, 'q')), false);
});

for (const tool of ['gcloud', 'glab']) test(`project:set-${tool}-reauthentication writes exactly true or false to its own file (ASS-58), project.json untouched; anything else fails, writing nothing`, async () => {
  const dir = projects();
  const command = `project:set-${tool}-reauthentication`;
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  const flag = () => readFileSync(join(dir, 'p', `${tool}-requires-reauthentication`), 'utf8');
  await cli(dir, command, 'p', 'true');
  assert.equal(flag(), 'true');
  await cli(dir, command, 'p', 'false');
  assert.equal(flag(), 'false');
  await assert.rejects(cli(dir, command, 'p', 'yes'), /true or false/);
  await assert.rejects(cli(dir, command, '../p', 'true'), /invalid project/);
  await assert.rejects(cli(dir, command, 'p'), /usage/);
  await assert.rejects(cli(dir, command, 'q', 'true'), /no project q/);
  assert.equal(flag(), 'false');
  assert.equal(existsSync(join(dir, 'q')), false);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, 'p')).toSorted(), [`${tool}-requires-reauthentication`, 'project.json']);   // no temp file left beside it
});

test('the live files leave the harness checkout clean: set and clear a rate limit and the gcloud and glab flags, and git status --porcelain data/projects/ stays empty under the repo\'s own .gitignore, each file ignored by its own line (ASS-58, ASS-94)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'gi-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  copyFileSync(join(import.meta.dirname, '..', '..', '.gitignore'), join(repo, '.gitignore'));
  mkdirSync(join(repo, 'data', 'projects', 'p'), { recursive: true });
  writeFileSync(join(repo, 'data', 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const dir = join(repo, 'data', 'projects');
  const clean = () => assert.equal(git('status', '--porcelain', '--untracked-files=all', 'data/projects/'), '');
  await cli(dir, 'project:set-rate-limit', 'p', 'claude', 'five_hour', '2026-10-11T13:00:00Z');
  await cli(dir, 'project:set-gcloud-reauthentication', 'p', 'true');
  await cli(dir, 'project:set-glab-reauthentication', 'p', 'true');
  clean();
  for (const file of ['rate-limit.json', 'gcloud-requires-reauthentication', 'glab-requires-reauthentication']) {
    assert.match(git('check-ignore', '-v', `data/projects/p/${file}`), new RegExp(`^\\.gitignore:\\d+:/data/projects/\\*/${file.replace('.', '\\.')}\\t`));
  }
  await cli(dir, 'project:clear-rate-limit', 'p', 'claude');
  await cli(dir, 'project:set-gcloud-reauthentication', 'p', 'false');
  await cli(dir, 'project:set-glab-reauthentication', 'p', 'false');
  clean();
});
