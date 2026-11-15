// A GCP workstation for the tests (ASS-433): fakeWorkstation(env) —
// fake-gcloud.js as `gcloud` and fake-ssh.js as `ssh`, first on the PATH of
// the env it returns (`env`, process.env by default, extended), their calls
// logged; HARNESS_HOME a short folder of its own under /tmp (a unix socket's
// path is at most 104 bytes, and the master's lives there).
// workstation(id, state) makes one (STATE_STOPPED by default), state(id)
// reads it and setState(id, s) sets it; mark(id, name) and unmark(id, name)
// put and take a marker file in its folder (drop, hang, refuse-forward,
// settle) or, without an id, the fake's own (expired, offline);
// gcloudCalls() and sshCalls() list what each was asked; flags(id) the
// --ssh-flag values its master was given; home(id) its user's home.
// ASS-434: each workstation is ready for workstation:setup as made — its own
// bin folder (system(id), first on its sessions' PATH: fake-ssh.js) holds a
// `docker` whose `info` answers (unless a `docker-broken` marker says it
// cannot reach its daemon) and a `claude`; its `boot-id` is set, and runtime(id)
// is its runtime folder's root (the container's /dev/shm).
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeWorkstation(base = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const bin = join(dir, 'bin'), workstations = join(dir, 'workstations');
  for (const d of [bin, workstations]) mkdirSync(d);
  symlinkSync(join(import.meta.dirname, 'fake-gcloud.js'), join(bin, 'gcloud'));
  symlinkSync(join(import.meta.dirname, 'fake-ssh.js'), join(bin, 'ssh'));
  const home = mkdtempSync('/tmp/wsh-');
  const env = { ...base, PATH: `${bin}:${base.PATH}`, FAKE_WS_DIR: workstations, FAKE_GCLOUD_LOG: join(dir, 'gcloud.log'), FAKE_SSH_LOG: join(dir, 'ssh.log'), HARNESS_HOME: home, WORKSTATION_POLL_SECONDS: '0.1' };
  const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const at = (id, ...rest) => join(workstations, id, ...rest);
  return {
    dir, bin, env, harnessHome: home,
    workstation: (id, state = 'STATE_STOPPED') => {
      mkdirSync(at(id, 'bin'), { recursive: true });
      writeFileSync(at(id, 'state'), state);
      writeFileSync(at(id, 'boot-id'), `boot-${id}-1`);
      writeFileSync(at(id, 'bin', 'docker'), DOCKER, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'claude'), '#!/bin/bash\necho "2.0.0 (Claude Code)"\n', { mode: 0o755 });
    },
    system: id => at(id, 'bin'),
    runtime: id => at(id, 'run'),
    state: id => readFileSync(at(id, 'state'), 'utf8').trim(),
    setState: (id, s) => writeFileSync(at(id, 'state'), s),
    mark: (id, name, content = '') => writeFileSync(id ? at(id, name) : join(workstations, name), content),
    unmark: (id, name) => rmSync(id ? at(id, name) : join(workstations, name), { force: true }),
    gcloudCalls: () => lines(env.FAKE_GCLOUD_LOG),
    sshCalls: () => lines(env.FAKE_SSH_LOG),
    flags: id => JSON.parse(readFileSync(at(id, 'ssh-flags'), 'utf8')),
    home: id => at(id, 'home'),
  };
}

// The workstation image's docker: `docker info` answers, unless the workstation's docker-broken marker is there.
const DOCKER = `#!/bin/bash
if [ -e "$(dirname "$0")/../docker-broken" ]; then echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \\"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info\\": dial unix /var/run/docker.sock: connect: permission denied" >&2; exit 1; fi
[ "$1" = info ] && echo 27.3.1
exit 0
`;
