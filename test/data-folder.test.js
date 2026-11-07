// The harness's live data lives under data/ at the repo root (ASS-55): no
// code, comment, prompt or persona still resolves a moved file at the root,
// and the tracked data sits under data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test('the tracked data is under data/: agent-names.json, harness.json, the sample session logs and the harness project\'s golden image — no other project\'s files (ASS-277: they are its own, on disk); none at the root', () => {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n');
  for (const f of ['data/agent-names.json', 'data/harness.json', 'data/projects/harness/golden-image/template.yaml'])
    assert.ok(tracked.includes(f), f);
  assert.deepEqual(tracked.filter(f => f.startsWith('data/projects/') && !f.startsWith('data/projects/harness/golden-image/')), []);
  assert.ok(tracked.some(f => f.startsWith('data/agents/')));
  assert.deepEqual(tracked.filter(f => /^(projects|agents|chats)\/|^(agent-names|harness|assignments|chats)\.json$/.test(f)), []);
  for (const f of ['agent-names.json', 'harness.json', 'projects', 'agents']) assert.equal(existsSync(join(ROOT, f)), false, f);
});
