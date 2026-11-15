// ASS-428 AC3 — a confined host agent's agent.sh writes under the generated
// host-agent sandbox settings (src/agents/confinement.js): each command a host
// agent gives content to, called bare with the content's file path, runs
// outside the sandbox (the settings' `<harness>/agent.sh *` exclusion) and its
// write under data/projects/<project>/ succeeds; the same call with the
// content redirected into it runs sandboxed, and the sandbox refuses the write.
//
// What runs for real: the harness's own agent.sh and commands, against a temp
// harness data folder, with settings written by confineHostAgent; the
// sandboxed calls under macOS's own sandbox (/usr/bin/sandbox-exec, the
// Seatbelt that Claude Code's sandbox uses on macOS), its profile made from
// those settings' filesystem rules (writes only where allowWrite and the
// working folder allow, never denyWrite — the data folder — which wins inside
// an allowed folder). What does not: Claude Code itself. Which command lines
// it runs outside the sandbox is claude-rules.js runsUnsandboxed — the
// excludedCommands patterns, a bare command only, as the harness has seen it
// behave (ABC-1770) — not Claude Code's own matcher. Skipped where
// sandbox-exec cannot run (not macOS, or already inside a sandbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { confineHostAgent } from '../../src/agents/confinement.js';
import { runsUnsandboxed, bare } from '../support/claude-rules.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { fakeForge } from '../support/fake-forge.js';

const ROOT = realpathSync(join(import.meta.dirname, '..', '..'));
const AGENT = join(ROOT, 'agent.sh');
// Absolute: the VM fixtures put a fake sandbox-exec on PATH.
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const sandboxRuns = (() => {
  try { execFileSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const APP = 'https://gitlab.com/g/app';

// seatbelt(settings, cwd) — a sandbox-exec profile holding the settings' filesystem write rules: every write refused
// but /dev's, the working folder's and allowWrite's (and Edit allow rules'), then denyWrite (and Edit deny rules')
// refused again — the later rule wins in Seatbelt, so a denied folder inside an allowed one stays denied.
function seatbelt(settings, cwd) {
  const fs = settings.sandbox.filesystem;
  const edits = rules => (rules ?? []).map(r => /^Edit\(\/(\/.*)\/\*\*\)$/.exec(r)?.[1]).filter(Boolean);
  const real = p => (existsSync(p) ? realpathSync(p) : p);
  const subpaths = paths => [...new Set(paths.map(real))].map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/dev") ${subpaths([cwd, ...fs.allowWrite, ...edits(settings.permissions.allow)])})
(deny file-write* ${subpaths([...fs.denyWrite, ...edits(settings.permissions.deny)])})`;
}

// asHostAgent(settings, line, { cwd, env }) — runs the command line as the confined agent's Bash tool would: outside
// the sandbox when the settings exclude it (runsUnsandboxed), else under sandbox-exec with the settings' profile.
// { sandboxed, code, stdout, stderr }.
function asHostAgent(settings, line, { cwd, env }) {
  const sandboxed = !runsUnsandboxed(settings, line);
  const [file, args] = sandboxed ? [SANDBOX_EXEC, ['-p', seatbelt(settings, cwd), '/bin/bash', '-c', line]] : ['/bin/bash', ['-c', line]];
  return new Promise(resolve => execFile(file, args, { cwd, env }, (error, stdout, stderr) => resolve({ sandboxed, code: error ? error.code : 0, stdout, stderr })));
}

// A temp harness data folder (harness-fixture.js: project p, ABC-3's variation A), with p's golden image defined and
// its repositories app on a fake forge, its agent confined: the settings confineHostAgent wrote for p.
function harness() {
  const f = fixture();
  const data = realpathSync(f.dir), projects = join(data, 'projects'), work = join(projects, 'p', 'work', 'ABC-3');
  mkdirSync(work, { recursive: true });
  const golden = join(projects, 'p', 'golden-image');
  mkdirSync(golden, { recursive: true });
  writeFileSync(join(golden, 'template.yaml'), 'vmType: vz\n');
  writeFileSync(join(golden, 'provision.sh'), '#!/bin/bash\necho provision\n');
  chmodSync(join(golden, 'provision.sh'), 0o755);
  const projectJson = join(projects, 'p', 'project.json');
  writeFileSync(projectJson, JSON.stringify({ ...JSON.parse(readFileSync(projectJson, 'utf8')), repositories: [{ url: APP }], 'golden-image': { folder: golden } }, null, 4));
  const forge = fakeForge();
  forge.route('glab', /^api projects\/g%2Fapp --hostname gitlab\.com$/, { out: { default_branch: 'master' } });
  const lima = mkdtempSync(join(tmpdir(), 'lima-'));
  const env = { ...f.env, PROJECTS_DIR: projects, PATH: forge.path, LIMA_HOME: lima };
  const { cwd, settings } = confineHostAgent({ root: ROOT, data, project: 'p' });
  // The agent's own temp folder, where it stages each command's content.
  const staging = realpathSync(mkdtempSync(join(tmpdir(), 'agent-staging-')));
  const stage = (name, content) => { const file = join(staging, name); writeFileSync(file, content); return file; };
  return { data, projects, work, golden, env, cwd, settings: JSON.parse(readFileSync(settings, 'utf8')), stage };
}

const sprintOf = h => JSON.parse(readFileSync(join(h.projects, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'));
const mrsOf = h => sprintOf(h).features[0].variations[0]['merge-request'] ?? [];

// Each command a host agent gives content to: its arguments with the staged file in the file position (`file`
// standing for it), and a check of what it wrote under data/projects/p.
const COMMANDS = [
  { name: 'work:append', args: ['p', 'ABC-3', 'A', 'change-log.md', 'file'], content: '- found: bats missing from the image\n',
    wrote: h => readFileSync(join(h.work, 'change-log-A.md'), 'utf8') === '- found: bats missing from the image\n', none: h => !existsSync(join(h.work, 'change-log-A.md')) },
  { name: 'work:write', args: ['p', 'ABC-3', 'A', 'notes.md', 'file'], content: '# Notes\n',
    wrote: h => readFileSync(join(h.work, 'notes-A.md'), 'utf8') === '# Notes\n', none: h => !existsSync(join(h.work, 'notes-A.md')) },
  { name: 'automated-tests:record', args: ['p', 'ABC-3', 'A', 'file'], content: '[{"list": "bats --count t", "run": "bats t"}]',
    wrote: h => JSON.parse(readFileSync(join(h.work, 'automated-tests-A.json'), 'utf8'))[0].run === 'bats t', none: h => !existsSync(join(h.work, 'automated-tests-A.json')) },
  { name: 'ticket:set-demo-plan', args: ['p', 'ABC-3', 'A', 'file'], content: '{"demo": false, "why": "a CI gate only"}',
    wrote: h => JSON.parse(readFileSync(join(h.work, 'demo-plan-A.json'), 'utf8')).why === 'a CI gate only', none: h => !existsSync(join(h.work, 'demo-plan-A.json')) },
  { name: 'vm:golden-write', args: ['p', 'provision.sh', 'file'], content: '#!/bin/bash\nsudo apt-get install -y bats\n',
    wrote: h => readFileSync(join(h.golden, 'provision.sh'), 'utf8').includes('bats'), none: h => !readFileSync(join(h.golden, 'provision.sh'), 'utf8').includes('bats') },
  { name: 'ticket:set-merge-request-plan', args: ['p', 'ABC-3', 'A', 'file'], content: JSON.stringify([{ id: 1, repository: APP, contents: 'the fix' }]),
    wrote: h => mrsOf(h).some(m => m.id === 1 && m.contents === 'the fix'), none: h => !mrsOf(h).length },
  { name: 'ticket:add-merge-request', args: ['p', 'ABC-3', 'A', 'file'], content: JSON.stringify({ repository: APP, contents: 'the gate fix', step: 'Blocked', why: 'bats missing' }),
    wrote: h => mrsOf(h).some(m => m.contents === 'the gate fix' && m['planned-by']?.step === 'Blocked'), none: h => !mrsOf(h).length },
];
const line = (args, file) => [AGENT, ...args.map(a => (a === 'file' ? file : a))].join(' ');
// The redirected form: stdin from the file, "-" in its place where the command marks stdin so.
const redirected = (c, file) => `${[AGENT, c.name, ...c.args.filter(a => a !== 'file'), ...(c.args.at(-1) === 'file' && ['ticket:add-merge-request', 'ticket:set-merge-request-plan'].includes(c.name) ? ['-'] : [])].join(' ')} < ${file}`;

test('ASS-428 AC3: the generated settings exclude the harness\'s agent.sh, bare, from the sandbox and deny writes under its data folder', () => {
  const h = harness();
  assert.ok(h.settings.sandbox.excludedCommands.includes(`${ROOT}/agent.sh *`));
  assert.ok(h.settings.sandbox.filesystem.denyWrite.includes(h.data));
  assert.equal(h.cwd, join(h.data, 'projects', 'p'));
  const file = join(tmpdir(), 'entry.md');
  assert.equal(runsUnsandboxed(h.settings, `${AGENT} work:append p ABC-3 A change-log.md ${file}`), true, 'bare, with the file path: outside');
  for (const sandboxed of [
    `${AGENT} work:append p ABC-3 A change-log.md < ${file}`,
    `${AGENT} work:append p ABC-3 A change-log.md <<'EOF'\n- entry\nEOF`,
    `cat ${file} | ${AGENT} work:append p ABC-3 A change-log.md`,
    `${AGENT} work:append p ABC-3 A change-log.md "$(cat ${file})"`,
    `cd /tmp && ${AGENT} work:append p ABC-3 A change-log.md ${file}`,
    `${AGENT} work:append p ABC-3 A change-log.md ${file}; echo done`,
    `bash ${AGENT} work:append p ABC-3 A change-log.md ${file}`,
    `/elsewhere/agent.sh work:append p ABC-3 A change-log.md ${file}`,
  ]) assert.equal(runsUnsandboxed(h.settings, sandboxed), false, sandboxed);
  assert.equal(bare(`${AGENT} ticket:raise-bug p "a | b; c > d" f.json`), true, 'operators inside quotes are text');
});

for (const c of COMMANDS) {
  test(`ASS-428 AC3: ${c.name} under the host-agent sandbox — with the file path, bare, it runs outside the sandbox and writes under data/projects/p; redirected, it runs sandboxed and the write is refused`, { skip: !sandboxRuns && 'sandbox-exec cannot run here' }, async () => {
    const refusedAt = harness();
    const staged = refusedAt.stage('content', c.content);
    const refused = await asHostAgent(refusedAt.settings, redirected(c, staged), refusedAt);
    assert.equal(refused.sandboxed, true);
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stderr, /Operation not permitted/);
    assert.ok(c.none(refusedAt), 'nothing written');
    // The same redirected call outside the sandbox writes: the refusal is the sandbox's alone.
    const control = await new Promise(resolve => execFile('/bin/bash', ['-c', redirected(c, staged)], { cwd: refusedAt.cwd, env: refusedAt.env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr })));
    assert.equal(control.code, 0, control.stderr);
    assert.ok(c.wrote(refusedAt), 'the redirected call writes when not sandboxed');

    const h = harness();
    const ok = await asHostAgent(h.settings, line([c.name, ...c.args], h.stage('content', c.content)), h);
    assert.equal(ok.sandboxed, false);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(c.wrote(h), 'written under data/projects/p');
  });
}

test('ASS-428 AC3: the sandbox profile made from the settings refuses any write under the data folder, and allows temp', { skip: !sandboxRuns && 'sandbox-exec cannot run here' }, async () => {
  const h = harness();
  const inData = join(h.work, 'x.md'), inTemp = join(realpathSync(tmpdir()), `ass-428-${process.pid}.txt`);
  const r = await asHostAgent(h.settings, `echo x > ${inData}; echo y > ${inTemp}`, h);
  assert.equal(r.sandboxed, true);
  assert.match(r.stderr, /Operation not permitted/);
  assert.ok(!existsSync(inData));
  assert.equal(readFileSync(inTemp, 'utf8'), 'y\n');
});
