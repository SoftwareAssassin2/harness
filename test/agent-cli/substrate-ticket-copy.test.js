// ASS-567 AC3, AC4: a sandbox agent's /mnt/ticket holds the ticket's files when it starts — the commands' side, on a
// fake Mac cluster (fake-substrate.js) whose sandbox runs commands through the fake command server. substrate:sandbox-up
// copies the ticket folder in as it makes the sandbox and again as it resumes a hibernated one (files added while it
// slept are there); substrate:sandbox-sync-ticket copies into a running one, refuses a hibernated one (exit 3: never
// copied into while suspended — that copy was lost live, and the agent found /mnt/ticket empty), and checks what it
// copied: a copy that leaves /mnt/ticket short exits 4 ("ticket folder empty"), which control logs as a harness fault
// (test/control/target-moves.test.js). Control's side of when it copies is there too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxed } from './sandbox-fixture.js';

test('AC3: /mnt/ticket holds the ticket\'s files after the sandbox is made, after a hibernate and resume, and after a sync; a hibernated one is never synced into (exit 3); a short copy exits 4', async () => {
  const t = await sandboxed();
  const work = t.s.at('projects', 'p', 'work', 'ABC-3');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'ticket.json'), '{"key":"ABC-3"}\n');
  writeFileSync(join(work, 'ticket-A.json'), '{"name":"A"}\n');
  writeFileSync(join(work, 'questions-and-answers.json'), '[]\n');
  const ticket = () => join(t.root('abc-3-a'), 'mnt', 'ticket');
  const names = () => (existsSync(ticket()) ? readdirSync(ticket()).sort() : []);

  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  for (const f of ['ticket.json', 'ticket-A.json', 'questions-and-answers.json']) assert.ok(names().includes(f), `${f} in /mnt/ticket after it was made: ${names()}`);

  // Hibernated: a sync is refused — nothing copied into a suspended sandbox.
  assert.equal((await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A')).code, 0);
  writeFileSync(join(work, 'plan-review-A.md'), 'written while it slept\n');
  const refused = await t.call('substrate:sandbox-sync-ticket', 'p', 'ABC-3', 'A');
  assert.equal(refused.code, 3, refused.out + refused.err);
  assert.match(refused.err, /sandbox is stopped \(hibernated\): substrate:sandbox-up resumes it and copies the ticket folder/);
  assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_SUSPENDED', 'the refused sync did not resume it');

  // Resumed: the copy is made again as it resumes, the file written meanwhile included.
  const again = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.created, false);
  assert.ok(names().includes('plan-review-A.md'), `the ticket folder as it is now: ${names()}`);
  assert.equal(readFileSync(join(ticket(), 'ticket.json'), 'utf8'), '{"key":"ABC-3"}\n');

  // Running: a sync brings it up to date.
  writeFileSync(join(work, 'execution-plan-A.md'), 'the plan\n');
  const sync = await t.call('substrate:sandbox-sync-ticket', 'p', 'ABC-3', 'A');
  assert.equal(sync.code, 0, sync.err);
  assert.ok(names().includes('execution-plan-A.md'), names().join(', '));

  // AC4: a copy that comes out short (here an entry the copy cannot carry: a socket) is caught, never taken as done.
  const sock = join(work, 's.sock');
  const server = createServer().listen(sock);
  await new Promise(r => server.once('listening', r));
  try {
    const short = await t.call('substrate:sandbox-sync-ticket', 'p', 'ABC-3', 'A');
    assert.equal(short.code, 4, short.out + short.err);
    assert.match(short.err, /ticket folder empty: .*\/mnt\/ticket holds \d+ of the ticket folder's \d+ entries after the copy/);
  } finally { server.close(); }
});
