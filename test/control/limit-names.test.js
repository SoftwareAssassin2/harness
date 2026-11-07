// ASS-126 AC4: the ticket limits go by their new names everywhere —
// max-tickets-in-progress, max-tickets-in-planning, max-tickets-in-grooming.
// Ticket history (src/off-board, data/projects/*/work) keeps what it said then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const OLD = /max-(planning-|backlog-)?assignments/;

test('ASS-126 AC4: no tracked file outside ticket history names a ticket limit by its old name', () => {
  const self = relative(ROOT, import.meta.filename);
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter(f => f && f !== self && !f.startsWith('src/off-board/') && !/^data\/projects\/[^/]+\/work\//.test(f));
  const named = files.filter(f => { try { return OLD.test(readFileSync(join(ROOT, f), 'utf8')); } catch { return false; } });
  assert.deepEqual(named, []);
});
