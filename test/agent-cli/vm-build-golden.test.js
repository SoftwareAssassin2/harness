// vm:build-golden (ASS-72) — a project's golden VM image, built from its
// projects/<project>/golden-image/ definition and tagged with the hash of its
// inputs. limactl, gh, glab, curl (the zot check) and security (the keychain
// vm:scan-image reads) are fakes on PATH, and HOME holds the project's
// ~/.harness/vm-credentials.json: limactl keeps instances as folders under
// LIMA_HOME and logs each call, with the name of each script it is asked to run
// in the VM and that script's stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, cpSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until, LOADED_MS } from '../support/until.js';
// untilBuilt — until() for a detached build's end: a whole build of fakes, ~20 steps of processes, which on a busy
// machine (other test files alongside) took past until()'s 30s (ASS-291: one run in 30); one that ends returns at once.
const untilBuilt = check => until(check, 3 * LOADED_MS);

const esc = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const SHARED = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'golden-image');
const GH = 'gho_GITHUBtok', GL = 'glpat-GITLAB.tok', PAT = 'ghp_DECLAREDtok';

function setup({ images = '', warm = false, registry = true, upstream = true, repositories = ['https://github.com/o/harness', 'https://gitlab.com/g/example-project'], tools, builtAt } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'golden-')));
  const bin = join(dir, 'bin'), log = join(dir, 'log'), lima = join(dir, 'lima'), def = join(dir, 'projects', 'p', 'golden-image'), shared = join(dir, 'shared'), home = join(dir, 'home');
  for (const d of [bin, log, lima, def, join(home, '.harness')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify({ p: { github: { 'keychain-service': 'GitHub PAT (Test)' } } }));
  cpSync(SHARED, shared, { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({
    name: 'P', 'golden-image': { folder: 'projects/p/golden-image', ...(tools && { tools }) }, repositories: repositories.map(url => ({ url })),
    ...(registry && { registry: { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: 5101,
      ...(upstream && { upstream: { host: 'us-central1-docker.pkg.dev', credentials: 'gcloud' } }) } }) }, null, 4));
  writeFileSync(join(def, 'template.yaml'), 'vmType: vz\nmounts: []\n');
  writeFileSync(join(def, 'provision.sh'), '#!/bin/bash\necho provision\n');
  writeFileSync(join(def, 'images.txt'), images);
  if (warm) writeFileSync(join(def, 'warm.sh'), '#!/bin/bash\necho warm\n');
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // shell [--workdir D] <vm> -- bash -c <script> <script name> <args…>: logs "shell <vm> <name> <args…>" and keeps its stdin; FAIL_SCRIPT=<name> fails it,
  // LEAK_SCRIPT=<name> writes its stdin, and LEAK=<text> anything, to the VM's disk; RUN_SCRIPT=<name> runs it here, its output in the log.
  // Each call but list also logs whether the project's VM lock is held then (ASS-149): "<subcommand> <held|free>".
  // start and stop (ASS-289) write the instance's status file, Running or Stopped; FAIL_STOP=<vm> fails a stop of it, as with a plain stop.
  // list [<vm>] --format <f> (ASS-287: the inventory, unlogged) prints <f> for each instance folder, or the one (exit 1 when none), its
  // {{.Name}}, {{.Dir}} and {{.Status}} (the folder's status file, else Stopped) filled.
  fake('limactl', `printf 'LIMA_HOME=%s\\n' "$LIMA_HOME" > '${log}/lima-home'
[[ "$1" == list ]] || perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; print flock($f, LOCK_EX | LOCK_NB) ? "$ARGV[1] free\\n" : "$ARGV[1] held\\n"' "$PROJECTS_DIR/p/vms.lock" "$1" >> '${log}/vm-lock'
case "$1" in
  list) shift; fmt="" names=()
        while (( $# )); do if [[ "$1" == --format ]]; then fmt="$2"; shift 2; else names+=("$1"); shift; fi; done
        (( \${#names[@]} )) || names=($(ls "$LIMA_HOME"))
        for n in "\${names[@]}"; do
          [[ -d "$LIMA_HOME/$n" ]] || { echo "No instance matching $n found." >&2; exit 1; }
          st="$(cat "$LIMA_HOME/$n/status" 2>/dev/null || echo Stopped)"; out="\${fmt//'{{.Name}}'/$n}"; out="\${out//'{{.Dir}}'/$LIMA_HOME/$n}"; printf '%s\\n' "\${out//'{{.Status}}'/$st}"
        done ;;
  create) name="\${2#--name=}"; mkdir "$LIMA_HOME/$name"; head -c 3000 /dev/zero > "$LIMA_HOME/$name/disk"; echo "create $name \${4##*/}" >> '${log}/limactl' ;;
  shell) shift; [[ "$1" == --workdir ]] && shift 2; vm="$1"; script="$5"; shift 5; name="$1"; shift
         echo "shell $vm $name $*" >> '${log}/limactl'; cat > '${log}/stdin.'"$name"
         [[ "$name" != "\${RUN_SCRIPT:-}" ]] || bash -c "$script" "$name" "$@" || exit 1
         [[ "$name" != "\${LEAK_SCRIPT:-}" ]] || cat '${log}/stdin.'"$name" >> "$LIMA_HOME/$vm/disk"
         printf '%s' "\${LEAK:-}" >> "$LIMA_HOME/$vm/disk"
         [[ "$name" != "\${FAIL_SCRIPT:-}" ]] || { echo "$name broke" >&2; exit 1; } ;;
  rename) mv "$LIMA_HOME/$2" "$LIMA_HOME/$3"; echo "$*" >> '${log}/limactl' ;;
  delete) rm -rf "$LIMA_HOME/$3"; echo "$*" >> '${log}/limactl' ;;
  start|stop) vm="\${@: -1}"; echo "$*" >> '${log}/limactl'
              [[ "$1" != stop || "$vm" != "\${FAIL_STOP:-}" ]] || { echo "stop broke" >&2; exit 1; }
              [[ ! -d "$LIMA_HOME/$vm" ]] || { [[ "$1" == start ]] && echo Running || echo Stopped; } > "$LIMA_HOME/$vm/status" ;;
  *) echo "$*" >> '${log}/limactl' ;;
esac`);
  // GH_LOGGED_OUT and GLAB_LOGGED_OUT expire the login: auth status fails, as it does then.
  fake('gh', `case "$*" in "auth status") [[ -z "\${GH_LOGGED_OUT:-}" ]] ;; "auth token") echo ${GH} ;; esac`);
  fake('glab', `echo "$*" >> '${log}/glab'; case "$*" in "auth status") [[ -z "\${GLAB_LOGGED_OUT:-}" ]] ;; "config get token --host gitlab.com") echo ${GL} ;; esac`);
  fake('security', `[[ "$*" == "find-generic-password -s GitHub PAT (Test) -w" ]] && echo ${PAT}`);
  fake('curl', `echo "$*" >> '${log}/curl'; [[ -e '${dir}/zot-up' ]]`);
  // df (ASS-287): the volume holding LIMA_HOME, DF_CAPACITY_K KiB (ample by default) less what LIMA_HOME takes now.
  fake('df', `cap=\${DF_CAPACITY_K:-1000000000000}; used=$(du -sk "$LIMA_HOME" | cut -f1); echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "/dev/fake $cap $used $((cap - used)) 1% /"`);
  // builtAt (ASS-291): date's UTC timestamp — the label's built-at — is always it, as for builds finishing in the same second.
  if (builtAt) fake('date', `[[ "$*" == "-u +%Y-%m-%dT%H:%M:%SZ" ]] && echo ${builtAt} || exec /bin/date "$@"`);
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'vm-disk-limit-gb': 100 }));
  // VM_KEYCHAIN_TIMEOUT: the fake keychain answers at once, but on a busy machine starting it took up to ~10s (ASS-109).
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: join(dir, 'projects'), LIMA_HOME: lima, GOLDEN_IMAGE_SHARED: shared, VM_KEYCHAIN_TIMEOUT: '60', HARNESS_FILE: join(dir, 'harness.json') };
  const logOf = name => (existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '');
  return {
    dir, def, shared, lima, env, logOf, home,
    build: (extra = {}) => run(AGENT, ['vm:build-golden', 'p'], { env: { ...env, ...extra } }),
    calls: () => logOf('limactl').trim().split('\n').filter(Boolean),
    reset: () => rmSync(join(log, 'limactl'), { force: true }),
    label: () => JSON.parse(readFileSync(join(lima, 'golden-p', 'golden-image.json'), 'utf8')),
  };
}

test('AC1: builds golden-p from the template and the declared setup, in order, then tags it with the hash of its inputs', async () => {
  const s = setup({ images: 'us-central1-docker.pkg.dev/x/y:1\n# a comment\n\nus-central1-docker.pkg.dev/x/z@sha256:ab\n', warm: true });
  writeFileSync(join(s.dir, 'zot-up'), '');
  const { stdout } = await s.build();
  assert.deepEqual(s.calls(), [
    'create golden-p-build template.yaml',
    'start --tty=false golden-p-build',
    'shell golden-p-build provision.sh ',
    'shell golden-p-build git.sh ',
    'shell golden-p-build desktop.sh ',                                            // ASS-76: every project's image has a desktop, browser and terminal
    'shell golden-p-build registry.sh us-central1-docker.pkg.dev',
    'stop golden-p-build',
    'start --tty=false golden-p-build',
    'shell golden-p-build repositories.sh https://github.com/o/harness https://gitlab.com/g/example-project',
    'shell golden-p-build images.sh ',
    'shell golden-p-build warm.sh ',
    'shell golden-p-build finish.sh ',
    'stop golden-p-build',
    'rename golden-p-build golden-p',
  ]);
  assert.match(s.logOf('stdin.registry.sh'), /\[host\."http:\/\/host\.lima\.internal:5101"\]/);   // the project's mirror, from registry:hosts-toml
  assert.equal(s.logOf('stdin.images.sh'), 'us-central1-docker.pkg.dev/x/y:1\nus-central1-docker.pkg.dev/x/z@sha256:ab\n');
  const label = s.label();
  assert.match(label.hash, /^[0-9a-f]{64}$/);
  assert.equal(label.project, 'p');
  assert.ok(stdout.includes(label.hash.slice(0, 12)), stdout);
  assert.deepEqual(readdirSync(s.lima), ['golden-p']);
});

test('AC2: run again with the same inputs, it reuses golden-p and builds nothing', async () => {
  const s = setup();
  await s.build();
  const label = s.label();
  s.reset();
  writeFileSync(join(s.def, '.DS_Store'), 'finder');                               // not an input
  writeFileSync(join(s.def, 'tests.json'), '{}');                                  // nor vm:test-repos' list and runner
  writeFileSync(join(s.def, 'run-test.sh'), 'exec bash -c "$1"\n');
  writeFileSync(join(s.def, 'ci-checks.json'), '{ "repositories": {} }');           // nor ci-checks:verify's checks (ASS-250)
  const { stdout } = await s.build();
  assert.deepEqual(s.calls(), []);
  assert.match(stdout, /golden-p is current .*nothing built/);
  assert.deepEqual(s.label(), label);
});

test('a change to any input rebuilds: the template, the setup, images.txt, a shared step, the repository list', async () => {
  const s = setup();
  await s.build();
  const hashes = new Set([s.label().hash]);
  const changes = [
    () => writeFileSync(join(s.def, 'template.yaml'), 'vmType: vz\nmounts: []\ncpus: 8\n'),
    () => writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho provision v2\n'),
    () => writeFileSync(join(s.def, 'images.txt'), '# none yet, but a new comment\n'),
    () => writeFileSync(join(s.shared, 'git.sh'), '#!/bin/bash\necho a new git\n'),
    () => { const f = join(s.dir, 'projects', 'p', 'project.json'), j = JSON.parse(readFileSync(f, 'utf8')); j.repositories.push({ url: 'https://github.com/o/new' }); writeFileSync(f, JSON.stringify(j)); },
  ];
  for (const change of changes) {
    change();
    s.reset();
    await s.build();
    assert.equal(s.calls()[0], 'create golden-p-build template.yaml');
    assert.deepEqual(s.calls().slice(-2), ['delete -f golden-p', 'rename golden-p-build golden-p']);   // the old image goes only once the new one is complete
    hashes.add(s.label().hash);
  }
  assert.equal(hashes.size, changes.length + 1);
});

test('tokens for private clones reach the VM on stdin only, never a command line', async () => {
  const s = setup({ warm: true });
  await s.build();
  assert.equal(s.logOf('stdin.repositories.sh'), `${GH}\n${GL}\n`);
  assert.equal(s.logOf('stdin.warm.sh'), `${GH}\n${GL}\n`);
  assert.equal(s.logOf('glab'), 'auth status\nconfig get token --host gitlab.com\n');   // an API call first, which refreshes an expired OAuth token
  for (const t of [GH, GL]) assert.ok(!s.logOf('limactl').includes(t));
  assert.ok(!readFileSync(join(s.lima, 'golden-p', 'golden-image.json'), 'utf8').includes(GH));
});

test('ASS-123 AC1: an expired glab or gh login fails the build at once, saying so, and hands nothing to the VM', async () => {
  for (const [extra, tool] of [[{ GLAB_LOGGED_OUT: '1' }, 'glab'], [{ GH_LOGGED_OUT: '1' }, 'gh']]) {
    const s = setup();
    await assert.rejects(s.build(extra), e => e.stderr.includes(`vm:build-golden: ${tool} is not authenticated`));
    assert.deepEqual(s.calls(), []);
    assert.doesNotMatch(s.logOf('glab'), /config get token/);
  }
});

test('with images to bake in and the project\'s zot down, it fails before creating anything', async () => {
  const s = setup({ images: 'us-central1-docker.pkg.dev/x/y:1\n' });
  await assert.rejects(s.build(), e => /p's registry is not answering on 127\.0\.0\.1:5101.*registry:up p/.test(e.stderr));
  assert.deepEqual(s.calls(), []);
  assert.match(s.logOf('curl'), /http:\/\/127\.0\.0\.1:5101\/v2\//);
});

test('a failed step keeps the old image and keeps the build, stopped, for inspection; the next run deletes it first', async () => {
  const s = setup();
  await s.build();
  const label = s.label();
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  await assert.rejects(s.build({ FAIL_SCRIPT: 'repositories.sh' }), e => /repositories failed — see .*golden-image-build\.log; golden-p-build is stopped and kept for inspection/.test(e.stderr));
  assert.deepEqual(s.label(), label);
  assert.match(readFileSync(join(s.dir, 'projects', 'p', 'golden-image-build.log'), 'utf8'), /repositories\.sh broke/);
  s.reset();
  await s.build();
  assert.deepEqual(s.calls().slice(0, 2), ['delete -f golden-p-build', 'create golden-p-build template.yaml']);
});

// ASS-289 AC1/AC4: a failed golden build once left its VM running for hours, holding
// 10 GiB of RAM. A failed build's VM is stopped — not deleted — before vm:build-golden exits.
test('ASS-289 AC1: a failed build stops its VM before exiting, keeping it, and says how to start it for inspection; one already stopped, or never created, is not stopped again', async () => {
  const s = setup();
  const start = `LIMA_HOME=${esc(s.lima)} limactl start golden-p-build`;
  await assert.rejects(s.build({ FAIL_SCRIPT: 'repositories.sh' }), e => {
    assert.match(e.stderr, new RegExp(`vm:build-golden: repositories failed — see .*golden-image-build\\.log; golden-p-build is stopped and kept for inspection: start it with ${start}`));
    assert.equal(e.stderr.match(/inspection/g).length, 1, 'said once, though the step ran in a pipe\'s subshell');
    return true;
  });
  assert.equal(s.calls().at(-1), 'stop golden-p-build', s.calls().join('\n'));
  assert.equal(readFileSync(join(s.lima, 'golden-p-build', 'status'), 'utf8').trim(), 'Stopped');
  assert.ok(existsSync(join(s.lima, 'golden-p-build', 'disk')), 'kept, not deleted');

  s.reset();                                                                         // the scan fails: the build stopped itself already
  await assert.rejects(s.build({ LEAK: PAT }), e => new RegExp(`scan failed — see .*; golden-p-build is stopped and kept for inspection: start it with ${start}`).test(e.stderr));
  assert.equal(s.calls().filter(c => c === 'stop golden-p-build').length, 2, 'the build\'s own two stops, no third');

  s.reset();                                                                         // a stop that fails is said, with how to stop it
  await assert.rejects(s.build({ FAIL_SCRIPT: 'provision.sh', FAIL_STOP: 'golden-p-build' }), e =>
    new RegExp(`provision failed — see .*; golden-p-build could not be stopped: stop it with LIMA_HOME=${esc(s.lima)} limactl stop -f golden-p-build`).test(e.stderr));
  assert.deepEqual(s.calls().slice(-2), ['stop golden-p-build', 'stop -f golden-p-build']);
});

test('ASS-289 AC1: a build that fails before creating its VM stops nothing and names no VM to inspect', async () => {
  const s = setup({ images: 'us-central1-docker.pkg.dev/x/y:1\n' });
  await assert.rejects(s.build(), e => !/inspection/.test(e.stderr));
  assert.deepEqual(s.calls(), []);
});

test('AC5: build time and disk size are printed, recorded in the label and the build log', async () => {
  const s = setup();
  const { stdout } = await s.build();
  const label = s.label();
  assert.match(stdout, /built golden-p in 0m \d+s; \d+\.\d\d GiB on disk; inputs [0-9a-f]{12}/);
  assert.ok(Number.isInteger(label['build-seconds']) && label['disk-bytes'] > 0, JSON.stringify(label));
  assert.match(readFileSync(join(s.dir, 'projects', 'p', 'golden-image-build.log'), 'utf8'), /built golden-p in/);
});

test('a project with no images and no warm.sh skips those steps; one with no registry skips the mirror', async () => {
  const s = setup({ registry: false, repositories: ['https://github.com/o/harness'] });
  await s.build();
  const steps = s.calls().filter(c => c.startsWith('shell')).map(c => c.split(' ')[2]);
  assert.deepEqual(steps, ['provision.sh', 'git.sh', 'desktop.sh', 'repositories.sh', 'finish.sh']);
  assert.equal(s.logOf('stdin.repositories.sh'), `${GH}\n\n`);                     // no GitLab repository: no glab token read
});

test('AC2 (ASS-134): a project whose registry has no upstream, as the harness\'s, gets no mirror', async () => {
  const s = setup({ upstream: false, repositories: ['https://github.com/o/harness'] });
  await s.build();
  assert.deepEqual(s.calls().filter(c => c.startsWith('shell')).map(c => c.split(' ')[2]), ['provision.sh', 'git.sh', 'desktop.sh', 'repositories.sh', 'finish.sh']);
});

test('AC3: VMs live under LIMA_HOME', async () => {
  const s = setup();
  await s.build();
  assert.equal(s.logOf('lima-home'), `LIMA_HOME=${s.lima}\n`);
  assert.ok(existsSync(join(s.lima, 'golden-p', 'disk')));
});

test('a project without a golden-image definition, or a bad project, fails clearly', async () => {
  const s = setup();
  const f = join(s.dir, 'projects', 'p', 'project.json');
  writeFileSync(f, JSON.stringify({ name: 'P' }));
  await assert.rejects(s.build(), e => /p has no golden-image in project\.json/.test(e.stderr));
  writeFileSync(f, JSON.stringify({ 'golden-image': { folder: 'projects/p/missing' } }));
  await assert.rejects(s.build(), e => /no .*projects\/p\/missing\/template\.yaml/.test(e.stderr));
  await assert.rejects(run(AGENT, ['vm:build-golden', '../p'], { env: s.env }), e => /invalid project/.test(e.stderr));
  await assert.rejects(run(AGENT, ['vm:build-golden'], { env: s.env }), e => /usage/.test(e.stderr));
});

test('AC4: the build is scanned for the declared tokens and the gh and glab tokens it cloned with, and recorded only when none is found', async () => {
  const s = setup();
  const { stdout } = await s.build();
  const buildLog = () => readFileSync(join(s.dir, 'projects', 'p', 'golden-image-build.log'), 'utf8');
  assert.match(stdout, /vm:build-golden: scan \d+s/);
  assert.match(buildLog(), /no token found in .*golden-p-build \(gh, github, glab\)/);
  const label = s.label();
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  for (const [extra, kind] of [[{ LEAK_SCRIPT: 'repositories.sh' }, /glab's token .* is in .*golden-p-build\/disk/], [{ LEAK: PAT }, /github's token .* is in .*golden-p-build\/disk/]]) {
    await assert.rejects(s.build(extra), e => {
      assert.match(e.stderr, /scan failed — see .*golden-image-build\.log; golden-p-build is stopped and kept for inspection/);
      for (const t of [GH, GL, PAT]) assert.ok(!e.stdout.includes(t) && !e.stderr.includes(t) && !buildLog().includes(t), t);
      return true;
    });
    assert.match(buildLog(), kind);
    assert.deepEqual(s.label(), label);                                             // the old image stays; the leaky build is not recorded
    assert.ok(!existsSync(join(s.lima, 'golden-p-build', 'golden-image.json')));
  }
});

test('a project with no declared credentials, or an unreadable keychain item, fails before creating anything, naming every bad item', async () => {
  const s = setup();
  const creds = join(s.env.HOME, '.harness', 'vm-credentials.json');
  writeFileSync(creds, JSON.stringify({ other: {} }));
  await assert.rejects(s.build(), e => /declares no VM credentials for project 'p'/.test(e.stderr));
  assert.deepEqual(s.calls(), []);
  writeFileSync(creds, JSON.stringify({ p: { github: { 'keychain-service': 'GitHub PAT (Test)' }, claude: { 'keychain-service': 'Missing (Test)' }, gitlab: { 'keychain-service': 'Gone (Test)' } } }));
  await assert.rejects(s.build(), e => /"Missing \(Test\)".*\n.*"Gone \(Test\)"/.test(e.stderr) && !e.stderr.includes(PAT));
  assert.deepEqual(s.calls(), []);
});

// ASS-76 AC4: every project's image gets the shared desktop.sh; its VMs start with no display, so none opens a window on
// the Mac (Lima's vz opens one at start when video.display is "vz" or "default") until the Demo action starts it with one.
test('every project has a golden image, whose template starts its VMs with no display', () => {
  const data = join(import.meta.dirname, '..', '..', 'data');   // project.json's folder is relative to it
  for (const p of readdirSync(join(data, 'projects')).filter(p => existsSync(join(data, 'projects', p, 'project.json')))) {
    const folder = JSON.parse(readFileSync(join(data, 'projects', p, 'project.json'), 'utf8'))['golden-image']?.folder;
    assert.ok(folder, `${p} has a golden image`);
    assert.match(readFileSync(join(data, folder, 'template.yaml'), 'utf8'), /^video:\n  display: "none"$/m, p);
  }
});

// ASS-149 AC1: the label records the input lines it hashed, so vm:golden-stale can name what changed since.
test('ASS-149 AC1: the label records the hashed input lines — every definition and shared file by its sha256, each repository, the mirror — whose sha256 is its hash', async () => {
  const s = setup();
  await s.build();
  const { inputs, hash } = s.label();
  assert.ok(inputs.includes('repository https://github.com/o/harness') && inputs.includes('repository https://gitlab.com/g/example-project'), inputs.join('\n'));
  assert.ok(inputs.some(l => /^[0-9a-f]{64} {2}definition\/provision\.sh$/.test(l)) && inputs.some(l => /^[0-9a-f]{64} {2}shared\/git\.sh$/.test(l)), inputs.join('\n'));
  assert.ok(inputs.includes('server = "https://us-central1-docker.pkg.dev"'), inputs.join('\n'));
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(`${inputs.join('\n')}\n`).digest('hex'), hash);
});

// A lock held by another process, as a running vm:create's or build's would be, until release().
async function holdLock(file) {
  const { spawn } = await import('node:child_process');
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60', file]);
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return { release: () => holder.kill() };
}

test('ASS-149 AC3: the project\'s VM lock is held for the delete-and-rename swap only, not while the image builds', async () => {
  const s = setup();
  await s.build();
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  rmSync(join(s.dir, 'log', 'vm-lock'));
  await s.build();
  const locks = s.logOf('vm-lock').trim().split('\n');
  assert.deepEqual(locks.slice(-2), ['delete held', 'rename held']);
  assert.ok(locks.slice(0, -2).every(l => l.endsWith(' free')), locks.join('\n'));
});

test('ASS-149 AC3: the swap waits for the VM lock (a vm:create cloning golden-p); a second build of the project is refused while one runs; a running ticket VM is untouched', async () => {
  const s = setup();
  mkdirSync(join(s.lima, 'ass-1-a'));
  writeFileSync(join(s.lima, 'ass-1-a', 'disk'), 'running');
  const build = await holdLock(join(s.dir, 'projects', 'p', 'golden-build.lock'));
  await assert.rejects(s.build(), e => /vm:build-golden: golden-p is being built already/.test(e.stderr));
  assert.deepEqual(s.calls(), []);
  build.release();
  const vms = await holdLock(join(s.dir, 'projects', 'p', 'vms.lock'));
  await assert.rejects(s.build({ VM_LOCK_TIMEOUT: '1' }), e => /timed out waiting for the lock on .*vms\.lock/.test(e.stderr));
  assert.ok(!existsSync(join(s.lima, 'golden-p')) && existsSync(join(s.lima, 'golden-p-build')));   // built, never swapped in
  vms.release();
  await s.build();
  assert.ok(existsSync(join(s.lima, 'golden-p')));
  assert.equal(readFileSync(join(s.lima, 'ass-1-a', 'disk'), 'utf8'), 'running');
  assert.ok(!s.calls().some(c => c.includes('ass-1-a')), s.calls().join('\n'));
});

// vm:golden-stale (ASS-149 AC1): golden-<project> against its inputs now, as the health check (check-health-v2) reads it.
const stale = async s => JSON.parse((await run(AGENT, ['vm:golden-stale', 'p'], { env: s.env })).stdout);

test('ASS-149 AC1: vm:golden-stale leaves a current image alone: built from the inputs it has now, it is not stale', async () => {
  const s = setup();
  await s.build();
  assert.deepEqual(await stale(s), { project: 'p', image: 'golden-p', stale: false, hash: s.label().hash, 'built-hash': s.label().hash, 'built-at': s.label()['built-at'], why: [] });
});

test('ASS-149 AC1: a stale image names the inputs added, removed and changed since it was built, from the input lines it recorded', async () => {
  const s = setup({ warm: true });
  await s.build();
  const label = s.label();
  const f = join(s.dir, 'projects', 'p', 'project.json'), j = JSON.parse(readFileSync(f, 'utf8'));
  j.repositories.push({ url: 'https://github.com/o/new' });
  writeFileSync(f, JSON.stringify(j));
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho provision v2\n');
  rmSync(join(s.def, 'warm.sh'));
  const now = await stale(s);
  assert.equal(now.stale, true);
  assert.deepEqual([now['built-hash'], now['built-at']], [label.hash, label['built-at']]);
  assert.match(now.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(now.hash, label.hash);
  assert.deepEqual(now.why, ['added repository https://github.com/o/new', 'removed definition/warm.sh', 'changed definition/provision.sh']);
  s.reset();
  await s.build();                                                                  // the hash vm:golden-stale names is the one a build tags
  assert.equal(s.label().hash, now.hash);
});

test('ASS-149 AC1: an image built before the input list was recorded says only that its inputs changed since it was built; one never built says so', async () => {
  const s = setup();
  assert.deepEqual((await stale(s)).why, ['golden-p has not been built']);
  assert.equal((await stale(s)).stale, true);
  await s.build();
  const file = join(s.lima, 'golden-p', 'golden-image.json'), { inputs, ...old } = s.label();
  writeFileSync(file, JSON.stringify({ ...old, hash: 'f'.repeat(64) }));
  const now = await stale(s);
  assert.equal(now.stale, true);
  assert.deepEqual(now.why, [`inputs changed since ${old['built-at']}; this build recorded no input list`]);
  writeFileSync(file, JSON.stringify(old));                                        // its hash still current: not stale, list or none
  assert.equal((await stale(s)).stale, false);
});

// ASS-151: a fast-tracked rebuild ticket's agent starts the build from its VM
// (vm:build-golden-start, through the forwarder) and checks it
// (vm:golden-status). The build runs detached on the Mac, with the fakes.
const golden = async (s, command, env = {}) => JSON.parse((await run(AGENT, [command, 'p'], { env: { ...s.env, ...env } })).stdout);
const LOGS = s => ({ log: join(s.dir, 'projects', 'p', 'golden-image-build.log'), 'run-log': join(s.dir, 'projects', 'p', 'golden-build-run.log') });
// A limactl that holds `create` until <dir>/go exists, then is the fake: a build held part way.
function gated(s) {
  const bin = join(s.dir, 'gate');
  mkdirSync(bin);
  writeFileSync(join(bin, 'limactl'), `#!/usr/bin/env bash\n[[ "$1" != create ]] || until [[ -e '${s.dir}/go' ]]; do sleep 0.05; done\nexec '${s.dir}/bin/limactl' "$@"\n`);
  chmodSync(join(bin, 'limactl'), 0o755);
  return { PATH: `${bin}:${s.env.PATH}` };
}

test('ASS-151 AC3: vm:golden-status says current for an image built from its inputs now; failed, no exit code, for one never built or stale with no build running; building while a build holds the lock — each with the logs', async () => {
  const s = setup();
  assert.deepEqual(await golden(s, 'vm:golden-status'), { project: 'p', image: 'golden-p', status: 'failed', 'exit-code': null, ...LOGS(s) });
  await s.build();
  assert.deepEqual(await golden(s, 'vm:golden-status'), { project: 'p', image: 'golden-p', status: 'current', 'exit-code': null, ...LOGS(s) });
  const held = await holdLock(join(s.dir, 'projects', 'p', 'golden-build.lock'));   // a build started by hand
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  try { assert.equal((await golden(s, 'vm:golden-status')).status, 'building'); } finally { held.release(); }
  await assert.rejects(run(AGENT, ['vm:golden-status', 'nope'], { env: s.env }), e => /no project nope/.test(e.stderr));
});

test('ASS-151 AC3: vm:build-golden-start starts the build detached and returns at once — building until it ends, then current; started again while it runs, or once current, it does nothing', async () => {
  const s = setup(), gate = gated(s);
  const started = Date.now();
  assert.deepEqual(await golden(s, 'vm:build-golden-start', gate), { project: 'p', image: 'golden-p', status: 'building', started: true, 'exit-code': null, ...LOGS(s) });
  assert.ok(Date.now() - started < 10_000, 'returned while the build waits');
  assert.equal((await golden(s, 'vm:golden-status')).status, 'building');
  assert.deepEqual(await golden(s, 'vm:build-golden-start', gate), { project: 'p', image: 'golden-p', status: 'building', started: false, 'exit-code': null, ...LOGS(s) });
  writeFileSync(join(s.dir, 'go'), '');
  assert.ok(await untilBuilt(() => existsSync(join(s.lima, 'golden-p', 'golden-image.json'))), 'built');
  assert.ok(await untilBuilt(() => existsSync(join(s.dir, 'projects', 'p', 'golden-build-run.exit'))));
  assert.deepEqual(await golden(s, 'vm:golden-status'), { project: 'p', image: 'golden-p', status: 'current', 'exit-code': 0, ...LOGS(s) });
  assert.equal(s.calls().filter(c => c.startsWith('create ')).length, 1, 'one build');
  s.reset();
  assert.deepEqual(await golden(s, 'vm:build-golden-start'), { project: 'p', image: 'golden-p', status: 'current', started: false, 'exit-code': 0, ...LOGS(s) });
  assert.deepEqual(s.calls(), []);
  assert.match(readFileSync(LOGS(s)['run-log'], 'utf8'), /vm:build-golden: built golden-p/);
});

test('vm:build-golden-start run several times at once starts one build (ASS-179 AC2): one start runs at a time, the rest find it building; the build holds no start lock', async () => {
  const s = setup(), gate = gated(s);
  const starts = await Promise.all(Array.from({ length: 4 }, () => golden(s, 'vm:build-golden-start', gate)));
  assert.deepEqual(starts.map(r => r.started).toSorted(), [false, false, false, true]);
  assert.ok(starts.every(r => r.status === 'building'));
  assert.equal((await golden(s, 'vm:build-golden-start', gate)).started, false, 'a start while it builds does not wait on the build');
  writeFileSync(join(s.dir, 'go'), '');
  assert.ok(await untilBuilt(() => existsSync(join(s.dir, 'projects', 'p', 'golden-build-run.exit'))));
  assert.equal(s.calls().filter(c => c.startsWith('create ')).length, 1, 'one build');
});

test('ASS-151 AC3: a build started that fails is reported failed, with its exit code and logs; the next start builds again', async () => {
  const s = setup();
  assert.equal((await golden(s, 'vm:build-golden-start', { FAIL_SCRIPT: 'provision.sh' })).started, true);
  assert.ok(await untilBuilt(() => existsSync(join(s.dir, 'projects', 'p', 'golden-build-run.exit'))));
  assert.deepEqual(await golden(s, 'vm:golden-status'), { project: 'p', image: 'golden-p', status: 'failed', 'exit-code': 1, ...LOGS(s) });
  assert.match(readFileSync(LOGS(s)['run-log'], 'utf8'), /provision failed/);
  assert.equal((await golden(s, 'vm:build-golden-start')).started, true);
  assert.ok(await untilBuilt(() => existsSync(join(s.dir, 'projects', 'p', 'golden-build-run.exit'))));
  assert.deepEqual(await golden(s, 'vm:golden-status'), { project: 'p', image: 'golden-p', status: 'current', 'exit-code': 0, ...LOGS(s) });
});

// ASS-229 AC1: a project's golden image has the build tools its project.json declares ("golden-image".tools):
// right after provision.sh, each is checked on the build VM's PATH, and one missing fails the build, naming it, before the long steps.
test('ASS-229 AC1: the tools project.json declares are checked on the VM\'s PATH after provision; one missing fails the build, naming it; none declared, no check', async () => {
  const s = setup({ tools: ['bash', 'jq'] });
  await s.build({ RUN_SCRIPT: 'tools' });
  assert.deepEqual(s.calls().slice(2, 4), ['shell golden-p-build provision.sh ', 'shell golden-p-build tools bash jq']);
  const t = setup({ tools: ['bash', 'no-such-tool-229', 'nor-this-229'] });
  await assert.rejects(t.build({ RUN_SCRIPT: 'tools' }), e => /vm:build-golden: tools failed — see .*golden-image-build\.log/.test(e.stderr));
  const log = readFileSync(join(t.dir, 'projects', 'p', 'golden-image-build.log'), 'utf8');
  assert.match(log, /no-such-tool-229 is not on PATH/);
  assert.match(log, /nor-this-229 is not on PATH/);
  assert.ok(!t.calls().some(c => c.includes('repositories.sh')), t.calls().join('\n'));
  const u = setup();
  await u.build();
  assert.ok(!u.calls().some(c => c.includes(' tools')), u.calls().join('\n'));
});

// ASS-234 AC4: the one credential kind whose tool runs in a VM — claude, for the claude or anthropic credential — is
// checked with the declared tools (ASS-229), once; forge and Jira tools (gh, glab, acli) run on the host, never checked.
test('ASS-234 AC4: vm:build-golden checks claude on the VM\'s PATH when claude or anthropic is declared; missing, it fails the build, naming it', async () => {
  const s = setup({ tools: ['jq'] });
  writeFileSync(join(s.dir, 'home', '.harness', 'vm-credentials.json'), JSON.stringify({ p: {
    claude: { 'keychain-service': 'GitHub PAT (Test)' }, anthropic: { 'keychain-service': 'GitHub PAT (Test)' }, github: { 'keychain-service': 'GitHub PAT (Test)' },
    gitlab: { 'keychain-service': 'GitHub PAT (Test)' }, git: { 'user-name': 'T', 'user-email': 't@example.com' } } }));
  const PATH = s.env.PATH.split(':').filter(d => !existsSync(join(d, 'claude'))).join(':');   // the tools check runs here: no claude of the Mac's
  await assert.rejects(s.build({ RUN_SCRIPT: 'tools', PATH }), e => /vm:build-golden: tools failed/.test(e.stderr));
  assert.ok(s.calls().includes('shell golden-p-build tools jq claude'), s.calls().join('\n'));
  assert.match(readFileSync(join(s.dir, 'projects', 'p', 'golden-image-build.log'), 'utf8'), /claude is not on PATH/);
  assert.ok(!s.calls().some(c => c.includes('repositories.sh')));
});

// ASS-234 AC3: a build marked a fix (vm:build-golden <project> --fix <what>) records it in its label, as fix and fixed-at
// (its built-at); later builds carry the last fix on, so vm:create knows a VM cloned before it.
test('ASS-234 AC3: vm:build-golden --fix records the fix in the label; a later build carries it on', async () => {
  const s = setup();
  await s.build();
  assert.equal(s.label().fix, undefined);
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho provision, with claude\n');
  await run(AGENT, ['vm:build-golden', 'p', '--fix', 'claude installed'], { env: s.env });
  const fixed = s.label();
  assert.equal(fixed.fix, 'claude installed');
  assert.equal(fixed['fixed-at'], fixed['built-at']);
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho provision v3\n');
  await s.build();
  assert.notEqual(s.label().hash, fixed.hash);
  assert.deepEqual([s.label().fix, s.label()['fixed-at']], [fixed.fix, fixed['fixed-at']]);
  await assert.rejects(run(AGENT, ['vm:build-golden', 'p', '--fix'], { env: s.env }), /usage: vm:build-golden <project> \[--fix <what it fixed>\]/);
});

// ASS-287 AC1: a rebuild deleted the old golden-p, but its blocks stayed allocated on APFS while any VM cloned from it
// referenced them — each rebuild pinned a whole generation. Now, once the new image is swapped in, under the VM lock, every
// one of p's VMs cloned from an older generation (its golden-image.json's generation not the new image's) is deleted while it
// is stopped and its variation is not in flight; a running or in-flight one is kept, never touched, and named. ASS-291:
// generations were told apart by built-at, whole seconds, and two builds in one second (this test's, on a fast run) looked
// like one, nothing deleted; each build's label now has a generation id of its own, so here both builds share a built-at
// (builtAt) and the old generation is still told apart. clone(s,
// vm, status) makes vm an APFS clone (cp -c) of golden-p's disk with its label, as vm:create does; one of p's when listed
// in its vms.json.
function clone(s, vm, status = 'Stopped') {
  mkdirSync(join(s.lima, vm));
  execFileSync('cp', ['-c', join(s.lima, 'golden-p', 'disk'), join(s.lima, vm, 'disk')]);
  cpSync(join(s.lima, 'golden-p', 'golden-image.json'), join(s.lima, vm, 'golden-image.json'));
  writeFileSync(join(s.lima, vm, 'status'), status);
}
const ofP = (s, ...vms) => writeFileSync(join(s.dir, 'projects', 'p', 'vms.json'), JSON.stringify(Object.fromEntries(vms.map((vm, i) => [vm, { ticket: vm.slice(0, -2).toUpperCase(), variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': `2026-10-0${i + 1}T00:00:00Z` }]))));
const privateSize = (s, file) => execFileSync(join(s.home, '.harness', 'bin', 'private-size'), [file], { encoding: 'utf8' }).trim().split(' ').map(Number);

test('ASS-287 AC1: a rebuild deletes p\'s stopped VMs cloned from the old generation, whose variation is not in flight, so it no longer occupies disk; a running one is kept and named, another project\'s untouched', async () => {
  const s = setup({ builtAt: '2026-11-07T12:00:00Z' });
  await s.build();
  const { 'built-at': old, generation } = s.label();
  assert.match(generation, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  clone(s, 'ass-1-a'); clone(s, 'ass-2-a', 'Running');
  mkdirSync(join(s.lima, 'xyz-1-a')); writeFileSync(join(s.lima, 'xyz-1-a', 'disk'), 'another project\'s');
  ofP(s, 'ass-1-a', 'ass-2-a');
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  s.reset();
  const { stdout } = await s.build();
  assert.deepEqual([s.label()['built-at'], s.label().generation === generation], [old, false], 'one built-at, two generations');
  assert.deepEqual(s.calls().slice(-3), ['delete -f golden-p', 'rename golden-p-build golden-p', 'delete -f ass-1-a']);
  assert.match(stdout, new RegExp(`vm:build-golden: deleted ass-1-a \\(ASS-1 A, cloned from golden-p of ${old}, [\\d.]+ GB\\)`));
  assert.match(stdout, new RegExp(`vm:build-golden: kept ass-2-a \\(ASS-2 A, cloned from golden-p of ${old}, [\\d.]+ GB\\): running`));
  assert.deepEqual(['ass-1-a', 'ass-2-a', 'xyz-1-a'].map(vm => existsSync(join(s.lima, vm))), [false, true, true]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.dir, 'projects', 'p', 'vms.json'), 'utf8'))), ['ass-2-a']);
  const [own, all] = privateSize(s, join(s.lima, 'ass-2-a', 'disk'));
  assert.equal(own, all, 'the kept clone shares no block with a deleted generation\'s other clones');
  assert.deepEqual(s.logOf('vm-lock').trim().split('\n').slice(-3), ['delete held', 'rename held', 'delete held']);
});

test('ASS-287 AC3: a build with less free space on LIMA_HOME\'s volume than golden-p\'s size deletes p\'s deletable VMs first; when that cannot free enough it fails before creating anything, naming the shortfall', async () => {
  const s = setup();
  await s.build();
  clone(s, 'ass-2-a', 'Running'); ofP(s, 'ass-2-a');
  writeFileSync(join(s.def, 'provision.sh'), '#!/bin/bash\necho v2\n');
  const used = () => Number(execFileSync('du', ['-sk', s.lima], { encoding: 'utf8' }).split('\t')[0]);
  s.reset();
  await assert.rejects(s.build({ DF_CAPACITY_K: String(used() + 1) }), e => /vm:build-golden: the volume holding .* has [\d.]+ GB free, and golden-p-build needs [\d.]+ GB \(golden-p's size\): [\d.]+ GB short; nothing more of p's VMs may be deleted/.test(e.stderr));
  assert.deepEqual(s.calls(), [], 'nothing deleted, nothing created');
  clone(s, 'ass-1-a'); writeFileSync(join(s.lima, 'ass-1-a', 'disk'), randomBytes(8 * 4096));   // 32 KiB of its own
  ofP(s, 'ass-1-a', 'ass-2-a');
  const { stderr } = await s.build({ DF_CAPACITY_K: String(used() + 1) });         // 1 KiB free, golden-p's 4 KiB needed: deleting ass-1-a frees enough
  assert.match(stderr, /vm:build-golden: deleted ass-1-a \(ASS-1 A, last accessed 2026-10-01T00:00:00Z, [\d.]+ GB\) to make room on the volume holding/);
  assert.equal(s.calls()[0], 'delete -f ass-1-a');
  assert.ok(existsSync(join(s.lima, 'ass-2-a')));
});
