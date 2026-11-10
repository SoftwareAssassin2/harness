// The prompts and personas serve every project, so they name none (ASS-17 AC3):
// no project's folder and no project's ticket key prefix — the off-board
// key-prefix, or the Jira project in a work source's url — in what an agent is
// sent (prompt.txt, the personas) or in an input argument's example. HD is the
// harness's old prefix. A prompt.json description is not sent; it may cite the
// ticket that made the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
// The projects on this machine: data/projects is local, untracked, so a fresh clone has none.
const projects = (existsSync(join(ROOT, 'data', 'projects')) ? readdirSync(join(ROOT, 'data', 'projects')) : []).filter(p => existsSync(join(ROOT, 'data', 'projects', p, 'project.json')));
const prefixes = ['HD', ...projects.flatMap(p => JSON.parse(readFileSync(join(ROOT, 'data', 'projects', p, 'project.json'), 'utf8'))['work-sources'] ?? [])
  .map(s => s['key-prefix'] ?? s.url?.match(/\/projects\/([A-Z]+)\b/)?.[1]).filter(Boolean)];
const key = new RegExp(`\\b(${prefixes.join('|')})-(\\d+|n)\\b`);
const prompts = readdirSync(join(ROOT, 'prompts')).filter(p => existsSync(join(ROOT, 'prompts', p, 'prompt.json')));

test('the prompts and personas an agent is sent name no project\'s ticket key', () => {
  const texts = [
    ...prompts.filter(p => existsSync(join(ROOT, 'prompts', p, 'prompt.txt'))).map(p => join('prompts', p, 'prompt.txt')),
    ...readdirSync(join(ROOT, 'personas')).map(f => join('personas', f)),
  ];
  const named = texts.filter(f => key.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(named, [], `${key} found in these`);
});

test('no prompt\'s input-argument example names a project\'s folder or ticket key', () => {
  const named = prompts.flatMap(p => (JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8'))['input-arguments'] ?? [])
    .filter(a => typeof a.example === 'string' && (key.test(a.example) || projects.some(id => a.example === id || a.example.includes(`projects/${id}`))))
    .map(a => `${p}: ${a.name} = ${a.example}`));
  assert.deepEqual(named, []);
});

// A step whose forward exit is file-updated goes on only once its file is
// written this turn, so a re-entry that finds the file still right must still
// write it (ASS-136): every such step in the grouped and v2 engines names a
// prompt that says to write it every run (the planning prompts then record a
// re-check that changes nothing as a dated "What changed" entry; the
// explanation, shown at Human Review, carries no change log). The flat engines
// keep their own prompts.
const RECHECK = /Write it every run, even when nothing (needs changing|has changed): the step goes on only once the file is written\./;
const fileUpdated = c => Boolean(c && typeof c === 'object' && !c.not && (c['file-updated'] || (c.all ?? c.any ?? []).some(fileUpdated)));

test('AC1, AC2, AC3: every grouped and v2 step whose forward exit is file-updated names a prompt saying to write its file every run', () => {
  const engines = engineNames().filter(d => /^(grouped|v2)-|-(grouped|v2)$/.test(d) && existsSync(join(engineDir(d), 'state-engine.json')));
  const steps = engines.flatMap(d => JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8')).steps
    .filter(s => s.action?.type === 'prompt' && (s['exit-events'] ?? []).some(e => fileUpdated(e.condition)))
    .map(s => ({ step: `${d}/${s.id}`, prompt: s.action.prompt })));
  assert.ok(steps.length >= 4, `found ${steps.map(s => s.step)}`);
  const missing = steps.filter(s => !RECHECK.test(readFileSync(join(ROOT, 'prompts', s.prompt, 'prompt.txt'), 'utf8')));
  assert.deepEqual(missing, []);
});

// Enrich Automated Test Data runs in the VM, on the checkout's master, before
// Generate Solution creates the merge request's branch from origin/<base>
// (ASS-112): a commit there would never reach that branch, so its test data
// is left uncommitted, as Generate Automated Tests leaves its tests, and goes
// onto the branch with them.
test('ASS-112: enrich-automated-test-data-grouped leaves its test data uncommitted, for Generate Solution to commit on the merge request\'s branch', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'enrich-automated-test-data-grouped', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(text, /Commit in the ticket's worktree/);
  assert.match(text, /Don't commit it: Generate Solution commits it on the merge request's branch, which it makes from origin\./);
});

// Generate Automated Tests runs in the VM (ASS-113), in /repos/, on the
// checkout's default branch, before Generate Solution makes the merge
// request's branch from origin/<base>: its list and run commands are run by
// automated-tests:* from the folder the agent starts in (/repos/ in a VM, the
// worktree on the host), not a repository's root, and its tests are left
// uncommitted, for Generate Solution to carry onto the branch and commit.
test('ASS-113: generate-automated-tests-grouped is told where it is, records commands run from the folder it starts in, and leaves its tests uncommitted; generate-solution-grouped carries them onto the merge request\'s branch and commits them there', () => {
  const tests = readFileSync(join(ROOT, 'prompts', 'generate-automated-tests-grouped', 'prompt.txt'), 'utf8');
  assert.match(tests, /\{where\}/);
  assert.doesNotMatch(tests, /from your worktree's root/);
  assert.match(tests, /each run with bash from the folder you start in \(in a VM, \/repos\/: cd into the repository first\)/);
  assert.match(tests, /Don't commit them: Generate Solution commits them on the merge request's branch, which it makes from origin\./);
  const solution = readFileSync(join(ROOT, 'prompts', 'generate-solution-grouped', 'prompt.txt'), 'utf8');
  assert.match(solution, /Carry onto it the uncommitted tests and test data the earlier steps left in the checkout/);
  const flat = readFileSync(join(ROOT, 'prompts', 'generate-automated-tests', 'prompt.txt'), 'utf8');
  assert.match(flat, /from your worktree's root/, 'the flat engines\' prompt is unchanged');
});

// ASS-337: a test whose run cannot execute in the VM leaked into
// automated-tests-<variation>.json because only `list` was checked, and
// Automated Testing blocked on it.
test('ASS-337 AC1, AC2, AC3: generate-automated-tests-grouped checks each entry\'s run in the VM, names the CI-only rule and its admission_test.go precedent; the flat engines\' prompt is unchanged', () => {
  const grouped = readFileSync(join(ROOT, 'prompts', 'generate-automated-tests-grouped', 'prompt.txt'), 'utf8');
  const rule = grouped.split(/(?<=\.) /).find(s => /ci-only/i.test(s));
  assert.ok(rule, 'AC1: a sentence names the CI-only rule');
  assert.match(rule, /`run` cannot execute in this VM/);
  assert.match(rule, /missing toolchain, outside credential, image not on the mirror/);
  assert.match(rule, /author it on the branch/);
  assert.match(rule, /omit it from automated-tests-\{variation\}\.json/);
  assert.match(grouped, /check its run command actually runs here in the VM, not only its list/, 'AC2');
  assert.match(grouped, /drop the entry otherwise/, 'AC2');
  assert.match(grouped, /Precedent: the admission_test\.go case/, 'AC3');
  const flat = readFileSync(join(ROOT, 'prompts', 'generate-automated-tests', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(flat, /ci-only|admission_test/i, 'the flat engines\' prompt is unchanged');
});

// Automated Testing (ASS-113 pair 2) sends a new failure back to Generate
// Solution; automated-tests:verify-success writes what ran and failed to the
// ticket's folder, automated-test-results-<variation>.md — the file
// generate-solution-grouped must be told to read, or it revises blind.
test('ASS-113: generate-solution-grouped reads the automated tests\' last results, automated-test-results-{variation}.md, among the notes that say what to fix; the flat engines\' prompt is unchanged', () => {
  const solution = readFileSync(join(ROOT, 'prompts', 'generate-solution-grouped', 'prompt.txt'), 'utf8');
  assert.match(solution, /automated-test-results-\{variation\}\.md/);
  const flat = readFileSync(join(ROOT, 'prompts', 'generate-solution', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(flat, /automated-test-results/);
});

// Local Testing (ASS-114 pair 1) sends a failed criterion back into Build at
// Generate Solution. The flat engines' test prompt knows neither the test
// plan nor which failures master has too: in the VM a whole-suite run can
// fail on its environment alone (ASS-125's plan names 7), and a criterion
// "the suite passes" judged on that rebuilds what no code change can fix. It
// also says to "bring up the app", which for the harness is the TUI — the
// supervisor, starting control. test-grouped says to test the way the test
// plan (and the demo plan, which shows how to bring the change up) says, and
// that a failure master has too fails no criterion.
test('ASS-114: test-grouped tests each criterion the way test-plan.md (and demo-plan-{variation}.json) says, a failure master has too failing none; the flat engines\' prompt is unchanged', () => {
  const grouped = readFileSync(join(ROOT, 'prompts', 'test-grouped', 'prompt.txt'), 'utf8');
  assert.match(grouped, /\{ticket-folder\}\/test-plan-\{variation\}\.md/);
  assert.match(grouped, /demo-plan-\{variation\}\.json/);
  assert.match(grouped, /automated-test-results-\{variation\}\.md/);
  assert.match(grouped, /master has too fails no criterion/);
  assert.match(grouped, /\{ticket-folder\}\/test-results-\{variation\}\.md/, 'what Generate Solution and Steps to Test read');
  const flat = readFileSync(join(ROOT, 'prompts', 'test', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(flat, /test-plan\.md|master has too/);
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'prompts', 'test-grouped', 'prompt.json'), 'utf8')).output, JSON.parse(readFileSync(join(ROOT, 'prompts', 'test', 'prompt.json'), 'utf8')).output);
});

// An agent's VM has no display (ASS-114 pair 1): take-screenshots-grouped
// says how to shoot a terminal app there — its screen produced as the demo
// plan does (never its supervisor or main.js, which for the harness starts
// control), in a <pre> page shot with Firefox ESR headless (in the golden
// image, desktop.sh) — and, when even that cannot be done, an empty list with
// a note, which the output schema allows.
test('ASS-114: take-screenshots-grouped shoots a terminal app with no display — its screen as the demo plan produces it, never its supervisor or main.js, in a dark monospace <pre> page shot with firefox-esr --headless --screenshot; else an empty list with a note', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'take-screenshots-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /no display/);
  assert.match(text, /demo-plan-\{variation\}\.json/);
  assert.match(text, /never start its supervisor or main\.js/);
  assert.match(text, /<pre>/);
  assert.match(text, /dark background, monospace/);
  assert.match(text, /firefox-esr --headless --screenshot=<absolute png>/);
  assert.match(text, /empty list with a note/);
  const output = JSON.parse(readFileSync(join(ROOT, 'prompts', 'take-screenshots-grouped', 'prompt.json'), 'utf8')).output;
  assert.equal(output.properties.note?.type, 'string');
  assert.deepEqual(output.required, ['screenshots']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'take-screenshots', 'prompt.txt'), 'utf8'), /firefox/, 'the flat engines\' prompt is unchanged');
});

// ASS-182 AC1: the VM's /mnt/ticket is read-only, so each screenshot is saved through agent.sh, the PNG on stdin.
test('ASS-182 AC1: take-screenshots-grouped saves each screenshot through work:add-screenshot, the PNG on stdin — one merge request\'s under its id, the ticket\'s under -', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'take-screenshots-grouped', 'prompt.txt'), 'utf8');
  assert.ok(text.includes('`{agent-sh} work:add-screenshot {project} {ticket} {variation} <id> criterion-<n>.png < <file>`'), text);
  assert.match(text, /`-` for <id> when it shows the ticket as a whole/);
});

// Update Documentation runs in the VM (ASS-115), after Build has pushed each
// merge request's branch: docs it edits must land on those branches, or they
// stay uncommitted in the VM's checkout, never reach a merge request and leave
// the tree dirty for a later Automated Testing. It is told where it is, reads
// the merge requests, commits on each one's branch and pushes it — never on
// its base. The flat engines' prompt is unchanged.
test('ASS-115: update-documentation-grouped is told where it is, updates the docs of every Open merge request on its branch, commits and pushes there, never on its base; the flat engines\' prompt is unchanged', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'update-documentation-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /\{where\}/);
  const plan = text.indexOf('{agent-sh} ticket:merge-request-plan {project} {ticket} {variation}'), checkout = text.indexOf('check out its branch'), commit = text.indexOf('Commit them on that branch and push it'), never = text.indexOf('Never commit to its base');
  assert.ok(plan > 0 && plan < checkout && checkout < commit && commit < never, text);
  assert.match(text, /every one that is Open/);
  assert.match(text, /If no documentation needs to change, say so and change nothing\./);
  const json = JSON.parse(readFileSync(join(ROOT, 'prompts', 'update-documentation-grouped', 'prompt.json'), 'utf8'));
  assert.deepEqual(json['input-arguments'].map(a => a.name), ['project', 'ticket', 'variation']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'update-documentation', 'prompt.txt'), 'utf8'), /merge-request-plan|\{where\}/);
});

// Update Merge Request Details rewrites each description; Explain the Change
// (Review, ASS-118) puts a "## Summary" at its top, which a later pass's
// rewrite must keep — but only when it is there: on a first pass it is not
// yet, and the step must not make one up (ASS-139). A harness ticket off the board has no url: the first
// line is its link only when ticket.json has one, else its key — never a
// made-up link. The flat engines' prompt is unchanged.
test('ASS-115: update-merge-request-details-grouped keeps the Summary Explain the Change put at the top, and links the ticket only by the url ticket.json has; the flat engines\' prompt is unchanged', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'update-merge-request-details-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /If the description starts with a "## Summary" section \(Explain the Change writes it\), keep it as it is and put the rest below it; if it has none, don't add one/);
  assert.doesNotMatch(text, /Keep a "## Summary"/, 'ASS-139: it runs before Explain the Change, so a Summary may not be there yet');
  assert.match(text, /its url in \{ticket-folder\}\/ticket\.json; its key alone when it has none/);
  const flat = readFileSync(join(ROOT, 'prompts', 'update-merge-request-details', 'prompt.txt'), 'utf8');
  assert.doesNotMatch(flat, /Summary|ticket\.json/);
});

// Found live (ASS-114 pair 1): after a word-diff against the commit before,
// test-grouped's agent left the VM's /repos/harness on a detached HEAD at the
// branch tip — a later committing step would have committed off the branch.
// The VM prompts that may check out another commit to compare (Test, Take
// Screenshots: a before/after) say to leave every repository on its branch,
// clean. write-steps-to-test writes only into the ticket folder; the flat
// engines' prompts are unchanged.
const LEAVE_ON_BRANCH = 'Leave every repository on the branch it was on when you started, with no uncommitted changes; if you check out another commit to compare, switch back to the branch by name.';
test('ASS-114: test-grouped and take-screenshots-grouped leave every repository on the branch it was on, clean, switching back by name after checking out another commit; the flat engines\' test and take-screenshots are unchanged', () => {
  for (const p of ['test-grouped', 'take-screenshots-grouped']) assert.ok(readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8').includes(LEAVE_ON_BRANCH), p);
  for (const p of ['test', 'take-screenshots']) assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8'), /switch back to the branch/, p);
});

// ASS-304: test-grouped's prompt had no rule against ending the `claude -p`
// turn while a command it started (e.g. a backgrounded `npm test`) was still
// running. On ASS-303 visit 3 the agent started `npm test > log 2>&1 &`,
// emitted its final JSON ~252s later with the suite still running, wrote no
// test-results file, and burned the Test visit budget. The rule covers both
// paths — foreground with a timeout long enough for the command, or
// background polled to exit — since the full suite (~13-18 min) outlasts
// Bash's 10-min foreground cap, so poll-to-exit is mandatory for it. The
// flat test prompt has no test-plan/demo-plan machinery and is out of scope.
const NO_BACKGROUND_AT_TURN_END = 'Never end your turn while a command you started is still running: run a long one (a full test suite, say) in the foreground with a timeout long enough for it, or, when it may outlast the tool\'s foreground limit, in the background, polling it until it exits — then write your results and finish.';
test('ASS-304: test-grouped never ends its turn while a command it started is still running — foreground with a long enough timeout, or background polled until it exits; the flat engines\' test prompt is unchanged', () => {
  const grouped = readFileSync(join(ROOT, 'prompts', 'test-grouped', 'prompt.txt'), 'utf8');
  assert.ok(grouped.includes(NO_BACKGROUND_AT_TURN_END), grouped);
  assert.match(grouped, /Never end your turn while a command you started is still running/);
  assert.match(grouped, /in the foreground with a timeout/);
  assert.match(grouped, /polling it until it exits/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'test', 'prompt.txt'), 'utf8'), /end your turn|still running/);
});

// ASS-317: an unfinished test run (the suite cut short within the turn) read
// as a rejection and cost a Build round and a Test visit. test-grouped's
// output gains a third verdict, did-not-finish, on which v2's Test re-runs;
// optional, so every caller of the shared shape stays valid, and the flat
// test prompt's output kept the same (the deep-equal above).
test('ASS-317 AC1: test-grouped\'s output has did-not-finish, a boolean, not required, no other field allowed, the flat test prompt\'s the same; its prompt says when to set it', () => {
  for (const name of ['test-grouped', 'test']) {
    const { output } = JSON.parse(readFileSync(join(ROOT, 'prompts', name, 'prompt.json'), 'utf8'));
    assert.equal(output.properties['did-not-finish']?.type, 'boolean', name);
    assert.ok(!output.required.includes('did-not-finish'), name);
    assert.deepEqual(output.required, ['is-approved', 'summary'], name);
    assert.equal(output.additionalProperties, false, name);
  }
  assert.match(readFileSync(join(ROOT, 'prompts', 'test-grouped', 'prompt.txt'), 'utf8'), /did-not-finish/);
});

// Add Screenshots to Merge Request runs in the VM (ASS-115) and attaches the
// screenshots Local Testing took to every Open merge request. GitLab takes an
// image through its uploads API; GitHub has no API to attach one to a pull
// request, so the images are pushed from the VM to a branch of their own,
// screenshots/<ticket>-<variation>, an orphan never merged into main, the
// merge request's branch untouched — and linked into the description pinned
// to that commit. The description's ## Summary, if it has one yet (never made
// up, ASS-139), stays at the top and the rest as it is. The flat engines' prompt is unchanged.
test('ASS-115: add-screenshots-to-merge-request-grouped is told where it is, uploads to a GitLab merge request through its API, and for a GitHub pull request pushes the images to an orphan screenshots/<ticket>-<variation> branch and links them pinned to its commit, adding or replacing a ## Screenshots section below ## Summary; the flat engines\' prompt is unchanged', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'add-screenshots-to-merge-request-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /\{where\}/);
  assert.match(text, /\{agent-sh\} ticket:merge-request-plan \{project\} \{ticket\} \{variation\}/);
  // ASS-238: the upload, on either forge, is the host's merge-request:upload-image (GitHub's an orphan screenshots/<KEY>-<variation> branch, pinned).
  assert.match(text, /\{agent-sh\} merge-request:upload-image \{project\} \{ticket\} \{variation\} <id> - <name>\.png < <path>/);
  assert.match(text, /Add or replace a "## Screenshots" section/);
  assert.match(text, /Keep a "## Summary" section at the top as it is if there is one \(never add one\)/);
  assert.doesNotMatch(text, /Keep a "## Summary" section at the top as it is,/, 'ASS-139: it runs before Explain the Change, so a Summary may not be there yet');
  assert.doesNotMatch(text, /Upload each one to the merge request/, 'GitHub has no upload: the step names each forge\'s way');
  const flat = readFileSync(join(ROOT, 'prompts', 'add-screenshots-to-merge-request', 'prompt.txt'), 'utf8');
  assert.match(flat, /Upload each one to the merge request/);
  assert.doesNotMatch(flat, /orphan|GitHub|\{where\}/);
});

// Explain the Change puts the variation's Summary at the top of every Open
// merge request's description (ASS-118), in the VM (ASS-116). An earlier
// step may already have put a "## Summary" there holding something else —
// found live: Update Merge Request Details wrapped PR #23's old body, with
// merge-request:create's broken ticket link line, under one — so the whole
// section, heading to next heading, is replaced and exactly one is left,
// first. On GitHub the body goes through a file (gh pr edit --body-file),
// never quoted on the command line. Only grouped-review and v2-review run
// this prompt, so it is changed in place.
test('ASS-116: explain-the-change replaces the whole of any "## Summary" section, heading to next heading, leaving exactly one, first; read and written through the host (ASS-238)', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'explain-the-change', 'prompt.txt'), 'utf8');
  assert.match(text, /A Summary section runs from its "## Summary" heading to the next "## " heading: replace the whole of it, whatever it holds/);
  assert.match(text, /leave exactly one "## Summary", first/);
  assert.match(text, /\{agent-sh\} merge-request:view \{project\} \{ticket\} \{variation\} <id>/);
  assert.match(text, /\{agent-sh\} merge-request:update \{project\} \{ticket\} \{variation\} <id> -/);
  const users = engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')) && readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8').includes('"prompt": "explain-the-change"'));
  assert.deepEqual(users, ['grouped-review', 'v2-review'], 'no flat engine runs it: no -grouped copy needed');
});

// Rejected at Human Review sends the ticket back into Plan at Write Execution
// Plan (ASS-116 pair 2: v2-review's replan, as grouped-review's), the reason
// kept as the variation's rejection-reason in ticket.json (ASS-118). Only
// Explain the Change read it, so the plan the rejection was about came back
// re-checked unchanged and was built again. The grouped copy reads it too;
// the flat engines' write-execution-plan is unchanged.
test('ASS-116: write-execution-plan-grouped answers the operator\'s rejection at Human Review — the variation\'s rejection-reason in ticket.json — and the flat write-execution-plan is unchanged', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'write-execution-plan-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /If the variation in ticket\.json has a "rejection-reason", the operator rejected an earlier pass at Human Review for it: revise the plan to answer it, and say how under "## What changed"\. Already answered there, keep the answer\./);
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'write-execution-plan', 'prompt.txt'), 'utf8'), /rejection-reason/);
});

// ASS-339: a plan pinned a consumer to a producer image published only after
// the producer's merge request merged; the digest was unknowable in the VM, so
// a placeholder sha256:0000…0000 shipped and Ensure Auto-Merge never armed it.
test('ASS-339 AC1, AC2, AC3: write-execution-plan-grouped forbids pinning a consumer to a producer digest published only after merge, names the all-zeros placeholder digest symptom; the flat write-execution-plan is unchanged', () => {
  const text = readFileSync(join(ROOT, 'prompts', 'write-execution-plan-grouped', 'prompt.txt'), 'utf8');
  assert.match(text, /Never pin a consumer to a digest or tag a producer repository publishes only after its merge request merges/, 'AC1');
  assert.match(text, /when that digest can't be read here in the VM \(no registry credentials\), plan the producer's merge request alone and leave the consumer's pin to Renovate or a separate follow-up ticket/, 'AC1');
  assert.match(text, /The pattern to avoid: a placeholder digest \(sha256:0000…0000\) pinned in the consumer — its merge request looks merge-ready but is un-pullable, so ensure-auto-merge can never arm it\./, 'AC2');
  const grep = text.split('\n').filter(l => l.includes('sha256:0') || l.includes('placeholder digest'));
  assert.equal(grep.length, 1, 'AC3: one line holds both');
  assert.match(grep[0], /Never pin a consumer/, 'AC3: the grep returns the new guidance');
  assert.doesNotMatch(readFileSync(join(ROOT, 'prompts', 'write-execution-plan', 'prompt.txt'), 'utf8'), /sha256:0|placeholder digest/, 'the flat prompt is unchanged');
});

// The requirements-changed workflow (ASS-79). Revise Acceptance Criteria
// writes {ticket-folder}/requirements-change.md from the latest description
// change in requirements-history.jsonl (ticket:sync's, ASS-38) and revises
// the criteria keeping their numbers where they still apply; Judge gives a
// verdict per criterion on the built work, else the plan. When the work is
// redone, each revising prompt the v2 engine runs (ASS-68 AC5: the grouped
// copies) reads requirements-change.md, and Root Cause Analysis starts from
// requirements-change-reason.md (ticket:requirements-change-verdict's). The
// flat engines' prompts are unchanged.
const text = p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
const REVISING = ['root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'generate-automated-tests', 'generate-solution', 'update-documentation'];
const READ_CHANGE = 'If {ticket-folder}/requirements-change-{variation}.md exists, the ticket\'s requirements changed: read it and revise for the change.';
const READ_REASON = 'If {ticket-folder}/requirements-change-reason.md exists, start from it.';

test('ASS-79 AC1: revise-acceptance-criteria writes requirements-change.md (from → to) from the last description line of requirements-history.jsonl, and revises the criteria keeping their numbers where they still apply, never renumbering, recorded on the variation', () => {
  const revise = text('revise-acceptance-criteria');
  assert.match(revise, /last "description" line of \{ticket-folder\}\/requirements-history\.jsonl/);
  assert.match(revise, /Write \{ticket-folder\}\/requirements-change-\{variation\}\.md \(through `\{agent-sh\} work:write \{project\} \{ticket\} \{variation\} requirements-change\.md`, the whole file on stdin\): what changed, as "from → to" points/);
  assert.match(revise, /keep a criterion's criteria-number when it still applies/);
  assert.match(revise, /Never renumber the rest\./);
  assert.match(revise, /`\{agent-sh\} ticket:set-acceptance-criteria \{project\} \{ticket\} \{variation\} -`/);   // ASS-182: on stdin, /mnt/ticket being read-only
  assert.doesNotMatch(revise, /acceptance-criteria\.json/);
});

test('ASS-79 AC2: judge-requirements-change judges the built work — every merge request not Closed whose branch is pushed — else the plan, giving one verdict per criterion, none left out', () => {
  const judge = text('judge-requirements-change');
  assert.match(judge, /\{agent-sh\} ticket:merge-request-plan \{project\} \{ticket\} \{variation\}/);
  assert.match(judge, /If none has been built yet, judge the plan instead: \{ticket-folder\}\/execution-plan-\{variation\}\.md/);
  assert.match(judge, /one entry per criterion in the variation's acceptance-criteria, none left out/);   // ASS-182: ticket.json's, as Revise recorded them
  assert.doesNotMatch(judge, /acceptance-criteria\.json/);
  assert.match(judge, /\{where\}/);
});

test('ASS-79 AC3/AC4: root-cause-analysis-grouped starts from requirements-change-reason.md, and every grouped revising prompt the v2 engine runs reads requirements-change.md; the flat engines\' prompts are unchanged', () => {
  assert.ok(text('root-cause-analysis-grouped').includes(READ_REASON));
  const v2 = engineNames().filter(d => d === 'harness-development-v2' || d.startsWith('v2-'))
    .flatMap(d => JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8')).steps.map(s => s.action?.prompt).filter(Boolean));
  for (const p of REVISING) {
    assert.ok(v2.includes(`${p}-grouped`), `the v2 engine runs ${p}-grouped`);
    assert.ok(text(`${p}-grouped`).includes(READ_CHANGE), `${p}-grouped`);
    assert.doesNotMatch(text(p), /requirements-change/, `${p}: the flat engines' prompt is unchanged`);
  }
});

// ASS-151: a golden-image rebuild ticket (fast-tracked, "Rebuild
// golden-<project>") runs the whole v2 flow and changes no code. Its Plan
// plans no merge request; Build records no automated test, starts the build
// on the Mac and does not wait; the reviews have nothing to review; Test
// verifies with vm:golden-status, the engine waiting while it builds (ASS-157), a failed build
// failing the step.
const said = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');
const REBUILD = /golden-image rebuild ticket \("fast-track": true in \{ticket-folder\}\/ticket\.json, titled "Rebuild golden-<project>"\)/;

test('ASS-151 AC4: the v2 prompts tell the agent on a golden-image rebuild ticket what its step is — no merge request planned, no test recorded, the build started and not waited on, nothing to review, the build verified with vm:golden-status, the engine waiting while it builds (ASS-157), failed failing', () => {
  for (const name of ['write-execution-plan-grouped', 'generate-automated-tests-grouped', 'generate-solution-grouped', 'code-review-grouped', 'security-review-grouped', 'test-grouped']) assert.match(said(name), REBUILD, name);
  assert.match(said('write-execution-plan-grouped'), /merge-requests\.json is \[\]/);
  assert.match(said('generate-automated-tests-grouped'), /automated-tests-\{variation\}\.json is \[\]/);
  assert.match(said('generate-solution-grouped'), /\{agent-sh\} vm:build-golden-start <project>/);
  assert.match(said('generate-solution-grouped'), /don't wait for it/);
  for (const name of ['code-review-grouped', 'security-review-grouped']) assert.match(said(name), /nothing to review: \{"is-approved": true\}/, name);
  const test = said('test-grouped');
  assert.match(test, /\{agent-sh\} vm:golden-status <project>/);
  // ASS-157: the engine waits for the build (Await the Golden Build), not the agent, who cannot sleep it out headless.
  assert.doesNotMatch(test, /sleep/);
  assert.match(test, /"building": the engine waits for the build before this step[^\n]*report the reading as it is: \{"is-approved": false/);
  assert.match(test, /"failed": \{"is-approved": false/);
});

// ASS-170: an agent asks a question with question:ask, which marks it Asked;
// a prompt that has it write the questions file itself lets it invent a status
// control never treats as open.
test('every prompt that has an agent ask a question has it use question:ask, never write questions-and-answers.json', () => {
  const texts = prompts.filter(p => existsSync(join(ROOT, 'prompts', p, 'prompt.txt'))).map(p => [p, readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8')]);
  assert.deepEqual(texts.filter(([, t]) => /\badd\b[^.\n]*questions-and-answers\.json/i.test(t)).map(([p]) => p), []);
  for (const p of ['groom', 'estimate']) assert.match(texts.find(([name]) => name === p)[1], /\{agent-sh\} question:ask \{project\} \{ticket\}/, p);
});

// ASS-181: every report a prompt writes in the ticket's folder is the
// variation's own, <name>-{variation}.md, written through work:write (whole)
// or work:append (an entry) — never by writing the file — and every prompt
// that names one, reader or writer, names that file: the bare name is no
// variation's, and there is no fallback to it.
const PER_VARIATION = ['root-cause-analysis', 'execution-plan', 'test-plan', 'requirements-change', 'explanation', 'change-log', 'code-review', 'security-review',
  'risk-assessment', 'token-expense-check', 'test-results', 'steps-to-test', 'plan-review', 'root-cause-analysis-review', 'review-work'];
const BARE = new RegExp(`(?<![\\w-])(${PER_VARIATION.join('|')})\\.md`, 'g');
const COMMAND = /`\{agent-sh\} work:(write|append) \{project\} \{ticket\} (\{variation\}|-) [a-z0-9-]+\.md`/g;
const sentText = p => ['prompt.txt', 'prompt.json'].filter(f => existsSync(join(ROOT, 'prompts', p, f))).map(f => readFileSync(join(ROOT, 'prompts', p, f), 'utf8')).join('\n');

test('ASS-181 AC4: no prompt names a converted report by its bare name — only as the <name> work:write or work:append takes', () => {
  const bare = prompts.flatMap(p => [...sentText(p).replace(COMMAND, '').matchAll(BARE)].map(m => `${p}: ${m[0]}`));
  assert.deepEqual(bare, [], 'name the variation\'s own, <name>-{variation}.md');
});

test('ASS-181 AC3: every report a prompt writes goes through work:write or work:append, the variation\'s own; none is written directly', () => {
  const writes = {
    'root-cause-analysis': ['write', 'root-cause-analysis'], 'root-cause-analysis-grouped': ['write', 'root-cause-analysis'],
    'review-root-cause-analysis': ['write', 'root-cause-analysis-review'], 'review-root-cause-analysis-grouped': ['write', 'root-cause-analysis-review'],
    'write-execution-plan': ['write', 'execution-plan'], 'write-execution-plan-grouped': ['write', 'execution-plan'],
    'write-test-plan': ['write', 'test-plan'], 'write-test-plan-grouped': ['write', 'test-plan'],
    'enrich-automated-test-data': ['append', 'test-plan'], 'enrich-automated-test-data-grouped': ['append', 'test-plan'],
    'revise-acceptance-criteria': ['write', 'requirements-change'], 'explain-the-change': ['write', 'explanation'], 'review-plan': ['write', 'plan-review'], 'review-plan-grouped': ['write', 'plan-review'],
    'code-review': ['write', 'code-review'], 'code-review-grouped': ['write', 'code-review'],
    'security-review': ['write', 'security-review'], 'security-review-grouped': ['write', 'security-review'],
    'risk-assessment': ['write', 'risk-assessment'], 'risk-assessment-grouped': ['write', 'risk-assessment'],
    'check-if-ticket-will-spend-tokens': ['write', 'token-expense-check'], 'check-if-ticket-will-spend-tokens-grouped': ['write', 'token-expense-check'],
    test: ['write', 'test-results'], 'test-grouped': ['write', 'test-results'], 'write-steps-to-test': ['write', 'steps-to-test'], 'write-steps-to-test-grouped': ['write', 'steps-to-test'], 'review-work': ['write', 'review-work'],
    ...Object.fromEntries(['apply-fix', 'generate-solution', 'generate-solution-grouped', 'generate-automated-tests-grouped', 'repair-environment-grouped', 'repair-environment-on-host-grouped',
      'troubleshoot-block', 'troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped', 'unblock', 'update-documentation', 'update-documentation-grouped', 'shut-down'].map(p => [p, ['append', 'change-log']])),
  };
  for (const [p, [command, name]] of Object.entries(writes)) {
    assert.ok(text(p).includes(`{ticket-folder}/${name}-{variation}.md (through \`{agent-sh} work:${command} {project} {ticket} {variation} ${name}.md\``), `${p}: work:${command} ${name}`);
  }
  assert.ok(text('estimate').includes('`{agent-sh} work:write {project} {ticket} - estimate.md`'), 'estimate: the ticket\'s own');
  const direct = new RegExp(`(?:[Ww]rite|[Aa]ppend|Add an entry to|Note in)[^.(\\n]*?\\{ticket-folder\\}/(?:${PER_VARIATION.join('|')})-\\{variation\\}\\.md(?! \\(through)`, 'g');
  assert.deepEqual(prompts.flatMap(p => [...sentText(p).matchAll(direct)].map(m => `${p}: ${m[0]}`)), []);
});

test('ASS-181 AC5: reflect-on-local-data writes its own report and changes no other file', () => {
  const reflect = text('reflect-on-local-data');
  assert.match(reflect, /Write the report to \{ticket-folder\}\/local-data\.md/);
  assert.match(reflect, /Don't change any file but that report/);
});

// ASS-180 AC4: the write prompts for the structured JSON files (automated-tests-<V>.json,
// demo-plan-<V>.json) name the stdin CLI commands and don't tell the agent
// to write {ticket-folder}/automated-tests- or /demo-plan- itself; the groom
// prompt names ticket:set-requirements, ticket:set-acceptance-criteria - and
// ticket:post-comment (for Jira tickets).
test('ASS-180 AC4: generate-automated-tests and -grouped name automated-tests:record, not a direct write of automated-tests-<V>.json', () => {
  for (const name of ['generate-automated-tests', 'generate-automated-tests-grouped']) {
    const t = text(name);
    assert.match(t, /\{agent-sh\} automated-tests:record \{project\} \{ticket\} \{variation\}/, `${name} names automated-tests:record`);
    assert.doesNotMatch(t, /[Ww]rite [^.]*?\{ticket-folder\}\/automated-tests-\{variation\}\.json/, `${name} does not tell the agent to write the file directly`);
  }
  // The grouped golden-image rebuild line still matched (prompts.test.js:293 regression).
  assert.match(text('generate-automated-tests-grouped'), /automated-tests-\{variation\}\.json is \[\]/);
});

test('ASS-227 AC1: generate-automated-tests-grouped says to mark "reproduces": true an entry that reproduces the ticket\'s bug, and every entry whose test file or target is new', () => {
  assert.match(text('generate-automated-tests-grouped'), /"reproduces": true/);
  assert.match(text('generate-automated-tests-grouped'), /reproduces the ticket's bug/);
  assert.match(text('generate-automated-tests-grouped'), /every entry whose test file or target is new in this ticket/);
});

// A "reproduces": true entry's run is judged with no master baseline
// (verify-success.sh, ASS-227), so every failure it reports counts as new -
// a whole-file run command is un-passable wherever the file also holds
// failures unrelated to the ticket (ASS-320). Step 4 must tell the agent to
// narrow such a run to the ticket's own tests instead.
test('ASS-324 AC1: generate-automated-tests-grouped says a "reproduces": true entry gets no master-baseline comparison, so its run command covers only the ticket\'s own tests — a --test-name-pattern or other runner filter — where the file also holds failures unrelated to the ticket', () => {
  const t = text('generate-automated-tests-grouped');
  assert.match(t, /no master-baseline comparison/);
  assert.match(t, /--test-name-pattern/);
  assert.match(t, /failing for reasons unrelated to the ticket/);
  assert.doesNotMatch(text('generate-automated-tests'), /test-name-pattern/, 'flat prompt unchanged');
});

test('ASS-180 AC4: write-test-plan and -grouped name ticket:set-demo-plan, not a direct write of demo-plan-<V>.json', () => {
  for (const name of ['write-test-plan', 'write-test-plan-grouped']) {
    const t = text(name);
    assert.match(t, /\{agent-sh\} ticket:set-demo-plan \{project\} \{ticket\} \{variation\}/, `${name} names ticket:set-demo-plan`);
    assert.doesNotMatch(t, /[Ww]rite [^.]*?\{ticket-folder\}\/demo-plan-\{variation\}\.json/, `${name} does not tell the agent to write the file directly`);
  }
});

// ASS-298 AC3: groom runs on the host, confined, so both calls take a staged file's path, not stdin.
test('ASS-180 AC4: groom names ticket:set-requirements, ticket:set-acceptance-criteria and ticket:post-comment — the first two with a staged file\'s path (ASS-298)', () => {
  const t = text('groom');
  assert.match(t, /`\{agent-sh\} ticket:set-requirements \{project\} \{ticket\} [^`\s-][^`\s]*`/);
  assert.match(t, /`\{agent-sh\} ticket:set-acceptance-criteria \{project\} \{ticket\} [^`\s-][^`\s]*`/);
  assert.doesNotMatch(t, /ticket:set-(requirements|acceptance-criteria)[^\n]*on stdin/);
  assert.match(t, /\{agent-sh\} ticket:post-comment/);
});

// ASS-298 AC3: a confined host agent's agent.sh call must be a bare line — a
// pipe or redirect re-sandboxes it — so the reflect-on-* reports (read by
// assess-health-v2) are staged in a file and its path given as work:write's
// last argument. Runs overlap, so each staged name is unique to the run (its
// <folder>, or {ticket}), and the path is the resolved absolute one, not a
// $TMPDIR left for the shell to expand.
const REFLECT = ['reflect-on-harness', 'reflect-on-project', 'reflect-on-local-environment', 'reflect-on-local-data', 'reflect-on-worktrees'];

test('ASS-298 AC3: each reflect-on-* prompt writes its report with work:write\'s trailing file-path argument, not stdin', () => {
  for (const p of REFLECT) {
    const t = text(p);
    assert.match(t, /`\{agent-sh\} work:write \{project\} <folder> - [a-z0-9-]+\.md [^`\n]+`/, p);
    assert.doesNotMatch(t, /work:write[^\n]*on stdin/, p);
  }
});

test('ASS-298 AC3: the reflect-on-* and groom prompts stage the body in a file unique to the run and pass its absolute path', () => {
  for (const p of REFLECT) {
    const line = text(p).split('\n').find(l => l.includes('work:write')) ?? '';
    assert.ok(/`\{agent-sh\} work:write \{project\} <folder> - [a-z0-9-]+\.md [^`\s]*<folder>[^`\s]*`/.test(line) || /\bunique\b/.test(line), `${p}: the staged file's name carries <folder>, or the prompt says it is unique`);
    assert.match(line, /absolute path/, `${p}: says to pass the absolute path`);
    assert.doesNotMatch(line, /`[^`]*\$TMPDIR[^`]*`/, `${p}: no $TMPDIR for the shell to expand in the call`);
  }
  const groom = text('groom').split('\n').find(l => l.includes('ticket:set-requirements')) ?? '';
  for (const command of ['ticket:set-requirements', 'ticket:set-acceptance-criteria'])
    if (!/\bunique\b/.test(groom)) assert.match(groom, new RegExp(`\`\\{agent-sh\\} ${command} \\{project\\} \\{ticket\\} [^\`\\s]*\\{ticket\\}[^\`\\s]*\``), `groom: ${command}'s staged file's name carries {ticket}, or the prompt says it is unique`);
  assert.match(groom, /absolute path/, 'groom: says to pass the absolute path');
  assert.doesNotMatch(groom, /`[^`]*\$TMPDIR[^`]*`/, 'groom: no $TMPDIR for the shell to expand in the call');
});

// ASS-198: check-on-merge-request, check-on-merge-request-grouped and
// generate-solution-grouped's step 2b all resolve a rebase conflict the same
// way — a Conflicts: paragraph, added as its own paragraph after each
// prompt's numbered list. ASS-258: each is checked for what it tells the
// agent to do, not for being byte-identical to the others.
const paragraph = p => text(p).split('\n\n').find(block => block.startsWith('Conflicts:'));
const CONFLICTS = ['check-on-merge-request', 'check-on-merge-request-grouped', 'generate-solution-grouped'];

test('ASS-198 AC2.1/2: check-on-merge-request, check-on-merge-request-grouped and generate-solution-grouped each have a Conflicts: paragraph, and each prompt\'s rebase step points at it', () => {
  for (const p of CONFLICTS) assert.ok(paragraph(p), `${p} has a Conflicts: paragraph`);
  assert.match(text('check-on-merge-request'), /Needs rebase: rebase onto the target branch and resolve conflicts.*Conflicts/);
  assert.match(text('check-on-merge-request-grouped'), /Needs rebase: git fetch origin, rebase onto origin\/<base> and resolve conflicts.*Conflicts/);
  assert.match(text('generate-solution-grouped'), /rebase it onto origin\/<base> and resolve them as Conflicts, below, says\./);
});

test('ASS-198 AC2.3: the Conflicts: paragraph names no ticket key, and routes its change log entry through work:append, never a direct write', () => {
  for (const shared of CONFLICTS.map(paragraph)) {
    assert.doesNotMatch(shared, key, 'no project\'s ticket key');
    assert.match(shared, /\{ticket-folder\}\/change-log-\{variation\}\.md \(through `\{agent-sh\} work:append \{project\} \{ticket\} \{variation\} change-log\.md`, the entry on stdin\)/);
  }
});

test('ASS-198 AC2.4: the paragraph says to resolve keeping both changes, fall back to the diff and file history for an unattributed file without blocking, run this ticket\'s and each named ticket\'s recorded tests, skip one no longer on the base, fix a failure in the files just resolved, and leave any other failure for a human with nothing pushed', () => {
  for (const shared of CONFLICTS.map(paragraph)) {
    assert.match(shared, /merge-request:conflicting-tickets \{project\} \{ticket\} \{variation\}/);
    assert.match(shared, /resolve every conflict keeping both changes/);
    assert.match(shared, /no ticket identified.*from the diff and that file's history, never blocking on it/);
    assert.match(shared, /skipping one that is no longer on the base \(exit 127, or it says there is no such test\)/);
    assert.match(shared, /fix a failure in the files you just resolved/);
    assert.match(shared, /on any other failure record it with its ticket, push nothing and leave it for a human/);
  }
});

test('ASS-198 AC2.5: engines/grouped-engines.md says Generate Solution resolves a conflicting rebase with the other ticket\'s intent, from merge-request:conflicting-tickets', () => {
  const doc = readFileSync(engineDir('grouped-engines.md'), 'utf8');
  assert.match(doc, /merge-request:conflicting-tickets/);
});

// ASS-199: generate-solution-grouped step 2b rebases every existing branch
// onto origin/<base> on each Build visit, no longer only when a merge request
// it depends on merged.
test('ASS-199 AC1: generate-solution-grouped fetches and rebases every existing branch onto origin/<base> on each Build visit, unconditionally', () => {
  const t = text('generate-solution-grouped');
  assert.match(t, /git fetch origin/);
  assert.match(t, /create it from origin\/<base> when it is not there yet/);
  assert.match(t, /when it is there, rebase it onto origin\/<base> and resolve them as Conflicts, below, says\./);
  assert.doesNotMatch(t, /a merge request it depends on merged/);
  assert.match(t, /git stash first if the checkout or the rebase refuses/);
});

// ASS-196: the Find Dependencies refinement step (harness only). Its prompt is
// a claude-only developer prompt taking the ticket; its text directs reading
// the ticket against every open backlog and sprint ticket and recording
// dependencies with ticket:set-dependencies and overlaps with
// ticket:set-overlaps — `none` when there are none, question:ask only for a
// doubtful dependency, and an overlap already on the other ticket not recorded
// again (stored once). The key-prefix guard above already covers that it names
// no project key.
test('ASS-196 AC1: find-dependencies is claude-only, persona developer, input ticket, with a required output field; its text records dependencies and overlaps, stored once, question:ask only when doubtful, over the open backlog and sprint', () => {
  const dir = join(ROOT, 'prompts', 'find-dependencies');
  assert.ok(existsSync(join(dir, 'prompt.json')) && existsSync(join(dir, 'prompt.txt')), 'the find-dependencies prompt exists');
  const json = JSON.parse(readFileSync(join(dir, 'prompt.json'), 'utf8'));
  assert.deepEqual(json['supported-command-line-interfaces'], ['claude']);
  assert.equal(json.persona, 'developer');
  assert.deepEqual((json['input-arguments'] ?? []).map(a => a.name), ['ticket']);
  assert.ok((json.output?.required ?? []).length >= 1, 'a required output field');
  const txt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  assert.match(txt, /ticket:set-dependencies/);
  assert.match(txt, /ticket:set-overlaps/);
  assert.match(txt, /\bnone\b/);                         // none when there are none
  assert.match(txt, /question:ask/);                     // only when a dependency is doubtful
  assert.match(txt, /backlog/i);
  assert.match(txt, /sprint/i);
  assert.match(txt, /already/i);                         // an overlap already on the other ticket is not recorded again (store-once)
});

// ASS-230: on EX-2825 the test plan listed one-off grep/jq/diff checks,
// pinned to commit SHAs, as "Automated"; Generate Automated Tests then wrote a
// permanent test file CI never runs. And the screenshots were text the agent
// composed (typed headers, cut lines) after re-running the checks. Grouped
// prompts only (v2 uses them too); the flat prompts stay as they are.
test('ASS-230 AC1: write-test-plan-grouped lists, per criterion, the committed CI tests apart from one-off verification, naming an existing CI target rather than planning a new test', () => {
  const t = text('write-test-plan-grouped');
  assert.ok(t.includes('"Automated (committed, run by the repo\'s CI)"'), t);
  assert.ok(t.includes('"One-off verification (run in Build/Test, not committed)"'), t);
  assert.match(t, /already covers a behavior, name it instead of planning a new test/);
  assert.doesNotMatch(text('write-test-plan'), /One-off verification/, 'flat prompt unchanged');
});

test('ASS-230 AC2: generate-automated-tests-grouped records an existing test or target that covers a behavior, writes new tests only where the repo\'s CI runs them, and never hard-codes an upstream commit SHA or a local path', () => {
  const t = text('generate-automated-tests-grouped');
  assert.match(t, /the test plan's "Automated" list, never its one-off verification/);
  assert.match(t, /an existing test or target already covers a behavior, record it instead of writing a new one/);
  assert.match(t, /only where the repo's own CI runs it/);
  assert.match(t, /never hard-code an upstream commit SHA or a local path/);
  assert.doesNotMatch(text('generate-automated-tests'), /hard-code an upstream commit SHA/, 'flat prompt unchanged');
});

test('ASS-230 AC3: test-grouped saves each criterion\'s raw command output through work:write, cited in test-results; take-screenshots-grouped renders it with work:output-page, verbatim, without re-running a check', () => {
  assert.ok(text('test-grouped').includes('`{ echo "$ <command>"; <command>; } 2>&1 | {agent-sh} work:write {project} {ticket} {variation} test-output-<n>.txt`'), text('test-grouped'));
  assert.match(text('test-grouped'), /cite test-output-<n>-\{variation\}\.txt/);
  const t = text('take-screenshots-grouped');
  assert.match(t, /no visible UI/);
  assert.ok(t.includes('`{agent-sh} work:output-page {project} {ticket} {variation} test-output-<n>.txt > <html>`'), t);
  assert.match(t, /[Dd]on't re-run any check/);
  assert.match(t, /never edit, cut or add to it/);
  assert.doesNotMatch(text('take-screenshots'), /output-page/, 'flat prompt unchanged');
  assert.doesNotMatch(text('test'), /test-output/, 'flat prompt unchanged');
  const allowed = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  assert.deepEqual(allowed['work:output-page'], { project: 0, ticket: 1, variation: 2 }, 'callable from the VM, for its own variation');
});

test('ASS-229 AC3: write-steps-to-test-grouped writes for a human tester on a normal dev checkout or CI; VM paths, shims and workarounds stay in test-results', () => {
  const t = text('write-steps-to-test-grouped');
  assert.match(t, /reader is a human tester on a normal dev checkout or CI/);
  assert.match(t, /VM paths, shims and workarounds stay in test-results, never in steps-to-test/);
  assert.doesNotMatch(text('write-steps-to-test'), /human tester/, 'flat prompt unchanged');
});

test('ASS-229 AC4: take-screenshots-grouped shoots with firefox-esr --headless --screenshot=<absolute png> and a window size (a bare --screenshot <png> writes nothing in the VM)', () => {
  const t = text('take-screenshots-grouped');
  assert.ok(t.includes('firefox-esr --headless --screenshot=<absolute png> --window-size=W,H file://<html>'), t);
  assert.doesNotMatch(t, /--screenshot <png>/);
});

// ASS-238: VM agents never hold a forge or Jira login of their own: the grouped/v2 prompts that read or edit a
// merge request do it through the host's merge-request:view, :update and :upload-image, never glab, gh, curl or a
// token. The flat engines' prompts are unchanged.
test('ASS-238 AC2: the grouped/v2 prompts that read or edit a merge request use merge-request:view/update (and upload-image), never glab, gh, curl, acli or a token; the flat ones are unchanged', () => {
  const uses = { 'update-merge-request-details-grouped': ['view', 'update'], 'add-screenshots-to-merge-request-grouped': ['view', 'update', 'upload-image'], 'explain-the-change': ['view', 'update'], 'check-on-merge-request-grouped': ['view', 'reply', 'resolve'] };
  for (const [p, commands] of Object.entries(uses)) {
    const t = text(p);
    for (const c of commands) assert.ok(t.includes(`{agent-sh} merge-request:${c} {project} {ticket} {variation} <id>`), `${p}: ${c}`);
    assert.doesNotMatch(t, /\b(glab|gh|curl|acli)\b|TOKEN|uploads API/, p);
  }
  for (const p of ['update-merge-request-details', 'add-screenshots-to-merge-request', 'check-on-merge-request']) assert.doesNotMatch(text(p), /merge-request:(view|update|upload-image|reply|resolve)/, p);
});

// ASS-239: the agent answers the review threads itself, through the host: each one it addressed replied to (what
// changed, with the commit, once pushed) and resolved; one it disagrees with, or that needs the operator, replied to
// and left open.
test('ASS-239 AC3: check-on-merge-request-grouped replies to and resolves each thread it addressed, with what changed and the commit, and replies without resolving where it disagrees or needs the operator', () => {
  const t = text('check-on-merge-request-grouped');
  assert.ok(t.includes('`{agent-sh} merge-request:reply {project} {ticket} {variation} <id> <thread-id> -`, the reply on stdin'), t);
  assert.ok(t.includes('`{agent-sh} merge-request:resolve {project} {ticket} {variation} <id> <thread-id>`'), t);
  assert.match(t, /each thread you addressed: reply with what changed and its commit, then resolve it/);
  assert.match(t, /disagree, or it needs the operator: reply saying why and leave it unresolved/);
  assert.doesNotMatch(t, /a human replies on and resolves/);
});

// ASS-241: the sprint screen's acceptance-criteria dots read each criterion's dev-status and testing-status, which
// the grouped/v2 Build and Test prompts now record through ticket:set-ac-status. The flat prompts are unchanged.
const SET_AC = (kind, value) => `\`{agent-sh} ticket:set-ac-status {project} {ticket} {variation} ${kind} <n> ${value}\``;

test('ASS-241 AC2: generate-solution-grouped records dev Passed for each criterion its change meets, Failed for one it could not meet, through ticket:set-ac-status', () => {
  const t = text('generate-solution-grouped');
  assert.ok(t.includes(`${SET_AC('dev', 'Passed')} for each acceptance criterion your change meets, ${SET_AC('dev', 'Failed')} for one it could not meet`), t);
  assert.doesNotMatch(text('generate-solution'), /set-ac-status/, 'flat prompt unchanged');
});

test('ASS-241 AC3: code-review-grouped, on a rejection, sets dev Failed for each criterion the rejection names, through ticket:set-ac-status', () => {
  const t = text('code-review-grouped');
  assert.ok(t.includes(`Before {"is-approved": false}, run ${SET_AC('dev', 'Failed')} for each acceptance criterion code-review-{variation}.md says is not met`), t);
  assert.doesNotMatch(text('code-review'), /set-ac-status/, 'flat prompt unchanged');
});

test('ASS-241 AC4: test-grouped records testing Passed or Failed for every criterion, matching test-results, through ticket:set-ac-status', () => {
  const t = text('test-grouped');
  assert.ok(t.includes(`For every acceptance criterion, record its result as test-results-{variation}.md gives it: ${SET_AC('testing', 'Passed')} or ${SET_AC('testing', 'Failed')}`), t);
  assert.doesNotMatch(text('test'), /set-ac-status/, 'flat prompt unchanged');
});

// ASS-248 AC8: the refinement prompts and the grouped/v2 planning, build and
// test prompts tell an agent when to ask and how to choose: blocking when a
// wrong guess costs rework, is irreversible, or is the operator's product or
// business call; else non-blocking, going on with the recommended answer as
// the assumption. Every question:ask they show carries the flag. The flat
// engines' prompts are unchanged: none of them says it.
const ASKING = ['groom', 'estimate', 'find-dependencies', 'root-cause-analysis-grouped', 'enrich-ac-grouped', 'write-execution-plan-grouped', 'write-test-plan-grouped',
  'generate-solution-grouped', 'generate-automated-tests-grouped', 'test-grouped'];
test('ASS-248 AC8: the refinement and grouped/v2 planning, build and test prompts say when to ask and how to choose blocking or non-blocking; the flat engines\' prompts are unchanged', () => {
  const text = p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
  for (const p of ASKING) {
    const t = text(p);
    assert.match(t, /\{agent-sh\} question:ask \{project\} \{ticket\} <?--blocking/, p);
    assert.match(t, /--non-blocking/, p);
    assert.match(t, /rework/, p);
    assert.match(t, /irreversible/, p);
    assert.match(t, /assum/, p);
  }
  // Every question:ask any prompt shows carries the flag.
  for (const p of readdirSync(join(ROOT, 'prompts')).filter(d => existsSync(join(ROOT, 'prompts', d, 'prompt.txt')))) {
    for (const call of text(p).match(/question:ask \{project\} \{ticket\}[^`]*/g) ?? []) assert.match(call, /--(non-)?blocking/, `${p}: ${call}`);
  }
  const flat = ['harness-development', 'example-development', 'blocked'].flatMap(e => {
    const engine = JSON.parse(readFileSync(join(engineDir(e), 'state-engine.json'), 'utf8'));
    return JSON.stringify(engine).match(/"prompt":"[^"]+"/g).map(m => m.slice(10, -1));
  });
  for (const p of new Set(flat)) assert.doesNotMatch(text(p), /--(non-)?blocking/, p);
});

test('ASS-248 AC3: revise-acceptance-criteria also takes a "question" line of requirements-history.jsonl — an answer that differs from the assumption the work went on', () => {
  const t = readFileSync(join(ROOT, 'prompts', 'revise-acceptance-criteria', 'prompt.txt'), 'utf8');
  assert.match(t, /"question"/);
  assert.match(t, /assumption/);
});

// ASS-249: CI Checks (ci-checks:verify) writes the project's merge-request CI
// checks' last run to ci-checks-results-<variation>.md: Generate Solution
// reads it to fix a new failure, Security Review as scanner evidence — and
// never copies a secret a scanner found.
test('ASS-249 AC5: generate-solution-grouped and security-review-grouped read ci-checks-results-{variation}.md; Security Review treats a scanner finding as evidence and never copies a secret value into its review; the flat prompts are unchanged', () => {
  const read = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');
  assert.match(read('generate-solution-grouped'), /\{ticket-folder\}\/ci-checks-results-\{variation\}\.md/);
  const security = read('security-review-grouped');
  assert.match(security, /\{ticket-folder\}\/ci-checks-results-\{variation\}\.md/);
  assert.match(security, /scanner finding is evidence/);
  assert.match(security, /[Nn]ever copy a secret value/);
  for (const flat of ['generate-solution', 'security-review']) assert.doesNotMatch(read(flat), /ci-checks/, flat);
});

// ASS-305: every criterion the harness writes must be one a Test agent can
// check by itself in the ticket's VM. Work needing the operator, the host, a
// Claude login, a credential or a live outside system goes to an Operator
// follow-up section, never a criterion: the agent rewrites the criterion as
// the nearest check it can run, else asks a --non-blocking question with that
// rewrite as the recommended answer. One shared verbatim rule in all five
// grouped/refinement prompts; the flat engines' prompts are unchanged.
const AC_WRITING = ['create-ticket-grouped', 'enrich-ac-grouped', 'revise-acceptance-criteria', 'groom', 'split-ticket'];
const AGENT_CHECKABLE = /a Test agent can check by itself in the ticket's VM \(commands, tests, the app, screenshots, throwaway data\)/;
const NOT_A_CRITERION = /never one needing the operator, the host, a Claude login, a credential or a live outside system/;

test('ASS-305 AC1/AC2/AC3: every prompt that writes or revises acceptance criteria says a criterion must be one a Test agent can check by itself in the ticket\'s VM, routes operator/host/login/credential/outside-system work to Operator follow-up with a rewrite-or-ask fallback, and drops create-ticket-grouped\'s "written as the operator\'s" line; the flat engines\' prompts are unchanged', () => {
  for (const p of AC_WRITING) {
    const t = text(p);
    assert.match(t, AGENT_CHECKABLE, p);
    assert.match(t, NOT_A_CRITERION, p);
    assert.match(t, /Operator follow-up/, p);
    assert.match(t, /nearest check an agent can run/, p);
    assert.match(t, /Operator follow-up[^\n]*never a criterion/i, p);
  }
  // create-ticket-grouped runs before the ticket exists, so it has no
  // question:ask; the other four fall back to a --non-blocking question.
  for (const p of AC_WRITING.filter(p => p !== 'create-ticket-grouped')) assert.match(text(p), /--non-blocking/, p);

  const grouped = text('create-ticket-grouped');
  assert.doesNotMatch(grouped, /written as the operator's/);
  assert.match(grouped, /No criterion may need anyone but the operator/);   // the sibling safety sentence stays
  // The new section is declared in the optional extras, so ":19 No other headings" stays true.
  assert.match(grouped.split('\n').find(l => l.startsWith('- Operator follow-up')) ?? '', /after Out of scope/);

  for (const flat of ['create-ticket', 'enrich-ac']) {
    assert.doesNotMatch(text(flat), AGENT_CHECKABLE, flat);
    assert.doesNotMatch(text(flat), NOT_A_CRITERION, flat);
  }
  assert.match(text('create-ticket'), /written as the operator's/);
});

// ASS-316 AC1: write-ticket's empty-key output must say why — analysis-did-not-hold
// (the two cases in prompt.txt:5, :37) or create-failed (the create command's
// error as printed) — each value named on its own sentence, so a value named
// anywhere else cannot satisfy it (the two cases must not cross); plus a
// one-line why, and the finish-JSON line carrying all three fields. The flat
// create-ticket prompt is untouched.
test('ASS-316 AC1: create-ticket-grouped\'s empty key carries no-ticket-reason and a one-line why; the flat create-ticket prompt is unchanged', () => {
  const grouped = text('create-ticket-grouped');
  const sentences = grouped.replace(/\n/g, ' ').split(/(?<=\.)\s+/);
  const sentenceWith = re => sentences.find(s => re.test(s)) ?? '';
  const analysisSentence = sentenceWith(/analysis is empty or doesn't hold/);
  const failedSentence = sentenceWith(/failed create:/i);
  assert.match(analysisSentence, /no-ticket-reason/, 'the analysis-empty/doesn\'t-hold case names the field');
  assert.match(analysisSentence, /analysis-did-not-hold/, 'and its own value');
  assert.doesNotMatch(analysisSentence, /create-failed/, 'not the other case\'s value');
  assert.match(analysisSentence, /\bwhy\b/);
  assert.match(failedSentence, /no-ticket-reason/, 'the failed-create case names the field');
  assert.match(failedSentence, /create-failed/, 'and its own value');
  assert.doesNotMatch(failedSentence, /analysis-did-not-hold/, 'not the other case\'s value');
  assert.match(failedSentence, /\bwhy\b/);
  assert.match(failedSentence, /error/i);
  assert.match(failedSentence, /as it printed/i);

  const finishBlock = grouped.slice(grouped.indexOf('Finish with JSON'));
  assert.match(finishBlock, /"key"/);
  assert.match(finishBlock, /"no-ticket-reason"/);
  assert.match(finishBlock, /"why"/);
  assert.match(finishBlock, /""/, 'the two are empty when a key was created');

  const schema = JSON.parse(readFileSync(join(ROOT, 'prompts', 'create-ticket-grouped', 'prompt.json'), 'utf8')).output;
  assert.deepEqual(schema.properties['no-ticket-reason']?.enum, ['', 'analysis-did-not-hold', 'create-failed']);
  assert.equal(schema.properties.why?.type, 'string');
  assert.deepEqual(schema.required, ['key', 'no-ticket-reason', 'why']);
  assert.equal(schema.additionalProperties, false);

  assert.doesNotMatch(text('create-ticket'), /no-ticket-reason/, 'the flat reference prompt is unchanged');
});
