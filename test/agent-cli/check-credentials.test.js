// project:check-credentials and project:credentials-status (ASS-395): every
// credential a project is declared to need, checked up front — its keychain
// items (by their attributes alone), the host's forge logins its repositories
// need, the gcloud/glab logins control probes, its Claude account — and the
// hold recorded in credentials-hold.json while one fails, each problem with
// the command that fixes it; removed once a check finds none. `security`, `gh`
// and `glab` are fakes on PATH; HOME is a folder of the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const script = (bin, name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };

// A Mac: HOME with ~/.harness/vm-credentials.json (`declaration`), a keychain
// folder (a file per service present), project p (`project` its project.json),
// fakes for security (44 for a missing item), gh and glab (failing while
// <dir>/<tool>-out exists, printing it on stderr), each call logged.
function mac({ declaration = { p: { claude: { 'keychain-service': 'Claude Token (Test)' }, gitlab: { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.example.com' }, git: { 'user-name': 'Ada Example', 'user-email': 'ada@example.com' } } }, keychain = ['Claude Token (Test)', 'GitLab PAT (Test)'], project = { name: 'P', repositories: [{ url: 'https://gitlab.example.com/acme/shop.git' }] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));
  const home = join(dir, 'home'), kc = join(dir, 'keychain'), bin = join(dir, 'bin'), projects = join(dir, 'projects');
  for (const d of [join(home, '.harness'), kc, bin, join(projects, 'p')]) mkdirSync(d, { recursive: true });
  if (declaration) writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify(declaration));
  for (const service of keychain) writeFileSync(join(kc, service), 'x');
  writeFileSync(join(projects, 'p', 'project.json'), JSON.stringify(project));
  script(bin, 'security', `printf '%s\\n' "$*" >> "${dir}/calls"
[[ "$1 $2" == "find-generic-password -s" && $# -eq 3 ]] || { echo "unexpected security call: $*" >&2; exit 2; }
[[ -e "${kc}/$3" ]] || exit 44`);
  for (const tool of ['gh', 'glab']) script(bin, tool, `printf '%s\\n' "${tool} $*" >> "${dir}/calls"; [[ ! -e "${dir}/${tool}-out" ]] || { cat "${dir}/${tool}-out" >&2; exit 1; }`);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: projects, GH_DISABLED: '', GLAB_DISABLED: '' };
  const cli = async (...args) => JSON.parse((await run(AGENT, args, { env })).stdout);
  const record = join(projects, 'p', 'credentials-hold.json');
  const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '');
  return { dir, home, kc, projects, env, cli, record, calls };
}

test('ASS-395 AC1: every declared credential present and working: not held, no record; keychain items read by their attributes alone, the forge login asked per host', async () => {
  const m = mac();
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.equal(existsSync(m.record), false);
  assert.equal(m.calls(), 'find-generic-password -s Claude Token (Test)\nfind-generic-password -s GitLab PAT (Test)\nglab auth status --hostname gitlab.example.com\n');
  assert.deepEqual(await m.cli('project:credentials-status', 'p'), { held: false, since: null, problems: [] });
});

test('ASS-395 AC1/AC2: a missing keychain item and a lost forge login are recorded as one hold, each with the command that fixes it; since kept while held; AC4: lifted once the check passes', async () => {
  const m = mac();
  rmSync(join(m.kc, 'GitLab PAT (Test)'));
  writeFileSync(join(m.dir, 'glab-out'), '');
  const out = await m.cli('project:check-credentials', 'p');
  assert.equal(out.held, true);
  assert.match(out.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(out.problems, [
    { credential: 'keychain item "GitLab PAT (Test)" (gitlab)', problem: 'missing from the keychain', fix: 'security add-generic-password -U -s "GitLab PAT (Test)" -a "$USER" -T /usr/bin/security -w "$(pbpaste)" (with the gitlab token copied)' },
    { credential: 'the glab login (gitlab.example.com)', problem: 'glab is not authenticated on gitlab.example.com', fix: 'glab auth login --hostname gitlab.example.com' },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(m.record, 'utf8')), { since: out.since, problems: out.problems });
  assert.deepEqual(await m.cli('project:credentials-status', 'p'), out);
  await assert.rejects(run(AGENT, ['project:credentials-status', 'p', '--fail-when-held'], { env: m.env }), e => e.code === 3 && JSON.parse(e.stdout).held === true);
  // One fixed: the other still holds, since as it was.
  writeFileSync(join(m.kc, 'GitLab PAT (Test)'), 'x');
  const still = await m.cli('project:check-credentials', 'p');
  assert.deepEqual(still, { held: true, since: out.since, problems: [out.problems[1]] });
  rmSync(join(m.dir, 'glab-out'));
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.equal(existsSync(m.record), false);
  assert.deepEqual(JSON.parse((await run(AGENT, ['project:credentials-status', 'p', '--fail-when-held'], { env: m.env })).stdout).held, false);
});

test('ASS-395 AC1: the gcloud login control found expired, the wrong Claude account, a GitHub repository\'s gh login and a broken declaration are each a problem; a project declaring none checks no keychain', async () => {
  const m = mac({
    declaration: { p: { claude: {} } },
    project: { name: 'P', repositories: [{ url: 'https://github.com/acme/shop' }], 'check-for-expired-gcloud-auth': true, 'account-hold': { since: '2026-11-12T00:00:00Z', expected: 'work@example.com', actual: 'me@example.com', 'config-dir': '/x/projects/p/.claude' } },
  });
  writeFileSync(join(m.projects, 'p', 'gcloud-requires-reauthentication'), 'true');
  writeFileSync(join(m.dir, 'gh-out'), '');
  const { problems } = await m.cli('project:check-credentials', 'p');
  assert.deepEqual(problems.map(p => p.credential), ['~/.harness/vm-credentials.json', 'the gh login (github.com)', 'the gcloud login', 'the Claude account']);
  assert.match(problems[0].problem, /'p' claude needs keychain-service/);
  assert.equal(problems[1].fix, 'gh auth login --hostname github.com');
  assert.equal(problems[2].fix, 'gcloud auth login');
  assert.deepEqual(problems[3], { credential: 'the Claude account', problem: 'work@example.com expected; logged in as me@example.com', fix: 'CLAUDE_CONFIG_DIR=/x/projects/p/.claude claude, then /login as work@example.com' });

  const none = mac({ declaration: { other: {} }, project: { name: 'P' } });
  assert.deepEqual(await none.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.equal(none.calls(), '');
});

test('ASS-429 AC4: a forge login check that fails only because the host could not be reached holds nothing; one that also says the login is gone is a problem', async () => {
  const m = mac();
  writeFileSync(join(m.dir, 'glab-out'), 'gitlab.example.com\n  x gitlab.example.com: API call failed: GET https://gitlab.example.com/api/v4/user: dial tcp: lookup gitlab.example.com: no such host\n');
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  writeFileSync(join(m.dir, 'glab-out'), 'GET https://gitlab.example.com/api/v4/user: 503 Service Unavailable\n');
  assert.deepEqual((await m.cli('project:check-credentials', 'p')).problems, []);
  writeFileSync(join(m.dir, 'glab-out'), 'x gitlab.example.com: API call failed: GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}\n');
  assert.deepEqual((await m.cli('project:check-credentials', 'p')).problems.map(p => p.credential), ['the glab login (gitlab.example.com)']);
});

test('ASS-395: both commands refuse a bad project or usage', async () => {
  const m = mac();
  for (const command of ['project:check-credentials', 'project:credentials-status']) {
    await assert.rejects(run(AGENT, [command], { env: m.env }), /usage/);
    await assert.rejects(run(AGENT, [command, '../p'], { env: m.env }), /invalid project/);
    await assert.rejects(run(AGENT, [command, 'nope'], { env: m.env }), /no project nope/);
  }
});

// ASS-561: a project with a jira work source — its Atlassian API token (the keychain item its atlassian entry names,
// else project.json's api-email/api-token) and the acli login — checked, but held apart: atlassian-needs.json, never
// credentials-hold.json. acli is a fake printing <dir>/acli-out and exiting <dir>/acli-code (0 without).
const BOARD = 'https://example.atlassian.net/jira/software/c/projects/PROJ/boards/12';
const ATLASSIAN = { 'keychain-service': 'Atlassian API Token (Test)', site: 'example.atlassian.net', email: 'ada@example.com' };
const LOGGED_IN = '✓ Authenticated\n  Site: example.atlassian.net\n  Email: ada@example.com\n  Authentication Type: api_token\n';
function jiraMac({ atlassian = ATLASSIAN, keychain = ['Atlassian API Token (Test)'], source = {} } = {}) {
  const m = mac({ declaration: { p: atlassian ? { atlassian } : {} }, keychain, project: { name: 'P', 'work-sources': [{ name: 'J', type: 'jira', url: BOARD, ...source }] } });
  script(join(m.dir, 'bin'), 'acli', `printf '%s\\n' "acli $*" >> "${m.dir}/calls"; cat "${m.dir}/acli-out" 2>/dev/null; exit "$(cat "${m.dir}/acli-code" 2>/dev/null || echo 0)"`);
  writeFileSync(join(m.dir, 'acli-out'), LOGGED_IN);
  const needs = join(m.projects, 'p', 'atlassian-needs.json');
  return { ...m, needs, acli: (out, code = 0) => { writeFileSync(join(m.dir, 'acli-out'), out); writeFileSync(join(m.dir, 'acli-code'), String(code)); } };
}
const FIX = './agent.sh project:set-atlassian-token p';

test('ASS-561 AC1/AC5: with a jira work source and no Atlassian keychain item, check-credentials reports it with the fix, holding nothing; the next check after it is saved clears it', async () => {
  const m = jiraMac({ keychain: [] });
  const out = await m.cli('project:check-credentials', 'p');
  assert.equal(out.held, false);
  assert.deepEqual(out.problems, []);
  assert.equal(existsSync(m.record), false, 'not a credentials hold');
  assert.deepEqual(out.atlassian.problems, [{ credential: 'keychain item "Atlassian API Token (Test)" (atlassian)', problem: 'missing from the keychain: the analytics cannot sign in to Jira', fix: FIX }]);
  assert.match(out.atlassian.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(JSON.parse(readFileSync(m.needs, 'utf8')), out.atlassian);
  assert.deepEqual(await m.cli('project:credentials-status', 'p'), out);
  await run(AGENT, ['project:credentials-status', 'p', '--fail-when-held'], { env: m.env });   // exits 0: not held
  // Saved: the next check finds nothing, and the record is gone.
  writeFileSync(join(m.kc, 'Atlassian API Token (Test)'), 'x');
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.equal(existsSync(m.needs), false);
});

test('ASS-561 AC1: with no atlassian entry, project.json\'s api-email and api-token are the token (nothing reported); with neither, that is reported', async () => {
  const kept = jiraMac({ atlassian: null, keychain: [], source: { 'api-email': 'ada@example.com', 'api-token': 'x' } });
  assert.deepEqual(await kept.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  const none = jiraMac({ atlassian: null, keychain: [] });
  const out = await none.cli('project:check-credentials', 'p');
  assert.equal(out.held, false);
  assert.deepEqual(out.atlassian.problems.map(p => [p.credential, p.fix]), [['the Atlassian API token', FIX]]);
  assert.match(out.atlassian.problems[0].problem, /no atlassian entry for p in ~\/\.harness\/vm-credentials\.json, nor an api-email and api-token/);
});

test('ASS-561 AC2: acli logged out, or logged in to another site, is reported with the fix, holding nothing; with the network down nothing is reported', async () => {
  const m = jiraMac();
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.match(m.calls(), /acli jira auth status/);
  m.acli('✗ You are not logged in. Run acli jira auth login.\n', 1);
  let out = await m.cli('project:check-credentials', 'p');
  assert.equal(out.held, false);
  assert.deepEqual(out.atlassian.problems, [{ credential: 'the acli login (example.atlassian.net)', problem: 'acli is not logged in to Jira', fix: FIX }]);
  m.acli('✓ Authenticated\n  Site: other.atlassian.net\n  Email: ada@example.com\n');
  out = await m.cli('project:check-credentials', 'p');
  assert.deepEqual(out.atlassian.problems.map(p => p.problem), ['acli is logged in to other.atlassian.net, not example.atlassian.net']);
  m.acli('Error: Get "https://example.atlassian.net/rest/api/3/myself": dial tcp: lookup example.atlassian.net: no such host\n', 1);
  assert.deepEqual(await m.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.equal(existsSync(m.needs), false);
  // An off-board project asks acli nothing.
  const off = mac({ project: { name: 'P', 'work-sources': [{ type: 'off-board' }] }, declaration: { p: { atlassian: ATLASSIAN } }, keychain: [] });
  assert.deepEqual(await off.cli('project:check-credentials', 'p'), { held: false, since: null, problems: [] });
  assert.doesNotMatch(off.calls(), /acli|Atlassian/);
});
