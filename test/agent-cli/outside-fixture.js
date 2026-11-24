// Test data for a fix ticket outside the sprint and backlog (ASS-562): the
// Jira ticket a variation waits on, as ticket:sync-outside keeps it in
// projects/<project>/outside-tickets.json, and the engine's done step paired
// to the ticket system's Done. Used with harness-fixture.js's fixture() (agent-cli)
// and the control fixture (tick-await-fix).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// One outside ticket as outside-tickets.json holds it; `extra` adds or overrides
// fields ('ticket-system-status-category': 'done', a lower-case key, a null status…).
export const outsideTicket = (key, status, extra = {}) => ({
  key, title: `Title ${key}`, url: `https://example.test/browse/${key}`,
  'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate', ...extra,
});

// Writes <dir>/projects/<project>/outside-tickets.json with these tickets, or `text` as is (a corrupt file).
export function writeOutside(dir, project, tickets) {
  const file = join(dir, 'projects', project, 'outside-tickets.json');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof tickets === 'string' ? tickets : JSON.stringify({ 'fetched-at': '2026-11-24T12:00:00Z', tickets }, null, 4));
  return file;
}

// Pairs <dir>/engines/<engine>'s done step with the ticket system's `status` (Done by default).
export function pairDone(dir, engine = 'example-development', status = 'Done') {
  const file = join(dir, 'engines', engine, 'workflow.yaml');
  const e = JSON.parse(readFileSync(file, 'utf8'));
  e.steps.find(s => s.id === 'done')['paired-ticket-system-status'] = status;
  writeFileSync(file, JSON.stringify(e, null, 4));
}
