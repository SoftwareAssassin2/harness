// memory:backup and memory:restore — each project's Hindsight bank exported
// and restored through Hindsight's bank transfer (ASS-148), against the stub
// Hindsight (test/support/fake-hindsight.js). The backups land in the shared
// fixture's own folder (its HINDSIGHT_DIR), never the real ~/Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fixture } from './harness-fixture.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const unit = (text, doc) => ({ id: `u-${doc}`, text, context: 'general', metadata: {}, document_id: doc, mentioned_at: '2026-10-01T00:00:00Z', fact_type: 'world', state: 'valid' });

// The fixture with p's project.json naming the stub Hindsight, whose bank p holds `units`.
async function setup(t, units = [unit('the build needs node 24', 'd1')]) {
  const f = fixture();
  const h = await fakeHindsight();
  t.after(() => h.close());
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hindsight: { port: h.port, 'llm-api-key': null } }));
  h.banks.set('p', units);
  const folder = join(f.dir, 'hindsight-install', 'hindsight-backups', 'p');
  // agent(args, stdin) — agent.sh run with stdin's text: { code, stdout, stderr }.
  const agent = (args, stdin = '') => new Promise(resolve => {
    const child = execFile(AGENT, args, { env: { ...f.env, HINDSIGHT_TRANSFER_WAIT_SECONDS: '5' } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(stdin);
  });
  return { f, h, folder, agent, archives: () => (existsSync(folder) ? readdirSync(folder).sort() : []) };
}

test('memory:backup exports the project\'s bank through Hindsight\'s transfer export into hindsight-backups/<project>/, timestamped', async t => {
  const s = await setup(t);
  const { code, stdout, stderr } = await s.agent(['memory:backup', 'p']);
  assert.equal(code, 0, stderr);
  const [name] = s.archives();
  assert.match(name, /^\d{8}T\d{6}Z\.zip$/);
  const out = JSON.parse(stdout);
  assert.deepEqual(out, { project: 'p', archive: join(s.folder, name), bytes: out.bytes, removed: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(s.folder, name), 'utf8')).units.map(u => u.text), ['the build needs node 24']);
  assert.ok(s.h.requests.some(r => r.method === 'POST' && r.path === '/v1/default/banks/p/transfer/export'));
});

test('memory:backup keeps the last 14 daily backups, removing the oldest; restore\'s pre-restore exports and other files are left be', async t => {
  const s = await setup(t);
  mkdirSync(s.folder, { recursive: true });
  const old = Array.from({ length: 14 }, (_, i) => `202610${String(i + 1).padStart(2, '0')}T030000Z.zip`);
  for (const name of [...old, 'pre-restore-20261001T000000Z.zip', 'notes.txt']) writeFileSync(join(s.folder, name), 'old');
  const { code, stdout, stderr } = await s.agent(['memory:backup', 'p']);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).removed, [join(s.folder, old[0])]);
  const now = s.archives();
  assert.equal(now.filter(n => /^\d{8}T\d{6}Z\.zip$/.test(n)).length, 14);
  assert.ok(!now.includes(old[0]) && now.includes(old[1]));
  assert.ok(now.includes('pre-restore-20261001T000000Z.zip') && now.includes('notes.txt'));
});

test('memory:backup fails, writing nothing, when the project\'s Hindsight is not answering or has no such bank', async t => {
  const s = await setup(t);
  s.h.banks.delete('p');
  const missing = await s.agent(['memory:backup', 'p']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /memory:backup: p's Hindsight on 127\.0\.0\.1:\d+ has no bank p/);
  await s.h.down();
  const down = await s.agent(['memory:backup', 'p']);
  assert.notEqual(down.code, 0);
  assert.match(down.stderr, /memory:backup: p's Hindsight on 127\.0\.0\.1:\d+ would not export the bank p/);
  assert.deepEqual(s.archives(), []);
  assert.match((await s.agent(['memory:backup', '../p'])).stderr, /invalid project/);
});

// p's agents (the fixture's Daredevil, Spock and Leia) ended: only q's left.
const endAgents = f => {
  const file = join(f.dir, 'assignments.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...json, assignments: json.assignments.slice(0, 1).map(a => ({ ...a, 'agent-name': 'Thor', project: 'q' })) }));
};
// Two daily backups of p's bank: an older and the latest, each of one memory.
const twoBackups = s => {
  mkdirSync(s.folder, { recursive: true });
  writeFileSync(join(s.folder, '20261024T030000Z.zip'), JSON.stringify({ bank: 'p', units: [unit('older lesson', 'old')] }));
  writeFileSync(join(s.folder, '20261025T030000Z.zip'), JSON.stringify({ bank: 'p', units: [unit('latest lesson', 'new'), unit('another latest lesson', 'new2')] }));
};
const texts = s => s.h.banks.get('p')?.map(u => u.text);

test('memory:restore <project>, confirmed: exports the current bank first (pre-restore-<time>.zip), deletes the bank, recreates it from the latest backup and reports what it imported', async t => {
  const s = await setup(t, [unit('the corrupt current state', 'cur')]);
  endAgents(s.f);
  twoBackups(s);
  const { code, stdout, stderr } = await s.agent(['memory:restore', 'p'], 'y\n');
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Restore p's memory from .*20261025T030000Z\.zip\? Its bank is deleted and recreated from it; the current bank is exported first\. \[y\/N\]/);
  const pre = s.archives().find(n => /^pre-restore-\d{8}T\d{6}Z\.zip$/.test(n));
  assert.ok(pre, s.archives().join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(join(s.folder, pre), 'utf8')).units.map(u => u.text), ['the corrupt current state']);
  assert.deepEqual(texts(s), ['latest lesson', 'another latest lesson']);
  assert.deepEqual(JSON.parse(stdout), { project: 'p', archive: join(s.folder, '20261025T030000Z.zip'), 'pre-restore': join(s.folder, pre), imported: { documents: 2, memory_units: 2 } });
  const calls = s.h.requests.filter(r => r.path.startsWith('/v1/default/banks/p') && !r.path.includes('/operations/')).map(r => `${r.method} ${r.path}`);
  assert.deepEqual(calls, ['POST /v1/default/banks/p/transfer/export', 'DELETE /v1/default/banks/p', 'POST /v1/default/banks/p/transfer/import']);
  assert.deepEqual(s.h.requests.find(r => r.path.endsWith('/transfer/import')).query, { mode: 'restore', target_bank_id: 'p' });
});

test('memory:restore <project> <archive> restores the archive named — a file in the project\'s backups, or a path', async t => {
  const s = await setup(t);
  endAgents(s.f);
  twoBackups(s);
  const named = await s.agent(['memory:restore', 'p', '20261024T030000Z.zip'], 'yes\n');
  assert.equal(named.code, 0, named.stderr);
  assert.equal(JSON.parse(named.stdout).archive, join(s.folder, '20261024T030000Z.zip'));
  assert.deepEqual(texts(s), ['older lesson']);
  const elsewhere = join(s.f.dir, 'copy.zip');
  writeFileSync(elsewhere, readFileSync(join(s.folder, '20261025T030000Z.zip')));
  const path = await s.agent(['memory:restore', 'p', elsewhere], 'y\n');
  assert.equal(path.code, 0, path.stderr);
  assert.deepEqual(texts(s), ['latest lesson', 'another latest lesson']);
  const missing = await s.agent(['memory:restore', 'p', 'nope.zip'], 'y\n');
  assert.match(missing.stderr, /memory:restore: no archive .*nope\.zip/);
});

test('memory:restore refuses while the project\'s agents run, and changes nothing when not confirmed or when there is no backup', async t => {
  const s = await setup(t, [unit('kept', 'k')]);
  twoBackups(s);
  const running = await s.agent(['memory:restore', 'p'], 'y\n');
  assert.notEqual(running.code, 0);
  assert.match(running.stderr, /memory:restore: p's agents are running \(Daredevil, Spock, Leia\); restore its memory once they have stopped/);
  endAgents(s.f);
  const declined = await s.agent(['memory:restore', 'p'], 'n\n');
  assert.notEqual(declined.code, 0);
  assert.match(declined.stderr, /memory:restore: not confirmed; p's memory is unchanged/);
  assert.deepEqual(await s.agent(['memory:restore', 'p'], '').then(r => r.code !== 0), true);
  assert.deepEqual(s.h.requests.filter(r => r.path.startsWith('/v1/')), []);
  assert.deepEqual(texts(s), ['kept']);
  const empty = await setup(t);
  endAgents(empty.f);
  assert.match((await empty.agent(['memory:restore', 'p'], 'y\n')).stderr, /memory:restore: p has no backups in .*hindsight-backups\/p/);
});

test('memory:restore deletes nothing when the pre-restore export fails — Hindsight down', async t => {
  const s = await setup(t, [unit('kept', 'k')]);
  endAgents(s.f);
  twoBackups(s);
  await s.h.down();
  const r = await s.agent(['memory:restore', 'p'], 'y\n');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /would not export the bank p/);
  assert.match(r.stderr, /memory:restore: p's memory is unchanged/);
  assert.ok(!s.archives().some(n => n.startsWith('pre-restore-')));
  assert.deepEqual(texts(s), ['kept']);
});

test('memory:restore whose import fails says where the bank\'s old contents are and how to put them back', async t => {
  const s = await setup(t, [unit('kept', 'k')]);
  endAgents(s.f);
  mkdirSync(s.folder, { recursive: true });
  writeFileSync(join(s.folder, 'broken.zip'), 'not an archive');
  const r = await s.agent(['memory:restore', 'p', 'broken.zip'], 'y\n');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /operation \S+ is failed: not a transfer archive/);
  const pre = join(s.folder, s.archives().find(n => n.startsWith('pre-restore-')));
  assert.ok(r.stderr.includes(`memory:restore: p's bank was deleted but not restored; what it held is in ${pre} — memory:restore p ${pre} puts it back`), r.stderr);
  // The bank gone, there is nothing to export first: pre-restore is null.
  const back = await s.agent(['memory:restore', 'p', pre], 'y\n');
  assert.equal(back.code, 0, back.stderr);
  assert.equal(JSON.parse(back.stdout)['pre-restore'], null);
  assert.deepEqual(texts(s), ['kept']);
});
