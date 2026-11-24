// ASS-553 AC1: a ticket's worktree on a workstation or cloud VM (run targets workstation-worktree, cloud-vm-worktree),
// through the bash commands. workstation:claim --workstation <id> --worktree gives the variation a folder of its own,
// <home>/harness/worktrees/<KEY>[.<variation>], with its own checkout (cloned once, the shared root's as a reference),
// ticket copy, forwarder token and machine name, beside a plain slot's steps there; a step's end commits and pushes
// its work and keeps the folder (never handed to another ticket); two tickets' worktrees on one machine never touch
// each other's files; workstation:remove-worktree removes it once the ticket is done (its machine connected), and
// never touches anything else. Against a fake workstation (test/support/fake-workstation.js), bare local repositories
// for GitLab.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, git, ID } from './workstation-fixture.js';

afterEach(closeAll);

async function connected(s) {
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 0);
}

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard.
test('ASS-553 AC1: two tickets\' worktrees on one workstation, beside a plain step — each its own folder and checkout, kept between steps, never touching the other\'s; removed once done', async () => {
  const s = wsFixture();
  await connected(s);
  const root = s.root(), runtime = s.entry().setup.runtime;
  const claim = async (name, ...more) => { const r = await s.result('workstation:claim', 'p', 'ABC-3', name, '--workstation', ID, ...more); assert.equal(r.code, 0, r.err); return JSON.parse(r.out); };

  // A plain step first (slot 0, the shared root); then two worktrees.
  const plain = await claim('C');
  const a = await claim('A', '--worktree'), b = await claim('B', '--worktree');
  assert.deepEqual([plain.slot, plain.folder, plain.worktree], [0, root, undefined]);
  assert.deepEqual([a.slot, a.folder, a.worktree], [1, join(root, 'worktrees', 'ABC-3'), true]);
  assert.deepEqual([b.slot, b.folder, b.worktree], [2, join(root, 'worktrees', 'ABC-3.B'), true]);
  assert.equal(a.machine, `workstation:p:${ID}:${join(root, 'worktrees', 'ABC-3')}`);
  assert.deepEqual(Object.entries(s.entry().holders).map(([n, h]) => [n, h.variation, h.folder, h.worktree]), [['1', 'A', a.folder, true], ['2', 'B', b.folder, true]]);
  assert.equal(s.variation('A').workstation.folder, a.folder);
  assert.deepEqual(s.variation('A')['remote-worktrees'].map(w => [w.name, w.folder, w.kind]), [[ID, a.folder, 'workstation']]);
  for (const f of [a.folder, b.folder]) {
    assert.ok(existsSync(join(f, 'repos', 'harness', '.git')), `${f}: its own checkout`);
    assert.equal(readFileSync(join(f, 'ticket', 'plan.md'), 'utf8'), 'the plan\n');
  }
  assert.ok(['agent-token', 'agent-token-1', 'agent-token-2'].every(t => existsSync(join(runtime, t))));
  assert.equal(s.tokens()[a.machine].variation, 'A');

  // A's step works in its own checkout; B's untracked file is B's alone. A's end (slot 1) ends A's step there as any
  // slot's (its trees left clean) and keeps A's folder; B's files and the plain step's are untouched.
  const aRepo = join(a.folder, 'repos', 'harness'), bRepo = join(b.folder, 'repos', 'harness');
  writeFileSync(join(aRepo, 'a.txt'), 'a\n');
  writeFileSync(join(bRepo, 'b.txt'), 'b\n');
  const end = await s.result('workstation:release', 'p', ID, '--force', '--slot', '1', '--completed', 'Build');
  assert.equal(end.code, 0, end.err);
  assert.deepEqual(JSON.parse(end.out).released, { ticket: 'ABC-3', variation: 'A', folder: a.folder, migrated: false });
  assert.ok(existsSync(join(aRepo, '.git')), 'its folder kept between its steps');
  assert.ok(existsSync(join(bRepo, 'b.txt')), "B's files untouched");
  assert.ok(!existsSync(join(root, 'repos', 'harness', 'a.txt')) && !existsSync(join(bRepo, 'a.txt')), "A's work only in A's checkout");
  assert.equal(git(aRepo, 'status', '--porcelain', '--untracked-files=all'), '', "its end left A's checkout clean");
  assert.deepEqual(Object.keys(s.entry().holders), ['2']);
  assert.equal(s.variation('A').workstation, undefined);

  // A's next step comes back to the same folder, not a slot another ticket had.
  const again = await claim('A', '--worktree');
  assert.equal(again.folder, a.folder);
  assert.equal((await s.result('workstation:release', 'p', ID, '--force', '--slot', String(again.slot))).code, 0);

  // Done: workstation:remove-worktree removes A's folder alone; B's (held now) is left, said why; the plain root stays.
  const rm = await s.result('workstation:remove-worktree', 'p', 'ABC-3', 'A');
  assert.equal(rm.code, 0, rm.err);
  assert.deepEqual(JSON.parse(rm.out), { removed: [{ name: ID, folder: a.folder }], left: [] });
  assert.ok(!existsSync(a.folder) && existsSync(b.folder) && existsSync(join(root, 'repos', 'harness', '.git')));
  assert.equal(s.variation('A')['remote-worktrees'], undefined);
  const held = JSON.parse((await s.result('workstation:remove-worktree', 'p', 'ABC-3', 'B')).out);
  assert.deepEqual(held.left, [{ name: ID, folder: b.folder, why: 'a step of it holds it now' }]);
  assert.ok(existsSync(b.folder));
  // Its step ended and the machine disconnected: left until it is connected again (never started for this).
  assert.equal((await s.result('workstation:release', 'p', ID, '--force', '--slot', '2')).code, 0);
  assert.equal((await s.result('workstation:release', 'p', ID, '--force')).code, 0);
  await s.cli('workstation:disconnect', 'p', ID);
  assert.deepEqual(JSON.parse((await s.result('workstation:remove-worktree', 'p', 'ABC-3', 'B')).out).left, [{ name: ID, folder: b.folder, why: 'not connected' }]);
  assert.ok(existsSync(b.folder));
});
