// ASS-343: ticket:fix-resume-step — where a blocked ticket resumes once the fix it waited on has
// landed: the fix ticket's declared resume-at, else the earliest step at or before the blocked one
// that its commits' files or the ticket's changed work files map to, else the blocked step itself.
// Against a temporary projects folder, off-board store and git workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const WAIT_BEGAN = '2026-11-10T12:00:00Z';
const change = (from, to, timestamp = '2026-11-10T10:00:00Z', sub) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp, 'agent-dispatch-log': [], ...(sub ? { 'sub-state-change': sub } : {}) });

// p runs `dev`: blocked (a detour), backlog and committed (no work), then the groups plan,
// build and release — release blocked, its own return-to-state — and done. ABC-3 A came from
// release and has waited on q's off-board Q-1 since WAIT_BEGAN. q's workspace is a git
// checkout whose origin's default branch is main.
function blocked() {
  const f = fixture();
  const at = (...rest) => join(f.dir, ...rest);
  const group = (id, sequence, engine) => ({ id, sequence, 'return-to-state': id, action: { type: 'state-engine', engine }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  write(at('engines', 'dev', 'state-engine.json'), { steps: [
    { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
    { id: 'backlog', sequence: 1, action: { type: 'none' } },
    { id: 'committed', sequence: 2, action: { type: 'none' } },
    group('plan', 3, 'sub-plan'), group('build', 4, 'sub-build'), group('release', 5, 'sub-release'),
    { id: 'done', sequence: 6, 'is-done': true, action: { type: 'none' } },
  ] });
  const updated = file => [{ condition: { all: [{ 'turn-complete': true }, { 'file-updated': { file, since: 'turn-start' } }] }, 'move-to-state': 'done' }];
  write(at('engines', 'sub-plan', 'state-engine.json'), { steps: [
    { id: 'enrich-ac', sequence: 1, action: { type: 'prompt', prompt: 'enrich-ac-grouped' } },
    { id: 'write-execution-plan', sequence: 2, action: { type: 'prompt', prompt: 'write-execution-plan-grouped' }, 'exit-events': updated('execution-plan.md') },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'sub-build', 'state-engine.json'), { steps: [
    { id: 'generate-automated-tests', sequence: 1, action: { type: 'prompt', prompt: 'generate-automated-tests-grouped' } },
    { id: 'automated-testing', sequence: 2, action: { type: 'script', command: './agent.sh automated-tests:verify-success {project} {ticket} {variation}' } },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'sub-release', 'state-engine.json'), { steps: [
    { id: 'take-out-of-draft-mode', sequence: 1, action: { type: 'prompt', prompt: 'take-out-of-draft-mode' } },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] });
  const p = at('projects', 'p', 'project.json');
  write(p, { ...JSON.parse(readFileSync(p, 'utf8')), 'execution-state-engine': 'dev' });
  const sprint = at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  Object.assign(s.features[0].variations[0], {
    'harness-status': { state: 'blocked', 'state-engine': 'dev', 'sub-status': { state: 'await-fix', 'state-engine': 'grouped-blocked' } },
    'waits-on': { project: 'q', ticket: 'Q-1' },
    'state-changes': [change('committed', 'plan'), change('plan', 'build'), change('build', 'release'), change('release', 'blocked'),
      change('blocked', 'blocked', WAIT_BEGAN, { 'state-engine': 'grouped-blocked', 'from-state': 'wait-on', 'to-state': 'await-fix' })],
  });
  writeFileSync(sprint, JSON.stringify(s));
  // q: the fix ticket's project, an off-board source keyed Q in the store, and its workspace.
  const tmp = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const origin = join(tmp, 'origin.git'), ws = join(tmp, 'workspace');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '-q', origin, ws], { stdio: 'ignore' });
  const git = (...args) => execFileSync('git', ['-C', ws, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { stdio: 'ignore' });
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  const q = at('projects', 'q', 'project.json');
  write(q, { ...JSON.parse(readFileSync(q, 'utf8')), 'work-sources': [{ name: 'Local', type: 'off-board', folder: 'q', 'key-prefix': 'Q' }], 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: ws }] });
  const store = join(tmp, 'off-board');
  const env = { ...f.env, OFF_BOARD_DIR: store };
  return {
    ...f,
    // The fix ticket Q-1, its front matter with resume-at when given.
    fixTicket: resume => write(join(store, 'q', 'Q-1.md'), `---\nkey: Q-1\ntype: Bug\nstatus: Done\n${resume ? `resume-at: ${resume}\n` : ''}created: ${WAIT_BEGAN}\nupdated: ${WAIT_BEGAN}\n---\n# The fix\n\n## Context\n\nx\n`),
    // A commit on main changing `files`.
    commit: (message, ...files) => { for (const file of files) write(join(ws, file), `${message}\n`); git('add', '-A'); git('commit', '-q', '-m', message); },
    // A file of ABC-3's work folder, written at `when`.
    work: (file, when) => { const path = at('projects', 'p', 'work', 'ABC-3', file); write(path, 'x'); utimesSync(path, new Date(when), new Date(when)); },
    resume: async (...args) => JSON.parse((await run(AGENT, ['ticket:fix-resume-step', ...(args.length ? args : ['p', 'ABC-3', 'A'])], { env })).stdout),
  };
}

test('ASS-343 AC3: nothing declared or derivable resumes at the step it blocked at (none)', async () => {
  const f = blocked();
  f.fixTicket();
  f.commit('Q-10: another ticket whose key starts the same', 'prompts/enrich-ac-grouped/prompt.txt');
  f.work('execution-plan-A.md', '2026-11-10T11:00:00Z');                                             // written before the wait began
  const out = await f.resume();
  assert.equal(out['resume-at'], 'release');
  assert.equal(out['resume-source'], 'none');
  assert.match(out['resume-why'], /nothing the fix changed maps to a step at or before release/);
  assert.deepEqual(out['resume-ignored'], []);
});

test('ASS-343 AC1: the fix ticket\'s declared resume-at wins, a step inside a group lifted to the group; one control may not take is ignored, saying why', async () => {
  const f = blocked();
  f.commit('Q-1: the fix', 'src/agent-cli/automated-tests/verify-success.sh');
  f.fixTicket('write-execution-plan');
  assert.deepEqual(await f.resume(), { 'resume-at': 'plan', 'resume-source': 'declared', 'resume-why': 'Q-1 declares resume-at write-execution-plan (in plan)', 'resume-ignored': [] });
  f.fixTicket('plan');
  assert.equal((await f.resume())['resume-at'], 'plan');
  f.fixTicket('committed');                                                                          // no work step: the commits decide
  const out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['build', 'commits']);
  assert.deepEqual(out['resume-ignored'], [{ step: 'committed', source: 'declared', why: 'committed does no work (its action is none)' }]);
});

test('ASS-343 AC1: derived from the fix\'s commits — a prompt, a command and an engine each map to the group running it; the earliest at or before the blocked step wins', async () => {
  const f = blocked();
  f.fixTicket();
  f.commit('Q-1: the release engine', 'engines/sub-release/state-engine.json');
  let out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['release', 'commits']);
  assert.match(out['resume-why'], /Q-1's commits change engines\/sub-release\/state-engine\.json/);
  f.commit('Q-1: the verify command', 'src/agent-cli/automated-tests/verify-success.sh');
  assert.equal((await f.resume())['resume-at'], 'build');
  f.commit('Q-1: the plan prompt', 'prompts/write-execution-plan-grouped/prompt.txt');
  out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['plan', 'commits']);
  assert.equal(out['resume-why'], 'Q-1\'s commits change prompts/write-execution-plan-grouped/prompt.txt, which sub-plan/write-execution-plan runs');
});

test('ASS-343 AC1: derived from the work folder — a file changed since the wait began maps to the step that writes it (file-updated exits, automated-tests-<V>.json)', async () => {
  const f = blocked();
  f.fixTicket();
  f.work('automated-tests-A.json', '2026-11-10T12:30:00Z');
  f.work('automated-tests-B.json', '2026-11-10T12:30:00Z');                                          // another variation's
  let out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['build', 'data']);
  assert.match(out['resume-why'], /automated-tests-A\.json changed in the work folder since the wait began; sub-build\/generate-automated-tests writes it/);
  f.work('execution-plan-A.md', '2026-11-10T12:31:00Z');
  out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['plan', 'data']);
  // A commit that maps later than the data does not win over it; one as early does (the commits' reason on a tie).
  f.commit('Q-1: the verify command', 'src/agent-cli/automated-tests/verify-success.sh');
  assert.equal((await f.resume())['resume-source'], 'data');
  f.commit('Q-1: the plan prompt', 'prompts/write-execution-plan-grouped/prompt.txt');
  assert.deepEqual(Object.values(await f.resume()).slice(0, 2), ['plan', 'commits']);
});

test('ASS-343: the wait\'s start is the variation\'s wait-began.at (ticket:wait-on, ASS-342) when it has one, before its entry into await-fix', async () => {
  const f = blocked();
  f.fixTicket();
  f.work('execution-plan-A.md', '2026-11-10T12:30:00Z');                                             // after the entry into await-fix
  assert.equal((await f.resume())['resume-source'], 'data');
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  s.features[0].variations[0]['wait-began'] = { at: '2026-11-10T13:00:00Z', inputs: {} };
  writeFileSync(sprint, JSON.stringify(s));
  assert.deepEqual(Object.values(await f.resume()).slice(0, 2), ['release', 'none'], 'written before the wait began');
});

test('ASS-343: always exits 0 — a ticket or variation it cannot find, or one waiting on nothing, is no step found', async () => {
  const f = blocked();
  assert.deepEqual(await f.resume('p', 'ABC-3', 'Z'), { 'resume-at': null, 'resume-source': 'none', 'resume-why': 'the step it blocked at cannot be told', 'resume-ignored': [] });
  assert.equal((await f.resume('nope', 'ABC-3', 'A'))['resume-at'], null);
  assert.deepEqual(Object.values(await f.resume('p', 'abc-3', 'A')).slice(0, 2), ['release', 'none']);   // no fix ticket in the store, no commits: none
});

// ASS-347: a ticket blocked more than once keeps each Blocked run in its variation's blocks
// ({ waits-on, status, landed, ended-at, came-from, run, timestamp }: steps.js append-output-to,
// ticket:record-output). ABC-3 A went plan → build → release, blocked there, waited on ASS-339
// and left Blocked at 09:30 for `resumed` (release unless given), went on to release, blocked
// again at 10:00, waited on `middle` (left at 10:30), and blocked at release a third time,
// now waiting on ASS-343. `blocks` overrides each block's fields by index.
function blockedAgain(f, { resumed = 'release', middle = 'ASS-340', landed = [true, true, true] } = {}) {
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  const at = time => `2026-11-10T${time}:00Z`;
  const rerun = resumed === 'plan' ? [change('blocked', 'plan', at('09:30')), change('plan', 'build', at('09:40')), change('build', 'release', at('09:50'))] : [change('blocked', 'release', at('09:30'))];
  const block = (ticket, time, i) => ({ 'waits-on': { project: 'q', ticket }, status: 'Done', landed: landed[i], 'ended-at': 'done', 'came-from': 'release/take-out-of-draft-mode', run: `run-${i}`, timestamp: at(time) });
  Object.assign(s.features[0].variations[0], {
    'waits-on': { project: 'q', ticket: 'ASS-343' },
    'state-changes': [change('committed', 'plan', at('08:00')), change('plan', 'build', at('08:30')), change('build', 'release', at('09:00')), change('release', 'blocked', at('09:10')),
      ...rerun, change('release', 'blocked', at('10:00')), change('blocked', 'release', at('10:30')), change('release', 'blocked', at('11:00')),
      change('blocked', 'blocked', WAIT_BEGAN, { 'state-engine': 'grouped-blocked', 'from-state': 'wait-on', 'to-state': 'await-fix' })],
    blocks: [block('ASS-339', '09:30', 0), block(middle, '10:30', 1), block('ASS-343', '11:30', 2)].filter(b => b['waits-on'].ticket),
  });
  writeFileSync(sprint, JSON.stringify(s));
}
const PLAN_PROMPT = 'prompts/write-execution-plan-grouped/prompt.txt';
const DETOUR = 'blocked is a blocked or detour state';

test('ASS-347 AC1: an earlier landed fix\'s commits count too — its plan prompt change rewinds a ticket blocked at release to plan (commits), naming its file', async () => {
  const f = blocked();
  f.commit('ASS-339: the plan prompt', PLAN_PROMPT);
  f.commit('ASS-343: the blocked engine', 'engines/grouped-blocked/state-engine.json');
  blockedAgain(f, { middle: null });
  const out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['plan', 'commits']);
  assert.equal(out['resume-why'], `ASS-339's commits change ${PLAN_PROMPT}, which sub-plan/write-execution-plan runs`);
  // ASS-343's own commits lift to Blocked, a detour: ignored, tagged with its key.
  assert.deepEqual(out['resume-ignored'], [{ step: 'blocked', source: 'commits', why: DETOUR, fix: 'ASS-343' }]);
});

test('ASS-347 AC2: a block whose fix did not land contributes nothing; an earlier fix\'s detour step is still ignored, tagged with its key', async () => {
  const f = blocked();
  f.commit('ASS-339: the plan prompt', PLAN_PROMPT);                                                  // its block says landed false
  f.commit('ASS-340: the blocked engine', 'engines/grouped-blocked/state-engine.json');
  f.commit('ASS-343: the verify command', 'src/agent-cli/automated-tests/verify-success.sh');
  blockedAgain(f, { landed: [false, true, true] });
  const out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['build', 'commits']);
  assert.match(out['resume-why'], /^ASS-343's commits change src\/agent-cli\/automated-tests\/verify-success\.sh/);
  // Nothing from ASS-339, whose block did not land; ASS-340's engine change lifts to Blocked, a detour.
  assert.deepEqual(out['resume-ignored'], [{ step: 'blocked', source: 'commits', why: DETOUR, fix: 'ASS-340' }]);
});

test('ASS-347: an earlier fix whose step ran again since its block ended no longer rewinds — resume-ignored says so', async () => {
  const f = blocked();
  f.commit('ASS-339: the plan prompt', PLAN_PROMPT);
  f.commit('ASS-343: the blocked engine', 'engines/grouped-blocked/state-engine.json');
  blockedAgain(f, { resumed: 'plan', middle: null });                                                 // resumed at plan after ASS-339 landed
  const out = await f.resume();
  assert.deepEqual([out['resume-at'], out['resume-source']], ['release', 'none']);
  assert.deepEqual(out['resume-ignored'], [{ step: 'plan', source: 'commits', why: 'plan ran again since ASS-339\'s block ended (2026-11-10T09:30:00Z), so its output already has that fix', fix: 'ASS-339' },
    { step: 'blocked', source: 'commits', why: DETOUR, fix: 'ASS-343' }]);
});

test('ASS-347 AC3: with one landed block — the fix waited on — the output is byte for byte as without blocks', async () => {
  const f = blocked();
  f.commit('Q-1: the verify command', 'src/agent-cli/automated-tests/verify-success.sh');
  f.work('execution-plan-A.md', '2026-11-10T12:31:00Z');
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const raw = async () => (await run(AGENT, ['ticket:fix-resume-step', 'p', 'ABC-3', 'A'], { env: { ...f.env, OFF_BOARD_DIR: join(f.dir, 'nowhere') } })).stdout;
  const before = await raw();
  const s = JSON.parse(readFileSync(sprint, 'utf8'));
  s.features[0].variations[0].blocks = [{ 'waits-on': { project: 'q', ticket: 'Q-1' }, status: 'Done', landed: true, 'ended-at': 'done', run: 'run-0', timestamp: '2026-11-10T09:00:00Z' }];
  writeFileSync(sprint, JSON.stringify(s));
  assert.equal(await raw(), before);
  s.features[0].variations[0].blocks.push({ 'waits-on': { project: 'q', ticket: 'Q-2' }, status: 'Done', landed: false, run: 'run-1', timestamp: '2026-11-10T09:30:00Z' });
  writeFileSync(sprint, JSON.stringify(s));
  assert.equal(await raw(), before, 'a block whose fix did not land changes nothing');
});
