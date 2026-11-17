// fake-ssh.js's master for a cloud VM (ASS-481): `ssh -M -S <socket> -N -T …
// -o ProxyCommand=<gcloud compute start-iap-tunnel …> -l <user> -R … cloud-vm-<id>`,
// as agent-cli/cloud-vm.bash cvm_open runs it. The VM is fake-gcloud-compute.js's
// folder $FAKE_WS_DIR/<id>. Its flags (every argument before the host) are
// written to the folder's `ssh-flags` (JSON), and its CLOUDSDK_CONFIG (the
// ProxyCommand's) to `ssh-config`. It answers only while the VM is RUNNING
// with its sshd up (no `ssh-wait` count above 0, no `no-banner`): else it
// fails as ssh does when the tunnel closes (255). A `refuse-forward` file
// fails it as ExitOnForwardFailure does. Then, as fake-gcloud.js's
// workstation master: a unix socket server at <socket> (fake-ssh.js's -O
// check and -O exit, and its sessions, ask it) up until -O exit, a SIGTERM,
// the VM leaving RUNNING or a `drop` file in its folder (removed as it drops).
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export function becomeMaster(args, socket, host) {
  const die = (text, code = 255) => { process.stderr.write(`${text}\n`); process.exit(code); };
  const id = String(host).replace(/^cloud-vm-/, ''), vm = join(process.env.FAKE_WS_DIR ?? '/nonexistent', id);
  if (!existsSync(join(vm, 'status'))) die(`ssh: Could not resolve hostname ${host}: the fake has no such VM`);
  writeFileSync(join(vm, 'ssh-flags'), JSON.stringify(args.slice(0, args.indexOf(host))));
  writeFileSync(join(vm, 'ssh-config'), process.env.CLOUDSDK_CONFIG ?? '');
  const status = () => readFileSync(join(vm, 'status'), 'utf8').trim();
  const wait = existsSync(join(vm, 'ssh-wait')) ? Number(readFileSync(join(vm, 'ssh-wait'), 'utf8')) : 0;
  if (status() !== 'RUNNING' || wait > 0 || existsSync(join(vm, 'no-banner'))) die('kex_exchange_identification: Connection closed by remote host');
  if (existsSync(join(vm, 'refuse-forward'))) die('Error: remote port forwarding failed for listen port 7787');
  if (!socket) die('fake ssh: a master needs -S <socket>', 2);
  mkdirSync(join(vm, 'home'), { recursive: true });
  let done = false;
  const server = createServer(conn => conn.setEncoding('utf8').on('data', line => {
    conn.end('ok\n');
    if (line.trim() === 'exit') end(0);
  }));
  const end = code => { if (done) return; done = true; server.close(); rmSync(socket, { force: true }); process.exit(code); };
  server.listen(socket);
  process.on('SIGTERM', () => end(143));
  setInterval(() => {
    if (existsSync(join(vm, 'drop'))) { rmSync(join(vm, 'drop')); end(255); }
    if (status() !== 'RUNNING') end(255);
  }, 100);
  return new Promise(() => {});
}
