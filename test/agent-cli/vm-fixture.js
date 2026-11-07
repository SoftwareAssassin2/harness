// A Lima for the vm:* commands' tests (ASS-74, ASS-75): the agent-cli fixture
// (harness-fixture.js) and a fake Lima (test/support/fake-vm.js) set up as
// the Mac that runs vm:create sees it — see lima().
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// Project p with two repositories (one on main, one on master), its zot on 5101; harness.json's forwarder on 7787 and
// VM disk limit 100 GB; golden-p built (no disk: it charges a new VM nothing);
// in the VM's root a clone of each at /repos/<basename>, the ticket's folder "mounted" at /mnt/ticket.
// LIMA_HOME is the fake's instances folder, and `df` a fake (ASS-287) for the volume holding it: its free space
// volume(kib) KiB less what the instances take now (du), so deleting a VM frees what it held; ample by default.
// The folder df was asked about is kept in <v.dir>/df-path.
export function lima() {
  const f = fixture(), v = fakeVm(f.env);
  const at = (...rest) => join(f.dir, ...rest);
  const origins = {};
  for (const [name, branch] of [['harness', 'main'], ['example-corpus', 'master']]) {
    const work = mkdtempSync(join(tmpdir(), 'origin-'));
    execFileSync('git', ['init', '-q', `--initial-branch=${branch}`, work]);
    git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
    writeFileSync(join(work, 'README.md'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one');
    mkdirSync(join(v.root, 'repos'), { recursive: true });
    execFileSync('git', ['clone', '-q', work, join(v.root, 'repos', name)]);   // as the golden image holds it
    git(work, 'commit', '-q', '--allow-empty', '-m', 'two');                    // master moved on since
    origins[name] = { work, branch };
  }
  edit(at('projects', 'p', 'project.json'), p => {
    p.repositories = [{ url: 'https://github.com/o/harness', description: 'h' }, { url: 'https://gitlab.com/g/example-corpus.git', description: 'c' }];
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 1, port: 5101 };
  });
  edit(at('harness.json'), h => { h['forwarder-port'] = 7787; h['vm-disk-limit-gb'] = 100; });
  v.instance('golden-p');
  const home = join(v.dir, 'home');
  mkdirSync(join(home, '.harness'), { recursive: true });
  writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify({ p: { claude: { 'keychain-service': 'Claude Token (Test)' } } }));
  v.script('security', 'echo sk-ant-oat01-TEST');
  v.script('sandbox-exec', `[[ "$1" == -p ]] || exit 2; printf '%s\\n' "$2" > "${v.dir}/sandbox-profile"; shift 2; exec "$@"`);
  const volume = kib => writeFileSync(join(v.dir, 'volume-k'), String(kib));
  volume(1e12);
  v.script('df', `printf '%s\\n' "\${@: -1}" > '${v.dir}/df-path'; cap=$(cat '${v.dir}/volume-k'); used=$(du -sk '${v.instances}' | cut -f1)
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "/dev/fake $cap $used $((cap - used)) 1% /"`);
  v.inVm('sudo', 'exec "$@"');
  v.inVm('findmnt', 'echo tmpfs');
  v.inVm('mountpoint', '[[ "$1" == -q && -d "$2" ]]');
  v.inVm('ip', `echo "3: lima0    inet $(cat "${v.dir}/ip" 2>/dev/null || echo 192.168.64.15)/24 metric 100 brd 192.168.64.255 scope global dynamic lima0"`);
  for (const d of ['run', join('etc', 'profile.d'), join('usr', 'local', 'bin')]) mkdirSync(join(v.root, d), { recursive: true });
  // The fake keychain answers at once, but on a busy machine starting it took up to ~10s (ASS-109).
  const env = { ...v.env, LIMA_HOME: v.instances, HOME: home, HARNESS_HOME: join(home, '.harness'), VM_KEYCHAIN_TIMEOUT: '60' };
  const cli = (...args) => run(AGENT, args, { env });
  mkdirSync(at('projects', 'p', 'work', 'ABC-3'), { recursive: true });
  const folder = realpathSync(at('projects', 'p', 'work', 'ABC-3'));
  const mount = () => { mkdirSync(join(v.root, 'mnt'), { recursive: true }); rmSync(join(v.root, 'mnt', 'ticket'), { force: true, recursive: true }); execFileSync('ln', ['-s', folder, join(v.root, 'mnt', 'ticket')]); };
  const tokens = () => JSON.parse(readFileSync(join(home, '.harness', 'vm-tokens.json'), 'utf8'));
  return { f, v, env, cli, origins, folder, mount, tokens, home, volume, vmFile: (...p) => join(v.root, ...p) };
}

