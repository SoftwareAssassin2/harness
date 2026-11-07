// Merge conflicts for merge-request:conflicting-tickets' tests (ASS-198): the
// agent-cli fixture (harness-fixture.js) with the tickets a conflict names —
// see conflicts() — and real git repositories stopped mid-rebase on a
// conflict — see rebasing().
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, hs } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The ticket each variation rule picks, with what its work folder records per variation:
// ABC-1 released (only in the older sprint-9), its B merged as !7 — the branch-name and merge-row rules;
// ABC-4 with B selected — the selected-variation fallback; ABC-5 with nothing — the A default.
// ZZZ-9 is in no sprint (found: false). The caller is ABC-3 A, as in harness-fixture.js.
export const TICKETS = {
  'ABC-1': { title: 'Index the corpus', description: 'Edges are indexed.', variations: ['A', 'B'] },
  'ABC-4': { title: 'Rename the column', description: 'citations.cite is cite_text.', variations: ['A', 'B'] },
  'ABC-5': { title: 'Log the import', description: 'Each import is logged.', variations: ['A'] },
};
export const ac = (key, v) => [{ 'criteria-number': 1, description: `${key} ${v} criterion`, 'dev-status': 'Passed', 'testing-status': 'Passed' }];
export const plan = (key, v) => `# ${key} execution plan (variation ${v})\n`;
export const tests = (key, v) => [{ list: `echo ${key}-${v}.spec.ts`, run: `echo ran ${key} ${v}` }];

const feature = key => ({
  key, title: TICKETS[key].title, description: TICKETS[key].description, 'ticket-system-status': 'Done',
  variations: TICKETS[key].variations.map(v => ({ name: v, 'harness-status': hs('done'), 'acceptance-criteria': ac(key, v) })),
});

// harness-fixture.js's project p with sprint-9 (older, not active) holding ABC-1, the active sprint-10 also ABC-4 and ABC-5,
// and each one's work folder (execution-plan-<V>.md, automated-tests-<V>.json).
export function conflicts() {
  const f = fixture();
  const at = (...rest) => join(f.dir, 'projects', 'p', ...rest);
  edit(at('sprints.json'), s => { s.list.unshift({ number: 9, 'is-active': false }); });
  const released = feature('ABC-1');
  released.variations[1]['merge-request'] = [{ id: 1, key: '!7', url: 'https://gitlab.com/group/project/-/merge_requests/7', status: 'Merged', 'build-status': 'Merged', branch: 'change/ABC-1.B-1', base: 'master' }];
  mkdirSync(at('sprints', 'sprint-9'), { recursive: true });
  writeFileSync(at('sprints', 'sprint-9', 'sprint.json'), JSON.stringify({ number: 9, bugs: [], spikes: [], features: [released] }));
  edit(at('sprints', 'sprint-10', 'sprint.json'), s => {
    s.features.push({ ...feature('ABC-4'), 'selected-variation': { name: 'B', state: 'done', timestamp: '2026-10-20T00:00:00Z' } }, feature('ABC-5'));
  });
  for (const [key, { variations }] of Object.entries(TICKETS)) {
    mkdirSync(at('work', key), { recursive: true });
    for (const v of variations) {
      writeFileSync(at('work', key, `execution-plan-${v}.md`), plan(key, v));
      writeFileSync(at('work', key, `automated-tests-${v}.json`), JSON.stringify(tests(key, v)));
    }
  }
  return f;
}

// A repository at `dir` stopped mid-rebase: master gets `base` — [subject, file] commits, each changing its file —
// and a feature branch, off master's first commit, changes every one of those files too; rebasing it onto master conflicts
// in each. Returns { dir, onto, origHead, mergeBase }, dir canonical (see below).
export function rebasing(dir, base) {
  mkdirSync(dir, { recursive: true });
  // Canonical path: the command reports its checkout from `pwd`, which resolves
  // symlinks (on macOS os.tmpdir() is /var/folders/… → /private/var/folders/…),
  // so the dir the tests compare against must be resolved the same way.
  dir = realpathSync(dir);
  execFileSync('git', ['init', '-q', '--initial-branch=master', dir]);
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T');
  const files = [...new Set(base.map(([, file]) => file))];
  for (const file of files) writeFileSync(join(dir, file), 'one\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
  const mergeBase = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'change/ABC-3-1');
  for (const file of files) writeFileSync(join(dir, file), 'ours\n');
  git(dir, 'commit', '-qam', 'ABC-3: the change');
  const origHead = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'master');
  for (const [subject, file] of base) { writeFileSync(join(dir, file), `${subject}\n`); git(dir, 'commit', '-qam', subject); }
  const onto = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'change/ABC-3-1');
  try { git(dir, 'rebase', 'master'); } catch { /* stops on the conflict, as wanted */ }
  return { dir, onto, origHead, mergeBase };
}

// conflicts() with ABC-3 A's VM recorded and running in a fake Lima (test/support/fake-vm.js): rebasing() a repository
// under /repos/ in its root puts it in the VM.
export function inVm() {
  const f = conflicts(), v = fakeVm(f.env);
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'p-abc-3-a' }; });
  v.instance('p-abc-3-a', 'Running');
  mkdirSync(join(v.root, 'repos'), { recursive: true });
  return { f, v, repos: join(v.root, 'repos') };
}

export const scratch = () => mkdtempSync(join(tmpdir(), 'conflict-'));
