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
//
// ASS-463: claude-rules.js now states Claude Code 2.1.325's matcher as read
// from its bundled source (every command on the line covered; never a cd, a
// shell or a wrapper; a heredoc, $(…) or a variable carried between commands
// sandboxed), and the settings carry the PreToolUse guard (agent-sh-guard.js),
// run here for real as the hook command the settings name: the lines host
// agents actually typed on 2026-11-15 run sandboxed and fail, the guard
// refuses each before it runs and names the bare call, and that bare call —
// assignments:status-update and assignments:approve among them — writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { confineHostAgent } from '../../src/agents/confinement.js';
import { runsUnsandboxed, bare } from '../support/claude-rules.js';
import { guard } from '../../src/agents/agent-sh-guard.js';
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

// asHostAgent(settings, line, { cwd, env }, { guarded }) — runs the command line as the confined agent's Bash tool
// would: outside the sandbox when the settings exclude it (runsUnsandboxed), else under sandbox-exec with the
// settings' profile. { sandboxed, code, stdout, stderr }. guarded: the settings' PreToolUse hook (agent-sh-guard.js)
// first — a line it refuses never runs: { denied: <its reason> }.
async function asHostAgent(settings, line, { cwd, env }, { guarded = false } = {}) {
  if (guarded) {
    const denied = await hook(settings, { tool_name: 'Bash', tool_input: { command: line }, cwd });
    if (denied) return { denied: denied.hookSpecificOutput.permissionDecisionReason };
  }
  const sandboxed = !runsUnsandboxed(settings, line);
  const [file, args] = sandboxed ? [SANDBOX_EXEC, ['-p', seatbelt(settings, cwd), '/bin/bash', '-c', line]] : ['/bin/bash', ['-c', line]];
  return new Promise(resolve => execFile(file, args, { cwd, env }, (error, stdout, stderr) => resolve({ sandboxed, code: error ? error.code : 0, stdout, stderr })));
}

// hook(settings, input) — runs the settings' PreToolUse Bash hook command as Claude Code would (a shell command, the
// hook input JSON on stdin): its JSON output, or null when it printed nothing (the call goes on).
function hook(settings, input) {
  const [entry] = settings.hooks.PreToolUse.filter(h => h.matcher === 'Bash');
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', ['-c', entry.hooks[0].command], (error, stdout) => (error ? reject(error) : resolve(stdout.trim() ? JSON.parse(stdout) : null)));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', ...input }));
  });
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
  return { data, projects, work, golden, env, cwd, settings: JSON.parse(readFileSync(settings, 'utf8')), stage, staging };
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

// ASS-463 — what Classify and Troubleshoot on Host typed on 2026-11-15 (the project's names put generic), each refused
// by the sandbox: the status update chained to the next step, the approval chained to `echo exit=$?`, the change-log
// entry's heredoc and its work:append in one Bash call, the path in a shell variable. And variations agents produce.
const AS_TYPED = (file, stagingDir) => [
  `${AGENT} assignments:status-update Daredevil "Classifying: image (amd64 pg)"; f=$(python3 -c "print('')" 2>/dev/null); ls ${stagingDir} | grep ^c`,
  `${AGENT} assignments:status-update Daredevil "reading qa block cause"; python3 -c "print(1)"`,
  `${AGENT} assignments:approve Daredevil; echo exit=$?`,
  `f="${stagingDir}/entry.md"; cat > "$f" <<'EOF'\n### Classify (Daredevil)\nClass: project.\nEOF\n${AGENT} work:append p ABC-3 A change-log.md "$f"; echo exit=$?`,
  `f=${stagingDir}/entry.md; cat > $f <<'EOF'\n### Classify\nEOF\n${AGENT} work:append p ABC-3 A change-log.md $f`,
  `cd ${stagingDir} && ${AGENT} work:append p ABC-3 A change-log.md ${file}`,
  `${AGENT} work:append p ABC-3 A change-log.md ${file} 2>&1`,
  `${AGENT} work:append p ABC-3 A change-log.md ${file} && echo ok`,
  `cat ${file} | ${AGENT} work:append p ABC-3 A change-log.md`,
  `${AGENT} work:append p ABC-3 A change-log.md < ${file}`,
  `env X=1 ${AGENT} work:append p ABC-3 A change-log.md ${file}`,
  `bash ${AGENT} work:append p ABC-3 A change-log.md ${file}`,
];

test('ASS-463 AC2: each agent.sh line host agents typed on 2026-11-15, and the variations they produce, runs sandboxed — and the guard refuses it before it runs, naming the bare call', () => {
  const h = harness();
  const file = h.stage('entry.md', '- entry\n');
  for (const line of AS_TYPED(file, h.staging)) {
    assert.equal(runsUnsandboxed(h.settings, line), false, line);
    const refused = guard(line, { root: ROOT, cwd: h.cwd });
    assert.ok(refused, `the guard lets through: ${line}`);
    assert.match(refused.reason, /would run sandboxed/);
    assert.match(refused.reason, /Bash call of its own/);
  }
  // The bare call each names is one the exclusion matches.
  const named = line => guard(line, { root: ROOT, cwd: h.cwd }).reason.split('\n').filter(l => l.startsWith(`  ${AGENT} `)).map(l => l.trim());
  assert.deepEqual(named(AS_TYPED(file, h.staging)[0]), [`${AGENT} assignments:status-update Daredevil 'Classifying: image (amd64 pg)'`]);
  assert.deepEqual(named(AS_TYPED(file, h.staging)[2]), [`${AGENT} assignments:approve Daredevil`]);
  assert.deepEqual(named(AS_TYPED(file, h.staging)[5]), [`${AGENT} work:append p ABC-3 A change-log.md ${file}`]);
  assert.deepEqual(named(AS_TYPED(file, h.staging)[6]), [`${AGENT} work:append p ABC-3 A change-log.md ${file}`]);
  for (const line of [0, 2, 5, 6].flatMap(i => named(AS_TYPED(file, h.staging)[i]))) {
    assert.equal(runsUnsandboxed(h.settings, line), true, line);
    assert.equal(guard(line, { root: ROOT, cwd: h.cwd }), null, line);
  }
  assert.match(guard(AS_TYPED(file, h.staging)[3], { root: ROOT, cwd: h.cwd }).reason, /write the content first to a temp file of your own .* then pass that file's absolute path itself/);
});

test('ASS-463 AC2: the guard lets the bare call through, and every line that names no harness agent.sh call (reading it, grep for it, a heredoc that only mentions it); a relative path to the harness\'s agent.sh is refused, and the exclusion has no relative pattern', () => {
  const h = harness();
  const file = h.stage('entry.md', '- entry\n');
  for (const line of [`${AGENT} work:append p ABC-3 A change-log.md ${file}`, `${AGENT}    assignments:status-update Daredevil "a | b; c > d"`, `${join(ROOT, 'off-board.sh')} ticket:view ASS-1`, `${AGENT} assignments:status-update Daredevil --from ${file}`]) {
    assert.equal(guard(line, { root: ROOT, cwd: h.cwd }), null, line);
    assert.equal(runsUnsandboxed(h.settings, line), true, line);
  }
  for (const line of [`grep -n agent.sh ${ROOT}/src/agent-cli/work/append.sh | head`, `ls -la ${AGENT}`, `cat ${AGENT}`, `cat > ${file} <<'EOF'\n${AGENT} work:append p ABC-3 A change-log.md x\nEOF`, `/elsewhere/agent.sh run`, 'echo hi; ls'])
    assert.equal(guard(line, { root: ROOT, cwd: h.cwd }), null, line);
  const relative = join('..', '..', '..', 'agent.sh');   // from data/projects/p to the harness root's
  const refused = guard(`${relative} work:append p ABC-3 A change-log.md ${file}`, { root: ROOT, cwd: join(ROOT, 'data', 'projects', 'p') });
  assert.match(refused.reason, new RegExp(`a path other than ${AGENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(h.settings.sandbox.excludedCommands.filter(p => /agent\.sh|off-board\.sh/.test(p)).every(p => p.startsWith('/')));
});

test('ASS-463 AC2: the generated settings run the guard as their PreToolUse Bash hook, and the hook command refuses a chained agent.sh line and passes a bare one', async () => {
  const h = harness();
  assert.equal(h.settings.hooks.PreToolUse.length, 1);
  assert.equal(h.settings.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(h.settings.hooks.PreToolUse[0].hooks[0].command, /agent-sh-guard\.js/);
  const out = await hook(h.settings, { tool_name: 'Bash', tool_input: { command: `cd /tmp && ${AGENT} assignments:approve Daredevil` }, cwd: h.cwd });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`\\n  ${AGENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} assignments:approve Daredevil\\n`));
  assert.equal(await hook(h.settings, { tool_name: 'Bash', tool_input: { command: `${AGENT} assignments:approve Daredevil` }, cwd: h.cwd }), null);
  assert.equal(await hook(h.settings, { tool_name: 'Read', tool_input: { file_path: '/x' }, cwd: h.cwd }), null);
});

const assignment = (h, name) => JSON.parse(readFileSync(join(h.data, 'assignments.json'), 'utf8')).assignments.find(a => a['agent-name'] === name);

test('ASS-463 AC3: assignments:status-update from a host agent — the update as an argument or --from a staged file, a bare call: it runs outside the sandbox and writes data/assignments.json; chained to the next step, as typed on 2026-11-15, it runs sandboxed and the write is refused', { skip: !sandboxRuns && 'sandbox-exec cannot run here' }, async () => {
  const h = harness();
  const chained = await asHostAgent(h.settings, `${AGENT} assignments:status-update Daredevil "reading qa block cause"; echo next`, h);
  assert.equal(chained.sandboxed, true);
  assert.match(chained.stderr, /Operation not permitted/);
  assert.equal(assignment(h, 'Daredevil')['ai-status-update-short'], null, 'nothing written');
  const denied = await asHostAgent(h.settings, `${AGENT} assignments:status-update Daredevil "reading qa block cause"; echo next`, h, { guarded: true });
  assert.match(denied.denied, /would run sandboxed/);

  const arg = await asHostAgent(h.settings, `${AGENT} assignments:status-update Daredevil "reading qa block cause"`, h, { guarded: true });
  assert.equal(arg.sandboxed, false);
  assert.equal(arg.code, 0, arg.stderr);
  assert.equal(assignment(h, 'Daredevil')['ai-status-update-short'], 'reading qa block cause');

  const file = h.stage('update.txt', 'it\'s "$HOME" and `x`\n');
  const fromFile = await asHostAgent(h.settings, `${AGENT} assignments:status-update Daredevil --from ${file}`, h, { guarded: true });
  assert.equal(fromFile.sandboxed, false);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(assignment(h, 'Daredevil')['ai-status-update-short'], 'it\'s "$HOME" and `x`');

  const approve = await asHostAgent(h.settings, `${AGENT} assignments:approve Daredevil`, h, { guarded: true });
  assert.equal(approve.sandboxed, false);
  assert.equal(approve.code, 0, approve.stderr);
});

test('ASS-463 AC3: agent-interaction:send-message from a host agent, the message --from a staged file, a bare call: it runs outside the sandbox and queues the message in the other agent\'s inbox under data/agents', { skip: !sandboxRuns && 'sandbox-exec cannot run here' }, async () => {
  const h = harness();
  const file = h.stage('message.txt', 'Use the helper in "lib/x.js" — not $(this).\n');
  const sent = await asHostAgent(h.settings, `${AGENT} agent-interaction:send-message Spock Daredevil --from ${file}`, h, { guarded: true });
  assert.equal(sent.sandboxed, false);
  assert.equal(sent.code, 0, sent.stderr);
  const inbox = execFileSync('/bin/sh', ['-c', `cat ${join(h.data, 'agents')}/Daredevil-*/inbox.jsonl`], { encoding: 'utf8' });
  assert.ok(inbox.includes('not $(this).'), inbox);
});
