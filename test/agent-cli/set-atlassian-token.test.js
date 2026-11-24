// project:set-atlassian-token (ASS-561): the token from the clipboard (or stdin) saved as the keychain item the
// project's atlassian entry in ~/.harness/vm-credentials.json names — through `security -i`, the token on its stdin
// only — the clipboard cleared, acli logged in with the token on its stdin, and the check run again so the
// dashboard's Atlassian chip clears. The token is never printed and never on any command line. security, pbpaste,
// pbcopy and acli are fakes on PATH logging their argv; HOME is a folder of the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const TOKEN = 'ATATT3xFfGF0-test_TOKEN=abc123';
const BOARD = 'https://example.atlassian.net/jira/software/c/projects/PROJ/boards/12';
const ATLASSIAN = { 'keychain-service': 'Atlassian API Token (Test)', site: 'example.atlassian.net', email: 'ada@example.com' };
const script = (bin, name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };

function mac({ declaration = { p: { atlassian: ATLASSIAN } }, clipboard = `${TOKEN}\n`, acliFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlassian-token-'));
  const home = join(dir, 'home'), kc = join(dir, 'keychain'), bin = join(dir, 'bin'), projects = join(dir, 'projects');
  for (const d of [join(home, '.harness'), kc, bin, join(projects, 'p')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify(declaration));
  writeFileSync(join(projects, 'p', 'project.json'), JSON.stringify({ name: 'P', 'work-sources': [{ name: 'J', type: 'jira', url: BOARD }] }));
  writeFileSync(join(dir, 'clipboard'), clipboard);
  // A stale record from an earlier check, which the check run at the end removes.
  writeFileSync(join(projects, 'p', 'atlassian-needs.json'), JSON.stringify({ since: '2026-11-23T00:00:00Z', problems: [{ credential: 'x', problem: 'y', fix: 'z' }] }));
  script(bin, 'security', `printf 'security %s\\n' "$*" >> "${dir}/argv"
if [[ "$*" == -i ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^add-generic-password\\ -U\\ -s\\ \\"([^\\"]+)\\"\\ -a\\ \\"[^\\"]+\\"\\ -T\\ /usr/bin/security\\ -w\\ \\"([^\\"]*)\\"$ ]] || { echo "bad command" >&2; continue; }
    printf '%s' "\${BASH_REMATCH[2]}" > "${kc}/\${BASH_REMATCH[1]}"
  done
  exit 0
fi
[[ "$1 $2" == "find-generic-password -s" ]] || exit 2
[[ -e "${kc}/$3" ]] || exit 44
[[ "\${4:-}" == -w ]] && cat "${kc}/$3"
exit 0`);
  script(bin, 'pbpaste', `printf 'pbpaste %s\\n' "$*" >> "${dir}/argv"; cat "${dir}/clipboard"`);
  script(bin, 'pbcopy', `printf 'pbcopy %s\\n' "$*" >> "${dir}/argv"; cat > "${dir}/clipboard"`);
  script(bin, 'acli', `printf 'acli %s\\n' "$*" >> "${dir}/argv"
if [[ "$*" == "jira auth login"* ]]; then cat > "${dir}/acli-stdin"; ${acliFails ? `echo "login failed for token $(cat "${dir}/acli-stdin")" >&2; exit 1` : 'echo "✓ Authentication successful"'}; exit 0; fi
if [[ "$*" == "jira auth status" ]]; then [[ -e "${dir}/acli-stdin" ]] || { echo "✗ not logged in"; exit 1; }; printf '✓ Authenticated\\n  Site: example.atlassian.net\\n'; exit 0; fi
exit 2`);
  const env = { ...process.env, HOME: home, USER: 'ada', PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: projects, GH_DISABLED: '1', GLAB_DISABLED: '1', ACLI_DISABLED: '' };
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return { dir, kc, projects, env, read, needs: join(projects, 'p', 'atlassian-needs.json') };
}
const settle = p => p.then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('ASS-561 AC3/AC5: the clipboard token is saved to the keychain item, acli logged in with it on stdin, the clipboard cleared, the token never printed nor on a command line; the chip\'s record cleared by the check run after', async () => {
  const m = mac();
  const r = await settle(run(AGENT, ['project:set-atlassian-token', 'p'], { env: m.env }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(m.kc, ATLASSIAN['keychain-service']), 'utf8'), TOKEN);
  assert.equal(m.read('acli-stdin'), TOKEN);
  assert.equal(m.read('clipboard'), '');
  assert.match(m.read('argv'), /^acli jira auth login --site example\.atlassian\.net --email ada@example\.com --token$/m);
  assert.match(m.read('argv'), /^security -i$/m);
  assert.match(m.read('argv'), /^pbcopy $/m);
  for (const text of [r.stdout, r.stderr, m.read('argv')]) assert.ok(!text.includes(TOKEN), text);
  assert.match(r.stdout, /saved the Atlassian API token as keychain item "Atlassian API Token \(Test\)"/);
  assert.match(r.stdout, /cleared the clipboard/);
  assert.match(r.stdout, /acli logged in to example\.atlassian\.net as ada@example\.com/);
  assert.equal(existsSync(m.needs), false, 'the check after it found nothing');
});

test('ASS-561 AC3: --stdin reads the token from stdin and leaves the clipboard alone', async () => {
  const m = mac({ clipboard: 'something else' });
  const child = execFile(AGENT, ['project:set-atlassian-token', 'p', '--stdin'], { env: m.env });
  child.stdin.end(`${TOKEN}\n`);
  const [code, out] = await new Promise(resolve => { let s = ''; child.stdout.on('data', d => { s += d; }); child.on('close', c => resolve([c, s])); });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(m.kc, ATLASSIAN['keychain-service']), 'utf8'), TOKEN);
  assert.equal(m.read('clipboard'), 'something else');
  assert.ok(!out.includes(TOKEN));
  assert.doesNotMatch(m.read('argv'), /pbpaste|pbcopy/);
});

test('ASS-561 AC3: acli failing says so with the token masked in what acli said; the keychain item stays saved', async () => {
  const m = mac({ acliFails: true });
  const r = await settle(run(AGENT, ['project:set-atlassian-token', 'p'], { env: m.env }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /acli could not log in to example\.atlassian\.net as ada@example\.com/);
  assert.match(r.stderr, /login failed for token <token>/);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  assert.equal(readFileSync(join(m.kc, ATLASSIAN['keychain-service']), 'utf8'), TOKEN);
});

test('ASS-561 AC3: with no atlassian entry it says what to add and saves nothing; an empty clipboard or one holding no token is refused, unprinted', async () => {
  const none = mac({ declaration: { p: {} } });
  let r = await settle(run(AGENT, ['project:set-atlassian-token', 'p'], { env: none.env }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /add an atlassian entry for p to ~\/\.harness\/vm-credentials\.json/);
  assert.match(r.stderr, /"atlassian": \{ "keychain-service": "Atlassian API Token \(p\)", "site": "example\.atlassian\.net", "email": /);
  assert.doesNotMatch(none.read('argv'), /security|acli|pbpaste/);

  const empty = mac({ clipboard: '  \n' });
  r = await settle(run(AGENT, ['project:set-atlassian-token', 'p'], { env: empty.env }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the clipboard is empty/);
  const prose = mac({ clipboard: 'my "secret" text; rm -rf' });
  r = await settle(run(AGENT, ['project:set-atlassian-token', 'p'], { env: prose.env }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not an API token/);
  assert.ok(!r.stderr.includes('secret'));
  assert.doesNotMatch(prose.read('argv'), /security|acli/);
  r = await settle(run(AGENT, ['project:set-atlassian-token'], { env: prose.env }));
  assert.match(r.stderr, /usage/);
});
