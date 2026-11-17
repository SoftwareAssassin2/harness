// The test fixture itself: its `env` is hermetic, so a test run by a live
// control (the merge gate's npm test) never sees that control's pid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, run } from './harness-fixture.js';

const PRINT = "process.stdout.write(process.env.HARNESS_CONTROL_PID ?? 'unset')";

test("ASS-484: a fixture's env drops an inherited HARNESS_CONTROL_PID", async () => {
  const before = process.env.HARNESS_CONTROL_PID;
  process.env.HARNESS_CONTROL_PID = String(process.pid);
  try {
    const f = fixture();
    assert.equal((await run(process.execPath, ['-e', PRINT], { env: f.env })).stdout, 'unset');
    // A test wanting a control pid still sets it explicitly.
    assert.equal((await run(process.execPath, ['-e', PRINT], { env: { ...f.env, HARNESS_CONTROL_PID: '123' } })).stdout, '123');
  } finally {
    if (before === undefined) delete process.env.HARNESS_CONTROL_PID;
    else process.env.HARNESS_CONTROL_PID = before;
  }
});
