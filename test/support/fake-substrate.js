// A machine for Substrate clusters in the tests (ASS-533): fakeSubstrateMachine(dir) makes `dir` stand in for the Mac,
// a workstation or a cloud VM — its own docker (FAKE_DOCKER, below) first on its PATH (`bin`), sudo, sysctl and
// service beside it, `root` its / (etc/docker/daemon.json, proc/sys, proc/meminfo: what is outside /home) and
// `persist` its /home (on a fake workstation, test/support/fake-workstation.js's home folder's parent stands in) — and
// fakeKit(file) writes a Substrate kit tarball (substrate.bash substrate_kit's shape: bin/kind, bin/kubectl,
// bin/kubectl-ate, bin/ate-setup and src/go.mod) of fakes. Under test/support/, which npm test's pattern leaves alone.
//
// The fake docker keeps its containers in its data-root (`dockerd-root` in the machine folder, which a `service docker
// restart` sets from daemon.json's data-root when it has one, else from `dockerd-default-root`), each a folder
// containers/<name> with `state` (true/false), `started-at`, `proxy_arp` and, for a kind node, `k8s/` — the
// cluster's state (installed release, namespaces, WorkerPools, atespaces, templates, actors, snapshots), so it lives
// exactly where the real node's /var volume would: in Docker's data-root. It answers what on-machine/substrate.sh asks:
// info (ServerVersion, DockerRootDir, MemTotal, NCPU), inspect (State.Running, State.StartedAt), start, stop, exec
// <node> (proxy_arp read and set), stats; anything else goes to docker.orig when the machine had a docker already
// (fake-workstation.js's), else answers nothing. A `docker-stopped` marker in the machine folder: Docker down.
//
// The kit's fakes find the cluster from the kubeconfig they are given (its `fake-kind-cluster: <name>` line) and
// Docker's data-root (docker info), and log each call to $FAKE_SUBSTRATE_LOG as a JSON line { tool, argv, kubeconfig
// (the file they were given, or null) }. Like the real ones they fall back to $KUBECONFIG, then ~/.kube/config: kind
// create and delete then write ~/.kube/config (so a call without --kubeconfig would change the operator's file), and
// kubectl and kubectl-ate log a read of it, `default-kubeconfig: true` — what AC8's test looks for. Markers in a
// node's k8s/broken/: api, rustfs, postgres, workers, pod (one system pod not ready), install (ate-setup fails).
//
// restart(dir) — the machine restarted: every container stopped (proxy ARP gone with its network namespace), root/etc
// and root/proc/sys back to a fresh machine's (the inotify limits low, no daemon.json), Docker's data-root its default
// again (a workstation's config starts dockerd with it): what is under `persist` stays.
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const write = (file, content, mode = 0o644) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content, { mode }); };

// fakeSubstrateMachine(dir, { persist, defaultRoot, memory, available }) — see the module comment. `defaultRoot` is
// Docker's data-root at a fresh start (under persist by default, as Google's workstation images have it); memory and
// available the bytes docker info and /proc/meminfo give.
export function fakeSubstrateMachine(dir, { persist = join(dir, 'home'), defaultRoot, memory = 16 * 1024 ** 3, available = 12 * 1024 ** 3, cpus = 8 } = {}) {
  const bin = join(dir, 'bin'), root = join(dir, 'root');
  mkdirSync(bin, { recursive: true });
  mkdirSync(persist, { recursive: true });
  if (existsSync(join(bin, 'docker')) && !existsSync(join(bin, 'docker.orig'))) renameSync(join(bin, 'docker'), join(bin, 'docker.orig'));
  write(join(bin, 'docker'), FAKE_DOCKER, 0o755);
  write(join(bin, 'sysctl'), FAKE_SYSCTL, 0o755);
  write(join(bin, 'service'), FAKE_SERVICE, 0o755);
  if (!existsSync(join(bin, 'sudo'))) write(join(bin, 'sudo'), '#!/bin/bash\necho "$*" >> "$(dirname "$0")/../sudo"\n[ "$1" != -n ] || shift\nexec "$@"\n', 0o755);
  const defaultDataRoot = defaultRoot ?? join(persist, '.docker_data');
  writeFileSync(join(dir, 'dockerd-default-root'), defaultDataRoot);
  writeFileSync(join(dir, 'docker-memory'), String(memory));
  writeFileSync(join(dir, 'docker-cpus'), String(cpus));
  const fresh = () => {
    rmSync(join(root, 'etc'), { recursive: true, force: true });
    write(join(root, 'proc', 'sys', 'fs', 'inotify', 'max_user_watches'), '129254\n');
    write(join(root, 'proc', 'sys', 'fs', 'inotify', 'max_user_instances'), '128\n');
    write(join(root, 'proc', 'meminfo'), `MemTotal:       ${Math.round(memory / 1024)} kB\nMemAvailable:   ${Math.round(available / 1024)} kB\n`);
    mkdirSync(join(root, 'etc'), { recursive: true });
    writeFileSync(join(dir, 'dockerd-root'), defaultDataRoot);
  };
  fresh();
  const dataRoot = () => readFileSync(join(dir, 'dockerd-root'), 'utf8').trim();
  const node = (cluster = 'harness-substrate') => join(dataRoot(), 'containers', `${cluster}-control-plane`);
  return {
    dir, bin, root, persist,
    env: { HARNESS_SUBSTRATE_ROOT: root, HARNESS_SUBSTRATE_PERSIST: persist },
    dataRoot, node, k8s: (cluster) => join(node(cluster), 'k8s'),
    restart: () => {
      fresh();
      for (const base of new Set([defaultDataRoot, ...(existsSync(join(dir, 'roots')) ? readFileSync(join(dir, 'roots'), 'utf8').trim().split('\n') : [])])) {
        const containers = join(base, 'containers');
        for (const c of existsSync(containers) ? readdirSync(containers) : []) {
          writeFileSync(join(containers, c, 'state'), 'false');
          writeFileSync(join(containers, c, 'proxy_arp'), '0');
        }
      }
    },
    broken: (what, on = true, cluster) => { const f = join(node(cluster), 'k8s', 'broken', what); if (on) write(f, ''); else rmSync(f, { force: true }); },
    sudoCalls: () => (existsSync(join(dir, 'sudo')) ? readFileSync(join(dir, 'sudo'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// fakeKit(file) — a kit tarball of the fakes at `file`; returns its sha256.
export function fakeKit(file) {
  const stage = mkdtempSync(join(tmpdir(), 'kit-'));
  write(join(stage, 'bin', 'kind'), FAKE_KIND, 0o755);
  write(join(stage, 'bin', 'kubectl'), FAKE_KUBECTL, 0o755);
  write(join(stage, 'bin', 'kubectl-ate'), FAKE_ATE, 0o755);
  write(join(stage, 'bin', 'ate-setup'), FAKE_ATE_SETUP, 0o755);
  write(join(stage, 'bin', 'fake-cluster.bash'), FAKE_CLUSTER_LIB, 0o644);
  write(join(stage, 'src', 'go.mod'), 'module go.ate.dev/substrate\n');
  mkdirSync(join(file, '..'), { recursive: true });
  execFileSync('tar', ['-czf', file, '-C', stage, 'bin', 'src'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  rmSync(stage, { recursive: true, force: true });
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// putKit(substrateDir, release) — the fake kit placed as substrate.bash's built kit for every platform, under
// <substrateDir>/build/<release>/ (the Mac's ~/.harness/substrate), so substrate:up builds nothing.
export function putKit(substrateDir, release = 'v1.0.1') {
  const b = join(substrateDir, 'build', release);
  const sha = fakeKit(join(b, 'darwin-arm64.tar.gz'));
  for (const p of ['darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64']) {
    if (p !== 'darwin-arm64') { rmSync(join(b, `${p}.tar.gz`), { force: true }); symlinkSync(join(b, 'darwin-arm64.tar.gz'), join(b, `${p}.tar.gz`)); }
    writeFileSync(join(b, `${p}.sha256`), `${sha}\n`);
  }
  return sha;
}

// The machine's docker (see the module comment).
const FAKE_DOCKER = `#!/bin/bash
m="$(cd "$(dirname "$0")/.." && pwd)"
if [ -e "$m/docker-stopped" ]; then echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; fi
dr="$(cat "$m/dockerd-root")"
c="$dr/containers"
fmt() { local f="$1"; f="\${f//'{{.ServerVersion}}'/27.3.1}"; f="\${f//'{{.DockerRootDir}}'/$dr}"; f="\${f//'{{.MemTotal}}'/$(cat "$m/docker-memory")}"; f="\${f//'{{.NCPU}}'/$(cat "$m/docker-cpus")}"; printf '%s\\n' "$f"; }
case "$1" in
  info)
    if [ "$2" = --format ]; then fmt "$3"; else echo "Server Version: 27.3.1"; fi ;;
  inspect)
    [ "$2" = -f ] || exit 0
    [ -d "$c/$4" ] || { echo "Error: No such object: $4" >&2; exit 1; }
    case "$3" in *Running*) cat "$c/$4/state" ;; *StartedAt*) cat "$c/$4/started-at" ;; *RestartPolicy*) echo "on-failure:1" ;; *Labels*) cat "$c/$4/label" 2>/dev/null ;; esac ;;
  network)
    # ASS-536: kind's network, its gateway the machine's side of the bridge.
    [ "$2 $3" = "inspect kind" ] || exit 1
    [ -n "$(ls -d "$c"/*-control-plane 2>/dev/null)" ] || { echo "Error: network kind not found" >&2; exit 1; }
    echo "172.18.0.1 fc00:f853:ccd:e793::1 " ;;
  rm) shift; [ "$1" = -f ] && shift; rm -rf "\${c:?}/$1" ;;
  start) [ -d "$c/$2" ] || { echo "Error: No such container: $2" >&2; exit 1; }; echo true > "$c/$2/state"; date -u +%Y-%m-%dT%H:%M:%S.000000000Z > "$c/$2/started-at"; echo "$2" ;;
  stop) [ -d "$c/$2" ] || exit 1; echo false > "$c/$2/state"; echo 0 > "$c/$2/proxy_arp"; echo "$2" ;;
  restart) [ -d "$c/$2" ] || exit 1; echo true > "$c/$2/state"; echo 0 > "$c/$2/proxy_arp"; date -u +%Y-%m-%dT%H:%M:%S.000000000Z > "$c/$2/started-at" ;;
  exec)
    n="$2"; shift 2
    [ "$(cat "$c/$n/state" 2>/dev/null)" = true ] || { echo "Error response from daemon: container $n is not running" >&2; exit 1; }
    case "$*" in
      *"cat /proc/sys/net/ipv4/conf/all/proxy_arp"*) cat "$c/$n/proxy_arp" ;;
      *"proxy_arp=1"*) echo 1 > "$c/$n/proxy_arp"; echo "net.ipv4.conf.all.proxy_arp = 1" ;;
      *kubelet.slice*) uid="\${@: -1}"; cat "$c/$n/k8s/usage/$uid" 2>/dev/null || echo "209715200 5000000" ;;
      # ASS-537: measure_snapshots — each actor's snapshots (k8s/snapshots/<uid>, bytes), its atespace's golden ones
      # (k8s/snapshots/tags-<atespace>) and the node's /var (k8s/disk: "<total> <free>").
      *"/var/lib/ate/snapshots"*) set -- "\${@:5}"; ns="$1"; shift
        for p in "$@"; do echo "snap \${p%%=*} $(cat "$c/$n/k8s/snapshots/\${p#*=}" 2>/dev/null || echo 0)"; done
        echo "tags $(cat "$c/$n/k8s/snapshots/tags-$ns" 2>/dev/null || echo 0)"
        echo "disk $(cat "$c/$n/k8s/disk" 2>/dev/null || echo 500000000000 400000000000)" ;;
      *) : ;;
    esac ;;
  run)
    # ASS-535: the cluster's registry container (on-machine substrate.sh registry-up): its name and image kept.
    # ASS-536: the relay to the Mac (mac-relay): its label kept, and its argv one per line in run.argv.
    n=""; img=""; label=""; for a in "$@"; do [ "$prev" = --name ] && n="$a"; [ "$prev" = --label ] && label="\${a#*=}"; prev="$a"; img="$a"; done
    [ -n "$n" ] || exit 1
    mkdir -p "$c/$n" && echo true > "$c/$n/state" && echo "$*" > "$c/$n/run" && printf '%s\\n' "$@" > "$c/$n/run.argv" && printf '%s\\n' "$label" > "$c/$n/label" && echo "fake-$n" ;;
  stats)
    for d in "$c"/*/; do
      [ -d "$d" ] || continue; n="$(basename "$d")"
      [ "$(cat "$d/state")" = true ] || continue
      [ -z "\${!#}" ] || [ "\${!#}" = "$n" ] || [[ "\${!#}" == *"{{"* ]] || continue
      u=1.5GiB; [ -d "$d/k8s" ] || u=20MiB   # ASS-535: the registry container is small
      if [[ "$*" == *CPUPerc* ]]; then echo "$u / 16GiB 12.5%"; else echo "$u / 16GiB"; fi
    done ;;
  *) if [ -x "$m/bin/docker.orig" ]; then exec "$m/bin/docker.orig" "$@"; fi ;;
esac
exit 0
`;

// sysctl -w k=v: written under the machine's root/proc/sys. service docker restart: Docker's data-root from daemon.json.
const FAKE_SYSCTL = `#!/bin/bash
m="$(cd "$(dirname "$0")/.." && pwd)"
[ "$1" = -w ] && shift
k="\${1%%=*}" v="\${1#*=}"
f="$HARNESS_SUBSTRATE_ROOT/proc/sys/\${k//.//}"
[ -n "$HARNESS_SUBSTRATE_ROOT" ] || { echo "sysctl: no fake root" >&2; exit 1; }
mkdir -p "$(dirname "$f")" && echo "$v" > "$f" && echo "$k = $v"
`;
const FAKE_SERVICE = `#!/bin/bash
m="$(cd "$(dirname "$0")/.." && pwd)"
[ "$1 $2" = "docker restart" ] || exit 0
r="$(jq -r '.["data-root"] // empty' "$HARNESS_SUBSTRATE_ROOT/etc/docker/daemon.json" 2>/dev/null)"
[ -n "$r" ] || r="$(cat "$m/dockerd-default-root")"
echo "$r" > "$m/dockerd-root"
echo "$r" >> "$m/roots"
echo " * Restarting Docker"
`;

// What the kit's fakes share: the call logged, the cluster found from the kubeconfig.
const FAKE_CLUSTER_LIB = `
log() {
  [ -n "$FAKE_SUBSTRATE_LOG" ] || return 0
  local a; a="$(printf '%s\\0' "\${ARGV[@]}" | jq -Rsc 'split("\\u0000")[:-1]')"
  jq -cn --arg t "$1" --arg kc "\${2:-}" --argjson d "\${3:-false}" --argjson a "$a" '{ tool: $t, argv: $a, kubeconfig: (if $kc == "" then null else $kc end), "default-kubeconfig": $d }' >> "$FAKE_SUBSTRATE_LOG"
}
dataroot() { docker info --format '{{.DockerRootDir}}'; }
# cluster_of <kubeconfig> — the cluster its fake-kind-cluster line names.
cluster_of() { sed -n 's/^# fake-kind-cluster: //p' "$1" 2>/dev/null | head -n 1; }
kubeconfig_text() { printf 'apiVersion: v1\\nkind: Config\\n# fake-kind-cluster: %s\\ncurrent-context: kind-%s\\n' "$1" "$1"; }
`;

const FAKE_KIND = `#!/bin/bash
ARGV=("$@")
. "$(dirname "$0")/fake-cluster.bash"
name=kind kc="" cfg="" image=""
args=()
while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift 2 ;; --kubeconfig) kc="$2"; shift 2 ;; --config) cfg="$2"; shift 2 ;; --image) image="$2"; shift 2 ;; --wait) shift 2 ;; *) args+=("$1"); shift ;; esac; done
target="\${kc:-\${KUBECONFIG:-$HOME/.kube/config}}"
default=false; [ -n "$kc" ] || [ -n "$KUBECONFIG" ] || default=true
log kind "$kc" "$default"
node="$(dataroot)/containers/$name-control-plane"
case "\${args[*]}" in
  "create cluster")
    [ ! -d "$node" ] || { echo "ERROR: failed to create cluster: node(s) already exist for a cluster with the name \\"$name\\"" >&2; exit 1; }
    mkdir -p "$node/k8s" && echo true > "$node/state" && echo 0 > "$node/proxy_arp" && date -u +%Y-%m-%dT%H:%M:%S.000000000Z > "$node/started-at"
    echo "$image" > "$node/image"
    mkdir -p "$(dirname "$target")"
    { [ "$default" = true ] && cat "$target" 2>/dev/null; kubeconfig_text "$name"; } > "$target.new" && mv "$target.new" "$target"
    echo "Creating cluster \\"$name\\" ..." ;;
  "get kubeconfig") [ -d "$node" ] || { echo "ERROR: could not locate any control plane nodes for cluster named '$name'" >&2; exit 1; }; kubeconfig_text "$name" ;;
  "get clusters") for d in "$(dataroot)"/containers/*-control-plane; do [ -d "$d" ] && basename "$d" -control-plane; done ;;
  "delete cluster")
    rm -rf "$node"
    if [ -f "$target" ]; then grep -v "fake-kind-cluster: $name\\$\\|current-context: kind-$name\\$" "$target" > "$target.new"; mv "$target.new" "$target"; fi
    echo "Deleting cluster \\"$name\\" ..." ;;
  "load image-archive "*) [ -d "$node" ] || exit 1; f="\${args[2]}"; echo "$(wc -c < "$f" | tr -d ' ') $(head -c 64 "$f")" >> "$node/k8s/images" ;;
  *) echo "fake kind: \${args[*]}" >&2; exit 1 ;;
esac
`;

const FAKE_KUBECTL = `#!/bin/bash
ARGV=("$@")
. "$(dirname "$0")/fake-cluster.bash"
kc="" ns="" args=()
while [ $# -gt 0 ]; do case "$1" in --kubeconfig) kc="$2"; shift 2 ;; --kubeconfig=*) kc="\${1#*=}"; shift ;; --request-timeout=*) shift ;; -n) ns="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done
default=false; [ -n "$kc" ] || [ -n "$KUBECONFIG" ] || default=true
log kubectl "$kc" "$default"
[ "$default" = false ] || { echo "fake kubectl: no kubeconfig given: would read ~/.kube/config" >&2; exit 1; }
cl="$(cluster_of "\${kc:-$KUBECONFIG}")"
node="$(dataroot)/containers/$cl-control-plane" k="$(dataroot)/containers/$cl-control-plane/k8s"
[ -n "$cl" ] && [ "$(cat "$node/state" 2>/dev/null)" = true ] || { echo "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?" >&2; exit 1; }
api() { [ ! -e "$k/broken/api" ]; }
a="\${args[*]}"
case "$a" in
  "get --raw /readyz") api || { echo "Error from server (InternalError)" >&2; exit 1; }; echo ok ;;
  "get --raw /api/v1/namespaces/ate-system/services/http:rustfs:9000/proxy/health") [ ! -e "$k/broken/rustfs" ] || { echo 'Error from server (ServiceUnavailable): no endpoints available for service "rustfs"' >&2; exit 1; }; echo '{"service":"rustfs-endpoint","status":"ok"}' ;;
  "exec postgres-0 -c postgres -- pg_isready") [ ! -e "$k/broken/postgres" ] || { echo "/var/run/postgresql:5432 - no response" >&2; exit 2; }; echo "/var/run/postgresql:5432 - accepting connections" ;;
  "get deployment ate-api-server") [ -f "$k/installed" ] || { echo 'Error from server (NotFound): deployments.apps "ate-api-server" not found' >&2; exit 1; } ;;
  "rollout status deployment/ate-api-server --timeout="*) [ -f "$k/installed" ] && api ;;
  "get pods -A -o json")
    items='[]'
    for p in ate-system/ate-api-server-1 ate-system/ate-controller-1 ate-system/postgres-0 ate-system/rustfs-1 kube-system/coredns-1; do
      ready=True; [ "$p" = ate-system/ate-controller-1 ] && [ -e "$k/broken/pod" ] && ready=False
      items="$(jq -c --arg ns "\${p%/*}" --arg n "\${p#*/}" --arg r "$ready" '. + [{ metadata: { namespace: $ns, name: $n, creationTimestamp: "2026-01-01T00:00:00Z" }, status: { phase: "Running", conditions: [{ type: "Ready", status: $r }], containerStatuses: (if $r == "True" then [] else [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] end) } }]' <<< "$items")"
    done
    jq -cn --argjson i "$items" '{ items: $i }' ;;
  "apply -f -")
    in="$(cat)"
    jq -c 'if .kind == "List" then .items[] else . end' <<< "$in" | while IFS= read -r o; do
      kind="$(jq -r .kind <<< "$o")" name="$(jq -r .metadata.name <<< "$o")" n="$(jq -r '.metadata.namespace // empty' <<< "$o")"
      case "$kind" in
        # ASS-538: Secrets (kept as applied: stringData) and ConfigMaps.
        Secret) [ -d "$k/ns/$n" ] || { echo "Error from server (NotFound): namespaces \"$n\" not found" >&2; exit 1; }
          f="$k/ns/$n/secret-$name.json"
          if [ -f "$f" ] && [ "$(cat "$f")" = "$o" ]; then echo "secret/$name unchanged"
          else w=created; [ -f "$f" ] && w=configured; echo "$o" > "$f"; echo "secret/$name $w"; fi ;;
        ConfigMap) mkdir -p "$k/configmaps"; f="$k/configmaps/$n-$name.json"
          w=created; [ -f "$f" ] && w=configured; echo "$o" > "$f"; echo "configmap/$name $w" ;;
        Namespace) if [ -d "$k/ns/$name" ]; then echo "namespace/$name unchanged"; else mkdir -p "$k/ns/$name"; echo "namespace/$name created"; fi ;;
        Service|EndpointSlice) f="$k/ns/$n/$(tr '[:upper:]' '[:lower:]' <<< "$kind")-$name.json"; mkdir -p "$k/ns/$n"   # ASS-536: the relay's
          if [ -f "$f" ] && [ "$(cat "$f")" = "$o" ]; then echo "$kind/$name unchanged"; else echo "$o" > "$f"; echo "$kind/$name configured"; fi ;;
        WorkerPool) f="$k/ns/$n/workerpool-$name.json"
          if [ -f "$f" ] && [ "$(cat "$f")" = "$o" ]; then echo "workerpool.ate.dev/$name unchanged"
          else w=created; [ -f "$f" ] && w=configured; echo "$o" > "$f"; echo "workerpool.ate.dev/$name $w"; fi ;;
      esac
    done ;;
  "get workerpool "*" -o json") f="$k/ns/$ns/workerpool-\${args[2]}.json"; [ -f "$f" ] || { echo "Error from server (NotFound): workerpools.ate.dev \\"\${args[2]}\\" not found" >&2; exit 1; }
    if [ -e "$k/broken/workers" ]; then jq -c '. + { status: { readyReplicas: 0 } }' "$f"; else jq -c '. + { status: { readyReplicas: .spec.replicas } }' "$f"; fi ;;
  "get namespace "*) [ -d "$k/ns/\${args[2]}" ] ;;
  "patch workerpool "*" --type merge -p "*) f="$k/ns/$ns/workerpool-\${args[2]}.json"; [ -f "$f" ] || exit 1
    jq -c --argjson p "\${args[6]}" '. * $p' "$f" > "$f.new" && mv "$f.new" "$f"; echo "workerpool.ate.dev/\${args[2]} patched" ;;
  "get namespaces -o json") jq -cn --args '{ items: [$ARGS.positional[] | { metadata: { name: . } }] }' $(ls "$k/ns" 2>/dev/null) ;;
  "delete namespace "*) rm -rf "$k/ns/\${args[2]}"; echo "namespace \\"\${args[2]}\\" deleted" ;;
  "delete pod "*) echo "pod \\"\${args[2]}\\" deleted" ;;
  "logs deployment/ate-api-server "*) cat "$k/api-server.log" 2>/dev/null ;;
  # ASS-538: the credential provider (its deployment, the namespace policy it reads, restarts counted), the
  # project's Secrets, the egress gateway's ext-proc log ($k/egress.log). Marker broken/provider: not ready.
  "get secrets -l harness.dev/credential -o json") jq -sc '{ items: [.[] | { metadata: .metadata }] }' "$k/ns/$ns"/secret-*.json 2>/dev/null || echo '{"items":[]}' ;;
  "delete secret "*) rm -f "$k/ns/$ns/secret-\${args[2]}.json"; echo "secret \"\${args[2]}\" deleted" ;;
  "get configmap k8s-credential-provider-namespace-policy -o json")
    [ -f "$k/installed" ] || { echo 'Error from server (NotFound): configmaps "k8s-credential-provider-namespace-policy" not found' >&2; exit 1; }
    f="$k/configmaps/ate-system-k8s-credential-provider-namespace-policy.json"
    if [ -f "$f" ]; then cat "$f"; else jq -cn '{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "k8s-credential-provider-namespace-policy", namespace: "ate-system", resourceVersion: "1" }, data: { "namespace-policy.yaml": "# No atespace may resolve any Secret until it is listed here\\npolicies: []\\n" } }'; fi ;;
  "get deployment k8s-credential-provider -o json") [ -f "$k/installed" ] || exit 1
    r=1; [ ! -e "$k/broken/provider" ] || r=0; jq -cn --argjson r "$r" '{ spec: { replicas: 1 }, status: { readyReplicas: $r } }' ;;
  "rollout restart deployment/k8s-credential-provider") echo x >> "$k/provider-restarts"; echo "deployment.apps/k8s-credential-provider restarted" ;;
  "rollout status deployment/k8s-credential-provider --timeout="*) [ ! -e "$k/broken/provider" ] ;;
  "logs deployment/atenet-egress -c ext-proc --since="*) cat "$k/egress.log" 2>/dev/null ;;
  *) echo "fake kubectl: $a" >&2; exit 1 ;;
esac
`;

const FAKE_ATE = `#!/bin/bash
ARGV=("$@")
. "$(dirname "$0")/fake-cluster.bash"
kc="" atespace="" template="" file="" args=()
while [ $# -gt 0 ]; do case "$1" in --kubeconfig) kc="$2"; shift 2 ;; -a) atespace="$2"; shift 2 ;; -o|--mode) shift 2 ;; --template) template="$2"; shift 2 ;; -f) file="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done
default=false; [ -n "$kc" ] || [ -n "$KUBECONFIG" ] || default=true
log kubectl-ate "$kc" "$default"
[ "$default" = false ] || { echo "fake kubectl-ate: no kubeconfig given: would read ~/.kube/config" >&2; exit 1; }
echo "Warning: no --token-file given; acting as the shared identity" >&2
cl="$(cluster_of "\${kc:-$KUBECONFIG}")"
k="$(dataroot)/containers/$cl-control-plane/k8s"
[ "$(cat "$(dataroot)/containers/$cl-control-plane/state" 2>/dev/null)" = true ] && [ ! -e "$k/broken/api" ] && [ -f "$k/installed" ] || { echo "Error: failed to connect to ate-api-server: no ready api pods in ate-system" >&2; exit 1; }
case "\${args[*]}" in
  "get atespace "*) [ -f "$k/atespaces/\${args[2]}" ] || { echo "Error: failed to get atespace \\"\${args[2]}\\": rpc error: code = NotFound" >&2; exit 1; } ;;
  "create atespace "*) mkdir -p "$k/atespaces" && : > "$k/atespaces/\${args[2]}" ;;
  "delete atespace "*) rm -f "$k/atespaces/\${args[2]}"; echo "atespace \\"\${args[2]}\\" deleted" ;;
  "get actor-template") cat "$k/templates-$atespace.json" 2>/dev/null || echo '{}' ;;
  "get actor") cat "$k/actors-$atespace.json" 2>/dev/null || echo '{}' ;;
  # ASS-535: templates and actors (sandboxes), kept in the lists above; a sandbox's / is sandboxes/<atespace>/<actor>/root.
  "create actor-template") t="$(cat "\${file/#-//dev/stdin}")"; n="$(jq -r .metadata.name <<< "$t")"
    [ -n "$atespace" ] || atespace="$(jq -r '.metadata.atespace // empty' <<< "$t")"; tf="$k/templates-$atespace.json"   # the manifest's, as the real one
    [ -f "$tf" ] || echo '{"actorTemplates":[]}' > "$tf"
    if [ -e "$k/broken/template" ]; then t="$(jq -c '. + { status: { goldenSnapshotStatus: { errorMessage: "the actor is larger than every eligible worker" } } }' <<< "$t")"
    else t="$(jq -c --arg n "$n" '. + { status: { goldenSnapshotStatus: { goldenTag: { name: ("golden-" + $n) } } } }' <<< "$t")"; fi
    jq -c --argjson t "$t" '.actorTemplates = ([.actorTemplates[]? | select(.metadata.name != $t.metadata.name)] + [$t])' "$tf" > "$tf.new" && mv "$tf.new" "$tf"
    echo "actor template \"$n\" created" ;;
  "get actor-template "*) jq -ce --arg n "\${args[2]}" '.actorTemplates[]? | select(.metadata.name == $n)' "$k/templates-$atespace.json" 2>/dev/null || { echo "Error: rpc error: code = NotFound" >&2; exit 1; } ;;
  "delete actor-template "*) tf="$k/templates-$atespace.json"; jq -c --arg n "\${args[2]}" '.actorTemplates |= map(select(.metadata.name != $n))' "$tf" > "$tf.new" && mv "$tf.new" "$tf" ;;
  "create actor "*) af="$k/actors-$atespace.json" a="\${args[2]}"
    jq -e --arg n "$template" '.actorTemplates[]? | select(.metadata.name == $n)' "$k/templates-$atespace.json" >/dev/null 2>&1 || { echo "Error: template $template not found" >&2; exit 1; }
    [ -f "$af" ] || echo '{"actors":[]}' > "$af"
    jq -e --arg a "$a" '.actors[] | select(.metadata.name == $a)' "$af" >/dev/null && { echo "Error: actor $a already exists" >&2; exit 1; }
    jq -c --arg a "$a" --arg t "$template" '.actors += [{ metadata: { name: $a, uid: ("actor-uid-" + $a) }, template: $t, status: { state: "ACTOR_STATE_SUSPENDED" } }]' "$af" > "$af.new" && mv "$af.new" "$af"
    r="$k/sandboxes/$atespace/$a/root"; mkdir -p "$r"; [ -z "$FAKE_SANDBOX_IMAGE" ] || cp -R "$FAKE_SANDBOX_IMAGE/." "$r/"
    echo "$a created" ;;
  "get actor "*) jq -ce --arg a "\${args[2]}" '.actors[]? | select(.metadata.name == $a)' "$k/actors-$atespace.json" 2>/dev/null || { echo "Error: actor not found" >&2; exit 1; } ;;
  "resume actor "*|"suspend actor "*) af="$k/actors-$atespace.json" a="\${args[2]}"
    jq -e --arg a "$a" '.actors[]? | select(.metadata.name == $a)' "$af" >/dev/null 2>&1 || { echo "Error: actor not found" >&2; exit 1; }
    # ASS-568: a crashed actor (status.state ACTOR_STATE_CRASHED, as a test sets it) is refused as the real one refuses it.
    if [ "\${args[0]}" = resume ] && jq -e --arg a "$a" '.actors[] | select(.metadata.name == $a and .status.state == "ACTOR_STATE_CRASHED")' "$af" >/dev/null; then
      echo "Error: failed to resume actor: rpc error: code = FailedPrecondition desc = AssignWorker prerequisite not met for Actor: $atespace/$a (got: ACTOR_STATE_CRASHED, want ACTOR_STATE_SUSPENDED)" >&2; exit 1
    fi
    if [ "\${args[0]}" = resume ]; then
      running="$(jq --arg a "$a" '[.actors[] | select(.metadata.name != $a and .status.state == "ACTOR_STATE_RUNNING")] | length' "$af")"
      replicas="$(jq -r '.spec.replicas // 1' "$k/ns/$atespace/workerpool-$atespace.json" 2>/dev/null || echo 1)"
      [ "$running" -lt "$replicas" ] || { echo "Error: failed to resume actor: rpc error: code = ResourceExhausted desc = no worker has room for the actor" >&2; exit 1; }
      st=ACTOR_STATE_RUNNING
    else st=ACTOR_STATE_SUSPENDED; fi
    jq -c --arg a "$a" --arg s "$st" '.actors |= map(if .metadata.name == $a then .status = (if $s == "ACTOR_STATE_RUNNING" then { state: $s, workerAssignment: { workerPodUid: ("uid-" + $a) } } else { state: $s } end) else . end)' "$af" > "$af.new" && mv "$af.new" "$af"
    echo "\${args[0]}d $a" ;;
  "delete actor "*) af="$k/actors-$atespace.json" a="\${args[2]}"
    jq -c --arg a "$a" '.actors |= map(select(.metadata.name != $a))' "$af" > "$af.new" && mv "$af.new" "$af"; rm -rf "$k/sandboxes/$atespace/$a" "$k/egress-$atespace-$a.json"; echo "actor \"$a\" deleted" ;;
  # ASS-536: an actor's one egress policy (a singleton: metadata.name "default"), kept as egress-<atespace>-<actor>.json;
  # update needs the stored uid and version, as the real one does. A policy of an actor that is gone, NotFound.
  "get egress-policy "*) f="$k/egress-$atespace-\${args[2]}.json"; [ -f "$f" ] || { echo "Error: egress policy of actor \"\${args[2]}\" not found" >&2; exit 1; }; cat "$f" ;;
  "create egress-policy "*|"update egress-policy "*) f="$k/egress-$atespace-\${args[2]}.json" a="\${args[2]}"
    jq -e --arg a "$a" '.actors[]? | select(.metadata.name == $a)' "$k/actors-$atespace.json" >/dev/null 2>&1 || { echo "Error: actor \"$a\" in atespace \"$atespace\" not found" >&2; exit 1; }
    m="$(cat "\${file/#-//dev/stdin}")"
    jq -e '.metadata.name == "default" and (.rules | type == "array") and all(.rules[]; (.http // .https // .tls_passthrough) as $r | $r != null and ($r.hostnames | length > 0) and all($r.hostnames[]; test("^[a-z0-9*][a-z0-9.-]*$")))' <<< "$m" >/dev/null || { echo "Error: invalid EgressPolicy" >&2; exit 1; }
    if [ "\${args[0]}" = create ]; then
      [ ! -f "$f" ] || { echo "Error: egress policy already exists" >&2; exit 1; }
      jq -c '.metadata += { uid: "uid-1", version: "1" }' <<< "$m" > "$f"; echo "egress policy of \"$a\" created"
    else
      [ -f "$f" ] || { echo "Error: egress policy not found" >&2; exit 1; }
      jq -e --slurpfile cur "$f" '.metadata.uid == $cur[0].metadata.uid and .metadata.version == $cur[0].metadata.version' <<< "$m" >/dev/null || { echo "Error: precondition failed: uid or version" >&2; exit 1; }
      jq -c '.metadata.version = ((.metadata.version | tonumber) + 1 | tostring)' <<< "$m" > "$f"; echo "egress policy of \"$a\" updated"
    fi ;;
  "delete egress-policy "*) rm -f "$k/egress-$atespace-\${args[2]}.json"; echo "egress policy deleted" ;;
  "proxy actor "*) af="$k/actors-$atespace.json" a="\${args[2]}" port="\${args[3]%%:*}"
    jq -e --arg a "$a" '.actors[]? | select(.metadata.name == $a)' "$af" >/dev/null 2>&1 || { echo "Error: actor not found" >&2; exit 1; }
    # ASS-568: no proxy to a crashed actor (its worker is gone).
    if jq -e --arg a "$a" '.actors[] | select(.metadata.name == $a and .status.state == "ACTOR_STATE_CRASHED")' "$af" >/dev/null; then echo "Error: actor $a is CRASHED" >&2; exit 1; fi
    # A proxy resumes a suspended actor, as the real one does.
    jq -c --arg a "$a" '.actors |= map(if .metadata.name == $a then .status = { state: "ACTOR_STATE_RUNNING", workerAssignment: { workerPodUid: ("uid-" + $a) } } else . end)' "$af" > "$af.new" && mv "$af.new" "$af"
    exec node "\${FAKE_COMMAND_SERVER:?}" "$port" "$k/sandboxes/$atespace/$a/root" ;;
  *) echo "fake kubectl-ate: \${args[*]}" >&2; exit 1 ;;
esac
`;

const FAKE_ATE_SETUP = `#!/bin/bash
ARGV=("$@")
. "$(dirname "$0")/fake-cluster.bash"
kc="" repo="" tag=""
for ((i = 1; i <= $#; i++)); do case "\${!i}" in --kubeconfig) j=$((i + 1)); kc="\${!j}" ;; --image-repo) j=$((i + 1)); repo="\${!j}" ;; --image-tag) j=$((i + 1)); tag="\${!j}" ;; esac; done
default=false; [ -n "$kc" ] || [ -n "$KUBECONFIG" ] || default=true
log ate-setup "$kc" "$default"
[ -f go.mod ] || { echo "Error: no go.mod found above $PWD: run ate-setup from inside the repository" >&2; exit 1; }
cl="$(cluster_of "$kc")" k="$(dataroot)/containers/$(cluster_of "$kc")-control-plane/k8s"
[ -n "$cl" ] && [ -d "$k" ] || { echo "Error: while reading kubeconfig: context does not exist" >&2; exit 1; }
[ ! -e "$k/broken/install" ] || { echo "Error: while decoding a manifest document: fake failure" >&2; exit 1; }
echo "$repo $tag" > "$k/installed"
echo "recorded this configuration"
`;
