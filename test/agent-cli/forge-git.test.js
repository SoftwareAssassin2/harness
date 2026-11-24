// ASS-583: moving branches through the Mac failed silently for a private forge over HTTPS: the Mac's git had no
// credentials there, and the relay and hand-over ran `git ls-remote … 2>/dev/null`, so "authentication failed" read as
// "no branches". forge-git.bash forge_git gives each forge call the project's declared credential (vm-credentials.json's
// gitlab keychain item), read from the keychain for that call only, and says why a call failed.
// AC1: with the credential declared, ls-remote, fetch, push and clone (forge_git itself, and the relay's own calls:
// code:hand-over onto a sandbox, substrate:sandbox-delete --keep-work, relay_clone) authenticate with it against an
// HTTPS forge that requires the token, and the token is in no git config, URL, file, argv or log.
// AC2: a refused token fails the call and the hand-over, naming the repository and "authentication failed".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { httpsGit } from '../support/https-git.js';
import { sandboxed, branchOnOrigin, MACHINE_BASH } from './sandbox-fixture.js';
import { git, edit } from './workstation-fixture.js';

const SRC = join(import.meta.dirname, '..', '..', 'src', 'agent-cli');
const TOKEN = 'glpat-ASS583-test-token-0123456789';
const SERVICE = 'GitLab PAT (Test)';
const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const servers = [];
after(() => Promise.all(servers.map(s => s.close())));

// A bare repository with one commit on main, in a folder of its own (the forge's root).
function forgeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'forge-root-'));
  const work = mkdtempSync(join(tmpdir(), 'forge-work-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
  writeFileSync(join(work, 'README.md'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
  git(work, 'branch', 'change/ABC-3-1');
  execFileSync('git', ['clone', '-q', '--bare', work, join(root, 'harness.git')]);
  execFileSync('git', ['init', '-q', '--bare', join(root, 'scratch.git')]);
  return root;
}

// keychain(dir, token) — a fake `security` (first on the PATH) answering the GitLab item with `token`, anything else
// with a placeholder; it logs its argv. And a `git` that logs its argv, then runs the real one.
function tools(dir, token) {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'token'), token);
  writeFileSync(join(bin, 'security'), `#!/bin/bash
printf '%s\\n' "$*" >> "${dir}/security.log"
[[ " $* " == *" -w "* ]] || exit 0
if [[ "$3" == "${SERVICE}" ]]; then cat "${dir}/token"; else echo sk-ant-oat01-TEST; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${dir}/git-argv.log"\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return bin;
}

// Every file under these folders that holds the token (none should).
function holding(token, ...dirs) {
  const found = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p, { throwIfNoEntry: false }); if (!s) continue;
    if (s.isDirectory()) walk(p); else if (s.size < 4 * 1024 * 1024 && readFileSync(p).includes(token)) found.push(p); } };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return found;
}

// The Mac's side for forge_git: HOME with a global git helper that logs any call (it must never be asked, nor told
// to store the token), the declaration naming the forge's host, git trusting the forge's certificate.
async function setup({ token = TOKEN, declare = true } = {}) {
  const root = forgeRoot();
  const forge = await httpsGit(root, { token: TOKEN }); servers.push(forge);
  const dir = mkdtempSync(join(tmpdir(), 'forge-mac-')), home = join(dir, 'home');
  mkdirSync(join(home, '.harness'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = "!f() { echo \\"$1\\" >> ${dir}/global-helper.log; cat >/dev/null; }; f"\n[user]\n\temail = t@example.com\n\tname = T\n`);
  const file = join(home, '.harness', 'vm-credentials.json');
  writeFileSync(file, JSON.stringify({ p: declare ? { gitlab: { 'keychain-service': SERVICE, host: forge.host } } : {} }));
  const bin = tools(dir, token);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VM_CREDENTIALS_FILE: file, GIT_SSL_CAINFO: forge.ca, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (...args) => new Promise(resolve => {
    const child = spawn('bash', ['-c', `source "${SRC}/forge-git.bash"; command=test; forge_git p "$@"`, 'forge', ...args], { env, cwd: dir });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
  });
  const log = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return { root, forge, dir, home, env, run, log };
}

test('AC1: with a declared credential, forge_git\'s ls-remote, fetch, clone and push authenticate with it; the token is in no config, URL, file, argv or log', async () => {
  const t = await setup();
  const url = t.forge.url('harness.git');
  const ls = await t.run(url, 'ls-remote', '--heads', url);
  assert.equal(ls.code, 0, ls.err);
  assert.match(ls.out, /refs\/heads\/change\/ABC-3-1/);
  assert.match(ls.out, /refs\/heads\/main/);
  const clone = join(t.dir, 'clone');
  const c = await t.run(url, 'clone', '--quiet', url, clone);
  assert.equal(c.code, 0, c.err);
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'one');
  const f = await t.run(url, '-C', clone, 'fetch', '--quiet', 'origin', '+refs/heads/change/ABC-3-1:refs/remotes/origin/change/ABC-3-1');
  assert.equal(f.code, 0, f.err);
  // A push to a scratch repository on the forge (never the live one).
  const scratch = t.forge.url('scratch.git');
  writeFileSync(join(clone, 'pushed.txt'), 'x\n'); git(clone, 'add', '.'); git(clone, 'commit', '-q', '-m', 'pushed');
  const p = await t.run(scratch, '-C', clone, 'push', '--quiet', scratch, 'HEAD:refs/heads/change/ABC-3-1');
  assert.equal(p.code, 0, p.err);
  assert.equal(execFileSync('git', ['--git-dir', join(t.root, 'scratch.git'), 'log', '-1', '--format=%s', 'change/ABC-3-1'], { encoding: 'utf8' }).trim(), 'pushed');
  // The forge let them in with the token (and refused the first, unauthenticated request, as GitLab does).
  assert.ok(t.forge.requests.some(r => r.allowed));
  assert.ok(t.forge.requests.filter(r => r.allowed).length >= 4);
  // Read from the keychain each time, by service name; the token nowhere it could be kept or seen.
  assert.match(t.log('security.log'), new RegExp(`find-generic-password -s ${SERVICE.replace(/[()]/g, '\\$&')} -w`));
  for (const output of [ls.err, c.out, c.err, f.err, p.err, t.log('git-argv.log'), t.log('security.log')]) assert.ok(!output.includes(TOKEN));
  assert.deepEqual(holding(TOKEN, t.home, clone), [], 'no file under HOME or the clone holds it');
  assert.ok(!git(clone, 'remote', 'get-url', 'origin').includes('@'), 'no credential in the URL');
  assert.equal(t.log('global-helper.log'), '', 'the Mac\'s own helpers are never asked, nor told to store it');
});

test('AC2: a refused token fails forge_git, naming the repository and "authentication failed"; nothing read as an empty list', async () => {
  const t = await setup({ token: 'glpat-wrong' });
  const url = t.forge.url('harness.git');
  const ls = await t.run(url, 'ls-remote', '--heads', url);
  assert.notEqual(ls.code, 0);
  assert.equal(ls.out, '');
  assert.match(ls.err, new RegExp(`^test: harness \\(${url.replace(/[.]/g, '\\.')}\\): authentication failed \\(`));
  assert.ok(!ls.err.includes('glpat-wrong'));
  // No credential declared for the host: git as before, and still never prompting.
  const u = await setup({ declare: false });
  const plain = await u.run(u.forge.url('harness.git'), 'ls-remote', '--heads', u.forge.url('harness.git'));
  assert.notEqual(plain.code, 0);
  assert.match(plain.err, /harness .*: authentication failed/);
  assert.equal(u.log('security.log'), '', 'no keychain read without a declaration');
});

// The relay's own calls: project p's harness repository on the HTTPS forge (the sandbox's origin and project.json's).
async function relayed({ token = TOKEN } = {}) {
  const t = await sandboxed();
  const forgeDir = dirname(t.s.origins.harness), name = basename(t.s.origins.harness);
  const forge = await httpsGit(forgeDir, { token: TOKEN }); servers.push(forge);
  const url = forge.url(name);
  const dir = mkdtempSync(join(tmpdir(), 'relay-mac-'));
  const bin = tools(dir, token);
  const file = join(t.s.env.HOME, '.harness', 'vm-credentials.json');
  edit(file, c => { c.p.gitlab = { 'keychain-service': SERVICE, host: forge.host }; });
  edit(t.s.at('projects', 'p', 'project.json'), p => { p.repositories[0].url = url; });
  Object.assign(t.s.env, { PATH: `${bin}:${t.s.env.PATH}`, GIT_SSL_CAINFO: forge.ca, GIT_CONFIG_NOSYSTEM: '1' });
  return { ...t, forge, url, dir, log: n => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : '') };
}

test('AC1: the relay moves branches into and out of a sandbox through a private HTTPS forge with the declared credential (ls-remote, fetch, push, clone)', async () => {
  const t = await relayed();
  const sha = branchOnOrigin(t.s);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const box = join(t.root('abc-3-a'), 'repos', 'harness');
  git(box, 'remote', 'set-url', 'origin', t.url);   // the sandbox's origin is the HTTPS forge, as a private GitLab project's
  // In: relay_in's ls-remote and fetch.
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(git(box, 'rev-parse', 'HEAD'), sha, 'the forge\'s branch checked out in the sandbox');
  // Out: relay_out's fetch and push.
  writeFileSync(join(box, 'more.txt'), 'more\n'); git(box, 'add', '.'); git(box, 'commit', '-q', '-m', 'ABC-3: more');
  const d = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A', '--keep-work');
  assert.equal(d.code, 0, d.err);
  assert.equal(execFileSync('git', ['--git-dir', t.s.origins.harness, 'log', '-1', '--format=%s', 'change/ABC-3-1'], { encoding: 'utf8' }).trim(), 'ABC-3: more');
  // relay_clone: a repository cloned on the Mac from the forge, into another sandbox.
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const c = await new Promise(resolve => {
    const child = spawn('bash', ['-c', `source "${MACHINE_BASH}"; source "${SRC}/substrate/relay.bash"; relay_clone test "$0" cloned "$1"`, 'substrate:p:mac:abc-3-a', t.url], { env: t.s.env });
    let err = ''; child.stderr.on('data', x => { err += x; }); child.on('close', code => resolve({ code, err }));
  });
  assert.equal(c.code, 0, c.err);
  assert.equal(git(join(t.root('abc-3-a'), 'repos', 'cloned'), 'remote', 'get-url', 'origin'), t.url);
  // Authenticated, and the token nowhere.
  assert.ok(t.forge.requests.filter(r => r.allowed).length >= 4);
  for (const output of [h.err, d.err, c.err, t.log('git-argv.log'), t.log('security.log')]) assert.ok(!output.includes(TOKEN));
  assert.deepEqual(holding(TOKEN, t.s.env.HOME, box, join(t.root('abc-3-a'), 'repos')), []);
});

test('AC2: a forge refusing the token fails the hand-over onto a sandbox, naming the repository and "authentication failed" (not "no branches")', async () => {
  const t = await relayed({ token: 'glpat-wrong' });
  branchOnOrigin(t.s);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  git(join(t.root('abc-3-a'), 'repos', 'harness'), 'remote', 'set-url', 'origin', t.url);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.notEqual(h.code, 0);
  assert.match(h.err, /code:hand-over: harness \(https:\/\/127\.0\.0\.1:\d+\/harness\.git\): authentication failed/);
  assert.match(h.err, /could not list harness's branches on origin/);
  assert.notEqual(t.s.variation('A')['run-target']?.target, 'local-substrate', 'nothing recorded');
});
