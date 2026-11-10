// vm:credentials and vm:scan-image (ASS-71) — a project's declared credentials,
// read from the Mac's keychain and injected into a running Lima VM's tmpfs.
// `security`, `limactl`, and (for running the injection script here, against a
// folder standing in for the VM's root) `sudo`, `findmnt` and `acli` are fakes on PATH.
// The fake `security` answers a read of an item's value (-w) and, ASS-350, of its
// attributes alone (no -w or -g: what vm:credential-stamps reads), as the real one prints them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const TOKENS = { 'Claude Token (Test)': 'sk-ant-oat01-CLAUDE_tok', 'GitHub PAT (Test)': 'ghp_GITHUBtok', 'GitLab PAT (Test)': 'glpat-GITLAB.tok', 'Atlassian API Key (Test)': 'ATATT3xATL=tok', 'Anthropic API Key (Test)': 'sk-ant-api03-ANTHROPIC_key-AA' };
const HARNESS = { claude: { 'keychain-service': 'Claude Token (Test)' }, github: { 'keychain-service': 'GitHub PAT (Test)' }, git: { 'user-name': 'Ada Example', 'user-email': 'c@example.com' } };
const CASE_LAW = {
  claude: { 'keychain-service': 'Claude Token (Test)' },
  gitlab: { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.com', 'npm-registries': { '@example': '86735929', '@example-activity': '86868744' } },
  atlassian: { 'keychain-service': 'Atlassian API Key (Test)', site: 'example.atlassian.net', email: 'c@example.com' },
  git: { 'user-name': 'Ada Example', 'user-email': 'c@example.com' },
};

const script = (bin, name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };

// A Mac: HOME with ~/.harness/vm-credentials.json, a keychain folder (one file per service, its modification time
// `<service>.mdat` when there, else 20261101000000Z; `<service>.hang` never answers;
// `<service>.alarm` ends as the time limit's alarm ends a read that never answers, at once), and fakes on PATH. The
// limit is 60s: the fake answers at once, but on a busy machine starting it took up to ~10s (ASS-109).
function mac(declaration = { harness: HARNESS, 'example': CASE_LAW }, keychain = TOKENS) {
  const dir = mkdtempSync(join(tmpdir(), 'vmc-'));
  const home = join(dir, 'home'), kc = join(dir, 'keychain'), bin = join(dir, 'bin'), log = join(dir, 'log');
  for (const d of [join(home, '.harness'), kc, bin, log]) mkdirSync(d, { recursive: true });
  if (declaration) writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify(declaration));
  for (const [service, value] of Object.entries(keychain)) writeFileSync(join(kc, service), `${value}\n`);   // as saved: a trailing newline to strip
  script(bin, 'security', `printf '%s\\n' "$*" >> "${log}/security"
[[ ( "$1 $2 $4" == "find-generic-password -s -w" && $# -eq 4 ) || ( "$1 $2" == "find-generic-password -s" && $# -eq 3 ) ]] || { echo "unexpected security call: $*" >&2; exit 2; }
[[ -e "${kc}/$3.hang" ]] && exec sleep 30
[[ -e "${kc}/$3.alarm" ]] && kill -ALRM $$
[[ -e "${kc}/$3" ]] || { echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2; exit 44; }
[[ $# -eq 4 ]] && exec cat "${kc}/$3"
m="$(cat "${kc}/$3.mdat" 2>/dev/null || echo 20261101000000Z)"
printf '%s\n' 'keychain: "/Users/ada/Library/Keychains/login.keychain-db"' 'version: 512' 'class: "genp"' 'attributes:' \
  '    0x00000007 <blob>="'"$3"'"' '    "acct"<blob>="ada"' '    "cdat"<timedate>=0x32303236313030313030303030305A00  "20261001000000Z\\000"' \
  '    "mdat"<timedate>=0x00  "'"$m"'\\000"' '    "svce"<blob>="'"$3"'"'`);
  script(bin, 'limactl', `printf '%s\\n' "$*" >> "${log}/limactl"; cat > "${log}/limactl.stdin"; exit "\${FAKE_LIMACTL_EXIT:-0}"`);
  const projects = join(dir, 'projects');   // PROJECTS_DIR: the vms.json vm:credentials records stamps in (ASS-350), never the repo's data/
  mkdirSync(projects);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VM_KEYCHAIN_TIMEOUT: '60', PROJECTS_DIR: projects };
  const cli = (...args) => run(AGENT, args, { env });
  const logOf = name => (existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '');
  return { dir, home, kc, bin, log, env, cli, logOf, projects };
}

// Runs the script vm:credentials sent to limactl, against a folder standing in for the VM's root: sudo runs its command, findmnt reports <fstype> and acli logs its call and writes its stdin into its config dir, as the real one does.
function inVm(m, fstype = 'tmpfs', root = mkdtempSync(join(tmpdir(), 'vmroot-'))) {
  const bin = join(m.dir, 'vm-bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'run'), { recursive: true });
  mkdirSync(join(root, 'etc', 'profile.d'), { recursive: true });
  script(bin, 'sudo', 'exec "$@"');
  script(bin, 'findmnt', `echo ${fstype}`);
  script(bin, 'acli', `printf '%s\\n' "$*" >> "${m.log}/acli"; mkdir -p "$ACLI_CONFIG_DIR/acli"; cat > "$ACLI_CONFIG_DIR/acli/global_auth_config.yaml"`);
  let status = 0, stderr = '';
  try {
    execFileSync('bash', ['-s'], { input: m.logOf('limactl.stdin'), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HARNESS_VM_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { status = e.status; stderr = String(e.stderr); }
  return { root, status, stderr };
}

// Every file under <root>, relative, with its contents.
function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(root, join(dir, e.name)) : [[relative(root, join(dir, e.name)), readFileSync(join(dir, e.name), 'utf8')]]));
}
const envOf = (root, ...names) => execFileSync('bash', ['-c', `set -a; . "$1"; set +a; for n in ${names.join(' ')}; do printf '%s=%s\\n' "$n" "\${!n-}"; done`, '_', join(root, 'run', 'harness', 'env')], { encoding: 'utf8' }).trim().split('\n');
const gitCredential = (root, host, token) => execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'run', 'harness', 'gitconfig'), GH_TOKEN: token, GITLAB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' } });
const gitGet = (root, key) => execFileSync('git', ['config', '--file', join(root, 'run', 'harness', 'gitconfig'), '--get-all', key], { encoding: 'utf8' }).trim();

test('vm:credentials harness <vm> reads only the declared items from the keychain and pipes one script to `limactl shell <vm> -- bash -s`, no token on any command line', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'ass-71-a');
  assert.equal(m.logOf('limactl'), 'shell ass-71-a -- bash -s\n');               // the only limactl call: into the running VM, nothing image-related
  assert.equal(m.logOf('security'), [   // read only, never unlock; no Atlassian or GitLab (AC2); attributes first (ASS-350), then values
    'find-generic-password -s Claude Token (Test)', 'find-generic-password -s GitHub PAT (Test)',
    'find-generic-password -s Claude Token (Test) -w', 'find-generic-password -s GitHub PAT (Test) -w', ''].join('\n'));
  for (const t of Object.values(TOKENS)) assert.ok(!m.logOf('limactl').includes(t) && !m.logOf('security').includes(t));
  assert.ok(m.logOf('limactl.stdin').includes(TOKENS['Claude Token (Test)']), 'the tokens travel on stdin');
});

test('in the VM the script writes every credential to /run/harness only (0700 dir, 0600 files), and profile.d sources the env file without holding a token', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'vm');
  const { root, status, stderr } = inVm(m);
  assert.equal(status, 0, stderr);
  const all = files(root);
  assert.deepEqual(all.map(([f]) => f).filter(f => !f.startsWith('run/harness/')), ['etc/profile.d/harness-credentials.sh']);
  for (const t of Object.values(TOKENS)) for (const [f, body] of all) if (body.includes(t)) assert.match(f, /^run\/harness\//, `${f} holds a token`);
  assert.equal(statSync(join(root, 'run', 'harness')).mode & 0o777, 0o700);
  for (const [f] of all.filter(([f]) => f.startsWith('run/harness/'))) assert.equal(statSync(join(root, f)).mode & 0o077, 0, `${f} is private`);
  assert.match(all.find(([f]) => f.startsWith('etc/'))[1], /\. \/run\/harness\/env/);
  assert.equal(statSync(join(root, 'etc', 'profile.d', 'harness-credentials.sh')).mode & 0o777, 0o644);   // root's in a VM: every login shell must read it
  assert.deepEqual(envOf(root, 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR', 'ACLI_CONFIG_DIR', 'NPM_CONFIG_USERCONFIG', 'GIT_CONFIG_GLOBAL'), [
    'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-CLAUDE_tok', 'GH_TOKEN=ghp_GITHUBtok', 'GITLAB_TOKEN=', 'GH_CONFIG_DIR=/run/harness/gh', 'GLAB_CONFIG_DIR=/run/harness/glab',
    'ACLI_CONFIG_DIR=', 'NPM_CONFIG_USERCONFIG=/run/harness/npmrc', 'GIT_CONFIG_GLOBAL=/run/harness/gitconfig']);
  // git: identity from the git entry, https with the token, ssh remotes rewritten to https.
  assert.equal(gitGet(root, 'user.name'), 'Ada Example');
  assert.equal(gitGet(root, 'user.email'), 'c@example.com');
  assert.equal(gitGet(root, 'url.https://github.com/.insteadof'), 'git@github.com:');
  assert.match(gitCredential(root, 'github.com', 'ghp_FROMENV'), /username=x-access-token\npassword=ghp_FROMENV\n/);
  assert.equal(m.logOf('acli'), '');                                              // not declared, not logged in
});

test('a gitlab + atlassian project gets GITLAB_TOKEN/GITLAB_HOST, an npmrc with both registries, git over https — and, ASS-238 AC3, no Jira credential: the Atlassian item is never read, acli never logged in', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'example', 'vm');
  const { root, status, stderr } = inVm(m);
  assert.equal(status, 0, stderr);
  assert.deepEqual(envOf(root, 'GITLAB_TOKEN', 'GITLAB_HOST', 'GH_TOKEN'), ['GITLAB_TOKEN=glpat-GITLAB.tok', 'GITLAB_HOST=gitlab.com', 'GH_TOKEN=']);
  assert.equal(readFileSync(join(root, 'run', 'harness', 'npmrc'), 'utf8'), [
    '@example:registry=https://gitlab.com/api/v4/projects/86735929/packages/npm/',
    '//gitlab.com/api/v4/projects/86735929/packages/npm/:_authToken=${GITLAB_TOKEN}',
    '@example-activity:registry=https://gitlab.com/api/v4/projects/86868744/packages/npm/',
    '//gitlab.com/api/v4/projects/86868744/packages/npm/:_authToken=${GITLAB_TOKEN}', ''].join('\n'));
  assert.equal(gitGet(root, 'url.https://gitlab.com/.insteadof'), 'git@gitlab.com:');
  assert.match(gitCredential(root, 'gitlab.com', 'glpat-FROMENV'), /username=oauth2\npassword=glpat-FROMENV\n/);
  assert.equal(m.logOf('acli'), '');
  assert.doesNotMatch(m.logOf('security'), /Atlassian/);
  assert.ok(!m.logOf('limactl.stdin').includes(TOKENS['Atlassian API Key (Test)']) && !/acli|ACLI/.test(m.logOf('limactl.stdin')));
  assert.deepEqual(envOf(root, 'ACLI_CONFIG_DIR'), ['ACLI_CONFIG_DIR=']);
  for (const [f, body] of files(root)) assert.ok(!body.includes(TOKENS['Atlassian API Key (Test)']), f);
});

test('credentials on tmpfs only: when /run/harness is not on tmpfs the script fails and writes no credential', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'vm');
  const { root, status, stderr } = inVm(m, 'ext4');
  assert.notEqual(status, 0);
  assert.match(stderr, /not on tmpfs/);
  assert.deepEqual(files(root), []);
});

test('AC5: run again after a keychain change, the VM gets the new token and nothing of the old run is left', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'example', 'vm');
  const { root } = inVm(m);
  writeFileSync(join(m.home, '.harness', 'vm-credentials.json'), JSON.stringify({ 'example': { claude: CASE_LAW.claude } }));
  writeFileSync(join(m.kc, 'Claude Token (Test)'), 'sk-ant-oat01-NEW\n');
  await m.cli('vm:credentials', 'example', 'vm');
  assert.equal(inVm(m, 'tmpfs', root).status, 0);
  assert.deepEqual(envOf(root, 'CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN'), ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-NEW', 'GITLAB_TOKEN=']);
  assert.ok(!existsSync(join(root, 'run', 'harness', 'acli')) && !existsSync(join(root, 'run', 'harness', 'npmrc')));
});

test('AC4: every missing, empty or unreadable item is named in one message, and nothing is sent to the VM', async () => {
  const m = mac(undefined, { 'Claude Token (Test)': '  \n', 'Atlassian API Key (Test)': 'has a \'quote' });
  writeFileSync(join(m.kc, 'GitLab PAT (Test).alarm'), '');
  await assert.rejects(m.cli('vm:credentials', 'example', 'vm'), e => {
    assert.match(e.stderr, /vm:credentials: example's VM credentials cannot be read from the keychain/);
    assert.match(e.stderr, /claude: "Claude Token \(Test\)" is empty/);
    assert.match(e.stderr, /gitlab: "GitLab PAT \(Test\)" is unreadable \(no answer within 60s: is the login keychain locked/);
    assert.doesNotMatch(e.stderr, /atlassian/, 'ASS-238 AC3: never read for a VM');
    assert.ok(!e.stderr.includes('quote'), 'no value is printed');
    return true;
  });
  await assert.rejects(mac(undefined, {}).cli('vm:credentials', 'harness', 'vm'), /claude: "Claude Token \(Test\)" is missing[\s\S]*github: "GitHub PAT \(Test\)" is missing/);
  assert.equal(m.logOf('limactl'), '');
});

test('a keychain read that never answers is cut off after VM_KEYCHAIN_TIMEOUT seconds and reported unreadable', async () => {
  const m = mac({ harness: { claude: HARNESS.claude } });
  writeFileSync(join(m.kc, 'Claude Token (Test).hang'), '');
  await assert.rejects(run(AGENT, ['vm:credentials', 'harness', 'vm'], { env: { ...m.env, VM_KEYCHAIN_TIMEOUT: '1' } }),
    /claude: "Claude Token \(Test\)" is unreadable \(no answer within 1s: is the login keychain locked/);
  assert.equal(m.logOf('limactl'), '');
});

test('ASS-123 AC2: by default a keychain read gets 30s, room for a loaded Mac, before it is cut off and reported unreadable', async () => {
  const m = mac({ harness: { claude: HARNESS.claude } });
  writeFileSync(join(m.kc, 'Claude Token (Test).alarm'), '');
  const { VM_KEYCHAIN_TIMEOUT, ...env } = m.env;
  await assert.rejects(run(AGENT, ['vm:credentials', 'harness', 'vm'], { env }),
    /claude: "Claude Token \(Test\)" is unreadable \(no answer within 30s: is the login keychain locked/);
  assert.equal(m.logOf('limactl'), '');
});

test('ASS-214: an anthropic project gets ANTHROPIC_API_KEY in the env file over stdin, and no CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const m = mac({ 'example': { anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } });
  await m.cli('vm:credentials', 'example', 'vm');
  assert.equal(m.logOf('security'), 'find-generic-password -s Anthropic API Key (Test)\nfind-generic-password -s Anthropic API Key (Test) -w\n');
  assert.ok(!m.logOf('limactl').includes(TOKENS['Anthropic API Key (Test)']), 'never on a command line');
  const { root, status, stderr } = inVm(m);
  assert.equal(status, 0, stderr);
  assert.deepEqual(envOf(root, 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'), ['ANTHROPIC_API_KEY=sk-ant-api03-ANTHROPIC_key-AA', 'CLAUDE_CODE_OAUTH_TOKEN=']);
});

test('ASS-214: anthropic is validated like the others', async () => {
  await assert.rejects(mac({ 'example': { anthropic: {} } }).cli('vm:credentials', 'example', 'vm'), /'example' anthropic needs keychain-service/);
});

test('ASS-217 AC1: a project declaring both claude and anthropic gets both in the VM\'s env file, over stdin, and vm:credentials prints both', async () => {
  const m = mac({ 'example': { claude: HARNESS.claude, anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } });
  assert.equal((await m.cli('vm:credentials', 'example', 'vm')).stdout, 'both\n');
  for (const t of [TOKENS['Claude Token (Test)'], TOKENS['Anthropic API Key (Test)']]) assert.ok(!m.logOf('limactl').includes(t), 'never on a command line');
  const { root, status, stderr } = inVm(m);
  assert.equal(status, 0, stderr);
  assert.deepEqual(envOf(root, 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'), ['ANTHROPIC_API_KEY=sk-ant-api03-ANTHROPIC_key-AA', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-CLAUDE_tok']);
});

// ASS-215 AC2: the script's rm -rf of /run/harness keeps vm:start's forwarder
// files, agent-token and agent-url, so a run on a running VM — control's or
// the operator's by hand — leaves its agent.sh able to reach the forwarder.
const FORWARDER = { 'agent-token': 'not-a-real-token\n', 'agent-url': 'http://host.lima.internal:7787/run\n' };
const seeded = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'vmroot-'));
  mkdirSync(join(root, 'run', 'harness'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'run', 'harness', name), body, { mode: 0o600 });
  return root;
};
const harnessFile = (root, name) => join(root, 'run', 'harness', name);
const harnessRead = (root, name) => (existsSync(harnessFile(root, name)) ? readFileSync(harnessFile(root, name), 'utf8') : undefined);

test('ASS-215 AC2: in a VM whose /run/harness holds agent-token, agent-url and an old env, the script keeps both forwarder files as they were, rewrites env, all 0600', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'vm');
  const { root, status, stderr } = inVm(m, 'tmpfs', seeded({ ...FORWARDER, env: 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-OLD\n' }));
  assert.equal(status, 0, stderr);
  for (const [name, body] of Object.entries(FORWARDER)) assert.equal(harnessRead(root, name), body, name);
  assert.deepEqual(envOf(root, 'CLAUDE_CODE_OAUTH_TOKEN'), ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-CLAUDE_tok']);
  for (const name of ['agent-token', 'agent-url', 'env']) assert.equal(existsSync(harnessFile(root, name)) && statSync(harnessFile(root, name)).mode & 0o777, 0o600, name);
});

test('ASS-215 AC2: run twice in a row, the second run keeps what the first wrote back', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'vm');
  const root = seeded(FORWARDER);
  assert.equal(inVm(m, 'tmpfs', root).status, 0);
  const { status, stderr } = inVm(m, 'tmpfs', root);
  assert.equal(status, 0, stderr);
  for (const [name, body] of Object.entries(FORWARDER)) assert.equal(harnessRead(root, name), body, name);
});

test('ASS-215 AC2: a forwarder file absent before (vm:credentials alone, never vm:start), or empty, is not made; the injection still succeeds', async () => {
  const m = mac();
  await m.cli('vm:credentials', 'harness', 'vm');
  const absent = inVm(m, 'tmpfs', seeded({}));
  assert.equal(absent.status, 0, absent.stderr);
  const empty = inVm(m, 'tmpfs', seeded({ 'agent-token': '', 'agent-url': '' }));
  assert.equal(empty.status, 0, empty.stderr);
  for (const root of [absent.root, empty.root]) for (const name of ['agent-token', 'agent-url']) assert.equal(existsSync(harnessFile(root, name)), false, name);
  assert.ok(existsSync(harnessFile(absent.root, 'env')));
});

test('ASS-215 AC1: vm:credentials prints the kind it injected — claude, then anthropic once the declaration is switched', async () => {
  const m = mac({ harness: HARNESS });
  assert.equal((await m.cli('vm:credentials', 'harness', 'vm')).stdout, 'claude\n');
  writeFileSync(join(m.home, '.harness', 'vm-credentials.json'), JSON.stringify({ harness: { ...HARNESS, claude: undefined, anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } }));
  assert.equal((await m.cli('vm:credentials', 'harness', 'vm')).stdout, 'anthropic\n');
});

test('vm:credentials fails clearly on a bad declaration or usage, and passes on limactl\'s failure', async () => {
  await assert.rejects(mac(null).cli('vm:credentials', 'harness', 'vm'), /no .*\.harness\/vm-credentials\.json/);
  await assert.rejects(mac().cli('vm:credentials', 'other', 'vm'), /declares no VM credentials for project 'other'/);
  await assert.rejects(mac({ harness: { svn: {} } }).cli('vm:credentials', 'harness', 'vm'), /unknown credential kind 'svn'/);
  await assert.rejects(mac({ harness: { github: {} } }).cli('vm:credentials', 'harness', 'vm'), /github needs keychain-service/);
  await assert.rejects(mac({ harness: { atlassian: { 'keychain-service': 'Atlassian API Key (Test)' } } }).cli('vm:credentials', 'harness', 'vm'), /atlassian needs site, email/);
  await assert.rejects(mac({ harness: { git: { 'user-name': 'X' } } }).cli('vm:credentials', 'harness', 'vm'), /git needs user-email/);
  await assert.rejects(mac().cli('vm:credentials', 'harness'), /usage/);
  await assert.rejects(mac().cli('vm:credentials', '../harness', 'vm'), /invalid project/);
  await assert.rejects(mac().cli('vm:credentials', 'harness', 'a b'), /invalid VM/);
  const m = mac();
  await assert.rejects(run(AGENT, ['vm:credentials', 'harness', 'vm'], { env: { ...m.env, FAKE_LIMACTL_EXIT: '1' } }), /could not inject/);
});

// ASS-350: each declared item's keychain modification time, never its value.
test('ASS-350: vm:credential-stamps <project> prints each declared item\'s mdat as JSON, read from its attributes only (no -w, no -g); never atlassian, never a token', async () => {
  const m = mac();
  writeFileSync(join(m.kc, 'GitLab PAT (Test).mdat'), '20261110140759Z');
  const { stdout, stderr } = await m.cli('vm:credential-stamps', 'example');
  assert.deepEqual(JSON.parse(stdout), { claude: '20261101000000Z', gitlab: '20261110140759Z' });
  assert.equal(m.logOf('security'), 'find-generic-password -s Claude Token (Test)\nfind-generic-password -s GitLab PAT (Test)\n');
  for (const t of Object.values(TOKENS)) assert.ok(!stdout.includes(t) && !stderr.includes(t) && !m.logOf('security').includes(t));
});

test('ASS-350: vm:credential-stamps leaves out an item it cannot read or that shows no mdat, and fails on a bad project or declaration', async () => {
  const m = mac({ example: { claude: CASE_LAW.claude, gitlab: CASE_LAW.gitlab } }, { 'Claude Token (Test)': 'sk-ant-oat01-CLAUDE_tok' });
  assert.deepEqual(JSON.parse((await m.cli('vm:credential-stamps', 'example')).stdout), { claude: '20261101000000Z' });
  await assert.rejects(m.cli('vm:credential-stamps', 'other'), /declares no VM credentials for project 'other'/);
  await assert.rejects(m.cli('vm:credential-stamps', '../x'), /invalid project/);
  await assert.rejects(m.cli('vm:credential-stamps'), /usage/);
});

test('ASS-350 AC1: vm:credentials records the injected items\' stamps on the VM\'s vms.json row, beside what it holds, never a token; a VM with no row, or no vms.json, gets none', async () => {
  const m = mac();
  mkdirSync(join(m.projects, 'example'));
  const vms = join(m.projects, 'example', 'vms.json');
  writeFileSync(vms, JSON.stringify({ vm: { ticket: 'EX-1', variation: 'A', state: 'Running', 'credential-kind': 'claude' } }));
  writeFileSync(join(m.kc, 'Claude Token (Test).mdat'), '20261110140759Z');
  const { stdout } = await m.cli('vm:credentials', 'example', 'vm');
  assert.equal(stdout, 'claude\n');
  assert.deepEqual(JSON.parse(readFileSync(vms, 'utf8')), { vm: { ticket: 'EX-1', variation: 'A', state: 'Running', 'credential-kind': 'claude',
    'credential-stamps': { claude: '20261110140759Z', gitlab: '20261101000000Z' } } });   // no atlassian: never injected
  await m.cli('vm:credentials', 'example', 'other-vm');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(vms, 'utf8'))), ['vm']);
  await m.cli('vm:credentials', 'harness', 'vm');
  assert.equal(existsSync(join(m.projects, 'harness', 'vms.json')), false);
  for (const t of Object.values(TOKENS)) assert.ok(!readFileSync(vms, 'utf8').includes(t) && !stdout.includes(t));
});

test('vm:scan-image <project> searches golden-<project> for every configured token and names the kind found, never the value', async () => {
  const m = mac();
  const lima = join(m.dir, 'lima');
  mkdirSync(join(lima, 'golden-harness'), { recursive: true });
  const disk = join(lima, 'golden-harness', 'disk');
  writeFileSync(disk, Buffer.concat([Buffer.alloc(8192), Buffer.from('nothing to see'), Buffer.alloc(4096, 0xff)]));
  const scan = () => run(AGENT, ['vm:scan-image', 'harness'], { env: { ...m.env, LIMA_HOME: lima } });
  assert.match((await scan()).stdout, /no token found in .*golden-harness \(claude, github\)/);
  writeFileSync(disk, Buffer.concat([Buffer.alloc(8192), Buffer.from(`x${TOKENS['GitHub PAT (Test)']}y`), Buffer.alloc(16)]));
  await assert.rejects(scan(), e => {
    assert.match(e.stderr, /github's token \("GitHub PAT \(Test\)"\) is in .*golden-harness\/disk/);
    assert.ok(!e.stderr.includes(TOKENS['GitHub PAT (Test)']) && !e.stdout.includes(TOKENS['GitHub PAT (Test)']));
    return true;
  });
  await assert.rejects(run(AGENT, ['vm:scan-image', 'example'], { env: { ...m.env, LIMA_HOME: lima } }), /no image .*golden-example/);
});

test('vm:scan-image <project> <instance> also searches for the gh and glab tokens a build used, passed in the environment', async () => {
  const m = mac();
  const lima = join(m.dir, 'lima'), GH = 'gho_FORGEgh', GL = 'glpat-FORGE.gl';
  mkdirSync(join(lima, 'golden-harness-build'), { recursive: true });
  const disk = join(lima, 'golden-harness-build', 'disk');
  const scan = (env = {}) => run(AGENT, ['vm:scan-image', 'harness', 'golden-harness-build'], { env: { ...m.env, LIMA_HOME: lima, ...env } });
  writeFileSync(disk, `a ${GL} b`);
  assert.match((await scan()).stdout, /no token found in .*golden-harness-build \(claude, github\)/);   // no forge token given: only the declared ones
  await assert.rejects(scan({ SCAN_GH_TOKEN: GH, SCAN_GL_TOKEN: GL }), e => {
    assert.match(e.stderr, /glab's token \("glab config get token"\) is in .*golden-harness-build\/disk/);
    assert.doesNotMatch(e.stderr, /gh's token/);
    for (const t of [GH, GL]) assert.ok(!e.stderr.includes(t) && !e.stdout.includes(t));
    return true;
  });
  writeFileSync(disk, 'clean');
  assert.match((await scan({ SCAN_GH_TOKEN: GH, SCAN_GL_TOKEN: '' })).stdout, /no token found .*\(claude, gh, github\)/);
  await assert.rejects(run(AGENT, ['vm:scan-image', 'harness', '../x'], { env: { ...m.env, LIMA_HOME: lima } }), /invalid instance/);
});
