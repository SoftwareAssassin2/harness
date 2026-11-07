// A Lima for the tests (ASS-74): fakeVm(env) — fake-limactl.js as `limactl`,
// first on the PATH of the env it returns (`env`, process.env by default,
// extended), its calls logged. script(name, body) adds a fake to the Mac's
// PATH, inVm(name, body) one to the VM's (what a `limactl shell` runs finds
// first); instance(name, status) makes a Lima instance; root is the folder
// standing in for the VMs' root; unreachable(name) marks an instance's sshd
// as not yet accepting connections (ASS-169); calls() lists what limactl was
// asked, as { vm, workdir, argv } (shell) or { argv }.
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeVm(base = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'vm-'));
  const bin = join(dir, 'bin'), vmBin = join(dir, 'vm-bin'), log = join(dir, 'limactl.log'), root = join(dir, 'vm'), instances = join(dir, 'instances');
  for (const d of [bin, vmBin, root, instances]) mkdirSync(d);
  symlinkSync(join(import.meta.dirname, 'fake-limactl.js'), join(bin, 'limactl'));
  const env = { ...base, PATH: `${bin}:${base.PATH}`, FAKE_LIMACTL_LOG: log, FAKE_VM_ROOT: root, FAKE_VM_BIN: vmBin, FAKE_LIMA_INSTANCES: instances };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  const fake = folder => (name, body) => { writeFileSync(join(folder, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(folder, name), 0o755); };
  const instance = (name, status = 'Stopped', sshPort = '0') => {
    mkdirSync(join(instances, name), { recursive: true });
    writeFileSync(join(instances, name, 'status'), status);
    writeFileSync(join(instances, name, 'ssh-port'), sshPort);
  };
  const unreachable = name => writeFileSync(join(instances, name, 'unreachable'), '');
  return { dir, bin, root, instances, env, calls, script: fake(bin), inVm: fake(vmBin), instance, unreachable };
}
