// ASS-568: a crashed Substrate sandbox — the commands' side, on a fake Mac cluster (fake-substrate.js) with the fake
// command server (fake-command-server.js). substrate:sandbox-state says crashed (with Substrate's reason);
// substrate:sandbox-up exits 4 for it, changing nothing (AC1); substrate:sandbox-delete --salvage pushes its branches
// through the Mac when its files can still be read, and deletes it all the same when they cannot (AC2); a new
// substrate:sandbox-up then makes a fresh one from the branches on the forge. Control's side is
// test/control/sandbox-crash.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxed, branchOnOrigin } from './sandbox-fixture.js';
import { git } from './workstation-fixture.js';

const WHY = 'worker restarted while hosting the actor';
// crash(t, actor) — the actor crashed, as Substrate leaves one after its worker restarted (a Docker restart).
function crash(t, actor) {
  const file = join(t.m.k8s(), 'actors-harness-p.json');
  const list = JSON.parse(readFileSync(file, 'utf8'));
  for (const a of list.actors) if (a.metadata.name === actor) a.status = { state: 'ACTOR_STATE_CRASHED', crash: { message: `resume failed: ${WHY}`, crashTime: '2026-11-23T21:17:00Z' } };
  writeFileSync(file, JSON.stringify(list));
}
// The proxy's pid file (on-machine substrate.sh: <substrate dir>/proxies/<project>/<actor>.pid), wherever the fake Mac keeps it.
function proxyPid(t, actor) {
  const find = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = find(p); if (f) return f; } else if (p.endsWith(join('proxies', 'p', `${actor}.pid`))) return p;
  } return null; };
  const f = find(join(t.s.env.HOME, '.harness'));
  return f ? Number(readFileSync(f, 'utf8').split('\n')[0]) : null;
}
const originLog = (t, branch) => execFileSync('git', ['--git-dir', t.s.origins.harness, 'log', '--format=%s', branch], { encoding: 'utf8' }).trim().split('\n');

test('AC1, AC2: a crashed sandbox — sandbox-state says crashed and why; sandbox-up exits 4 changing nothing; delete --salvage pushes its committed branches (and what was left) through the Mac while its files can be read; a new one is then made from them', async () => {
  const t = await sandboxed();
  branchOnOrigin(t.s);
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  const name = up.json.machine;
  const repo = join(t.root('abc-3-a'), 'repos', 'harness');
  writeFileSync(join(repo, 'more.txt'), 'committed in the sandbox\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'ABC-3: more');
  writeFileSync(join(repo, 'left.txt'), 'left uncommitted\n');
  crash(t, 'abc-3-a');

  const state = await t.call('substrate:sandbox-state', 'p', 'mac', 'abc-3-a');
  assert.equal(state.json.state, 'crashed');
  assert.equal(state.json.crash, `resume failed: ${WHY}`);
  const refused = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(refused.code, 4, refused.out + refused.err);
  assert.match(refused.err, new RegExp(`the sandbox abc-3-a on mac has crashed \\(crashed: resume failed: ${WHY}\\): it cannot be resumed; control replaces it`));
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_CRASHED', 'nothing changed');
  assert.equal(t.s.variation('A').sandbox.name, 'abc-3-a');

  // Its command server still answers here (the fake's proxy lives on): its files can be read, so they are saved.
  const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A', '--salvage');
  assert.equal(del.code, 0, del.err);
  assert.deepEqual([del.json.salvaged, del.json.salvage, del.json.branches], [true, null, [{ repo: 'harness', branch: 'change/ABC-3-1' }]]);
  assert.deepEqual(originLog(t, 'change/ABC-3-1').slice(0, 3), ['ABC-3: work left uncommitted on its crashed sandbox on mac', 'ABC-3: more', 'ABC-3: the last step']);
  assert.equal(t.state('abc-3-a'), null, 'deleted');
  assert.equal(t.s.variation('A').sandbox, undefined);
  assert.equal(t.s.tokens()[name], undefined, 'its forwarder token revoked');

  // The step's next try: a fresh sandbox, the saved branch brought in.
  const fresh = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(fresh.json.created, true);
  assert.deepEqual(fresh.json.branches, [{ repo: 'harness', branch: 'change/ABC-3-1' }]);
  assert.equal(readFileSync(join(t.root('abc-3-a'), 'repos', 'harness', 'more.txt'), 'utf8'), 'committed in the sandbox\n');
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
});

test('AC2: a crashed sandbox whose files cannot be read (its command server gone) is deleted all the same, saying why nothing was saved; a resume that finds it crashed exits 4 too', async () => {
  const t = await sandboxed();
  branchOnOrigin(t.s);
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  const repo = join(t.root('abc-3-a'), 'repos', 'harness');
  writeFileSync(join(repo, 'more.txt'), 'never pushed\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'ABC-3: lost');
  // Hibernated, then crashed (its snapshot lost): its proxy ended with the stop, so nothing answers for it.
  assert.equal((await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A')).code, 0);
  assert.equal(proxyPid(t, 'abc-3-a'), null, 'no proxy left');
  crash(t, 'abc-3-a');
  const refused = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(refused.code, 4, refused.err);
  const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A', '--salvage');
  assert.equal(del.code, 0, del.err);
  assert.equal(del.json.salvaged, false);
  assert.match(del.json.salvage, /its files cannot be read: its command server does not answer/);
  assert.deepEqual(del.json.branches, []);
  assert.equal(t.state('abc-3-a'), null, 'deleted anyway');
  assert.ok(!originLog(t, 'change/ABC-3-1').includes('ABC-3: lost'), 'its unpushed commit is lost');
});
