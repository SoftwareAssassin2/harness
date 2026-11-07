// merge-request:conflicting-tickets (ASS-198): read-only, run in the
// conflicted checkout (cwd first, else the variation's VM, test/support/fake-vm.js),
// it finds the ticket(s) whose base commits touch the unmerged paths and
// prints each one's intent — title, description, acceptance criteria,
// execution plan and recorded test commands — and the variation its commits
// pick. conflict-fixture.js's conflicts() gives those tickets, rebasing() a
// real repository stopped mid-rebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT } from './harness-fixture.js';
import { conflicts, rebasing, inVm, scratch, git, TICKETS, ac, plan, tests } from './conflict-fixture.js';

const execp = promisify(execFile);
// Always resolves — { code: 0, stdout, stderr } on success, { code, stdout, stderr } on a non-zero exit — so a case not yet
// built (an unknown command, exit 1) fails the test's assertions cleanly instead of an unhandled rejection.
const call = (cwd, env, ...args) => execp(AGENT, args, { cwd, env }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const conflicting = (cwd, env) => call(cwd, env, 'merge-request:conflicting-tickets', 'p', 'ABC-3', 'A');

const fileEntry = (out, file) => out.files.find(e => e.file === file);
const listing = dir => readdirSync(join(dir, 'projects'), { recursive: true })
  .filter(p => statSync(join(dir, 'projects', p)).isFile())
  .sort()
  .map(p => `${p}@${statSync(join(dir, 'projects', p)).mtimeMs}`)
  .join('\n');

test('AC1 case 1: a conflicted file whose base commits name a ticket key resolves to that ticket\'s intent, with the checkout, base and merge-base read', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-5: log the import', 'a.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.checkout, r.dir);
  assert.equal(out.vm, null);
  assert.equal(out.base, r.onto);
  assert.equal(out['merge-base'], r.mergeBase);
  assert.ok(fileEntry(out, 'a.txt')?.keys?.includes('ABC-5'), JSON.stringify(out.files));
  const t = out.tickets['ABC-5'];
  assert.equal(t.title, TICKETS['ABC-5'].title);
  assert.equal(t.description, TICKETS['ABC-5'].description);
  assert.deepEqual(t['acceptance-criteria'], ac('ABC-5', 'A'));
  assert.equal(t['execution-plan'], plan('ABC-5', 'A'));
  assert.deepEqual(t['test-commands'], tests('ABC-5', 'A'));
  assert.equal(t.variation, 'A');
  assert.equal(t['variation-from'], 'default');
  assert.ok(t.files.includes('a.txt'));
  assert.ok(Array.isArray(t.commits) && t.commits.length > 0);
});

test('AC1 case 2: a change/<KEY>.<variation>-<id> branch name in an attributed subject picks that variation, named "branch"', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [["Merge branch 'change/ABC-1.B-3' into master", 'b.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(fileEntry(out, 'b.txt')?.keys?.includes('ABC-1'), JSON.stringify(out.files));
  const t = out.tickets['ABC-1'];
  assert.equal(t.variation, 'B');
  assert.equal(t['variation-from'], 'branch');
  assert.equal(t.title, TICKETS['ABC-1'].title);
  assert.deepEqual(t['acceptance-criteria'], ac('ABC-1', 'B'));
});

// Two commits touch the same file: one gives the ticket key, the other a merge-row marker (!7) and no branch name —
// the variation ladder's second rung reads a Merged row of the ticket the file is already attributed to.
test('AC1 case 3: with no branch name, a #<n>/!<n> in an attributed subject matching a Merged merge-request row picks that row\'s variation, named "merge-request"', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-1: start the corpus', 'c.txt'], ['Index the corpus (!7)', 'c.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const t = out.tickets['ABC-1'];
  assert.equal(t.variation, 'B');
  assert.equal(t['variation-from'], 'merge-request');
});

test('AC1 case 4: with no branch name or merge-row match, a ticket\'s selected-variation is picked, named "selected-variation"', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-4: rename', 'd.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const t = out.tickets['ABC-4'];
  assert.equal(t.variation, 'B');
  assert.equal(t['variation-from'], 'selected-variation');
});

test('AC1 case 5: with none of a branch name, merge-row match or selected-variation, variation A is picked, named "default"', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-5: log', 'e.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const t = out.tickets['ABC-5'];
  assert.equal(t.variation, 'A');
  assert.equal(t['variation-from'], 'default');
});

test('AC1 case 6: a file with no ticket key resolves to "no ticket identified", without blocking the file that does have one', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-5: do the import', 'a.txt'], ['no key here', 'b.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(fileEntry(out, 'a.txt')?.keys?.includes('ABC-5'));
  assert.equal(fileEntry(out, 'b.txt')?.note, 'no ticket identified');
});

test('AC1 case 7: a key named in a subject but absent from every sprint file reports found: false, its file still named under that key', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ZZZ-9: nothing in any sprint', 'z.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.tickets['ZZZ-9'], { key: 'ZZZ-9', found: false });
  assert.ok(fileEntry(out, 'z.txt')?.keys?.includes('ZZZ-9'));
});

test('AC1 case 8: a ticket released into an older sprint-N, not the active sprint, is still found by sweeping sprints/sprint-*/sprint.json', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [["Merge branch 'change/ABC-1.B-1' into master", 'c.txt']]);
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const t = out.tickets['ABC-1'];
  assert.notEqual(t.found, false);
  assert.equal(t.title, TICKETS['ABC-1'].title);
  assert.equal(t.description, TICKETS['ABC-1'].description);
});

test('AC1 case 9: outside a rebase it fails with a clear message naming where it looked — the cwd, and the VM too when the variation has one — and writes nothing', async () => {
  const f = conflicts();
  const before = listing(f.dir);
  const clean = scratch();
  execFileSync('git', ['init', '-q', clean]);
  const host = await conflicting(clean, f.env);
  assert.notEqual(host.code, 0);
  assert.equal(host.stdout, '');
  assert.ok(host.stderr.includes(clean), host.stderr);

  const vmSetup = inVm();
  const other = await conflicting(vmSetup.f.dir, vmSetup.v.env);
  assert.notEqual(other.code, 0);
  assert.ok(other.stderr.includes('p-abc-3-a'), other.stderr);

  assert.equal(listing(f.dir), before);
});

test('AC1 case 10: a second checkout also mid-rebase is named in the output, not silently dropped, while the cwd one\'s is the one reported', async () => {
  const vmSetup = inVm();
  const cwdRepo = rebasing(scratch(), [['ABC-5: log the import', 'a.txt']]);
  const other = rebasing(join(vmSetup.repos, 'other'), [['ABC-4: rename', 'd.txt']]);
  const result = await conflicting(cwdRepo.dir, vmSetup.v.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.checkout, cwdRepo.dir);
  assert.ok(result.stdout.includes(other.dir) || JSON.stringify(out).includes('other'), result.stdout);
});

test('AC1 case 10b: with cwd not a work tree and two checkouts mid-rebase in the VM, the one not reported is still named in also-mid-rebase', async () => {
  const vmSetup = inVm();
  const app = rebasing(join(vmSetup.repos, 'app'), [['ABC-5: log the import', 'a.txt']]);
  const other = rebasing(join(vmSetup.repos, 'other'), [['ABC-4: rename', 'd.txt']]);
  const result = await conflicting(vmSetup.f.dir, vmSetup.v.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const reported = out.checkout;
  assert.ok([app.dir, other.dir].includes(reported), result.stdout);
  const expected = reported === app.dir ? other.dir : app.dir;
  assert.deepEqual(out['also-mid-rebase'], [expected]);
});

test('AC1 case 11: merge-base falls back to the rebase directory\'s orig-head file once ORIG_HEAD has been pruned, the same result as with ORIG_HEAD present', async () => {
  const f = conflicts();
  const r = rebasing(scratch(), [['ABC-5: log the import', 'a.txt']]);
  git(r.dir, 'update-ref', '-d', 'ORIG_HEAD');
  const result = await conflicting(r.dir, f.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out['merge-base'], r.mergeBase);
});

test('AC1 case 12: with cwd not a git work tree and the variation\'s VM recorded, the conflicted checkout under its /repos/ is read through limactl shell --workdir /repos/', async () => {
  const vmSetup = inVm();
  const r = rebasing(join(vmSetup.repos, 'app'), [['ABC-5: log the import', 'a.txt']]);
  const result = await conflicting(vmSetup.f.dir, vmSetup.v.env);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.vm, 'p-abc-3-a');
  assert.equal(out.checkout, r.dir);
  assert.equal(out.base, r.onto);
  assert.equal(out['merge-base'], r.mergeBase);
  assert.equal(out.tickets['ABC-5'].title, TICKETS['ABC-5'].title);
  const shellCalls = vmSetup.v.calls().filter(c => c.vm === 'p-abc-3-a' && c.workdir === '/repos/');
  assert.ok(shellCalls.length > 0, JSON.stringify(vmSetup.v.calls()));
});

test('AC1 case 13: the wrong number of arguments exits non-zero with the usage line, writing nothing', async () => {
  const f = conflicts();
  const before = listing(f.dir);
  const missing = await call(f.dir, f.env, 'merge-request:conflicting-tickets', 'p', 'ABC-3');
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /usage/i);
  const extra = await call(f.dir, f.env, 'merge-request:conflicting-tickets', 'p', 'ABC-3', 'A', 'extra');
  assert.notEqual(extra.code, 0);
  assert.match(extra.stderr, /usage/i);
  assert.equal(listing(f.dir), before);
});

test('AC1 case 14: no file under $projects changes across the golden path, mixed attribution, an unlisted key or a failure — it is read-only by contract', async () => {
  const f = conflicts();
  const before = listing(f.dir);
  await conflicting(rebasing(scratch(), [['ABC-5: log the import', 'a.txt']]).dir, f.env);
  await conflicting(rebasing(scratch(), [['ABC-5: do the import', 'a.txt'], ['no key here', 'b.txt']]).dir, f.env);
  await conflicting(rebasing(scratch(), [['ZZZ-9: nothing', 'z.txt']]).dir, f.env);
  await conflicting(scratch(), f.env);
  assert.equal(listing(f.dir), before);
});
