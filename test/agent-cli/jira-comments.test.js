// ticket:sync-jira-comments (ASS-37): a Jira ticket's comments, as the
// downloader fetched them, kept in projects/<project>/work/<KEY>/
// jira-comments.json by Jira id through the locked writer.
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
  const dir = mkdtempSync(join(tmpdir(), 'jira-comments-'));
  mkdirSync(join(dir, 'p'));
  const file = join(dir, 'p', 'work', 'ABC-1', 'jira-comments.json');
  let n = 0;
  // sync(comments | text) — the command on a file holding { comments } (or that text as is).
  const sync = (comments, ticket = 'ABC-1', project = 'p') => {
    const payload = join(dir, `fetch-${n++}.json`);
    writeFileSync(payload, typeof comments === 'string' ? comments : JSON.stringify({ comments }));
    return cli(project, ticket, payload);
  };
  const cli = (...args) => run(AGENT, ['ticket:sync-jira-comments', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
  return { file, sync, cli, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const comment = (id, body, updated = '2026-10-14T10:00:00.000+0000') => ({ id, author: 'Ann Lee', created: '2026-10-14T10:00:00.000+0000', updated, body });

test('ticket:sync-jira-comments makes work/<KEY>/jira-comments.json, keyed by Jira id; a later fetch adds the new ones and duplicates none', async () => {
  const f = fixture();
  assert.equal(existsSync(f.file), false);
  const { stdout } = await f.sync([comment('10', 'First'), comment('11', 'Second')]);
  assert.match(stdout, /2 comments \(2 new\)/);
  assert.deepEqual(f.read(), {
    10: { author: 'Ann Lee', created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T10:00:00.000+0000', body: 'First' },
    11: { author: 'Ann Lee', created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T10:00:00.000+0000', body: 'Second' },
  });
  assert.match(readFileSync(f.file, 'utf8'), /^\{\n {4}"10"/);
  await f.sync([comment('10', 'First'), comment('11', 'Second'), comment('12', 'Third')]);
  assert.deepEqual(Object.entries(f.read()).map(([id, c]) => [id, c.body]), [['10', 'First'], ['11', 'Second'], ['12', 'Third']]);
});

test('an edited comment (its updated changed) is replaced; a deleted one, missing from the fetch, is kept', async () => {
  const f = fixture();
  await f.sync([comment('10', 'First'), comment('11', 'Second')]);
  await f.sync([comment('11', 'Second, edited', '2026-10-14T11:00:00.000+0000')]);
  assert.deepEqual(Object.entries(f.read()).map(([id, c]) => [id, c.body, c.updated]), [
    ['10', 'First', '2026-10-14T10:00:00.000+0000'],
    ['11', 'Second, edited', '2026-10-14T11:00:00.000+0000'],
  ]);
});

test('ticket:sync-jira-comments fails, writing nothing, on a bad project or ticket, a missing or malformed file, a comment without an id, or bad arguments', async () => {
  const f = fixture();
  await f.sync([comment('10', 'First')]);
  const before = readFileSync(f.file, 'utf8');
  await assert.rejects(f.sync([], 'ABC-1', '../p'), /invalid project/);
  await assert.rejects(f.sync([], 'a/b'), /invalid ticket/);
  await assert.rejects(f.sync([], 'ABC-1', 'nope'), /no project nope/);
  await assert.rejects(f.sync('{'), /not \{ comments/);
  await assert.rejects(f.sync('{"comments":{}}'), /not \{ comments/);
  await assert.rejects(f.sync([{ body: 'no id' }]), /not \{ comments/);
  await assert.rejects(f.cli('p', 'ABC-1', '/nowhere.json'), /no file/);
  await assert.rejects(f.cli('p', 'ABC-1'), /usage/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
