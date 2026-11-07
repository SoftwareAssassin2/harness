// ASS-179 AC5: no CLI writes a file with a shell redirect of its own but
// through json-file.bash's helpers — update_json (locked JSON), append_line
// (a locked append), replace_file and write_json (temp and rename) — or one of
// the writes listed below, each with why it may. A new `>`/`>>` into a file in
// src/agent-cli, src/harness-cli or src/off-board-cli fails here: route it
// through a helper, or list it with its reason. A listed write no longer
// there fails too, so the list stays true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const FOLDERS = ['src/agent-cli', 'src/harness-cli', 'src/off-board-cli'];

// Redirects to a file named by a quoted word or an absolute path: `> "$f"`,
// `>>"$log"`, `> /tmp/x`. Not 2>…, >&2, 2>&1 or /dev/…; not a comment line.
// An unquoted `> $x` is left out: in this code it is a jq or (( )) comparison.
function redirects(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/(?<![0-9&<>=-])(>>?)\s*("[^"]*"|\/[^\s;)'"]+)/g)) {
      if (/^"?\/dev\//.test(m[2])) continue;
      found.push({ line: i + 1, op: m[1], target: m[2] });
    }
  });
  return found;
}

// file → { target: why }. Targets as written, quotes included.
const ALLOWED = {
  'src/agent-cli/json-file.bash': {
    '"$file.$$"': 'update_json: a new file made {} beside and renamed over, under its lock',
    '"$tmp"': 'replace_file / write_json: the temp file renamed over the original',
    '"$file"': 'append_line itself, under <file>.lock',
  },
  'src/agent-cli/assignments/create.sh': {
    '"$last_model_file.$$"': 'temp beside, renamed over (unlocked: last writer wins; assignments:create is ASS-178\'s)',
    '"$used_file"': 'noclobber create of {} when missing, then update_json',
  },
  'src/agent-cli/chat/chats.bash': { '"$file"': 'noclobber create when missing, then update_json' },
  'src/agent-cli/collaboration/collaboration.bash': { '"$dir/collaboration.json"': 'noclobber create when missing, then update_json' },
  'src/agent-cli/ticket/sync-jira-comments.sh': { '"$dir/jira-comments.json"': 'noclobber create when missing, then update_json' },
  'src/agent-cli/project/set-last-data-download.sh': { '"$file.$$"': 'temp beside, renamed over' },
  'src/agent-cli/reauthentication.bash': { '"$file.$$"': 'temp beside, renamed over' },
  'src/agent-cli/registry/refresh-credentials.sh': { '"$file.$$"': 'temp beside, renamed over' },
  'src/agent-cli/registry/up.sh': {
    '"$1.$$"': 'temp beside, renamed over',
    '"$storage/zot.out"': 'zot\'s own output log',
    '"$zot_pid_file"': 'one writer: registry:up runs once at a time per project (registry-up.lock)',
  },
  'src/agent-cli/memory/up.sh': {
    '"$data/hindsight.out"': 'Hindsight\'s own output log',
    '"$pid_file"': 'one writer: memory:up runs once at a time per project (memory-up.lock)',
    '"$data/config.sha256"': 'one writer: memory:up runs once at a time per project (memory-up.lock)',
  },
  'src/agent-cli/registry/sweep.sh': {
    '"$pulls.$$"': 'temp beside, renamed over',
    '"$log"': 'a scratch log of its own',
    '"$storage/sweep.$$"': 'a scratch file of its own',
  },
  'src/agent-cli/sprint/advance.sh': { '"$tmp"': 'temp renamed over, under the files\' locks (sprint:advance is ASS-178\'s)' },
  'src/agent-cli/ticket/move.sh': {
    '"$tmp"': 'temp renamed over, under both projects\' locks (ASS-172)',
    '"$to_backlog.$$"': 'temp beside, renamed over, under the locks',
  },
  'src/off-board-cli/ticket.bash': { '"$tmp"': 'rewrite_ticket: temp renamed over, under the store lock (ASS-175)' },
  'src/off-board-cli/ticket/create.sh': { '"$tmp"': 'temp renamed into place, under the store lock (ASS-175)' },
  'src/agent-cli/vm/build-golden.sh': {
    '"$log"': 'the build log, written by the one build holding golden-build.lock',
    '"$LIMA_HOME/$build/golden-image.json"': 'inside the build VM\'s own folder, under golden-build.lock',
    '"$failed"': 'a mktemp file: the failure said (ASS-289)',
  },
  'src/agent-cli/vm.bash': { '", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)\' "': 'perl\'s open mode in a lock probe (build_in_progress), not a redirect' },
  'src/agent-cli/vm/build-golden-start.sh': {
    '"$3"': 'the run log, one start at a time (golden-build-start.lock)',
    '"$4"': 'the run exit code, one start at a time (golden-build-start.lock)',
  },
  'src/agent-cli/merge-request/merge-in-turn.sh': { '"$log"': 'the merge gate\'s log, started by the one ask holding merge.lock (ASS-197)' },
  'src/agent-cli/vm/test-repos.sh': { '"$log"': 'its test log', '"$out"': 'a scratch file of its own' },
  'src/agent-cli/vm/demo.sh': { '"$log"': 'a temp file inside the VM' },
  'src/agent-cli/vm/start.sh': {
    '"$R/run/harness/agent-token"': 'inside the VM, not the harness\'s data',
    '"$R/run/harness/agent-url"': 'inside the VM, not the harness\'s data',
  },
  'src/agent-cli/vm/credentials.sh': {
    '"$h/agent-token"': 'inside the VM, not the harness\'s data (ASS-215: kept across its rm -rf)',
    '"$h/agent-url"': 'inside the VM, not the harness\'s data (ASS-215: kept across its rm -rf)',
  },
  'src/agent-cli/vm/in-vm/demo-desktop.sh': { '"$R$rc"': 'runs inside the VM' },
  'src/agent-cli/vm/raise-golden-rebuilds.sh': { '"$body"': 'a temp file', '"$lines"': 'a temp file' },
  'src/agent-cli/vm/golden.bash': { '", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)\' "': 'perl\'s open mode in a lock probe, not a redirect' },
  'src/agent-cli/vm/firewall.sh': { '/sbin/pfctl</string><string>-E</string><string>-a</string><string>com.apple/harness-vm</string><string>-f</string><string>$anchor</string></array>': 'XML text, not a redirect' },
  'src/agent-cli/registry/push.sh': { '/<repository>/<image>:<tag>': 'usage text, not a redirect' },
  'src/agent-cli/ticket/set-gate-when-leaving-state.sh': { '/<state>…]': 'usage text, not a redirect' },
  'src/agent-cli/code.bash': { '"$f"': 'a mktemp file in a shim run in the project' },
  'src/agent-cli/code/create-worktree.sh': { '"$(git -C "': 'the workspace\'s .git/info/exclude, not the harness\'s data' },
  'src/agent-cli/automated-tests/verify-success.sh': { '"$3"': 'a test run\'s output, to its own temp file', '"$tmp/master-$i"': 'a temp folder of its own' },
  'src/agent-cli/ci-checks/verify.sh': Object.fromEntries(['"$4"', '"$tmp/head"', '"$tmp/base"', '"$tmp/changed"', '"$tmp/master-tail"', '"$tmp/master-$i"'].map(t => [t, 'a temp folder of its own (mktemp -d)'])),
  'src/agent-cli/project/check-on-master.sh': { '"$why"': 'a temp file of its own' },
  'src/agent-cli/ticket/announce-ready.sh': { '"$note"': 'a mktemp file' },
  'src/agent-cli/ticket/join-sprint.sh': { '"$fetched"': 'a mktemp file' },
  'src/agent-cli/ticket/raise-bug.sh': { '"$work/create.json"': 'a temp folder of its own' },
  'src/agent-cli/ticket/sync.sh': { '"$body"': 'a mktemp file' },
  'src/harness-cli/export-project.sh': Object.fromEntries(['"$stage/project.json"', '"$stage/vm-credentials.template.json"', '"$stage/manifest.json"'].map(t => [t, 'the bundle\'s staging folder of its own (mktemp -d)'])),
  'src/harness-cli/install-project.sh': Object.fromEntries(['"$stage/vm-credentials.json"', '"$stage/project.json"'].map(t => [t, 'the install\'s staging folder of its own (mktemp -d), checked before anything is written'])),
  'src/harness-cli/move-data.sh': { '"$work/paths"': 'a temp folder of its own', '"$work/before.sha256"': 'a temp folder of its own', '"$work/after.sha256"': 'a temp folder of its own' },
};

function scripts() {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(sh|bash)$/.test(name)) files.push(path); } };
  for (const folder of FOLDERS) walk(join(ROOT, folder));
  return files;
}

test('the scanner finds a write into a file, and passes over what is no write', () => {
  assert.deepEqual(redirects('echo x >> "$projects/p/x.jsonl"\nprintf y >"$f"\njq . > /tmp/out').map(r => [r.line, r.op, r.target]),
    [[1, '>>', '"$projects/p/x.jsonl"'], [2, '>', '"$f"'], [3, '>', '/tmp/out']]);
  assert.deepEqual(redirects('cmd 2>/dev/null >&2\ncmd > /dev/null 2>&1\n# echo x > "$f"\nexec 9>>"$lock"\njq \'$a > $b\''), []);
});

test('every file write in the CLIs goes through json-file.bash\'s helpers or is a listed one (ASS-179 AC5)', () => {
  const unlisted = [], seen = new Set();
  for (const file of scripts()) {
    const name = relative(ROOT, file);
    for (const r of redirects(readFileSync(file, 'utf8'))) {
      if (ALLOWED[name]?.[r.target]) seen.add(`${name} ${r.target}`);
      else unlisted.push(`${name}:${r.line} ${r.op} ${r.target}`);
    }
  }
  assert.deepEqual(unlisted, [], 'write these through update_json / append_line / replace_file, or list them with why');
  const stale = Object.entries(ALLOWED).flatMap(([name, targets]) => Object.keys(targets).map(t => `${name} ${t}`)).filter(k => !seen.has(k));
  assert.deepEqual(stale, [], 'listed writes no longer there');
});
