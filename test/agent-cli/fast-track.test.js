// ASS-83: a ticket the health check raises for itself is fast-tracked —
// ticket:create --fast-track marks it, and the mark goes with it into the
// sprint (ticket:join-sprint, ticket:sync) or, its join failed, into the
// backlog, flagged there for the next try.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture, run } from './harness-fixture.js';

const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');

// The fixture with p's off-board work source (prefix HD), a backlog step to
// sync a new sprint ticket to and a committed one to join it at, and HD-1, a
// fast-tracked ticket, and HD-2, a plain one, created off-board.
async function offBoard() {
  const f = fixture();
  f.env.OFF_BOARD_DIR = join(f.dir, 'off-board');
  const edit = (path, change) => { const file = join(f.dir, ...path); const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
  edit(['projects', 'p', 'project.json'], p => p['work-sources'].push({ name: 'Harness', type: 'off-board', folder: 'p', 'key-prefix': 'HD' }));
  edit(['engines', 'example-development', 'state-engine.json'], e => {
    e.steps.unshift({ id: 'committed', sequence: 0, 'paired-ticket-system-status': 'Committed', action: { type: 'none' } });
    e.steps.unshift({ id: 'backlog', sequence: 0, 'paired-ticket-system-status': 'Backlog', action: { type: 'none' } });
  });
  await run(OFF_BOARD, ['ticket:create', 'p', 'Bug', 'Rebuild the golden image', '--fast-track'], { env: f.env });
  await run(OFF_BOARD, ['ticket:create', 'p', 'Bug', 'Plain'], { env: f.env });
  return { ...f, edit, ticket: key => f.sprint().bugs.find(t => t.key === key) };
}

test('ASS-83 AC1, AC5: ticket:join-sprint carries fast-track onto the sprint ticket, in the sprint file marked active even past its end date; a plain ticket carries none', async () => {
  const f = await offBoard();
  f.edit(['projects', 'p', 'sprints.json'], s => { s.list[0].start = '2020-01-01'; s.list[0].end = '2020-01-14'; });   // long over
  await f.agent('ticket:join-sprint', 'p', 'HD-1', 'committed');
  await f.agent('ticket:join-sprint', 'p', 'HD-2', 'committed');
  assert.equal(f.ticket('HD-1')['fast-track'], true);
  assert.equal(f.ticket('HD-1').variations[0]['harness-status'].state, 'committed');
  assert.equal('fast-track' in f.ticket('HD-2'), false);
});

test('ASS-83 AC5: a failed join (no sprint tracking work) writes nothing to the sprint; the ticket stays off-board at Backlog, and synced to the backlog it is flagged fast-track there', async () => {
  const f = await offBoard();
  f.edit(['projects', 'p', 'sprints.json'], s => { s.list[0]['is-active'] = false; });
  await assert.rejects(f.agent('ticket:join-sprint', 'p', 'HD-1', 'committed'), e => /no active sprint/.test(e.stderr));
  assert.equal(f.sprint().bugs.some(t => t.key === 'HD-1'), false);
  const listed = JSON.parse((await run(OFF_BOARD, ['ticket:get', 'p', 'HD-1'], { env: f.env })).stdout);
  assert.deepEqual([listed.status, listed['fast-track']], ['Backlog', true]);
  const file = join(f.dir, 'fetched.json');
  writeFileSync(file, JSON.stringify({ tickets: [{ key: 'HD-1', title: 'Rebuild the golden image', 'ticket-system-status': 'Backlog', 'fast-track': true }, { key: 'HD-2', title: 'Plain', 'ticket-system-status': 'Backlog' }] }));
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  await f.agent('ticket:sync', 'p', 'backlog', file);
  const backlog = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), 'utf8')).tickets;
  assert.equal(backlog.find(t => t.key === 'HD-1')['fast-track'], true);
  assert.equal('fast-track' in backlog.find(t => t.key === 'HD-2'), false);
});
