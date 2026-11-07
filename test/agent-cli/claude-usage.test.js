// project:set-claude-usage — the project's Claude session and weekly (ASS-65) usage and logged-in
// account (ASS-47), as control reads them, recorded in
// projects/<p>/claude-usage.json (live data, never the tracked project.json)
// for the dashboard's models box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAMP } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'cu-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const usageFile = dir => join(dir, 'p', 'claude-usage.json');
const usage = dir => existsSync(usageFile(dir)) ? JSON.parse(readFileSync(usageFile(dir), 'utf8')) : undefined;

test('project:set-claude-usage writes { email, session: { percent, resets-at }, weekly: { percent, resets-at }, auth-method, org (ASS-221), as-of } to claude-usage.json, the percents raw; project.json untouched', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await cli(dir, 'project:set-claude-usage', 'p', 'me@example.com', '7.5', '2026-10-15T13:00:00Z', '89', '2026-10-18T03:00:00Z', 'claude.ai', 'Fake Org');
  const first = usage(dir);
  assert.match(first['as-of'], STAMP);
  assert.deepEqual({ ...first, 'as-of': 'now' }, { email: 'me@example.com', session: { percent: 7.5, 'resets-at': '2026-10-15T13:00:00Z' }, weekly: { percent: 89, 'resets-at': '2026-10-18T03:00:00Z' }, 'auth-method': 'claude.ai', org: 'Fake Org', 'as-of': 'now' });
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  await cli(dir, 'project:set-claude-usage', 'p', 'other@example.com', '100', '2026-10-15T18:00:00.274Z', '0.5', '2026-10-19T03:00:00.281Z', 'api_key', 'Other Org');   // a plain overwrite
  assert.deepEqual({ ...usage(dir), 'as-of': 'now' }, { email: 'other@example.com', session: { percent: 100, 'resets-at': '2026-10-15T18:00:00.274Z' }, weekly: { percent: 0.5, 'resets-at': '2026-10-19T03:00:00.281Z' }, 'auth-method': 'api_key', org: 'Other Org', 'as-of': 'now' });
});

test('project:set-claude-usage: - leaves that field null; weekly is null when both its arguments are - (no weekly cap, ASS-65)', async () => {
  const dir = projects();
  await cli(dir, 'project:set-claude-usage', 'p', '-', '-', '-', '-', '-', '-', '-');
  assert.deepEqual({ ...usage(dir), 'as-of': 'now' }, { email: null, session: { percent: null, 'resets-at': null }, weekly: null, 'auth-method': null, org: null, 'as-of': 'now' });
  await cli(dir, 'project:set-claude-usage', 'p', 'me@example.com', '0', '-', '-', '2026-10-18T03:00:00Z', '-', '-');
  assert.deepEqual(usage(dir).session, { percent: 0, 'resets-at': null });
  assert.deepEqual(usage(dir).weekly, { percent: null, 'resets-at': '2026-10-18T03:00:00Z' });
  await cli(dir, 'project:set-claude-usage', 'p', 'me@example.com', '0', '-', '40', '-', '-', '-');
  assert.deepEqual(usage(dir).weekly, { percent: 40, 'resets-at': null });
});

test('project:set-claude-usage fails, writing nothing, on a bad project, a percent not from 0 to 100, a resets-at not ISO 8601 UTC, or the weekly pair or auth-method and org missing', async () => {
  const dir = projects();
  const W = ['89', '2026-10-18T03:00:00Z', 'claude.ai', 'Org'];
  const bad = [
    ['nope', 'me@example.com', '7', '2026-10-15T13:00:00Z', ...W],
    ['../p', 'me@example.com', '7', '2026-10-15T13:00:00Z', ...W],
    ['p', 'me@example.com', '100.1', '2026-10-15T13:00:00Z', ...W],
    ['p', 'me@example.com', '-1', '2026-10-15T13:00:00Z', ...W],
    ['p', 'me@example.com', 'seven', '2026-10-15T13:00:00Z', ...W],
    ['p', 'me@example.com', '', '2026-10-15T13:00:00Z', ...W],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00+00:00', ...W],
    ['p', 'me@example.com', '7', 'tomorrow', ...W],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', '100.1', ...W.slice(1)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', '-1', ...W.slice(1)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', 'most', ...W.slice(1)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', W[0], '2026-10-18T03:00:00+00:00', ...W.slice(2)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', W[0], 'next week', ...W.slice(2)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', ...W.slice(0, 3)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', ...W.slice(0, 2)],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z', W[0]],
    ['p', 'me@example.com', '7', '2026-10-15T13:00:00Z'],
    ['p', 'me@example.com', '7'],
  ];
  for (const args of bad) {
    await assert.rejects(cli(dir, 'project:set-claude-usage', ...args), undefined, args.join(' '));
    assert.equal(usage(dir), undefined, args.join(' '));
  }
});
