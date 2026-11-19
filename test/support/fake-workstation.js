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
// --ssh-flag values its master was given (ASS-481: a cloud VM's, its ssh's
// own flags); home(id) its user's home.
// ASS-434: each workstation is ready for workstation:setup as made — its own
// bin folder (system(id), first on its sessions' PATH: fake-ssh.js) holds a
// `docker` whose `info` answers (unless a `docker-broken` marker says it
// cannot reach its daemon) and a `claude`; its `boot-id` is set, and runtime(id)
// is its runtime folder's root (the container's /dev/shm). ASS-472: its
// docker pulls and tags too (DOCKER, below), its images in the workstation
// folder's `images` file, each pull logged in its `pulls`.
// ASS-500: a `docker-stopped` marker is its Docker daemon not running — `docker` cannot
// connect, and its `pgrep` (PGREP, below) finds no dockerd; without it dockerd runs.
// ASS-504: setup starts each workstation's restart watcher (a process on this
// Mac, detached): it finds no metadata server (HARNESS_WS_METADATA_URL a port
// nothing listens on, unless a test sets its own) and checks every second
// (HARNESS_WS_WATCHER_SECONDS) that its pid file still names it; when the test
// process exits, every fake workstation's runtime folder is removed, so each
// watcher still running ends by itself within a second, never firing.
// ASS-501: its bin folder holds an `ss` too, printing the folder's
// `listening` lines (as `ss -Hltnp` would; listen(id, lines) writes them,
// SESSION in a line standing for the session's own sshd, fake-ssh.js's and
// fake-gcloud.js's FAKE_SSH_SESSION_PID) whose pid is still alive, and a
// `sudo` that runs its command as is, each call logged in its `sudo` file.
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.once('exit', () => { for (const dir of made) for (const id of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, id, 'run'), { recursive: true, force: true }); });

export function fakeWorkstation(base = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const bin = join(dir, 'bin'), workstations = join(dir, 'workstations');
  for (const d of [bin, workstations]) mkdirSync(d);
  symlinkSync(join(import.meta.dirname, 'fake-gcloud.js'), join(bin, 'gcloud'));
  symlinkSync(join(import.meta.dirname, 'fake-ssh.js'), join(bin, 'ssh'));
  const home = mkdtempSync(join(tmpdir(), 'wsh-'));
  made.push(workstations);
  const env = { HARNESS_WS_METADATA_URL: 'http://127.0.0.1:9/computeMetadata/v1/instance/preempted', HARNESS_WS_WATCHER_SECONDS: '1', ...base, PATH: `${bin}:${base.PATH}`, FAKE_WS_DIR: workstations, FAKE_GCLOUD_LOG: join(dir, 'gcloud.log'), FAKE_SSH_LOG: join(dir, 'ssh.log'), HARNESS_HOME: home, WORKSTATION_POLL_SECONDS: '0.1' };
  const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const at = (id, ...rest) => join(workstations, id, ...rest);
  return {
    dir, bin, env, harnessHome: home,
    workstation: (id, state = 'STATE_STOPPED') => {
      mkdirSync(at(id, 'bin'), { recursive: true });
      writeFileSync(at(id, 'state'), state);
      writeFileSync(at(id, 'boot-id'), `boot-${id}-1`);
      writeFileSync(at(id, 'bin', 'docker'), DOCKER, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'pgrep'), PGREP, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'claude'), '#!/bin/bash\necho "2.0.0 (Claude Code)"\n', { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'ss'), SS, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'sudo'), SUDO, { mode: 0o755 });
    },
    // ASS-481: cloudVm(id, status) — a cloud VM (fake-gcloud-compute.js, fake-ssh-master.js), TERMINATED by default,
    // ready for workstation:setup as a workstation is; status(id) reads its status, setStatus(id, s) sets it.
    cloudVm: (id, status = 'TERMINATED') => {
      mkdirSync(at(id, 'bin'), { recursive: true });
      writeFileSync(at(id, 'status'), status);
      writeFileSync(at(id, 'boot-id'), `boot-${id}-1`);
      writeFileSync(at(id, 'bin', 'docker'), DOCKER, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'pgrep'), PGREP, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'claude'), '#!/bin/bash\necho "2.0.0 (Claude Code)"\n', { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'ss'), SS, { mode: 0o755 });
      writeFileSync(at(id, 'bin', 'sudo'), SUDO, { mode: 0o755 });
    },
    status: id => readFileSync(at(id, 'status'), 'utf8').trim(),
    setStatus: (id, s) => writeFileSync(at(id, 'status'), s),
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
    listen: (id, lines) => writeFileSync(at(id, 'listening'), lines.map(l => `${l}\n`).join('')),
    sudoCalls: id => (existsSync(at(id, 'sudo')) ? readFileSync(at(id, 'sudo'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// ASS-500: the workstation's pgrep, as `pgrep -x dockerd` asks it: dockerd runs unless the docker-stopped marker is there.
const PGREP = `#!/bin/bash
[ "$*" = "-x dockerd" ] || exit 1
[ ! -e "$(dirname "$0")/../docker-stopped" ]
`;

// The workstation image's docker: `docker info` answers, unless the workstation's docker-broken marker is there
// (ASS-500: or its docker-stopped one, the daemon not running).
// ASS-472: `docker pull <ref>` asks the registry the reference names for its manifest — a 127.0.0.1:<port> one
// (zot through the connection's forward) as named, any other host at $FAKE_AR_URL (fake-registry.js standing in for
// Artifact Registry), with the auth DOCKER_CONFIG's config.json holds for the host (ASS-477: or the credential
// helper its credHelpers name for the host, else its credsStore, asked as Docker asks one — a helper that fails
// fails the pull, "error getting credentials") — and keeps "<name> <digest>"
// in the workstation's `images` file (its Docker's images): "Image is up to date" when it holds that digest
// already, else "Downloaded newer image". Every pull is logged to its `pulls` file as "<ref> <auth: yes|no>".
// `docker tag <src> <dst>` gives dst src's digest. ASS-473: `docker image inspect <ref>` succeeds when it holds the
// image — by name, or at the digest a <name>@<digest> names. Anything else answers nothing.
const DOCKER = `#!/bin/bash
ws="$(dirname "$0")/.."
if [ -e "$ws/docker-stopped" ]; then echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; fi
if [ -e "$ws/docker-broken" ]; then echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \\"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info\\": dial unix /var/run/docker.sock: connect: permission denied" >&2; exit 1; fi
keep() { touch "$ws/images"; awk -v k="$1" '$1 != k' "$ws/images" > "$ws/images.new"; echo "$1 $2" >> "$ws/images.new"; mv "$ws/images.new" "$ws/images"; }
case "$1" in
  info) echo 27.3.1 ;;
  pull)
    ref="\${@: -1}" name="\${ref%%@*}" digest=""
    [[ "$ref" != *@* ]] || digest="\${ref#*@}"
    host="\${name%%/*}" rest="\${name#*/}" tag=latest
    if [[ "\${rest##*/}" == *:* ]]; then tag="\${rest##*:}" rest="\${rest%:*}"; fi
    cfg="\${DOCKER_CONFIG:-$HOME/.docker}/config.json" auth=""
    helper="$(jq -r --arg h "$host" '.credHelpers[$h] // .credsStore // empty' "$cfg" 2>/dev/null)"
    if [ -n "$helper" ]; then
      if ! creds="$(printf '%s\\n' "$host" | "docker-credential-$helper" get 2>/dev/null)"; then
        echo "$ref no" >> "$ws/pulls"
        echo "Error response from daemon: Get \\"https://$host/v2/\\": error getting credentials - err: exit status 1, out: \\\`$creds\\\`" >&2; exit 1
      fi
      auth="$(jq -j '"\\(.Username):\\(.Secret)"' <<< "$creds" | base64 | tr -d '\\n')"
    else auth="$(jq -r --arg h "$host" '.auths[$h].auth // empty' "$cfg" 2>/dev/null)"; fi
    if [ -n "$auth" ]; then echo "$ref yes"; else echo "$ref no"; fi >> "$ws/pulls"
    case "$host" in 127.0.0.1:*) url="http://$host" ;; *) url="\${FAKE_AR_URL:-https://$host}" ;; esac
    h=(); [ -z "$auth" ] || h=(-H "Authorization: Basic $auth")
    headers="$(curl -sS -D - -o /dev/null "\${h[@]}" "$url/v2/$rest/manifests/\${digest:-$tag}" 2>&1)"
    code="$(head -n 1 <<< "$headers" | awk '{ print $2 }')"
    case "$code" in
      200) ;;
      401) echo "Error response from daemon: Head \\"https://$host/v2/$rest/manifests/\${digest:-$tag}\\": denied: Unauthenticated request." >&2; exit 1 ;;
      404) echo "Error response from daemon: manifest for $ref not found: manifest unknown: manifest unknown" >&2; exit 1 ;;
      *) echo "Error response from daemon: Get \\"https://$host/v2/\\": dial tcp: connect: connection refused" >&2; exit 1 ;;
    esac
    d="$(tr -d '\\r' <<< "$headers" | awk 'tolower($1) == "docker-content-digest:" { print $2 }')"
    echo "\${digest:-$tag}: Pulling from $rest"
    if grep -qxF "$name $d" "$ws/images" 2>/dev/null; then echo "Status: Image is up to date for $ref"; else keep "$name" "$d"; echo "Status: Downloaded newer image for $ref"; fi
    echo "$ref" ;;
  image)
    [ "$2" = inspect ] || exit 0
    ref="$3" name="\${3%%@*}"
    if [[ "$ref" == *@* ]]; then grep -qxF "$name \${ref#*@}" "$ws/images" 2>/dev/null
    else awk -v k="$name" '$1 == k { found = 1 } END { exit !found }' "$ws/images" 2>/dev/null; fi
    [ $? -eq 0 ] || { echo "Error: No such image: $ref" >&2; exit 1; }
    echo "[{}]" ;;
  tag)
    d="$(awk -v k="\${2%%@*}" '$1 == k { print $2 }' "$ws/images" 2>/dev/null)"
    [ -n "$d" ] || { echo "Error response from daemon: No such image: $2" >&2; exit 1; }
    keep "$3" "$d" ;;
esac
exit 0
`;

// ASS-501: the machine's ss and sudo (above).
const SS = `#!/bin/bash
ws="$(dirname "$0")/.."
[ -f "$ws/listening" ] || exit 0
while IFS= read -r line; do
  line="\${line//SESSION/$FAKE_SSH_SESSION_PID}"
  pid="$(grep -oE 'pid=[0-9]+' <<< "$line" | head -n 1 | cut -d = -f 2)"
  [ -z "$pid" ] || ps -p "$pid" >/dev/null 2>&1 || continue
  printf '%s\\n' "$line"
done < "$ws/listening"
`;
const SUDO = `#!/bin/bash
echo "$*" >> "$(dirname "$0")/../sudo"
[ "$1" != -n ] || shift
exec "$@"
`;
