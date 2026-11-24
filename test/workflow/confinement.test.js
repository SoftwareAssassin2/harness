// Which of the real engines' steps a confined host agent runs (ASS-108), and
// that a confined one keeps out of every project's checkout on the Mac (AC6,
// AC7): every host prompt step not on a ticket's code is confined; the
// current engines' code steps all run in the ticket's worktree; the grouped
// engines' code steps — root-cause analysis among them — run in the VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { worksOnCode, confinedWhereText, vmWhereText } from '../../src/control/dispatch.js';
import { runsInVm } from '../../src/control/vm.js';
import { hostAgentSettings } from '../../src/agents/confinement.js';
import { editAllowed, bashWriteAllowed, runsUnsandboxed } from '../support/claude-rules.js';
import { guard } from '../../src/agents/agent-sh-guard.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { copyFileSync } from 'node:fs';
import { engineDir, engineNames } from '../support/engine-walk.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'workflow.yaml')))
  .map(d => [d, readEngine(join(engineDir(d), 'workflow.yaml'))]));
const hostPrompts = Object.entries(engines).flatMap(([engine, e]) => e.steps.filter(s => s.action?.type === 'prompt' && !runsInVm(s)).map(step => ({ engine, step })));

test('every host prompt step without a worktree is confined but the fix ticket\'s Apply Fix, which changes the repo its ticket names, and grouped Blocked\'s host repair, which repairs the ticket\'s own environment; the VM repair runs in the VM', () => {
  const record = { 'working-in-dev-container': false };
  const unconfined = hostPrompts.filter(({ step }) => worksOnCode(step, { name: 'A' }, record)).map(({ engine, step }) => `${engine}/${step.id}`);
  // ASS-390: Repair Project's host step too — it clones the failing repository into a temp folder and pushes its fix branch from there.
  assert.deepEqual(unconfined.toSorted(), ['grouped-blocked/repair-environment-on-host', 'grouped-blocked/repair-project-on-host', 'self-healing-fix/apply-fix']);
  assert.ok(runsInVm(engines['grouped-blocked'].steps.find(s => s.id === 'repair-environment')));
  assert.ok(runsInVm(engines['grouped-blocked'].steps.find(s => s.id === 'repair-project')));
  assert.ok(hostPrompts.length > 20);
  assert.equal(worksOnCode(hostPrompts[0].step, { build: { 'worktree-folder': '/w' } }, record), true);   // in a worktree: the ticket's code
  assert.equal(worksOnCode(hostPrompts[0].step, {}, { 'working-in-dev-container': true }), true);        // the workspace, through the dev container
});

test('the current engines run every code step in the ticket\'s worktree (created before any but Extract Acceptance Criteria), so confinement leaves them as they were', () => {
  for (const name of ['harness-development', 'example-development']) {
    const steps = engines[name].steps;
    const created = steps.find(s => s.id === 'create-worktree').sequence;
    assert.deepEqual(steps.filter(s => s.action.type === 'prompt' && s.sequence < created).map(s => s.id), ['enrich-ac'], name);
  }
});

test('the grouped engines\' code steps — Plan (root-cause analysis among them), Build, Document — run in the ticket variation\'s VM, never on the Mac', () => {
  for (const name of ['grouped-plan', 'grouped-build', 'grouped-document']) {
    const prompts = engines[name].steps.filter(s => s.action.type === 'prompt');
    assert.ok(prompts.length > 0, name);
    for (const step of prompts) assert.ok(runsInVm(step), `${name}/${step.id}`);
  }
  assert.ok(runsInVm(engines['grouped-plan'].steps.find(s => s.id === 'root-cause-analysis')));
});

// The live projects' folders: project.json is untracked, so a fresh clone (a VM's) has none and skips.
test('a confined host agent can change no project\'s checkout on the Mac — each project.json\'s local-pc folder — beyond the harness\'s own data in its own', t => {
  if (!['harness', 'example'].every(p => existsSync(join(ROOT, 'data', 'projects', p, 'project.json')))) return t.skip('no live project.json files');
  const settings = hostAgentSettings(ROOT);
  const tmp = realpathSync(tmpdir());
  const folders = readdirSync(join(ROOT, 'data', 'projects')).filter(p => existsSync(join(ROOT, 'data', 'projects', p, 'project.json')))
    .flatMap(p => (JSON.parse(readFileSync(join(ROOT, 'data', 'projects', p, 'project.json'), 'utf8'))['local-environments'] ?? []).filter(e => e.type === 'local-pc').map(e => e.folder));
  assert.ok(folders.length >= 2, folders.join(', '));
  for (const folder of folders) {
    for (const file of [join(folder, 'todo.md'), join(folder, 'libs', 'users', 'ada', 'docs', 'todo.md'), join(folder, 'src', 'x.js'), join(folder, '.git', 'index')]) {
      assert.equal(editAllowed(settings, file), false, file);
      assert.equal(bashWriteAllowed(settings, file, { cwd: join(ROOT, 'data', 'projects', 'p'), tmp }), false, file);
    }
  }
});

test('a host step in a named repository (run-in-repository, ASS-119) works on that repository\'s code: not confined', () => {
  assert.equal(worksOnCode({ 'run-in-repository': 'harness', action: { type: 'prompt' } }, {}, {}), true);
  assert.equal(worksOnCode({ action: { type: 'prompt' } }, {}, {}), false);
});

// ASS-182 AC3: what each agent is told matches its rules — a confined host agent writes only temp, a VM agent's /mnt/ticket is read-only — and both write the harness's data only through agent.sh, its content on stdin, never piped.
test('ASS-182 AC3: a confined host agent is told it writes only temp and the harness\'s data only through agent.sh, never piping a write; a VM agent that /mnt/ticket is read-only and every write goes through agent.sh on stdin', () => {
  const host = confinedWhereText('/h/data/projects/p', '/code');
  assert.match(host, /You may write only temp; Claude Code refuses any other write\./);
  assert.match(host, /only through the agent\.sh commands you are given/);
  // ASS-428: by file, a bare call — the old "on stdin from a heredoc or a temp file (< file)" ran it sandboxed.
  assert.match(host, /each run as a Bash call of its own and a bare command line/);
  assert.match(host, /Give a command its content by file, never on stdin/);
  assert.match(host, /Never a pipe, redirect, heredoc, cd, &&, ; or \$\(…\) on an agent\.sh line/);
  assert.match(host, /name each such command in sandbox-refused/);
  assert.doesNotMatch(host, /<<'EOF'|< file/);
  assert.doesNotMatch(host, /data folders/);
  const vm = vmWhereText({ id: 'p', json: { repositories: [{ url: 'https://github.com/o/app', description: 'The app.' }] } }, 'abc-3-a');
  assert.match(vm, /The ticket's folder is \/mnt\/ticket, read-only: read the ticket's files there; write them only through agent\.sh, the content on stdin\./);
  assert.doesNotMatch(vm, /read and write/);
});

// ASS-229 AC2: a project's VM agents are told how to run its full checks there, from project.json's "vm-full-checks"; none, nothing.
test('ASS-229 AC2: vmWhereText adds project.json\'s vm-full-checks line to {where}, for the whole VM and for one repository; a project without one gets none', () => {
  const repositories = [{ url: 'https://github.com/o/app', description: 'The app.' }];
  const line = 'Full checks: bash scripts/validate.sh in the repository.';
  for (const repository of [undefined, 'app']) {
    const lines = vmWhereText({ id: 'p', json: { repositories, 'vm-full-checks': line } }, 'abc-3-a', repository).split('\n');
    assert.equal(lines.at(-1), line, repository);
    assert.match(vmWhereText({ id: 'p', json: { repositories } }, 'abc-3-a', repository).split('\n').at(-1), /^The ticket's folder is .* Run every other command here, in the VM\.$/, repository);
  }
});

// ASS-238 AC3: the forge token in a VM is for git and package installs only; every VM agent is told so, and to read
// and update merge requests through the host, never calling a forge or Jira API itself.
test('ASS-238 AC3: vmWhereText says the forge token is for git and package installs only, merge requests go through agent.sh merge-request:*, and no forge or Jira API is called from the VM', () => {
  for (const repository of [undefined, 'app']) {
    const vm = vmWhereText({ id: 'p', json: { repositories: [{ url: 'https://github.com/o/app' }] } }, 'abc-3-a', repository);
    assert.ok(vm.includes('The forge token in your environment is for git and package installs only. Read and update merge requests only through agent.sh merge-request:view, merge-request:update, merge-request:upload-image, merge-request:reply and merge-request:resolve; never call a forge or Jira API yourself.'), vm);
  }
});

// ASS-428 AC2: every prompt a host agent runs — confined or not — gives agent.sh its content by a file path, a bare
// call: no agent.sh call takes it on stdin ("on stdin", "-" where a path may stand), from a redirect, heredoc or pipe.
// Left out: the flat development engines' steps in the ticket's worktree (and their test sub-engines), which run
// outside the sandbox (worksOnCode) and whose prompts are never changed.
const STDIN_MARKED = ['ticket:set-acceptance-criteria', 'ticket:set-merge-request-plan', 'ticket:add-merge-request', 'ticket:propose-split', 'ticket:post-comment'];
const inWorktree = (engine, step) => ['steps-to-test', 'test'].includes(engine)
  || (['harness-development', 'example-development'].includes(engine) && step.sequence >= engines[engine].steps.find(s => s.id === 'create-worktree').sequence);
test('ASS-428 AC2: every host prompt gives agent.sh its content by a staged file\'s path, a bare call — never on stdin, a redirect, heredoc or pipe', () => {
  const host = [...new Set(hostPrompts.filter(({ engine, step }) => !inWorktree(engine, step)).map(({ step }) => step.action.prompt))];
  for (const p of ['troubleshoot-block-on-host-grouped', 'classify-issue-grouped', 'repair-image-on-host-grouped', 'repair-environment-on-host-grouped', 'repair-project-on-host-grouped', 'groom', 'estimate', 'split-ticket', 'clean-memory', 'apply-fix'])
    assert.ok(host.includes(p), p);
  const problems = host.flatMap(p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8').split('\n').flatMap((line, i) => {
    const at = `${p}:${i + 1}`, found = [];
    const calls = [...line.matchAll(/`([^`]*(?:\{agent-sh\}|agent\.sh)[^`]*)`/g)].map(m => m[1]);
    for (const call of calls) {
      const bare = call.replace(/"[^"]*"/g, 'S').replace(/<[^<>\s][^<>]*>/g, 'X');   // quoted text and <placeholders> aside
      if (/[|<>;&]|\$\(/.test(bare)) found.push(`${at}: not a bare call: ${call}`);
      const command = /(?:\{agent-sh\}|agent\.sh) ([a-z-]+:[a-z-]+)/.exec(call)?.[1];
      if (STDIN_MARKED.includes(command) && / -$/.test(call.trim())) found.push(`${at}: "-" (stdin) where a file path goes: ${call}`);
    }
    if (calls.length && /(?<!never )on stdin/.test(line)) found.push(`${at}: content on stdin`);
    if (/<<\s*'?EOF|\bheredoc \(<</.test(line)) found.push(`${at}: a heredoc`);
    return found;
  }));
  assert.deepEqual(problems, []);
});

// ASS-463 AC4: the messages control and other agents send an agent while it works — its dispatch's wrapper, the status
// check-in (supervise.js's nag: agent:request-status-update), a paired agent's message, the shut-down — as each engine
// names them, filled for a host agent exactly as agent.sh fills them: every agent.sh call in them is one the host-agent
// sandbox runs outside it (claude-rules.js runsUnsandboxed, the generated settings) and the guard lets through, each
// is told to run as a Bash call of its own, and none takes its content on stdin but in a VM.
const ROLES = { 'receive-dispatch-prompt': ['receive-dispatch', f => f.agent('agent:dispatch', 'Daredevil'), 'Daredevil'],
  'receive-pair-dispatch-prompt': ['receive-pair-dispatch', f => f.agent('agent:dispatch', 'Spock'), 'Spock'],
  'receive-message-prompt': ['receive-message-from-another-agent', f => f.agent('agent-interaction:send-message', 'Spock', 'Daredevil', 'the message'), 'Daredevil'],
  'ask-for-status-update-prompt': ['ask-for-status-update', f => f.agent('agent:request-status-update', 'Daredevil'), 'Daredevil'],
  'shut-down-prompt': ['shut-down', f => f.agent('agent:shut-down', 'Daredevil'), 'Daredevil'] };
// agentShCalls(text, agentSh) — each agent.sh call in the text: a line that is one, or one in backquotes; placeholders filled.
const agentShCalls = (text, agentSh) => [...text.split('\n').filter(l => l.trim().startsWith(agentSh)).map(l => l.trim()),
  ...[...text.matchAll(/`([^`]*agent\.sh[^`]*)`/g)].map(m => m[1])]
  .map(c => c.replace(/"<[^>]+>"/g, '"some text"').replace(/<to-agent>/g, 'Daredevil').replace(/<[a-z-]+-file>/g, '/tmp/x.md'));
test('ASS-463 AC4: every status, check-in, message and shut-down prompt an engine sends a host agent gives agent.sh calls the sandbox runs outside it, each to be run as a Bash call of its own, none on stdin but in a VM', async () => {
  const settings = hostAgentSettings(ROOT);
  const agentSh = join(realpathSync(ROOT), 'agent.sh');
  const templates = Object.fromEntries(Object.keys(ROLES).map(key => [key, new Set([ROLES[key][0], ...Object.values(engines).map(e => e[key]).filter(Boolean)])]));
  assert.ok(templates['receive-dispatch-prompt'].has('receive-dispatch-grouped'), [...templates['receive-dispatch-prompt']].join());
  const problems = [];
  let checked = 0;
  for (const [key, names] of Object.entries(templates)) {
    for (const name of names) {
      const f = fixture();
      const [slot, send, to] = ROLES[key];
      copyFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), join(f.dir, 'prompts', slot, 'prompt.txt'));
      await send(f);
      const text = f.inbox(to).at(-1);
      const calls = agentShCalls(text, agentSh);
      if (key !== 'shut-down-prompt' && !calls.length) problems.push(`${name}: no agent.sh call found in ${text}`);
      for (const call of calls) {
        checked++;
        if (!runsUnsandboxed(settings, call)) problems.push(`${name}: runs sandboxed: ${call}`);
        if (guard(call, { root: realpathSync(ROOT) })) problems.push(`${name}: the guard refuses: ${call}`);
      }
      if (calls.length && !/Bash call of its own|own Bash call/.test(text)) problems.push(`${name}: never says to run agent.sh as a Bash call of its own`);
      for (const line of text.split('\n')) if (/on stdin/.test(line) && !/in a VM/.test(line)) problems.push(`${name}: content on stdin: ${line}`);
      if (/;\s*\{?(status-update|approve)-command/.test(readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8'))) problems.push(`${name}: a command chained in the template`);
    }
  }
  assert.ok(checked >= 10, String(checked));
  assert.deepEqual(problems, []);
  // The {code-scope} preamble every wrapper starts with no longer says "the content on stdin" (host agents redirected into agent.sh).
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'agent-cli', 'prompt.bash'), 'utf8'), /you are given, the content on stdin/);
});

// ASS-463 AC2: control's {where} reaches every agent — a prompt without its own {where} (Classify, Troubleshoot on
// Host) gets it first — so a confined host agent always reads how to call agent.sh.
test('ASS-463 AC2: agent:dispatch puts control\'s where= first in a prompt without {where}, and in place in one with it', async () => {
  const f = fixture();
  const where = confinedWhereText('/h/data/projects/p', '/code', `${ROOT}/agent.sh`);
  const { stdout } = await f.agent('agent:dispatch', 'Daredevil', `where=${where}`);
  assert.ok(stdout.includes(`${where}\n\nBuild ABC-3 variation A of p`), stdout);
  assert.match(where, /each run as a Bash call of its own and a bare command line/);
  assert.match(where, /no cd before it, nothing chained after it/);
  writeFileSync(join(f.dir, 'prompts', 'generate-solution', 'prompt.txt'), 'Intro.\n{where}\nBuild.\n');
  const placed = (await f.agent('agent:dispatch', 'Daredevil', `where=${where}`)).stdout;
  assert.ok(placed.includes(`Intro.\n${where}\nBuild.`), placed);
  assert.equal(placed.split(where).length, 2, 'once');
});
