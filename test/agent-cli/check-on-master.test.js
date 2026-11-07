// project:check-on-master (ASS-163 AC1) — the operator's decision box, made
// deterministic: is the failure Troubleshoot attributed to a project's own
// code a problem on the latest master? The project's master CI for the same
// job is asked, read-only (glab for GitLab, gh for GitHub): the latest
// finished master pipeline that ran the job, and its result. Failed there:
// present (exit 0) — a project bug may be raised; passed: absent (exit 3) —
// our environment or access; no such job, an unfinished result, nothing
// named, or the forge unreachable: unknown (exit 4) — not proven, no bug,
// the operator asked. The evidence is printed either way. On the harness
// project (its project issues are the harness's own backlog) nothing is
// checked (exit 2). glab and gh are test/support/fake-forge.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const GITLAB = 'https://gitlab.com/example/identity';
const GITHUB = 'https://github.com/o/tools';
const PIPELINE = id => ({ id, sha: `sha${id}`, web_url: `${GITLAB}/-/pipelines/${id}` });
const JOB = (name, status) => ({ name, status, web_url: `${GITLAB}/-/jobs/9${status.length}` });

function project() {
  const f = fixture(), forge = fakeForge();
  const env = { ...f.env, PATH: forge.path };
  const check = (...args) => run(AGENT, ['project:check-on-master', ...args], { env }).then(r => ({ code: 0, out: JSON.parse(r.stdout) }), e => ({ code: e.code, out: e.stdout ? JSON.parse(e.stdout) : undefined, stderr: e.stderr }));
  const edit = (path, change) => { const file = join(f.dir, ...path); const j = JSON.parse(readFileSync(file, 'utf8')); change(j); writeFileSync(file, JSON.stringify(j)); };
  return { ...f, forge, check, edit };
}
const pipelines = (f, list, ref = 'master') => f.forge.route('glab', new RegExp(`^api projects/example%2Fidentity/pipelines\\?ref=${ref}&scope=finished&per_page=20 --hostname gitlab\\.com$`), { out: list });
const jobs = (f, id, list) => f.forge.route('glab', new RegExp(`^api projects/example%2Fidentity/pipelines/${id}/jobs\\?per_page=100 --hostname gitlab\\.com$`), { out: list });
const forgeCalls = f => [...f.forge.log('glab'), ...f.forge.log('gh')].filter(l => l !== 'auth status');

test('AC1/AC2: a job that failed on the latest master pipeline is present on master (exit 0), the pipeline, commit and job given as evidence', async () => {
  const f = project();
  pipelines(f, [PIPELINE(12)]);
  jobs(f, 12, [JOB('lint', 'success'), JOB('test:keycloak', 'failed')]);
  const { code, out } = await f.check('p', GITLAB, 'test:keycloak');
  assert.equal(code, 0);
  assert.equal(out['on-master'], 'present');
  assert.equal(out['master-evidence'], `${GITLAB} master: job test:keycloak failed — ${GITLAB}/-/jobs/96, pipeline ${GITLAB}/-/pipelines/12 at sha12`);
  assert.ok(forgeCalls(f).every(c => c.startsWith('api projects/') && !/-X|--method/.test(c)), 'read-only GETs');
});

test('AC1/AC3: a job that passed on the latest master pipeline is absent on master (exit 3): our environment or access', async () => {
  const f = project();
  pipelines(f, [PIPELINE(12)]);
  jobs(f, 12, [JOB('test:keycloak', 'success')]);
  const { code, out } = await f.check('p', `${GITLAB}.git/`, 'test:keycloak');
  assert.equal(code, 3);
  assert.equal(out['on-master'], 'absent');
  assert.match(out['master-evidence'], /job test:keycloak success — .*pipeline .*\/pipelines\/12 at sha12$/);
});

test('AC1: the latest master pipeline that ran the job is the one read — a newer one without it is passed over; the branch is the one project.json gives the repository, master by default', async () => {
  const f = project();
  f.edit(['projects', 'p', 'project.json'], p => { p.repositories = [{ url: `${GITLAB}.git`, 'work-space': { branch: 'main' } }]; });
  pipelines(f, [PIPELINE(13), PIPELINE(12)], 'main');
  jobs(f, 13, [JOB('docs', 'success')]);
  jobs(f, 12, [JOB('test:keycloak', 'failed')]);
  const { code, out } = await f.check('p', GITLAB, 'test:keycloak');
  assert.equal(code, 0);
  assert.match(out['master-evidence'], /^https:\/\/gitlab\.com\/example\/identity main: job test:keycloak failed .*pipelines\/12 at sha12$/);
});

test('AC1: a GitHub repository is asked of gh — the latest completed master workflow run with the job, and its conclusion', async () => {
  const f = project();
  f.forge.route('gh', /^api repos\/o\/tools\/actions\/runs\?branch=master&status=completed&per_page=20$/, { out: { workflow_runs: [{ id: 7, head_sha: 'abc', html_url: `${GITHUB}/actions/runs/7` }] } });
  f.forge.route('gh', /^api repos\/o\/tools\/actions\/runs\/7\/jobs\?per_page=100$/, { out: { jobs: [{ name: 'unit', conclusion: 'failure', html_url: `${GITHUB}/actions/runs/7/job/1` }] } });
  const { code, out } = await f.check('p', GITHUB, 'unit');
  assert.equal(code, 0);
  assert.equal(out['master-evidence'], `${GITHUB} master: job unit failure — ${GITHUB}/actions/runs/7/job/1, pipeline ${GITHUB}/actions/runs/7 at abc`);
  f.forge.route('gh', /^api repos\/o\/tools\/actions\/runs\/7\/jobs\?per_page=100$/, { out: { jobs: [{ name: 'unit', conclusion: 'success', html_url: 'u' }] } });
  assert.equal((await f.check('p', GITHUB, 'unit')).code, 3);
  assert.deepEqual(f.forge.log('glab').filter(l => l !== 'auth status'), []);
});

test('AC5: missing master evidence is unknown (exit 4) — not proven, so no bug: no master pipeline ran the job, its result is not a pass or a fail, or the forge cannot be reached; the operator is told what to check', async () => {
  const f = project();
  pipelines(f, [PIPELINE(12)]);
  jobs(f, 12, [JOB('lint', 'failed')]);
  let r = await f.check('p', GITLAB, 'test:keycloak');
  assert.equal(r.code, 4);
  assert.equal(r.out['on-master'], 'unknown');
  assert.match(r.out['master-evidence'], /no finished master pipeline of the last 20 ran job test:keycloak/);
  assert.equal(r.out['ai-feedback-short'], 'Not proven on master: no project bug raised');
  assert.match(r.out['ai-feedback-long'], /Check job test:keycloak on https:\/\/gitlab\.com\/example\/identity's master/);

  jobs(f, 12, [JOB('test:keycloak', 'canceled')]);
  r = await f.check('p', GITLAB, 'test:keycloak');
  assert.deepEqual([r.code, r.out['on-master']], [4, 'unknown']);
  assert.match(r.out['master-evidence'], /job test:keycloak canceled/);

  f.forge.route('glab', /pipelines\?/, { out: '401 Unauthorized', exit: 1 });
  r = await f.check('p', GITLAB, 'test:keycloak');
  assert.deepEqual([r.code, r.out['on-master']], [4, 'unknown']);
  assert.match(r.out['master-evidence'], /could not ask glab: 401 Unauthorized/);
});

test('AC5: no repository or job named, or a url on no forge, is unknown (exit 4), no forge asked', async () => {
  const f = project();
  for (const [url, job] of [['-', 'unit'], [GITLAB, '-'], ['git@gitlab.com:g/x.git', 'unit']]) {
    const r = await f.check('p', url, job);
    assert.deepEqual([r.code, r.out['on-master']], [4, 'unknown'], `${url} ${job}`);
  }
  assert.deepEqual(forgeCalls(f), []);
});

test('on the harness project a project issue is the harness\'s own backlog: nothing checked (exit 2), no forge asked', async () => {
  const f = project();
  f.edit(['harness.json'], h => { h['harness-project'] = 'p'; });
  const r = await f.check('p', GITHUB, 'unit');
  assert.deepEqual([r.code, r.out['on-master']], [2, 'not-checked']);
  assert.deepEqual(forgeCalls(f), []);
});

test('a bad project fails (exit 1)', async () => {
  const f = project();
  assert.equal((await f.check('nope', GITLAB, 'unit')).code, 1);
  assert.equal((await f.check('p', GITLAB)).code, 1);
});
