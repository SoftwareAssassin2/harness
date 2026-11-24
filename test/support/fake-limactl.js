#!/usr/bin/env node
// A stand-in for `limactl` in the tests (ASS-74), as Lima looks from the Mac.
// Every call is appended to $FAKE_LIMACTL_LOG as a JSON line: { vm, workdir,
// argv } for a shell, { argv } for anything else.
// - `shell [--workdir <dir>] <vm> -- <argv…>` runs argv here in a session of
//   its own, stdio passed through and its exit code returned — so, as with a
//   real VM, a SIGTERM to this process's group never reaches it: this process
//   just dies (ASS-69). It runs in $FAKE_VM_ROOT/<dir> (made if missing), with
//   HARNESS_VM_ROOT=$FAKE_VM_ROOT (the in-VM scripts' stand-in for the VM's
//   root) and $FAKE_VM_BIN (commands "in the VM") first on its PATH. With an
//   `unreachable` marker in the instance's folder (ASS-169) it prints ssh's
//   "Connection refused" line and exits 255 instead, as a VM whose sshd is
//   not yet up does.
// - Instances are folders in $FAKE_LIMA_INSTANCES holding `status` and
//   `ssh-port` (and whatever disk files a test writes): `list --format <f>`
//   prints <f> for each, `list <vm> --format <f>` for one (exit 1 when there
//   is none), <f>'s {{.Name}}, {{.Status}}, {{.SSHLocalPort}}, {{.Dir}} (the
//   folder) and {{.Config.Video.Display}} (its `display`, none by default)
//   filled; `edit --tty=false <vm> --set '.video.display = "<d>"'` writes
//   <d> to `display`, and `--set '.ssh.localPort = <p>'` pins <p>; `clone
//   --tty=false <from> <to> --set <expr>` makes one, Stopped, with the
//   expression in `set` and the ssh port it pins (exit 1 when <from> is
//   missing) — a pinned port in `ssh-port` and, as Lima has it, in the
//   instance's lima.yaml (ssh.localPort, ASS-467); a list skips names
//   starting . or _, as Lima does; `start --tty=false <vm>` makes it Running, `stop` Stopped,
//   `delete -f` removes it; `copy -r <from> <to>` copies a file or folder,
//   either side `<vm>:<path>`, the path under $FAKE_VM_ROOT (ASS-432; exit 1
//   when the instance or the source is missing).
// - ASS-577: with FAKE_LIMA_REFUSE_STOPPED=1, a `shell` or `copy` into an
//   instance whose status is not Running fails as Lima's does (exit 1, its
//   "is stopped, run `limactl start …`" line), and `shell` into a missing one too.
// Under test/support/, which npm test's pattern leaves alone.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const log = entry => { if (process.env.FAKE_LIMACTL_LOG) appendFileSync(process.env.FAKE_LIMACTL_LOG, `${JSON.stringify(entry)}\n`); };
const instances = process.env.FAKE_LIMA_INSTANCES ?? '/nonexistent';
const at = (vm, file) => join(instances, vm, file);
const read = (vm, file) => readFileSync(at(vm, file), 'utf8').trim();
const positional = args.slice(1).filter(a => !a.startsWith('-'));
// pin(vm, port) — the ssh port it pins: `ssh-port`, and ssh.localPort in its lima.yaml (ASS-467), as Lima keeps it.
const pin = (vm, port) => {
  writeFileSync(at(vm, 'ssh-port'), String(port));
  writeFileSync(at(vm, 'lima.yaml'), `vmType: vz\nssh:\n  localPort: ${port}\n  loadDotSSHPubKey: false\n`);
};

// refuseStopped(vm) — ASS-577: as Lima refuses a shell or copy into an instance that is not running (opt-in, above).
function refuseStopped(vm) {
  if (process.env.FAKE_LIMA_REFUSE_STOPPED !== '1') return;
  if (!existsSync(join(instances, vm))) { console.error(`time="x" level=fatal msg="instance \`${vm}\` does not exist, run \`limactl create ${vm}\` to create a new instance"`); process.exit(1); }
  if (read(vm, 'status') !== 'Running') { console.error(`time="x" level=fatal msg="instance \`${vm}\` is stopped, run \`limactl start ${vm}\` to start the instance"`); process.exit(1); }
}

if (args[0] === 'shell') {
  let i = 1, workdir = null;
  if (args[i] === '--workdir') { workdir = args[i + 1]; i += 2; }
  const vm = args[i], argv = args.slice(args.indexOf('--', i) + 1);
  log({ vm, workdir, argv });
  refuseStopped(vm);
  if (existsSync(at(vm, 'unreachable'))) {
    console.error(`ssh: connect to host 127.0.0.1 port ${read(vm, 'ssh-port')}: Connection refused`);
    process.exit(255);
  }
  const root = process.env.FAKE_VM_ROOT ?? process.cwd(), cwd = join(root, workdir ?? '');
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, HARNESS_VM_ROOT: root, PATH: `${process.env.FAKE_VM_BIN ? `${process.env.FAKE_VM_BIN}:` : ''}${process.env.PATH}` };
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'inherit' });
  child.on('error', () => process.exit(127));
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (signal === 'SIGTERM' ? 15 : 9)));
  process.on('SIGTERM', () => process.exit(143));
} else {
  log({ argv: args });
  const [command] = args, format = args[args.indexOf('--format') + 1];
  if (command === 'list') {
    const [vm] = positional.filter(a => a !== format);
    const fields = name => ({ Name: name, Status: read(name, 'status'), SSHLocalPort: read(name, 'ssh-port'), Dir: join(instances, name), 'Config.Video.Display': existsSync(at(name, 'display')) ? read(name, 'display') : 'none' });
    const render = name => format.replace(/\{\{\.([\w.]+)\}\}/g, (_, field) => fields(name)[field] ?? '');
    if (vm === undefined) {
      if (existsSync(instances)) for (const name of readdirSync(instances)) if (!/^[._]/.test(name)) console.log(render(name));
    } else {
      if (!existsSync(join(instances, vm))) { console.error(`No instance matching ${vm} found.`); process.exit(1); }
      console.log(render(vm));
    }
  } else if (command === 'clone') {
    const [from, to] = positional, expr = args[args.indexOf('--set') + 1];
    if (!existsSync(join(instances, from))) { console.error(`instance ${from} not found`); process.exit(1); }
    mkdirSync(join(instances, to), { recursive: true });
    writeFileSync(at(to, 'status'), 'Stopped');
    writeFileSync(at(to, 'set'), expr);
    pin(to, /\.ssh\.localPort\s*=\s*(\d+)/.exec(expr)?.[1] ?? '0');
  } else if (command === 'edit') {
    const set = args[args.indexOf('--set') + 1] ?? '';
    const display = /\.video\.display\s*=\s*"(\w+)"/.exec(set), port = /\.ssh\.localPort\s*=\s*(\d+)/.exec(set);
    if (!existsSync(join(instances, positional[0])) || !(display || port)) process.exit(1);
    if (display) writeFileSync(at(positional[0], 'display'), display[1]);
    if (port) pin(positional[0], port[1]);
  } else if (command === 'start' || command === 'stop') {
    writeFileSync(at(positional[0], 'status'), command === 'start' ? 'Running' : 'Stopped');
  } else if (command === 'delete') {
    rmSync(join(instances, positional[0]), { recursive: true, force: true });
  } else if (command === 'copy') {
    const [from, to] = positional.map(p => {
      const m = /^([^/:]+):(.*)$/.exec(p);
      if (!m) return p;
      if (!existsSync(join(instances, m[1]))) { console.error(`instance ${m[1]} not found`); process.exit(1); }
      refuseStopped(m[1]);
      return join(process.env.FAKE_VM_ROOT ?? process.cwd(), m[2]);
    });
    if (!existsSync(from)) { console.error(`${from}: No such file or directory`); process.exit(1); }
    cpSync(from, to, { recursive: true });
  }
}
