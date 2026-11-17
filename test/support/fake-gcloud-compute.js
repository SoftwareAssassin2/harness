// fake-gcloud.js's cloud VMs (ASS-481): `gcloud [--quiet] [--verbosity=…]
// compute instances <describe|start|resume> <id> --zone=… --project=… …`,
// `gcloud compute start-iap-tunnel <id> 22 --listen-on-stdin --zone=… --project=…`
// and `gcloud config get-value account`, as a plain Compute Engine VM looks
// from the Mac. Imported by fake-gcloud.js (which has logged the call); it
// exits itself.
// - Each VM is a folder $FAKE_WS_DIR/<id> (fake-workstation.js cloudVm)
//   holding `status`: RUNNING, TERMINATED, SUSPENDED, STOPPING, SUSPENDING,
//   STAGING; none: NOT_FOUND. STOPPING moves on to TERMINATED, SUSPENDING to
//   SUSPENDED and STAGING to RUNNING once `describe` has been asked as often
//   as its `settle` file says (1 without).
// - `start` (only TERMINATED) makes it STAGING, with a new `boot-id` and its
//   `run` folder emptied (a boot: only /dev/shm is lost, the disk is kept);
//   `resume` (only SUSPENDED) makes it STAGING, its boot kept. --async or not,
//   each returns at once.
// - `start-iap-tunnel` (only RUNNING; else "failed to connect to backend")
//   writes the guest's SSH banner and waits for its stdin to end — unless
//   the VM's `ssh-wait` file holds a count above 0 (the guest still booting:
//   each tunnel lowers it and fails), or a `no-banner` file is there (sshd
//   never answers).
// - `config get-value account` prints $FAKE_GCLOUD_ACCOUNT
//   (ada.lovelace@example.com without).
// $FAKE_WS_DIR/expired and offline fail every call as fake-gcloud.js's do.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2), words = args.filter(a => !a.startsWith('--'));
const dir = process.env.FAKE_WS_DIR ?? '/nonexistent';
const die = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code); };
if (words[0] === 'config') {
  if (words[1] === 'get-value' && words[2] === 'account') { console.log(process.env.FAKE_GCLOUD_ACCOUNT ?? 'ada.lovelace@example.com'); process.exit(0); }
  die(`fake gcloud: unknown command ${args.join(' ')}`);
}
const tunnel = words[1] === 'start-iap-tunnel';
const sub = tunnel ? 'start-iap-tunnel' : words[2], id = tunnel ? words[2] : words[3];
if (!tunnel && words[1] !== 'instances') die(`fake gcloud: unknown command ${args.join(' ')}`);
if (existsSync(join(dir, 'expired'))) die(`ERROR: (gcloud.compute.${sub}) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login`);
if (existsSync(join(dir, 'offline'))) die(`ERROR: (gcloud.compute.${sub}) There was a problem refreshing your current auth tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by NameResolutionError("<urllib3.connection.HTTPSConnection object>: Failed to resolve 'oauth2.googleapis.com'"))`);
const vm = join(dir, id ?? '');
if (!id || !existsSync(join(vm, 'status'))) die(`ERROR: (gcloud.compute.instances.${sub}) Could not fetch resource:\n - The resource 'projects/p/zones/z/instances/${id}' was not found`);
const status = () => readFileSync(join(vm, 'status'), 'utf8').trim();
const setStatus = s => writeFileSync(join(vm, 'status'), s);
const NEXT = { STOPPING: 'TERMINATED', SUSPENDING: 'SUSPENDED', STAGING: 'RUNNING' };

if (sub === 'describe') {
  const s = status();
  if (NEXT[s]) {
    const left = existsSync(join(vm, 'settle')) ? Number(readFileSync(join(vm, 'settle'), 'utf8')) : 1;
    if (left <= 1) { rmSync(join(vm, 'settle'), { force: true }); setStatus(NEXT[s]); } else writeFileSync(join(vm, 'settle'), String(left - 1));
  }
  console.log(s);
  process.exit(0);
} else if (sub === 'start' || sub === 'resume') {
  const want = sub === 'start' ? 'TERMINATED' : 'SUSPENDED';
  if (status() !== want) die(`ERROR: (gcloud.compute.instances.${sub}) The instance '${id}' is ${status()}, not ${want}`);
  setStatus('STAGING');
  if (sub === 'start') { writeFileSync(join(vm, 'boot-id'), randomUUID()); rmSync(join(vm, 'run'), { recursive: true, force: true }); }
  console.error(`${sub === 'start' ? 'Starting' : 'Resuming'} instance(s) ${id}...`);
  process.exit(0);
} else if (sub === 'start-iap-tunnel') {
  const wait = existsSync(join(vm, 'ssh-wait')) ? Number(readFileSync(join(vm, 'ssh-wait'), 'utf8')) : 0;
  if (status() !== 'RUNNING' || wait > 0 || existsSync(join(vm, 'no-banner'))) {
    if (wait > 0 && status() === 'RUNNING') writeFileSync(join(vm, 'ssh-wait'), String(wait - 1));
    die("ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4003: 'failed to connect to backend'].");
  }
  process.stdout.write('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13 (fake)\r\n');
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
} else die(`fake gcloud: unknown command ${args.join(' ')}`);
