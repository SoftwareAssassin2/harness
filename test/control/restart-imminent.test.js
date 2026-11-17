// ASS-504 AC2, AC4: an agent deep in a long tool call when its machine is
// about to go down. machine:restart-imminent (as the forwarder runs it for the
// VM's restart watcher) queues the interrupt and restart prompt; the
// supervisor interrupts the turn and sends the prompt; the interrupted turn's
// result neither stops the agent nor completes its step — the prompt is run —
// and once the prompt's own turn ends control ends the agent without
// completing the step (no exit evaluated, no failure counted), so the step
// runs again from what it pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';
import { readSession } from '../../src/agents/session.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('ASS-504 AC2, AC4: an agent mid tool call is interrupted and runs the restart prompt; the interrupted turn\'s result does not end it, and the prompt\'s turn ends it without completing its step', async () => {
  const f = controlFixture();
  // Its first turn a tool call that runs until interrupted; any turn it ends approves the plan (the plan step's exit to build).
  Object.assign(process.env, { FAKE_LONG_TOOL: '1', FAKE_OUTPUT: JSON.stringify({ 'is-approved': true }) });
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'];
    const live = f.ctx.agents.get(name);
    assert.equal(f.variation()['harness-status'].state, 'plan');
    assert.ok(await until(() => readSession(live.agent.dir)?.some(l => l.includes('▶ Bash {"command":"./validate.sh"}'))), 'deep in its tool call');
    await tick(f.ctx);
    assert.ok(f.ctx.agents.has(name), 'a turn under way is left alone');

    const told = await f.agent('machine:restart-imminent', 'p', 'ABC-3', 'A', 'cloud-vm:p:vm-1:/home/ada/harness');
    assert.equal(told.stdout, `restart imminent on cloud-vm:p:vm-1:/home/ada/harness: told ${name}\n`);
    const at = Date.now();
    assert.ok(await until(() => live.agent.interrupted));
    assert.ok(Date.now() - at < 2000, `interrupted ${Date.now() - at} ms after the line was queued`);
    assert.ok(f.lines.includes(`dispatch ${name}: restart imminent: its turn interrupted and the restart prompt sent (commit and push now)`), f.lines.join('\n'));
    assert.ok(await until(() => live.result));
    assert.equal(live.result.subtype, 'success', 'the result control sees is the restart prompt\'s turn, never the interrupted one');
    assert.ok(alive(live.agent.pid), 'the interrupted turn did not stop it');
    const log = readSession(live.agent.dir);
    const [interrupt, sent, ended, ran] = ['[interrupt]', '> RESTART NOW', '[the interrupted turn ended]', 'You said RESTART NOW'].map(l => log.indexOf(l));
    assert.ok(interrupt > 0 && interrupt < sent && sent < ended && ended < ran, log.join('\n'));   // the prompt runs after the interrupted turn

    await tick(f.ctx);
    assert.ok(f.lines.includes(`finish ${name}: its restart-imminent turn ended; ended without completing its step, which runs again`), f.lines.join('\n'));
    assert.ok(!f.ctx.agents.has(name));
    assert.ok(!f.assignments().assignments.some(a => a['agent-name'] === name));
    assert.equal(f.variation()['harness-status'].state, 'plan', 'its step not completed: the plan was not taken as approved');
    assert.ok(!f.lines.some(l => /tried again in/.test(l)), 'no failure counted');
    const inbox = readFileSync(join(live.agent.dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(inbox.at(-1), { prompt: 'RESTART NOW', interrupt: true });
  } finally {
    delete process.env.FAKE_LONG_TOOL;
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});
