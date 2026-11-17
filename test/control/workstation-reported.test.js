// ASS-478 AC4: what a step's end reports (workstation-steps.js reported): a push
// that failed goes on the releasing variation's Health only when the branch is
// its own (its merge-request plan's, or one named for it, change/<KEY>-<id> or
// change/<KEY>.<variation>-<id>); another ticket's is logged, never on its Health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reported, ownBranch, PUSH_HEALTH } from '../../src/control/workstation-steps.js';

function ctx() {
  const calls = [], lines = [];
  return { calls, lines, log: (phase, line) => lines.push(`${phase} ${line}`), attempt: (_p, _w, fn) => fn(), cli: async args => { calls.push(args); return ''; } };
}
const out = failed => ({ pushed: [], 'push-failed': failed, committed: [], discarded: [], 'master-reset': [], unclean: [] });
const t = { key: 'ABC-3' };

test('ownBranch: the plan\'s branches and those named for the variation, never another ticket\'s', () => {
  const a = { name: 'A', 'merge-request': [{ id: 1, branch: 'feature/planned' }] }, b = { name: 'B' };
  assert.equal(ownBranch(t, a, 'feature/planned'), true);
  assert.equal(ownBranch(t, a, 'change/ABC-3-1'), true);
  assert.equal(ownBranch(t, a, 'change/ABC-31-1'), false);
  assert.equal(ownBranch(t, a, 'change/ABC-3.B-1'), false);
  assert.equal(ownBranch(t, b, 'change/ABC-3.B-2'), true);
  assert.equal(ownBranch(t, b, 'change/ABC-3-2'), false);
  assert.equal(ownBranch(t, a, 'change/XYZ-9-1'), false);
  assert.equal(ownBranch(undefined, a, 'change/ABC-3-1'), false);
});

test('a failed push of its own branch goes on its Health', async () => {
  const c = ctx(), v = { name: 'A', 'merge-request': [{ id: 1, branch: 'change/ABC-3-1' }] };
  await reported(c, { id: 'p' }, out([{ repository: 'harness', branch: 'change/ABC-3-1', why: 'rejected' }]), 'head', 'ABC-3 A', t, v);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].slice(0, 5), ['ticket:set-ai-feedback', 'p', 'ABC-3', 'A', 'Could not push: harness change/ABC-3-1: rejected']);
  assert.ok(c.calls[0][5].startsWith(PUSH_HEALTH));
});

test('another ticket\'s failed push is only logged: not on this one\'s Health, and its own Health is cleared as on a clean end', async () => {
  const c = ctx(), v = { name: 'A', 'ai-feedback-long': `${PUSH_HEALTH} harness change/XYZ-9-1: rejected. old` };
  await reported(c, { id: 'p' }, out([{ repository: 'harness', branch: 'change/XYZ-9-1', why: 'rejected' }]), 'head', 'ABC-3 A', t, v);
  assert.deepEqual(c.calls, [['ticket:clear-ai-feedback', 'p', 'ABC-3', 'A', v['ai-feedback-long']]]);
  assert.ok(c.lines.some(l => /could not push harness change\/XYZ-9-1: rejected — not its own branch \(ASS-478\), so not on its Health/.test(l)), c.lines.join('\n'));
  assert.ok(!c.lines.some(l => /could not push its committed work/.test(l)));
});
