// ASS-432 AC3: every command run in, file copied to or status read of a
// ticket variation's VM goes through the machine layer (agent-cli/machine.bash,
// control/machine.js), so a second kind of machine is added in one place. This
// fails on a direct limactl shell, copy or list anywhere under src but the
// Lima backend (machine-lima.bash, machine-lima.js) and golden image building
// (vm/build-golden.sh, vm/golden-image/*), which may stay Lima's own (AC2).
// src/off-board holds ticket text, not code. A line is a call, not words that
// name one (a comment, an error message such as "limactl shell, exit 255"):
// in bash, limactl where a command starts — a line's start, after ; & | $(
// <( ! a keyword (then, do, if, …) or an env assignment (LIMA_HOME=… limactl);
// in JS, 'limactl' given to execFile or spawn with the subcommand next, or
// a limactl(['list', …]) wrapper's call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const ALLOWED = ['src/agent-cli/machine-lima.bash', 'src/control/machine-lima.js', 'src/agent-cli/vm/build-golden.sh'];
const ALLOWED_FOLDERS = ['src/agent-cli/vm/golden-image/'];
const TICKETS = 'src/off-board/';   // not tracked in every checkout

const SUB = '(?:shell|copy|cp|list|ls)';
const BASH_CALL = new RegExp(`(?:^|\\$\\(|<\\(|[;&|!]|\\b(?:then|do|else|if|elif|while|until|exec|time|command)\\b|\\b[A-Za-z_][A-Za-z0-9_]*=\\S+\\s)\\s*limactl\\s+${SUB}\\b`);
const JS_CALL = new RegExp(`['"\`]limactl['"\`]\\s*,\\s*\\[?\\s*['"\`]${SUB}['"\`]|\\bexec(?:Sync)?\\(\\s*['"\`]limactl\\s+${SUB}\\b|\\blimactl\\(\\s*\\[\\s*['"\`]${SUB}['"\`]`);

// calls(text, js) — the lines of the file's text that call limactl shell, copy or list.
function calls(text, js) {
  return text.split('\n').filter(line => {
    const code = line.trim();
    if (js ? code.startsWith('//') || code.startsWith('*') : code.startsWith('#')) return false;
    return (js ? JS_CALL : BASH_CALL).test(line);
  });
}

const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

test('the guard knows a limactl shell, copy or list call from words that only name one', () => {
  const bash = [
    'limactl shell --workdir / "$vm" -- true',
    '  ip="$(limactl shell "$vm" -- ip -4 -o addr show lima0)"',
    'printf x | limactl shell "$vm" -- bash -s',
    '[[ "$(limactl list "$vm" --format \'{{.Status}}\')" == Running ]]',
    'if limactl list "$vm" >/dev/null; then :; fi',
    '[[ -n "$vm" ]] && LIMA_HOME="$(lima_home)" limactl shell --workdir /repos/ "$vm" -- true',
    'limactl copy -r ./dir "$vm":/tmp/',
    'x=1; limactl cp a b',
  ];
  for (const line of bash) assert.deepEqual(calls(line, false), [line], line);
  const words = [
    '# limactl shell, as vm:start does',
    'could_not "the VM ($vm)" "$repo: could not reach the VM to fetch origin (limactl shell, exit 255): $(err)"',
    'vm_error="limactl shell $vm (exit $rc): $(cat err)"',
    'echo "to take the fix, limactl delete -f $vm" >&2',
    'limactl delete -f "$vm"',
    'machine_run --workdir / "$vm" -- true',
  ];
  for (const line of words) assert.deepEqual(calls(line, false), [], line);
  const js = [
    "execFile('limactl', ['shell', vm, '--', 'true'], {}, () => {});",
    "const argv = ['limactl', 'shell', '--workdir', cwd, vm, '--'];",
    "spawn(\"limactl\", [\"list\", '--format', f]);",
    'execSync(`limactl list --format json`);',
    "const { stdout } = await limactl(['list', '--format', f], env);",   // a wrapper of its own
  ];
  for (const line of js) assert.deepEqual(calls(line, true), [line], line);
  for (const line of ['// through limactl shell', "if (error) reject(new Error(`limactl list: ${error.message}`));", "machineCommand(vm, argv, { cwd: REPOS })"]) assert.deepEqual(calls(line, true), [], line);
});

test('ASS-432 AC3: no limactl shell, copy or list call under src outside the Lima backend and golden image building', () => {
  for (const path of [...ALLOWED, ...ALLOWED_FOLDERS]) assert.ok(existsSync(join(ROOT, path)), `${path}, allowed, is still there`);
  const found = files(SRC)
    .map(path => relative(ROOT, path))
    .filter(path => !ALLOWED.includes(path) && ![...ALLOWED_FOLDERS, TICKETS].some(folder => path.startsWith(folder)))
    .filter(path => /\.(sh|bash|js|mjs)$/.test(path))
    .flatMap(path => calls(readFileSync(join(ROOT, path), 'utf8'), /\.m?js$/.test(path)).map(line => `${path}: ${line.trim()}`));
  assert.deepEqual(found, [], 'run it through the machine layer (src/agent-cli/machine.bash, src/control/machine.js) instead');
});
