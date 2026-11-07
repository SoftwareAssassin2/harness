// The agent-cli's locked JSON writer, exercised through real processes: the
// commands that use it, run concurrently against the same files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');

// A projects/ folder with one project holding a global file and one ticket file.
function projects(globalCount = 3, ticketCount = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  const entry = i => ({ question: `Q${i}?`, 'recomended-answer': '', answer: '', 'why-asked': '', 'why-this-answer': '', scope: '', 'asked-on-ticket': 'abc-1', 'asked-time-stamp': '', 'answered-time-stamp': '', status: 'Asked', 'ai-feedback-if-not-accepted': '' });
  mkdirSync(join(dir, 'p', 'work', 'abc-1'), { recursive: true });
  writeFileSync(join(dir, 'p', 'global-questions-and-answers.json'), JSON.stringify({ list: Array.from({ length: globalCount }, (_, i) => entry(i)) }, null, 4));
  writeFileSync(join(dir, 'p', 'work', 'abc-1', 'questions-and-answers.json'), JSON.stringify({ list: Array.from({ length: ticketCount }, (_, i) => entry(i)) }, null, 4));
  return dir;
}
// JSON_LOCK_TIMEOUT: thirty writers queue for one lock, which on a busy machine can take longer than the default 30s (ASS-109).
const answer = (dir, ...args) => run(AGENT, ['question:answer', ...args], { env: { ...process.env, PROJECTS_DIR: dir, JSON_LOCK_TIMEOUT: '600' } });
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const globalFile = dir => join(dir, 'p', 'global-questions-and-answers.json');

// Holds the lock on <file>.lock from a separate process until it is killed —
// by the test, or when the test ends — so how long a writer takes to start,
// however busy the machine, cannot outlast the hold (ASS-109).
function holdLock(t, file) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${file}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  return new Promise(resolve => holder.stdout.once('data', () => resolve(holder)));
}
// Whether `promise` is still pending after `ms`: a writer still waiting for the lock.
const pending = (promise, ms = 500) => Promise.race([promise.then(() => false, () => false), new Promise(r => setTimeout(r, ms, true))]);

test('question:answer writes the answer, marks it Answered with a UTC time stamp, and leaves the rest alone', async () => {
  const dir = projects();
  await answer(dir, 'p', 'global', '1', 'Bluebook, always.');
  const list = read(globalFile(dir)).list;
  assert.equal(list[1].answer, 'Bluebook, always.');
  assert.equal(list[1].status, 'Answered');
  assert.match(list[1]['answered-time-stamp'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual([list[0].status, list[2].status, list[0].answer], ['Asked', 'Asked', '']);
  assert.match(readFileSync(globalFile(dir), 'utf8'), /^\{\n {4}"list"/);   // written with four-space indents

  mkdirSync(join(dir, 'p', 'work', 'ABC-2'));                         // the work folder is the key verbatim, as the rest of the harness names it
  writeFileSync(join(dir, 'p', 'work', 'ABC-2', 'questions-and-answers.json'), JSON.stringify({ list: [{ question: 'Q?', status: 'Asked' }] }));
  await answer(dir, 'p', 'ABC-2', '0', 'Per ticket.');
  assert.equal(read(join(dir, 'p', 'work', 'ABC-2', 'questions-and-answers.json')).list[0].status, 'Answered');
  await assert.rejects(answer(dir, 'p', 'XYZ-9', '0', 'x'), /work\/XYZ-9\/questions/);   // and on a case-insensitive disk too
});

test('question:answer can also write why-this-answer and scope; whichever is left out stays as it was', async () => {
  const dir = projects();
  await answer(dir, 'p', 'global', '0', 'Bluebook.', 'Courts expect it.', 'project');
  await answer(dir, 'p', 'global', '1', 'ALWD.', 'Law schools teach it.');
  await answer(dir, 'p', 'global', '2', 'Neither.', '', '');
  const [first, second, third] = read(globalFile(dir)).list;
  assert.deepEqual([first.answer, first['why-this-answer'], first.scope], ['Bluebook.', 'Courts expect it.', 'project']);
  assert.deepEqual([second['why-this-answer'], second.scope], ['Law schools teach it.', '']);   // scope left alone
  assert.deepEqual([third['why-this-answer'], third.scope], ['', '']);                        // given empty, set empty
  await assert.rejects(answer(dir, 'p', 'global', '0', 'a', 'b', 'c', 'd'), /usage/);
});

test('a missing question, file or argument fails without touching anything', async () => {
  const dir = projects();
  const before = readFileSync(globalFile(dir), 'utf8');
  await assert.rejects(answer(dir, 'p', 'global', '7', 'x'), /no question 7/);
  await assert.rejects(answer(dir, 'p', 'global', '-1', 'x'), /index/);
  await assert.rejects(answer(dir, 'p', 'abc-9', '0', 'x'));
  await assert.rejects(answer(dir, 'p', '../p', '0', 'x'), /ticket/);
  await assert.rejects(answer(dir, 'p', 'global', '0', ''), /answer/);
  assert.equal(readFileSync(globalFile(dir), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, 'p')).filter(f => !/^(global-questions-and-answers\.json(\.lock)?|work)$/.test(f)), []);   // no temp files left
});

test('thirty writers at once to the same file lose no update', async () => {
  const dir = projects(30);
  await Promise.all(Array.from({ length: 30 }, (_, i) => answer(dir, 'p', 'global', String(i), `answer ${i}`)));
  const list = read(globalFile(dir)).list;
  assert.deepEqual(list.map(q => q.answer), list.map((_, i) => `answer ${i}`));
  assert.ok(list.every(q => q.status === 'Answered'));
});

test('a writer waits for a held lock, and goes ahead once it is released', async t => {
  const dir = projects();
  const holder = await holdLock(t, globalFile(dir));
  const writing = answer(dir, 'p', 'global', '0', 'after the wait');
  assert.ok(await pending(writing), 'it waits');
  assert.equal(read(globalFile(dir)).list[0].answer, '');
  holder.kill();
  await writing;
  assert.equal(read(globalFile(dir)).list[0].answer, 'after the wait');
});

test('a writer gives up after its lock timeout, leaving the file as it was', async t => {
  const dir = projects();
  const before = readFileSync(globalFile(dir), 'utf8');
  await holdLock(t, globalFile(dir));
  await assert.rejects(run(AGENT, ['question:answer', 'p', 'global', '0', 'x'], { env: { ...process.env, PROJECTS_DIR: dir, JSON_LOCK_TIMEOUT: '1' } }), /timed out/);
  assert.equal(readFileSync(globalFile(dir), 'utf8'), before);
});

test('a lock holder that is killed outright cannot leave the lock stuck', async t => {
  const dir = projects();
  const holder = await holdLock(t, globalFile(dir));
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  // A stuck lock would fail the write when its wait timed out; the default 30s, so a busy machine is no failure.
  await run(AGENT, ['question:answer', 'p', 'global', '0', 'not stuck'], { env: { ...process.env, PROJECTS_DIR: dir } });
  assert.equal(read(globalFile(dir)).list[0].answer, 'not stuck');
});

test('a written file keeps its permissions', async () => {
  const dir = projects();
  chmodSync(globalFile(dir), 0o664);
  await answer(dir, 'p', 'global', '0', 'x');
  assert.equal(statSync(globalFile(dir)).mode & 0o777, 0o664);
});

test('assignments:pause and assignments:start write through the same lock', async t => {
  const file = join(mkdtempSync(join(tmpdir(), 'as-')), 'assignments.json');
  writeFileSync(file, JSON.stringify({ status: 'Running', assignments: [{ 'agent-name': 'A' }] }));
  const env = { ...process.env, ASSIGNMENTS_FILE: file };
  const holder = await holdLock(t, file);
  const pausing = run(AGENT, ['assignments:pause', 'all', 'human'], { env });
  assert.ok(await pending(pausing), 'it waits');
  assert.equal(read(file).status, 'Running');
  holder.kill();
  await pausing;
  assert.deepEqual([read(file).status, read(file).assignments], ['Paused', [{ 'agent-name': 'A' }]]);
  await run(AGENT, ['assignments:start', 'all', 'human'], { env });
  assert.equal(read(file).status, 'Running');
});

// update_json --create (ASS-94): a file that may not exist yet, created as {}
// under the same lock, so the first writers to a live-data file cannot race.
const JSON_FILE = join(ROOT, 'src', 'agent-cli', 'json-file.bash');
const updateJson = (...args) => run('bash', ['-c', 'source "$0"; update_json "$@"', JSON_FILE, ...args], { env: { ...process.env, JSON_LOCK_TIMEOUT: '600' } });

test('update_json --create: thirty writers at once to a file not there yet create it once and lose no update; without --create a missing file still fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  const file = join(dir, 'live.json');
  await assert.rejects(updateJson(file, '.n = 1'), /no file/);
  assert.deepEqual(readdirSync(dir), []);
  await Promise.all(Array.from({ length: 30 }, () => updateJson('--create', file, '.n = ((.n // 0) + 1) | .first //= .n')));
  assert.deepEqual(read(file), { n: 30, first: 1 });
  assert.deepEqual(readdirSync(dir).toSorted(), ['live.json', 'live.json.lock']);   // no temp file left beside it
  await assert.rejects(updateJson('--create', join(dir, 'nowhere', 'live.json'), '.n = 1'), /no file/);   // its folder must exist
});

const replaceFile = (file, input, umask = '022') => new Promise((resolve, reject) => {
  const child = execFile('bash', ['-c', 'umask "$1"; source "$0"; replace_file "$2"', JSON_FILE, umask, file], (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve()));
  child.stdin.end(input);
});

test('replace_file (ASS-176): forty writers at once each write through a temp file of their own beside the file and rename it over — none fails, the file is one whole write, no temp is left; empty input fails, leaving the file as it was; a new file gets the mode `>` would give it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  const file = join(dir, 'ticket.json');
  const writes = Array.from({ length: 40 }, (_, i) => `${JSON.stringify({ n: i, pad: 'x'.repeat(20000) })}\n`);
  await Promise.all(writes.map(text => replaceFile(file, text)));
  assert.ok(writes.includes(readFileSync(file, 'utf8')));
  assert.deepEqual(readdirSync(dir), ['ticket.json']);
  assert.equal(statSync(file).mode & 0o777, 0o644);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(replaceFile(file, ''));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['ticket.json']);
  await replaceFile(join(dir, 'secret.json'), '{}\n', '077');
  assert.equal(statSync(join(dir, 'secret.json')).mode & 0o777, 0o600);
});

// bash <script> with json-file.bash sourced, its stdout and stderr.
const withHelper = (script, ...args) => run('bash', ['-c', `source "$0"; ${script}`, JSON_FILE, ...args], { env: { ...process.env, JSON_LOCK_TIMEOUT: '600' } });

test('append_line (ASS-179 AC1): thirty appenders at once each add one whole line under <file>.lock; a held lock is waited for; --fresh starts the file afresh with the line', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'al-'));
  const file = join(dir, 'inbox.jsonl');
  const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(100000) }));
  await Promise.all(lines.map(line => withHelper('append_line "$1" "$2"', file, line)));
  assert.deepEqual(readFileSync(file, 'utf8').split('\n').toSorted(), ['', ...lines].toSorted());
  assert.deepEqual(readdirSync(dir).toSorted(), ['inbox.jsonl', 'inbox.jsonl.lock']);

  const holder = await holdLock(t, file);
  const waiting = withHelper('append_line "$1" "$2"', file, 'after');
  assert.ok(await pending(waiting), 'waits while <file>.lock is held');
  holder.kill('SIGKILL');
  await waiting;
  assert.match(readFileSync(file, 'utf8'), /\nafter\n$/);

  await withHelper('append_line --fresh "$1" "$2"', file, 'only');
  assert.equal(readFileSync(file, 'utf8'), 'only\n');
  await withHelper('append_line "$1" "$2"', join(dir, 'new.md'), 'first');   // a file not there yet is made
  assert.equal(readFileSync(join(dir, 'new.md'), 'utf8'), 'first\n');
});

test('lock_on refuses a descriptor this shell already holds a lock on, keeping that lock (ASS-179 AC5); once closed it is free again; a child inheriting it may lock its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lo-'));
  const a = join(dir, 'a.lock'), b = join(dir, 'b.lock'), file = join(dir, 'f.json');
  writeFileSync(file, '{}');
  const free = lock => `perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "${lock}"`;
  // A second lock on the same descriptor fails, naming it, and the first stays held.
  const { stdout } = await withHelper(`lock_on 9 "$1" first 5; if lock_on 9 "$2" second 5; then echo replaced; else echo refused; fi; ${free('$1')} && echo a-free || echo a-held`, a, b);
  assert.deepEqual(stdout.trim().split('\n'), ['refused', 'a-held']);
  await assert.rejects(withHelper('lock_on 9 "$1" first 5; lock_on 9 "$2" second 5', a, b), e => /second: descriptor 9 already holds a lock/.test(e.stderr));
  // update_json (descriptor 9) refuses inside a lock_on 9, writing nothing.
  await assert.rejects(withHelper('lock_on 9 "$1" first 5; update_json "$2" ".n = 1"', a, file), /descriptor 9 already holds a lock/);
  assert.equal(readFileSync(file, 'utf8'), '{}');
  // Released, it may be taken again; update_json one after another is fine.
  await withHelper('lock_on 9 "$1" first 5; exec 9>&-; lock_on 9 "$2" second 5; exec 9>&-; update_json "$3" ".n = 1"; update_json "$3" ".n += 1"', a, b, file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).n, 2);
  // A child process given the descriptor (a command run while it is held) locks its own lock on it.
  const child = await withHelper(`lock_on 8 "$1" parent 5; bash -c 'source "$0"; lock_on 8 "$1" child 5 && echo child-locked' "$0" "$2"`, a, b);
  assert.equal(child.stdout.trim(), 'child-locked');
});
