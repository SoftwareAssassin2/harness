// The downloader cycle's team step (ASS-409, cycle.js 5d, team.js): after the
// analytics syncs and before the last-data-download, the real team:update on
// the fixture, each line it prints logged; a failure logged once and the
// cycle going on. Invented people and repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCycle } from '../../src/downloader/cycle.js';
import * as team from '../../src/downloader/team.js';
import * as mergedMergeRequests from '../../src/downloader/merged-merge-requests.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/group/app';

// An off-board project p with one GitLab repository; its analytics folder made, with no files yet.
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'team-step-'));
  const project = join(dir, 'data', 'projects', 'p');
  mkdirSync(join(project, 'analytics'), { recursive: true });
  writeFileSync(join(project, 'project.json'), JSON.stringify({ 'work-sources': [{ name: 'Off', type: 'off-board', folder: 'p' }], repositories: [{ url: APP, status: 'Active' }] }));
  return { dir, project };
}
// exec: analytics:sync-merge-requests and team:update run the real agent.sh on the fixture; the rest are only recorded.
function executor(dir, { fail = false } = {}) {
  const calls = [];
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'data', 'projects'), ENGINES_DIR: join(dir, 'engines') };
  const exec = async (file, args) => {
    if (file === 'glab') return JSON.stringify([{ iid: 1, title: 'PROJ-1 login', source_branch: 'proj-1', author: { username: 'ada', name: 'Ada Lovelace' }, merged_at: '2026-11-10T10:00:00.000Z', updated_at: '2026-11-10T10:00:00.000Z', web_url: `${APP}/-/merge_requests/1` }]);
    calls.push(args[0]);
    if (fail && args[0] === 'team:update') throw Object.assign(new Error('team:update: team.json is not JSON: Unexpected token\nmore'), { code: 1 });
    return args[0] === 'analytics:sync-merge-requests' || args[0] === 'team:update' ? (await promisify(execFile)(AGENT, args, { env })).stdout : '';
  };
  return { calls, exec };
}
const adapters = (extra = {}) => ({ offBoard: { fetchTickets: async () => [] }, mergedMergeRequests, ...extra });

test('ASS-409 AC7: every cycle runs team:update after the analytics syncs and before the last-data-download, logging each member added', async () => {
  const r = root();
  const { calls, exec } = executor(r.dir);
  const lines = [];
  await runCycle({ root: r.dir, project: 'p', now: new Date('2026-11-12T10:00:00Z'), adapters: adapters({ team }), exec, log: l => lines.push(l) });
  assert.deepEqual(calls, ['analytics:sync-merge-requests', 'team:update', 'project:set-last-data-download']);
  assert.ok(lines.includes('team: added Ada Lovelace (unmatched, git ada)'), lines.join('\n'));
  const written = JSON.parse(readFileSync(join(r.project, 'team.json'), 'utf8'));
  assert.deepEqual(written.members.map(m => [m['git-username'], m.role]), [['ada', 'unmatched']]);
  // The next cycle adds no one: nothing logged for the team.
  const again = executor(r.dir), later = [];
  await runCycle({ root: r.dir, project: 'p', now: new Date('2026-11-12T10:05:00Z'), adapters: adapters({ team }), exec: again.exec, log: l => later.push(l) });
  assert.ok(again.calls.includes('team:update'));
  assert.ok(!later.some(l => l.startsWith('team:')), later.join('\n'));
});

test('ASS-409 AC7: no analytics file, no team step; nor without the adapter (an older caller)', async () => {
  const r = root();
  const { calls, exec } = executor(r.dir);
  await runCycle({ root: r.dir, project: 'p', now: new Date(), adapters: { offBoard: { fetchTickets: async () => [] }, team }, exec, log: () => {} });
  assert.deepEqual(calls, ['project:set-last-data-download']);
  assert.equal(existsSync(join(r.project, 'team.json')), false);
  const older = executor(r.dir);
  await runCycle({ root: r.dir, project: 'p', now: new Date(), adapters: adapters(), exec: older.exec, log: () => {} });
  assert.deepEqual(older.calls, ['analytics:sync-merge-requests', 'project:set-last-data-download']);
});

test('ASS-409 AC7: a team:update that fails is logged once until the reason changes, and the cycle goes on', async () => {
  const r = root();
  writeFileSync(join(r.project, 'analytics', 'tickets.json'), JSON.stringify({ 'fetched-through': '2026-11-12T09:00:00Z', tickets: {} }));
  const lines = [];
  const once = async (fail = true) => {
    const { calls, exec } = executor(r.dir, { fail });
    await runCycle({ root: r.dir, project: 'p', now: new Date(), adapters: { offBoard: { fetchTickets: async () => [] }, team }, exec, log: l => lines.push(l) });
    return calls;
  };
  assert.deepEqual(await once(), ['team:update', 'project:set-last-data-download']);
  await once();
  assert.deepEqual(lines.filter(l => l.startsWith('team:')), ['team: team.json not updated: team:update: team.json is not JSON: Unexpected token']);
  await once(false);   // works again
  await once();        // and fails again: logged
  assert.equal(lines.filter(l => l.startsWith('team: team.json not updated')).length, 2);
  rmSync(r.dir, { recursive: true, force: true });
});
