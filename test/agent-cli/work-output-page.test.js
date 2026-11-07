// work:output-page (ASS-230 AC3): a ticket with no visible UI is shown by the
// raw output its Test step saved (work:write test-output-<n>.txt), rendered
// into a dark monospace <pre> page for Take Screenshots to shoot — the bytes
// as captured, only HTML-escaped: nothing cut, typed or added by the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'work-output-page-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-5'), { recursive: true });
  return { dir, folder: join(dir, 'p', 'work', 'ABC-5') };
}
const cli = (dir, ...args) => new Promise(resolve => {
  execFile(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});
const unescape = s => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

test('ASS-230 AC3/AC4: work:output-page prints the variation\'s saved output in a dark monospace <pre> page, verbatim — every line, escaped, nothing added inside the <pre>', async () => {
  const { dir, folder } = projects();
  const raw = '$ jq -r .x f.json | grep -c "<a href>"\n3\n  indented & <tagged>\n\n(… not omitted …)\nlast line\n';
  writeFileSync(join(folder, 'test-output-1-A.txt'), raw);
  const { code, stdout, stderr } = await cli(dir, 'work:output-page', 'p', 'abc-5', 'A', 'test-output-1.txt');
  assert.equal(code, 0, stderr);
  const pre = stdout.match(/<pre>([\s\S]*)<\/pre>/);
  assert.ok(pre, stdout);
  assert.equal(unescape(pre[1]), raw, 'the output, byte for byte');
  assert.doesNotMatch(pre[1], /<(?!\/pre)/, 'no raw < inside the <pre>: the output cannot inject markup');
  assert.match(stdout, /background:\s*#[0-9a-f]{3,6}/i);
  assert.match(stdout, /monospace/);
});

test('ASS-230 AC3: work:output-page reads only the variation\'s own file in the work folder, and fails on a missing one or a refused name', async () => {
  const { dir, folder } = projects();
  writeFileSync(join(folder, 'test-output-1-B.txt'), 'B\'s\n');
  const missing = await cli(dir, 'work:output-page', 'p', 'ABC-5', 'A', 'test-output-1.txt');
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /work:output-page/);
  for (const name of ['../x.txt', 'ticket.json', 'Bad.txt']) assert.notEqual((await cli(dir, 'work:output-page', 'p', 'ABC-5', 'A', name)).code, 0, name);
  assert.notEqual((await cli(dir, 'work:output-page', 'p', 'ABC-5', 'A')).code, 0, 'usage');
});
