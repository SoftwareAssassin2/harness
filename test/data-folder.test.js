// The harness's live data lives under data/ at the repo root (ASS-55): no
// code, comment, prompt or persona still resolves a moved file at the root,
// and the tracked data sits under data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MOVED = '(projects|agents|chats|assignments\\.json|chats\\.json|harness\\.json|last-model-used|agent-names(-last-used)?\\.json)';
// What resolves, or says, a moved file is at the root.
const OLD = [
  new RegExp(`\\.\\./\\.\\./(\\.\\./)*${MOVED}["}]`),                // bash: "$here/../../../projects"
  new RegExp(`\\$\\{?\\w+_root\\}?/${MOVED}\\b`),                  // bash: "$pause_root/projects", a variable holding the repo root
  new RegExp(`join\\((root|ROOT), '${MOVED}'`),                      // JS: join(root, 'projects') (in a test, root is often a fixture's data folder: ROOT only)
  new RegExp(`${MOVED}[^\\n]{0,40}\\bat( the)? (repo|harness) root|repo root's ${MOVED}`),
  /\bunder projects\//,                                             // prompt.json: "Project folder name under projects/"
  /\{harness-folder\}\/projects\//,
  /\(in \{harness-folder\}\)|in \{harness-folder\}[:.]/,            // "Read harness.json (in {harness-folder})"
];

const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

test('no code, comment, prompt or persona resolves a moved file at the repo root', () => {
  const scanned = ['src', 'prompts', 'personas', 'test'].flatMap(d => files(join(ROOT, d)))
    .concat(['agent.sh', 'harness.sh', 'off-board.sh', '.gitignore', join('engines', 'grouped-engines.md')].map(f => join(ROOT, f)))
    .filter(f => !f.startsWith(join(ROOT, 'src', 'off-board') + '/') && f !== import.meta.filename);
  const hits = scanned.flatMap(f => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
    OLD.some(re => re.test(line) && !(f.startsWith(join(ROOT, 'test')) && /join\(root, /.test(line) && !OLD.some(o => o !== re && o.test(line)))) ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
  assert.deepEqual(hits, []);
});

test('the tracked data is under data/: agent-names.json and harness.json only — no session log or project\'s files (ASS-277: they are its own, on disk); none at the root', () => {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n');
  assert.deepEqual(tracked.filter(f => f.startsWith('data/')).toSorted(), ['data/agent-names.json', 'data/harness.json']);
  assert.deepEqual(tracked.filter(f => /^(projects|agents|chats)\/|^(agent-names|harness|assignments|chats)\.json$/.test(f)), []);
  for (const f of ['agent-names.json', 'harness.json', 'projects', 'agents']) assert.equal(existsSync(join(ROOT, f)), false, f);
});

// ASS-459, extending ASS-277's rule (the tracked tree holds no client or
// personal content) to what the files say, not only which files are tracked:
// ASS-277's test above checks file names alone, so 37 lines naming a client's
// GCP project, cluster, repositories, ticket keys and the operator's accounts
// reached tracked code, tests and docs unnoticed. The terms are kept here as
// SHA-256 hashes, never in plain text, so this public guard does not itself
// publish them. Each line of every tracked (or untracked, not ignored) file is
// lower-cased and split into words on anything but a-z and 0-9; a word, or two
// adjacent words run together ("first-last", "first.last@…"), whose hash is
// listed fails the test. Use a generic example instead: example-gcp-project,
// example-group, ABC-<n>, ada@example.com, Ada/Grace/Alan Example.
const BANNED = {
  b27ee0faae720916940f1ab2872c9d246ec0e176c15e44ef08239f9956096145: 'the client\'s company name (in GCP project ids, account names)',
  c7a679faf160c4da1bb2bd68efaaca85cb49d7e6bab83f45ee5d434853425bc2: 'the client\'s product name (its GitLab group, repositories, npm scope, GKE cluster and config names, gcloud config folder, project id; also written as two words joined by - or _)',
  '9732243516ecafb74556667c8bd5e83da5bc4942d7493db84890242f2188863d': 'the client\'s Jira project key (its <KEY>-<n> ticket keys and the VMs named after them)',
  ea2f5fc7587dddd9da7931b22e4a4dc2a5b992b42d4db8c18d05f9831ebfbe1c: 'one of the operator\'s personal email account names',
  '465c3e4547df263db439c46cc109c49cda52d477e8056deb168469d01975badd': 'the operator\'s account name at the client',
  '5d23e26e9a6143496601e1e3170eb01fab1c6f26c832e3e32cbcb304a1d80e79': 'the operator\'s full name (as in a work email\'s first.last, or a workstation id first-last)',
  c2ce08a31f29cc53d42636ed79280c869b8fb85b56aa1f5abecba96db4cfb99b: 'a client team member\'s surname',
  efd5939d7ce74aab6417f96525c2d9ca10a750b541bcef13c4096c84672c770e: 'a client team member\'s surname',
  a9d0bc4649cda2af0ed6511da0a4635275aeca4310851be5b98544d23c334759: 'a client team member\'s full name',
  e86b2416c1f1591aa5bf63711bff4b3cce096db4040e7a3cc8d4489325ea5bd1: 'a client team member\'s full name',
  '18d02258ade766a6291c5a01d3360c0c9a4617d0394ad5827160f17b1860a17c': 'a client team member\'s full name',
  '88d9a55c73e601ae9ccecfb34cf76cd49f27d46cda6158cad50a70f9f043111f': 'the GitLab project id of one of the client\'s npm package registries',
  '9a215aec2f7b00db4d163e1f6b1bc5e46910b262f46017b555170f23852f90f3': 'the GitLab project id of one of the client\'s npm package registries',
};
// The only exception: LICENSE's copyright line names its author, the public
// owner of the GitHub repository, which an MIT licence must.
const ALLOWED = { LICENSE: ['5d23e26e9a6143496601e1e3170eb01fab1c6f26c832e3e32cbcb304a1d80e79'] };

test('ASS-459 (ASS-277): no tracked file names a client, its people, repositories, cloud resources or ticket keys, or the operator\'s accounts', () => {
  const listed = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const seen = new Map();
  const banned = word => {
    if (!seen.has(word)) {
      const hash = createHash('sha256').update(word).digest('hex');
      seen.set(word, BANNED[hash] ? hash : null);
    }
    return seen.get(word);
  };
  const hits = [];
  for (const f of listed) {
    const path = join(ROOT, f);
    if (!existsSync(path) || !statSync(path).isFile()) continue;   // a deleted file not yet staged, a submodule
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) continue;                               // binary
    text.split('\n').forEach((line, i) => {
      const words = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      for (const [j, word] of words.entries()) for (const w of [word, word + (words[j + 1] ?? '')]) {
        const hash = banned(w);
        if (hash && !ALLOWED[f]?.includes(hash)) hits.push(`${f}:${i + 1}: ${BANNED[hash]}`);
      }
    });
  }
  assert.deepEqual([...new Set(hits)], []);
});
