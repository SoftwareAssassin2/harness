// analytics:record-sign-in (ASS-475): the downloader's analytics sign-in
// check, recorded for the dashboard — data/projects/<p>/jira-token-rejected.json
// written while Jira rejects the token (its first time kept), removed once a
// round signs in; a bad payload or project writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'record-sign-in-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  let n = 0;
  const record = (payload, project = 'p') => {
    const file = join(dir, `answer-${n++}.json`);
    writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
    return run(AGENT, ['analytics:record-sign-in', project, file], { env: { ...process.env, PROJECTS_DIR: dir } });
  };
  const file = join(dir, 'p', 'jira-token-rejected.json');
  return { record, file, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const REJECTED = { 'signed-in': false, status: 401, problem: 'HTTP 401 Unauthorized for /rest/api/3/myself', 'work-source': 'J' };

test('ASS-475: a rejected token is recorded with its first time; a later rejection keeps that time and takes the new problem; signing in removes the record', async () => {
  const f = fixture();
  const { stdout } = await f.record(REJECTED);
  assert.match(stdout, /^token rejected since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
  const first = f.read();
  assert.deepEqual({ ...first, since: 'x' }, { since: 'x', status: 401, problem: REJECTED.problem, 'work-source': 'J' });
  writeFileSync(f.file, JSON.stringify({ ...first, since: '2026-11-01T00:00:00Z' }));
  await f.record({ ...REJECTED, status: 200, problem: 'answered as an anonymous user' });
  assert.deepEqual(f.read(), { since: '2026-11-01T00:00:00Z', status: 200, problem: 'answered as an anonymous user', 'work-source': 'J' });
  assert.match((await f.record({ 'signed-in': true })).stdout, /^signed in$/m);
  assert.equal(existsSync(f.file), false);
  // Signed in with no record: nothing to do.
  assert.match((await f.record({ 'signed-in': true })).stdout, /^signed in$/m);
  assert.equal(existsSync(f.file), false);
});

test('ASS-475: a payload not of the shape, or a missing project, fails and writes nothing', async () => {
  const f = fixture();
  for (const bad of ['not json', { 'signed-in': false }, { 'signed-in': false, status: '401', problem: 'x' }, {}]) {
    await assert.rejects(f.record(bad), /analytics:record-sign-in: .* is not/);
  }
  await assert.rejects(f.record(REJECTED, 'nope'), /no project nope/);
  assert.equal(existsSync(f.file), false);
});
