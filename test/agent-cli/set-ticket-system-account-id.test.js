// project:set-ticket-system-account-id — records the account id the
// downloader is signed in to Jira as, in the project folder's
// ticket-system-account-id file (ASS-344), for a ticket's
// ticket-system-assignment-id to be compared with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'tsa-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['project:set-ticket-system-account-id', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const read = dir => readFileSync(join(dir, 'p', 'ticket-system-account-id'), 'utf8');

test('project:set-ticket-system-account-id writes the account id, alone and with no newline, to the project folder\'s ticket-system-account-id, leaving project.json be', async () => {
  const dir = projects();
  const config = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await set(dir, 'p', '5b10ac8d82e05b22cc7d4ef5');
  assert.equal(read(dir), '5b10ac8d82e05b22cc7d4ef5');
  await set(dir, 'p', '712020:0e5c1d2a-7f3b-4c8e-9a1d-2b3c4d5e6f70');
  assert.equal(read(dir), '712020:0e5c1d2a-7f3b-4c8e-9a1d-2b3c4d5e6f70');
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), config);
  assert.deepEqual(readdirSync(join(dir, 'p')).sort(), ['project.json', 'ticket-system-account-id']);   // no temp file left behind
});

test('project:set-ticket-system-account-id fails, writing nothing, on a bad id, project or usage', async () => {
  const dir = projects();
  await assert.rejects(set(dir, 'p', 'me@example.com'), /not an account id/);
  await assert.rejects(set(dir, 'p', ''), /not an account id/);
  await assert.rejects(set(dir, 'p', 'a b'), /not an account id/);
  await assert.rejects(set(dir, 'p'), /usage/);
  await assert.rejects(set(dir, '../p', 'acc-1'), /invalid project/);
  await assert.rejects(set(dir, 'q', 'acc-1'), /no project q/);
  assert.equal(existsSync(join(dir, 'p', 'ticket-system-account-id')), false);
  assert.equal(existsSync(join(dir, 'q')), false);
});
