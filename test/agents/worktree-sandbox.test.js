// ASS-555: the Claude Code sandbox settings of an agent on a worktree run target (src/agents/worktree-sandbox.js), and
// how dispatch makes them (src/control/dispatch.js agentSandbox). AC3: generated per agent from the project's
// allowlist and the worktree path; no secret is ever written into them. AC1, AC2: on the Mac (Seatbelt) and on a remote
// machine (bubblewrap), the agent.sh it may run outside the sandbox by absolute path alone. ASS-564: a machine whose
// sandbox can't run (a remote one's probe failed or not run yet; the Mac without Seatbelt) gets unsandboxed settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxSettings, remoteSandboxProblem, macSandboxProblem, unsandboxedSettings, SEATBELT, remoteAgentSh, homeOf, isSandboxedTarget, SANDBOXED_TARGETS, MODEL_CREDENTIALS } from '../../src/agents/worktree-sandbox.js';
import { agentCommand, CLAUDE } from '../../src/agents/process.js';
import { agentSandbox } from '../../src/control/dispatch.js';

const SECRET = 'glpat-THIS-IS-A-SECRET-VALUE-0123456789';
const TOKENISH = /glpat-|ghp_|sk-ant-|THIS-IS-A-SECRET/;

// ctx and project as dispatch has them: HARNESS_HOME with a vm-credentials.json declaring keychain service names (never
// a token), the token itself in the environment (as a VM's or workstation's would be), the project's repositories.
function world({ entry } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ass555-'));
  writeFileSync(join(home, 'vm-credentials.json'), JSON.stringify({ p: { claude: { 'keychain-service': 'harness-p-claude' }, gitlab: { 'keychain-service': 'harness-p-gitlab', host: 'gitlab.example.com', 'npm-registries': { '@acme': 'https://gitlab.example.com/api/v4/packages/npm/' } } } }));
  const ctx = { env: { HARNESS_HOME: home, GITLAB_TOKEN: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET }, root: '/opt/harness', paths: { projects: '/opt/harness/data/projects' }, macSandboxProblem: () => null };
  const project = { id: 'p', json: { name: 'p', repositories: [{ url: 'git@github.com:acme/site.git' }, { url: 'https://gitlab.example.com/acme/app.git' }], 'dev-environments': { substrate: { egress: { allow: ['*.pythonhosted.org'] } } } },
    workstations: { 'ws-1': entry ?? { setup: { ok: true, sandbox: { ok: true }, runtime: '/dev/shm/harness-1000' } } },
    seats: [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree' }] };
  return { ctx, project };
}

test('ASS-555: the sandboxed targets are the four worktree ones; Lima VMs and Substrate sandboxes are left as they are', () => {
  assert.deepEqual([...SANDBOXED_TARGETS], ['local-worktree', 'local-workspace', 'workstation-worktree', 'cloud-vm-worktree']);
  for (const t of ['local-vm', 'workstation', 'cloud-vm', 'local-substrate', 'workstation-substrate', 'cloud-vm-substrate']) assert.equal(isSandboxedTarget(t), false, t);
});

test('ASS-555 AC3: the Mac\'s settings come from the project\'s allowlist and the worktree path — strict, no unsandboxed retry, failIfUnavailable — and hold no secret', () => {
  const { ctx, project } = world();
  const wt = '/opt/harness/data/projects/p/checkouts/app/.worktrees/T-1';
  const s = agentSandbox(ctx, project, { target: 'local-worktree', vm: null, folder: wt });
  const json = JSON.stringify(s.settings);
  assert.doesNotMatch(json, TOKENISH, 'no token, whatever the environment holds');
  const { sandbox, permissions } = s.settings;
  assert.equal(sandbox.filesystem.allowWrite[0], wt);
  assert.deepEqual(sandbox.network.allowedDomains, ['*.githubusercontent.com', '*.pythonhosted.org', 'api.anthropic.com', 'api.github.com', 'codeload.github.com', 'github.com', 'gitlab.example.com', 'registry.npmjs.org'], 'ASS-538\'s allowlist: forges, model API, declared GitLab (its npm registries), npm, the project\'s additions');
  assert.equal(sandbox.network.strictAllowlist, true);
  assert.equal(sandbox.network.allowLocalBinding, true, 'macOS: a test suite\'s own servers on localhost');
  assert.deepEqual([sandbox.enabled, sandbox.failIfUnavailable, sandbox.allowUnsandboxedCommands], [true, true, false]);
  assert.deepEqual(sandbox.excludedCommands, ['/opt/harness/agent.sh *', '/opt/harness/off-board.sh *']);
  assert.deepEqual(sandbox.credentials.envVars.map(e => [e.name, e.mode]), MODEL_CREDENTIALS.map(n => [n, 'deny']));
  for (const p of ['~/.ssh', '~/.config/gh', '~/.config/glab-cli', '~/Library/Application Support/glab-cli', '~/.harness', '/opt/harness/data/projects/*/project.json']) assert.ok(sandbox.credentials.files.some(f => f.path === p && f.mode === 'deny'), p);
  assert.deepEqual(permissions, { blockWritesOutsideWorkingDirectories: true, deny: ['WebFetch'] });
  assert.equal(s.agentSh, '/opt/harness/agent.sh');
  assert.match(s.where, /Claude Code's sandbox/);
  // Per agent: another worktree, another project's allowlist.
  const other = agentSandbox(ctx, { ...project, json: { name: 'q', repositories: [{ url: 'https://example.org/x.git' }] } }, { target: 'local-workspace', vm: null, folder: '/src/q' });
  assert.equal(other.settings.sandbox.filesystem.allowWrite[0], '/src/q');
  assert.ok(other.settings.sandbox.network.allowedDomains.includes('example.org'));
});

test('ASS-555 AC1: an agent working in the project\'s dev container runs its docker exec there, and nothing else, outside the sandbox', () => {
  const { ctx, project } = world();
  const s = agentSandbox(ctx, project, { target: 'local-workspace', vm: null, folder: '/src/p', container: 'p-dev', containerFolder: '/workspace' });
  assert.deepEqual(s.settings.sandbox.excludedCommands, ['/opt/harness/agent.sh *', '/opt/harness/off-board.sh *', 'docker exec -w /workspace p-dev *']);
});

test('ASS-555 AC2, AC3: a remote worktree\'s settings — bubblewrap\'s platform, the variation folder\'s repos/ writable, the machine\'s agent.sh by absolute path, its runtime folder unreadable — no secret', () => {
  const { ctx, project } = world();
  const vm = 'workstation:p:ws-1:/home/u/harness/worktrees/T-1';
  const s = agentSandbox(ctx, project, { target: 'workstation-worktree', vm, folder: '/home/u/harness/worktrees/T-1/repos/app/', key: 'T-1', variation: 'A' });
  assert.doesNotMatch(JSON.stringify(s.settings), TOKENISH);
  const { sandbox } = s.settings;
  assert.deepEqual(sandbox.filesystem.allowWrite.slice(0, 2), ['/home/u/harness/worktrees/T-1/repos/app', '/home/u/harness/worktrees/T-1/repos']);
  assert.deepEqual(s.addDirs, ['/home/u/harness/worktrees/T-1/repos'], 'its file tools may write every repository of the variation');
  assert.deepEqual(sandbox.excludedCommands, ['/home/u/harness/bin/agent.sh *'], 'the forwarder\'s client: the Mac\'s forwarder is on the machine\'s loopback, out of a Linux sandbox\'s reach');
  assert.equal(s.agentSh, '/home/u/harness/bin/agent.sh');
  assert.equal(sandbox.network.allowLocalBinding, undefined, 'Linux: each command has its own loopback');
  assert.ok(sandbox.credentials.files.some(f => f.path === '/dev/shm/harness-1000'), 'the runtime folder, its credentials, unreadable');
  assert.ok(!sandbox.credentials.files.some(f => /Library/.test(f.path)));
  assert.ok(!sandbox.filesystem.allowWrite.some(p => p.endsWith('/ticket') || p === '/home/u/harness/worktrees/T-1'), 'its ticket copy stays read-only');
});

test('ASS-564 AC1: a remote worktree whose machine\'s sandbox can\'t run, or has not been checked, gets unsandboxed settings — not refused — its file tools still held to its worktree, no secret', () => {
  const vm = 'workstation:p:ws-1:/home/u/harness/worktrees/T-1';
  for (const [entry, why] of [[{ setup: { ok: true, sandbox: { ok: false, why: 'bwrap could not make a sandbox: setting up uid map: Permission denied' } } }, /uid map/], [{ setup: { ok: true } }, /not checked yet/]]) {
    const { ctx, project } = world({ entry });
    const s = agentSandbox(ctx, project, { target: 'workstation-worktree', vm, folder: '/home/u/harness/worktrees/T-1/repos/app/' });
    assert.match(s.unsandboxed, why);
    assert.equal(s.machine, 'ws-1');
    assert.deepEqual(s.settings, { permissions: { blockWritesOutsideWorkingDirectories: true }, sandbox: { enabled: false } }, 'no sandbox settings, so no failIfUnavailable to make Claude Code exit');
    assert.deepEqual(s.settings, unsandboxedSettings());
    assert.doesNotMatch(JSON.stringify(s.settings), TOKENISH);
    assert.deepEqual(s.addDirs, ['/home/u/harness/worktrees/T-1/repos'], 'its file tools may still write every repository of the variation, and only those');
    assert.equal(s.agentSh, '/home/u/harness/bin/agent.sh');
    assert.match(s.where, /sandbox is unavailable on this machine .*run unsandboxed: all the same, write only inside \/home\/u\/harness\/worktrees\/T-1\/repos/);
  }
  assert.equal(remoteSandboxProblem({ setup: { sandbox: { ok: true } } }), null);
  assert.match(remoteSandboxProblem({ setup: { ok: true } }), /not checked yet/);
  assert.equal(remoteSandboxProblem({ setup: { sandbox: { ok: false, why: 'socat not installed' } } }), 'socat not installed');
});

test('ASS-564 AC1: on the Mac without Seatbelt a worktree agent gets unsandboxed settings; with it (macSandboxProblem: sandbox-exec there), the sandbox', () => {
  const { ctx, project } = world();
  const s = agentSandbox({ ...ctx, macSandboxProblem: () => 'Seatbelt\'s /usr/bin/sandbox-exec is missing' }, project, { target: 'local-worktree', vm: null, folder: '/wt' });
  assert.deepEqual(s.settings, unsandboxedSettings());
  assert.equal(s.unsandboxed, 'Seatbelt\'s /usr/bin/sandbox-exec is missing');
  assert.equal(s.machine, 'mac');
  assert.equal(macSandboxProblem(f => f === SEATBELT), null);
  assert.equal(macSandboxProblem(() => false), `Seatbelt's ${SEATBELT} is missing`);
  assert.equal(agentSandbox(ctx, project, { target: 'local-worktree', vm: null, folder: '/wt' }).unsandboxed, null);
});

test('ASS-564 AC2: where the sandbox works the settings are ASS-555\'s, failIfUnavailable included', () => {
  const { ctx, project } = world();
  const vm = 'workstation:p:ws-1:/home/u/harness/worktrees/T-1';
  const remote = agentSandbox(ctx, project, { target: 'workstation-worktree', vm, folder: '/home/u/harness/worktrees/T-1/repos/app/' });
  assert.equal(remote.unsandboxed, null);
  assert.deepEqual(remote.settings, sandboxSettings({ platform: 'linux', worktree: '/home/u/harness/worktrees/T-1/repos/app', writable: ['/home/u/harness/worktrees/T-1/repos'], hosts: remote.settings.sandbox.network.allowedDomains, agentSh: ['/home/u/harness/bin/agent.sh'], deniedReads: ['/dev/shm/harness-1000'] }));
  const mac = agentSandbox(ctx, project, { target: 'local-worktree', vm: null, folder: '/wt' });
  for (const s of [remote, mac]) assert.deepEqual([s.settings.sandbox.enabled, s.settings.sandbox.failIfUnavailable, s.settings.sandbox.allowUnsandboxedCommands, s.settings.sandbox.network.strictAllowlist], [true, true, false, true]);
});

test('ASS-555: the agent command keeps --dangerously-skip-permissions and passes the settings inline, with --add-dir; a confined agent\'s settings file still wins; none — the old unsandboxed default', () => {
  const settings = sandboxSettings({ platform: 'linux', worktree: '/w', hosts: ['github.com'] });
  const argv = agentCommand({ command: CLAUDE, sandbox: settings, addDirs: ['/w2'] });
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.deepEqual(argv.slice(-4), ['--add-dir', '/w2', '--settings', JSON.stringify(settings)]);
  assert.deepEqual(agentCommand({ command: CLAUDE, confinedBy: '/f.json', sandbox: settings }).slice(-2), ['--settings', '/f.json']);
  assert.deepEqual(agentCommand({ command: CLAUDE }).slice(-2), ['--settings', '{"sandbox":{"enabled":false}}']);
  assert.equal(homeOf('/home/u/harness/worktrees/T-1.B'), '/home/u');
  assert.equal(remoteAgentSh('/home/u/harness'), '/home/u/harness/bin/agent.sh');
  assert.throws(() => sandboxSettings({}), /no worktree/);
});
