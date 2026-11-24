// ASS-554 AC2: a ticket whose Plan runs in a worktree (worktree: true), whose Build runs in its Substrate sandbox and
// whose Review and Document run in the worktree again keeps its work at every switch: code:hand-over pushes the branch
// from where the last step ran and brings it in where the next runs. Real git (bare origins, the project's workspace
// cloned from one), the harness's own clone for local-worktree (ASS-553), and a fake Substrate sandbox on a fake Mac
// cluster (sandbox-fixture.js: the sandbox has no forge credentials, so its branches move through the Mac). The
// grouped engines' branches are Build's (change/<KEY>-<id>, named by the merge-request plan, made in the machine):
// Plan, which writes only work files, stands on a branch of the Mac's that is never pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, edit } from './workstation-fixture.js';
import { sandboxed } from './sandbox-fixture.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const commit = (dir, name, text, message) => { writeFileSync(join(dir, name), text); git(dir, 'add', name); execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], { env: { ...process.env, ...IDENTITY } }); };

test('ASS-554 AC2: plan (local-worktree) → build (local-substrate) → review and document (local-worktree) → back in the sandbox — each step\'s commits, and what one left uncommitted, are there for the next; the worktree is the same one; no stray branch pushed; the operator\'s checkout untouched', async () => {
  const t = await sandboxed();
  Object.assign(t.s.env, IDENTITY);
  // The project's workspace on the Mac (its local-pc folder), a clone of the harness repository's origin.
  const ws = join(mkdtempSync(join(tmpdir(), 'workspace-')), 'harness');
  execFileSync('git', ['clone', '-q', t.s.origins.harness, ws]);
  git(ws, 'remote', 'set-head', 'origin', 'main');
  edit(t.s.at('projects', 'p', 'project.json'), p => {
    p['local-environments'] = [{ name: 'local-pc', type: 'local-pc', folder: ws }];
    p['dev-environments']['run-targets'] = ['local-substrate', 'local-worktree'];
  });
  const handOver = async target => { const r = await t.call('code:hand-over', 'p', 'ABC-3', 'A', target); assert.equal(r.code, 0, r.err); return r.json; };
  const onOrigin = branch => { try { return execFileSync('git', ['--git-dir', t.s.origins.harness, 'rev-parse', '--verify', '--quiet', branch], { encoding: 'utf8' }).trim(); } catch { return null; } };

  // Plan, on local-worktree: a branch to stand on in the harness's own clone, the worktree made on first use. Plan
  // writes work files (agent.sh work:write), not commits.
  const planned = await handOver('local-worktree');
  const folder = planned.folder;
  assert.ok(folder.startsWith(t.s.at('projects', 'p', 'checkouts')), folder);
  assert.equal(readFileSync(join(folder, 'README.md'), 'utf8'), 'one\n');

  // Build, in the sandbox: Plan's branch held nothing, so nothing was pushed for it; Build's agent makes the ticket's
  // branch (change/ABC-3-1, the merge-request plan's) and commits, and leaves a file uncommitted.
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const built = await handOver('local-substrate');
  assert.deepEqual([built.from, built.to], ['local-worktree', 'local-substrate']);
  assert.equal(onOrigin(planned.branch), null, 'no stray branch on the forge for a plan');
  const box = join(t.root('abc-3-a'), 'repos', 'harness');
  git(box, 'checkout', '-q', '-b', 'change/ABC-3-1');
  commit(box, 'feature.txt', 'from Build\n', 'ABC-3: the change');
  writeFileSync(join(box, 'loose.txt'), 'left by Build\n');

  // Review, back in the same worktree, moved onto Build's branch: Build's work, the leftover committed on the way.
  const reviewed = await handOver('local-worktree');
  assert.deepEqual([reviewed.from, reviewed.to, reviewed.branch, reviewed.folder], ['local-substrate', 'local-worktree', 'change/ABC-3-1', folder]);
  assert.equal(git(folder, 'symbolic-ref', '--short', 'HEAD'), 'change/ABC-3-1');
  for (const [name, text] of [['feature.txt', 'from Build\n'], ['loose.txt', 'left by Build\n']]) assert.equal(readFileSync(join(folder, name), 'utf8'), text, name);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), onOrigin('change/ABC-3-1'), 'on origin too');
  // Document (a worktree step too) commits the docs there, and leaves a note uncommitted.
  commit(folder, 'DOCS.md', 'from Document\n', 'ABC-3: docs');
  writeFileSync(join(folder, 'note.md'), 'left by Document\n');

  // Back in the sandbox (a fix after review, say): it has every step's work.
  const again = await handOver('local-substrate');
  assert.deepEqual([again.from, again.to], ['local-worktree', 'local-substrate']);
  assert.equal(git(box, 'symbolic-ref', '--short', 'HEAD'), 'change/ABC-3-1');
  for (const [name, text] of [['feature.txt', 'from Build\n'], ['loose.txt', 'left by Build\n'], ['DOCS.md', 'from Document\n'], ['note.md', 'left by Document\n']]) assert.equal(readFileSync(join(box, name), 'utf8'), text, name);
  assert.equal(t.s.variation('A')['run-target'].target, 'local-substrate');
  // The operator's checkout never got a branch nor a worktree.
  assert.equal(git(ws, 'branch', '--list', 'change/*'), '');
  assert.ok(!existsSync(join(ws, '.worktrees')));
});
