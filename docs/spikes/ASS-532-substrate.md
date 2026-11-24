# ASS-532: Can Agent Substrate run our ticket work, locally and on GKE, and how many tickets at once?

Spike findings, 2026-11-22 (local half only). Agent Substrate `main` at
`f5428049` (1.0 line), installed with its own tooling into kind on this Mac:
Apple M4 Pro, 14 cores, 48 GB, macOS 26.7.3. Docker Desktop 29.9.3 (raised to
16 GiB for the spike), kind v0.33.0 (node v1.37.0), Go 1.27.4, Lima 2.3.0.
The harness was stopped, but other overnight builds ran beside this spike:
the Mac's load average sat at 40 to 64 throughout, with 23 GB compressed.
**Every timing below was taken under that contention.** Read them as
ratios between runs taken minutes apart, not as absolute speeds.

Nothing on GCP was created. Each GKE answer is marked **not run: needs
operator approval**, and comes from Substrate's and substrate-gke's own
documentation and source, with the exact commands to run.

The scripts that reproduce every run are in [`ASS-532/`](ASS-532/) (listed at
the end).

## Summary

| # | Question | Answer |
|---|---|---|
| 1 | Does it install in kind? gVisor? microVM? | **Yes. gVisor: yes. microVM: not under Docker Desktop (no `/dev/kvm`). It does work inside a Lima VM with nested virtualization, but slowly.** |
| 2 | Tests and Docker-needing CI checks in a sandbox? | **The harness's tests pass in a sandbox (148/151 of a subset; the 3 failures are timing tests), but slowly. The subset took 2.4 times the Mac's time, and the full suite would take hours. Process creation is about 37 times slower in gVisor than in a plain container. Docker inside a sandbox: no, in either mode.** |
| 3 | A sandbox image from the golden definition, arm64 and amd64? | **Yes. `provision.sh` runs unchanged in a Dockerfile, plus the shared `git.sh`. amd64 builds under emulation.** |
| 4 | Hibernate a Claude Code session and resume it? Mid-turn? | **Gate: yes, with processes, memory and checkout kept. Mid-turn: survivable but not free. The in-flight request is reset, and Claude Code retries it after resume.** |
| 5 | Can a sandbox reach the Mac's forwarder? | **Locally: yes (`host.docker.internal`, an egress rule). From GKE: not run. It needs a reverse tunnel or relay.** |
| 6 | Density against a Lima VM? | **Memory: about 0.4 to 1.5 GiB per active ticket against about 4 GiB, and about 0 per hibernated one. CPU for process-heavy steps is the limit.** |
| 7 | GKE cost, nested virtualization? | **Not run. About $320 to $430 a month for a minimal cluster. Nested virtualization only on x86 C3/C4/N2/N4 pools, not E2.** |
| 8 | Egress gateway credential injection, Claude Code through it? | **Yes. The dummy GitLab and Anthropic credentials were injected and never seen in the sandbox. Claude Code worked through it. A rotation applied at once.** |

**Overall:** Substrate works on this Mac and solves the memory problem:
hibernated tickets cost nothing, and active ones a fraction of a VM. But it
is **not a drop-in replacement for Lima VMs for builds**, for two reasons:
- **No Docker inside a sandbox.** `SYS_ADMIN` is refused at admission in both
  modes.
- **gVisor is far slower for process-heavy work** on Apple Silicon
  (`fork`+`exec` about 37 times slower than runc in the same VM). The
  harness's test suite is exactly that kind of work.

The recommendations at the end change the Substrate tickets to match:
- Sandboxes for agent turns and light script steps.
- Lima or remote machines for Docker and heavy test steps.
- A measured GKE trial before ASS-535 commits to sandboxes as build machines.

---

## 1. Install in kind; gVisor and microVM

**Install (as the README says), times measured:**

```sh
git clone https://github.com/agent-substrate/substrate /tmp/ASS-532/src && cd /tmp/ASS-532/src
KIND_CLUSTER_NAME=ass532 hack/create-kind-cluster.sh            # 25 s
export ATE_INSTALL_KIND=true KIND_CLUSTER_NAME=ass532
go run ./cmd/ate-setup deploy ate-system --credential-provider='{"name":"k8s.io"}' \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-system/sa/atenet-client   # 4 min 06 s (first run builds every image with ko)
GOBIN=/tmp/ASS-532/bin go install ./cmd/kubectl-ate
```

- **gVisor runs.** The `sandbox` demo deployed in 63 s. Our own harness
  template built its golden snapshot in about 29 s, of which 7 s was pulling
  the 676 MB image.
- **Actors start fast.** `create actor` took 60 to 270 ms and `resume actor`
  120 to 700 ms. The actor's server answered 0.3 to 1.1 s after resume.
- **The install is a whole stack.** It installs postgres, rustfs (an S3
  store, holding the snapshots), the ate API server, controller, atelet,
  atenet router and egress gateway, a credential provider, a pod-certificate
  controller, and otel, jaeger and prometheus.
- **Its fixed cost is about 2.3 GiB** of anonymous memory in the kind node
  (section 6).

**microVM.**
- **Docker Desktop cannot run it.** `hack/create-kind-cluster.sh`'s probe
  fails (`docker run --device /dev/kvm busybox`: "error gathering device
  information while adding custom device "/dev/kvm": no such file or
  directory"). Docker Desktop's VM exposes no KVM, and has no setting for
  nested virtualization.
- **It does work with Substrate's documented Lima path** (docs/dev/microvm-local.md,
  Option B). The run used a separate `LIMA_HOME` so no harness VM was
  touched:
  ```sh
  LIMA_HOME=/tmp/ASS-532/lima limactl start --name=nested template:docker-rootful --cpus=6 --memory=12 --disk=60 --nested-virt
  # guest kernel 7.0 needs the GICv3 trap the doc names:
  #   GRUB_CMDLINE_LINUX_DEFAULT="… kvm-arm.vgic_v3_group1_trap=1", update-grub, restart
  DOCKER_HOST=unix:///…/nested/sock/docker.sock KIND_REGISTRY_PORT=5002 KO_DOCKER_REPO=localhost:5002 \
    KIND_CLUSTER_NAME=ass532vm hack/create-kind-cluster.sh   # "/dev/kvm found: micro-VM … support will be enabled"
  go run ./cmd/ate-setup --kind deploy ate-system …; go run ./cmd/ate-setup --kind deploy demo counter-microvm
  ```
  - The node advertised `ate.dev/kvm: 4096`.
  - `counter-microvm` built its golden snapshot in 42 s.
  - Its counter kept its in-memory, file and rootfs values across a suspend
    and resume ("preserved memory count: 4 | preserved file counter: 4 |
    preserved rootfs counter: 4").
- **Our harness template ran on microVM too:**
  - The golden snapshot took about 50 s.
  - Resume took 3.9 s the first time and 0.83 s later. The counter demo took
    5.8 to 6.8 s. Suspend took 2.2 to 8.1 s.
  - The guest kernel was 6.18.56, with its root on virtiofs.
  - **The microVM path is far slower than gVisor at process-heavy work** under
    nested virtualization (section 2).
- **It needs a second VM.** Locally, microVM means a Lima VM (12 GiB here)
  holding Docker, kind and Substrate all over again, beside Docker Desktop or
  instead of it.

Gotchas found on the way (each one matters for ASS-533 and ASS-535):
- **An actor larger than its worker never places.** A 4Gi worker pod
  advertises 3.94 GiB of capacity, so a 4 GiB actor can't place. The error
  ("the actor is larger than every eligible worker") is only in
  ate-api-server's log. `kubectl ate get actor-template` showed no error and
  no golden tag. A health check must look for the golden tag, and read the API
  server's log for why.
- **Images must be pinned by digest** ("must be pinned by digest (changing the
  image invalidates snapshots)").
- **Root in a sandbox has almost no capabilities** by default: `AUDIT_WRITE`,
  `KILL`, `NET_BIND_SERVICE`. It can't `sudo -u agent`, or even list the
  agent's home. The template must add `CHOWN, DAC_OVERRIDE, FOWNER, FSETID,
  SETUID, SETGID, SETFCAP, SETPCAP, SYS_CHROOT`, the most that is allowed (see
  `template.yaml.tmpl`).
- **There is no exec API.** Neither `kubectl ate` nor the ateapi gRPC service
  can run a command in an actor. The only way in is the actor's own port,
  through `kubectl ate proxy actor` or the atenet router. So the sandbox image
  must carry its own command server. The spike used the sandbox demo's
  `/process` server (`sx.sh` calls it). The router's response timeout is 5
  minutes (docs/guides/dataplane-timeouts.md), so long steps must run
  detached and be polled, or stream their output.

## 2. The project's tests and Docker-needing CI checks, in each mode

**The harness's own `npm test`** (node only). The baseline on the Mac (14
cores, test concurrency 13), under the contention above:
- 4119 tests: 4102 passed, 6 failed, 11 skipped.
- 1500 s.
- The 6 failures are timing and VM tests, and look like load. They are
  pre-existing, not this spike's.

In a gVisor sandbox (4 CPU, 3.5 GiB, test concurrency 3):
1. **The first image failed every worktree test.** It was the golden
   `provision.sh` only, which leaves git at 2.47. `code:create-worktree`,
   `automated-tests:*` and `merge-request:create` failed. The harness needs
   git 2.48 or later (`worktree add --relative-paths`), which the golden VM gets
   from the **shared** step `src/agent-cli/vm/golden-image/git.sh`, not from
   `provision.sh`. With `git.sh` added to the image, those tests pass.
2. **The full suite was far too slow to finish.** After about 15 minutes, 238
   tests had passed, with 2 failures: workstation and cloud-VM machine-layer
   tests, which may be timing. At that rate the 4119 tests would take 4 to 5
   hours, against 25 minutes on the Mac, so it was stopped. The runs were then
   compared on smaller units:

| Same moment, same image | Mac (native) | runc container in the kind node (same Docker VM) | gVisor sandbox | microVM sandbox (nested) |
|---|---|---|---|---|
| 500 × `/bin/true` (fork+exec) | 2216 ms | 643–962 ms | 24 057 ms | 50 × in 10 571 ms (≈ 106 000 ms for 500) |
| 200 × `echo {} \| jq .` | 1382 ms | 633–788 ms | 16 243 ms | — |
| 20 × `git status` | 352 ms | 245–275 ms | 6392 ms | 1 × in 553 ms |
| 20 × `node -e 0` | 5137 ms | 476–578 ms | 3703 ms | — |
| 2000 small files written and read | 1329 ms | 143–176 ms | 2241 ms | — |

- **gVisor against runc on the same kernel and VM:**
  - fork+exec is about 37 times slower.
  - git is about 26 times slower.
  - node startup is about 7 times slower.
  - small-file I/O is about 15 times slower.
- **Why:** Substrate runs `runsc` on the systrap platform, and on an arm64
  guest inside Docker Desktop every syscall trap is expensive. The harness's
  tests spawn bash, git and jq thousands of times.
- **A subset of test files:** `data-folder`, `single-instance`,
  `tui/blocked-tab`, `tui/chat-look`, `tui/collaboration`,
  `agent-cli/code` (151 tests):
  - Mac: 298 s, all passing.
  - gVisor sandbox: 148 of 151 passed in **703 s**, 2.4 times as long with 4
    CPUs against 14. The 3 failures are ASS-329's "a run past
    automated-test-run-minutes is stopped with everything it started" tests:
    timing tests that kill a process tree, which fail here as the timing
    stretches.
  - Just `agent-cli/code.test.js` (71 tests) took 227 s on the Mac, and in
    gVisor had 13 tests done after about 9 minutes when it was stopped.
- **microVM under nested virtualization was slower still.** About 210 ms per
  exec. The benchmark did not finish within the router's 5-minute window.
- **On GKE,** gVisor would run on x86 nodes (systrap or KVM platform), where
  syscall overhead is known to be much lower. That is **not measured**, and it
  is the first thing a GKE trial must measure.

**Docker inside a sandbox: no, in either mode.**
- **gVisor.** `dockerd` fails "Devices cgroup isn't mounted": nothing is
  mounted at `/sys/fs/cgroup`, and root can't mount. Asking for the
  capabilities Docker needs is **refused at admission**:
  `security_context.capabilities.add[9]: Unsupported value: "SYS_ADMIN":
  supported values: "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID",
  "KILL", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID",
  "SYS_CHROOT"` (and the same for `NET_ADMIN`).
- **microVM** (its own guest kernel). `dockerd` starts, but its managed
  containerd never comes up ("timeout waiting for containerd to start"), and
  root in the guest still can't mount (`mount: /mnt: permission denied`). The
  same capability list applies.
- **User namespaces do work in both** (`unshare -Urm` then `mount -t tmpfs`
  succeeds). So rootless podman or buildah with `vfs` storage *might* run
  containers inside a sandbox. That is **untested**: installing them needs
  egress to a package mirror, and the 2-hour time-box ran out. It would also
  be slow in gVisor.
- **So a project's CI checks or tests that need Docker** (docker compose,
  testcontainers, image builds) **can't run in a Substrate sandbox** as they
  do in a Lima VM. Those steps must run elsewhere: a Lima VM, a cloud VM, or a
  Cloud Build job.

## 3. Images: built from the golden definition; arm64 locally, amd64 on GKE

- **The golden definition runs unchanged as a Dockerfile.**
  [`ASS-532/image/Dockerfile`](ASS-532/image/Dockerfile) does it:
  - It runs the harness project's golden `provision.sh` as user `agent` with
    passwordless sudo, as in the VM. That took 18.5 s.
  - It runs the shared `git.sh` before it, which builds git 2.56.1 in 35 s.
  - The arm64 build took 1 min 44 s in all.
  - The image is 676 MB compressed and 2.2 GB unpacked.
  - It was pushed to the kind registry and pinned by digest.
- **What the Dockerfile needs that the VM doesn't:**
  - `curl` and `xz-utils` in the base image. The Lima cloud image has them,
    and `git.sh` assumes them: its first run failed with "curl: command not
    found".
  - The command server binary, and the repositories baked in. They stand in
    for `repositories.sh`. A sandbox has no egress unless its policy allows it,
    so `git fetch` at start needs a forge rule.
  - **Not** `desktop.sh` or `memory.sh` (VM kernel settings), `registry.sh`
    (the dockerd mirror, moot without Docker) or `finish.sh`.
- **`images.txt` (images baked in for Docker) has no meaning in a sandbox**,
  since there is no Docker.
- **amd64 for GKE.** GKE's supported machines are x86: C3 and up, not E2, and
  nested virtualization only on C3/C4/N2/N4. So the cluster needs a
  `linux/amd64` image. `ARCH=amd64 ./build-image.sh …` builds it under
  Docker Desktop's emulation in **4 min 47 s**, against 1 min 44 s native: `git.sh` took 88 s against 35 s, and `provision.sh` 85 s against 18.5 s. The result is a `linux/amd64` image with git 2.56.1 and node v24.22.3. A production build should use a
  native amd64 builder (Cloud Build, or a GKE node), or `docker buildx` with a
  remote amd64 builder, rather than emulate `git.sh`'s compile.
- **Trust bundle:** the template mounts the gateway's trust bundle at
  `/run/ate/egress-trust-bundle`, and sets `NODE_EXTRA_CA_CERTS`,
  `GIT_SSL_CAINFO` and `SSL_CERT_FILE` to it. Per Substrate's docs it must
  not be baked into the image, because it rotates.

## 4. Hibernation with a running Claude Code session

The setup, in a gVisor sandbox (`harness-net` template, with an egress policy):
- Three long-running processes (`tlshold.mjs`) stood in for a Claude Code
  session. No API and no key were used.
  - **A** holds one keep-alive TLS connection to an in-cluster server
    (`tls_passthrough` rule), with a request every 5 s.
  - **B** sends one request that the server answers only after 90 s, so it
    is in flight at the suspend.
  - **C** holds a keep-alive connection to `https://example.com` through
    the gateway's MITM (`https` rule).
- A file was written into the checkout.

Then `kubectl ate suspend --mode=sync`, a wait of about 55 s, and `resume`.

| | Result |
|---|---|
| Processes | **All survived**, with the same pids. Their 10 s ticks show the gap (01:14:59, then 01:16:04). |
| Checkout and files | **Kept** (`HIBERNATE-TEST.txt`, `git status` the same). |
| Idle keep-alive connections (A, C) | **Closed cleanly at the suspend** (`socket … closed hadError=false` at 01:15:00). After resume the clients opened new connections (a new local port) and carried on. No error reached the program. |
| In-flight request (B) | **Reset at the suspend:** `ECONNRESET socket hang up after 22264ms`. |
| Suspend / resume time | Sync suspend took 1.34 s (sandbox using 170 MB) and 6.5 s (after writing 4 GiB into it). Resume took 0.17 to 1.2 s: the CLI's wall time, and memory pages in lazily. |
| Snapshot size | 372 KB for an idle sandbox started from the golden snapshot. 1.1 GB (zstd) for the one with 4 GiB written. Stored in rustfs (S3). Locally also on the node, at `/var/lib/ate/snapshots`. |

**Mid-turn**
([`midturn.sh`](ASS-532/midturn.sh)). The test:
- Real Claude Code 2.1.330 in the sandbox, `claude -p "say hi"`.
- `ANTHROPIC_BASE_URL` pointed at the echo server's `/delay45`: a "model"
  that answers after 45 s, behind the gateway's injection, with a placeholder
  key.
- Suspended 12 s into the call, resumed 22 s later.

The result:
- **Claude Code survived and finished** (exit 0, the reply printed).
- **The upstream saw 3 model calls instead of the baseline's 2.** The first,
  sent at 01:19:42, was reset by the suspend. Claude Code's own retry sent it
  again at 01:20:16, 3 s after the resume, and the call was answered 45 s
  later.
- **So mid-turn hibernation is safe for correctness, but not free.** Every
  in-flight model call is abandoned and paid for again: its input tokens, and
  any output already streamed. Nothing is gained if the turn would have ended
  within the hibernation anyway.
- **The same reset hits any call in progress through the forwarder**, an
  `agent.sh` command. A half-run forwarder call is worse than a retried model
  call, because the command may have run on the Mac.

**Hibernate only when no agent turn and no in-machine script is running**
(ASS-537 AC1). Mid-turn hibernation (ASS-537 AC4) is not worth building; see
the recommendations.

## 5. Calling the Mac's `agent.sh` forwarder

**Locally: yes.**
- The forwarder listens on the Mac's `127.0.0.1:<forwarder-port>`
  (`src/control/forwarder.js`). The spike used a stand-in with the same shape
  ([`fake-forwarder.mjs`](ASS-532/fake-forwarder.mjs), on `127.0.0.1:18099`).
  It runs nothing, and refuses any token but one.
- From inside the sandbox it is reachable at `http://host.docker.internal:18099`.
  Docker Desktop maps that name to the Mac's loopback, as Lima maps
  `host.lima.internal`, and the caller appears as `127.0.0.1` there too.
- It needs one egress rule, `http: {hostnames: ["host.docker.internal"], ports: {numbers: [18099]}}`:
  - `POST /run {token, argv}` with the right token got back the NDJSON
    `{"o":…}{"exit":0}`.
  - A wrong token got `403`.
  - A sandbox with no such rule can't reach it. Egress is default-deny, and
    the name doesn't even resolve (`NXDOMAIN`).
- **Anything else in the Docker VM can reach the forwarder too**, such as
  another pod or container. On the network, only a sandbox's own egress policy
  stops it. So as with VMs, **the token is the real boundary.** ASS-536's
  "nothing else on the network can" holds for sandboxes, but not for every
  process in the Docker VM.

**From GKE: not run (needs operator approval).**
- **The Mac can't be dialled from GKE.** It sits behind NAT, and the forwarder
  is bound to loopback.
- **The workable shape is the one workstations already use** (ASS-433/435, a
  reverse forward made from the Mac's side):
  1. A small relay in the cluster: an sshd pod and its Service, for example
     `forwarder-relay.harness-system.svc:18099`.
  2. The Mac reaches it with `kubectl port-forward` to the pod's sshd.
  3. Over that, `ssh -R 18099:127.0.0.1:<forwarder-port>` carries the
     forwarder into the cluster.
  4. Each sandbox gets an `http` egress rule for the relay's Service only.
     Tokens and the allowlist work unchanged.
- **The alternative, a public endpoint for the forwarder, should not be used.**

## 6. Density: memory and CPU per active and per hibernated ticket

The figures are measured as the worker pods' own cgroups, which hold the
gVisor sandbox (`worker-mem.sh`), plus the kind node's memory.
[`density.sh`](ASS-532/density.sh) did the main run.

| | Memory | CPU |
|---|---|---|
| Substrate's fixed cost (kind node: k8s, Substrate, postgres, rustfs, otel) | **about 2.3 GiB** anon (on top of Docker Desktop's own VM). Plus about 4.8 GB of page cache, which is reclaimable. | 0.1 to 0.3 core idle |
| Warm worker pod, empty (per pool slot) | **about 24 MiB** anon (plus reclaimable cache) | ~0 |
| Sandbox overhead (Sentry, gofer, command server) | **about 40 MiB.** 8 sandboxes each holding 300 MB of heap came to 2919 MiB in all. | ~0 idle |
| Claude Code waiting on a model call | **534 MiB** RSS (2.1.330, a short prompt; long sessions grow) | ~0 while waiting |
| Running the harness tests | about 320 to 420 MiB peak per sandbox, beside an idle shell | as much as its 4-CPU limit allows |
| Files written into the sandbox | **Count as memory.** The rootfs overlay lives in the Sentry's memory. Writing 4 GiB of files grew the pod to 3440 MiB, and deleting them gave it back (64 MiB). `free` inside the sandbox doesn't show it. | — |
| **Hibernated ticket** | **0.** Its worker went back to about 24 MiB anon. The snapshot is on disk (372 KB to 1.1 GB). | 0 |
| Lima VM, for comparison | About its configured **4 GiB** once used. Lima's vz VMs can't give memory back (docs/ASS-421-vm-memory.md, ASS-419), and control counts a VM at its configured memory once it has been seen there. | 4 vCPU |

**How many tickets at once on this Mac** (48 GB, the harness's default budget
`max-memory-percent 90`, so about 43 GB):
- **Lima today:** about 43 / (4 GiB + margin) ≈ **9 to 10 tickets in VMs**.
  A ticket waiting at a gate keeps its VM (a stopped VM frees memory, but its
  processes are lost).
- **Substrate, by memory:**
  - Docker Desktop's VM sized to about 36 GB leaves about 33 GB for
    sandboxes, after Docker's own VM and the 2.3 GiB fixed cost.
  - A harness-like ticket's sandbox (Claude Code plus tests plus a small
    checkout) takes about 1 to 1.5 GiB: **about 20 to 30 active tickets**.
  - A client project with GBs of `node_modules` or build output in its rootfs
    takes 3 to 4 GiB: **about 8 to 10 active**, no better than Lima for those.
  - **Hibernated tickets are free** in memory, and limited by disk only.
- **Substrate, by CPU:** process-heavy script steps run 10 to 37 times slower
  in gVisor here.
  - A Build that runs tests in the sandbox would hold its CPU many times
    longer than a VM does, so **with 14 cores, CPU, not memory, sets the
    ceiling for steps that run tests.**
  - Agent turns (mostly waiting on the model) cost almost no CPU.
- **Kubernetes requests:** a warm pool slot reserves its memory *request*,
  even empty. The spike's pool requested 256Mi per worker (overcommitted on
  purpose) with a 4Gi limit. Requests must be set low, and placement left to
  Substrate's capacity accounting.

## 7. GKE: cost against the e2-standard-4 plan, nested virtualization

**Not run: needs operator approval.** The figures below are from the GKE
installation guide (docs.cloud.google.com, "install-overview-substrate") and
`ai-on-gke/substrate-gke` (the installer, `tools/setup-gcp`).

**Requirements:**
- GKE **Standard** (not Autopilot), 1.37 or later, with Dataplane V2.
- Machine types `c3-standard-4` or larger. **"Mixed-CPU-architecture series
  such as E2 aren't supported"**, so the harness's e2-standard-4 VMs can't be
  Substrate nodes.
- **Nested virtualization for microVM:** a node pool created with nested
  virtualization on C3, C4, N2 or N4 (x86), which the installer does by
  default (`--enable-nested-virtualization=true`). It can't be added to an
  existing pool.
- gVisor needs nothing extra.
- Arm machines (C4A, T2A) aren't listed.

**What the installer creates:**
- APIs, and the node service account.
- The cluster: 1.37 on Rapid, DNS-endpoint only.
- A `c3-standard-4` workload pool.
- By default **two extra one-node `e2-standard-4` system pools**
  (`ate-system-infra`, `ate-postgres`).
- A snapshot bucket and an `-assets` bucket.
- The `ate-snapshot-transfer` service account and IAM bindings.
- Monitoring dashboards.
- Optionally an Artifact Registry repository.
- **A 500 GiB PersistentDisk for postgres, kept after the cluster is
  deleted.** It needs deleting separately.

**Estimated monthly cost** (on-demand list prices, us-central1; europe-west1
is about 10% higher):

| Option | Parts | ≈ / month |
|---|---|---|
| Installer default, zonal | 1 × c3-standard-4 workload node ($152), 2 × e2-standard-4 system nodes ($196), 500 GiB pd-balanced for postgres ($50), boot disks ($30). The GKE fee ($73) is covered by the free tier ($74.40, one zonal cluster per billing account). Buckets and snapshots: a few dollars. | **≈ $430** |
| Minimal | 1 × c3-standard-8 for everything (`SEPARATE_SYSTEM_NODES=false`; postgres requests 2 vCPU), postgres disk cut to 10 GiB (the `postgres-size10` overlay), boot disk ($10) | **≈ $320** |
| Plain VM plan (memory: `gce-vm-plan`) | 5 × e2-standard-4 at about $108 each: 5 tickets at once, stopping themselves when idle | ≈ $540 at full use, less when idle |

**Capacity:**
- **A c3-standard-8** (8 vCPU, 32 GB):
  - Memory holds about 12 to 20 active harness-like sandboxes.
  - CPU allows about 2 to 4 test-heavy builds at once.
  - It holds any number of hibernated tickets.
- **Node-pool autoscaling** to zero for the workload pool (the system pools
  stay) cuts idle cost toward the fixed ~$200.
- **gVisor's speed on GKE's x86 nodes is the open question.** Its overhead
  there should be much lower than the 37 times measured here, but the trial
  must measure it.

**Commands for the trial** (they create billable resources: run only with
approval):

```sh
export PROJECT=<gcp-project> ZONE=europe-west1-b CLUSTER=harness-substrate
gcloud auth application-default login
gcloud services enable container.googleapis.com --project "$PROJECT"
git clone https://github.com/ai-on-gke/substrate-gke && cd substrate-gke
make dry-run                                     # walks the wizard, touches nothing
NODE_MACHINE_TYPE=c3-standard-8 SEPARATE_SYSTEM_NODES=false \
  CLUSTER_NAME="$CLUSTER" CLUSTER_LOCATION="$ZONE" make run
# then: the spike's pool/template (ARCH=amd64 image), bench.sh, per-file.sh and the npm test subset
# teardown: the command the wizard prints at the end, then delete the postgres PD it leaves behind
```

## 8. Egress gateway: credentials that never enter the sandbox

The setup ([`egress.yaml`](ASS-532/egress.yaml),
[`egress-policy.yaml`](ASS-532/egress-policy.yaml)):
- **Credentials:** dummy ones only (`sk-ant-DUMMY-…`, `glpat-DUMMY-…`), held
  as Kubernetes Secrets.
- **The grant:** the bundled `k8s.io` provider's namespace policy lets the
  `harness-tickets` atespace use them.
- **The upstream:** an in-cluster echo server stands in for GitLab and the
  Anthropic API.

| Check | Result |
|---|---|
| Sandbox holds no token | The environment has none, and no file under `/etc /home /root /run` holds one. |
| `x-api-key: placeholder` (Anthropic) | Arrived upstream as `sk-ant-DUMMY-not-a-real-key-1` |
| `PRIVATE-TOKEN: placeholder` (GitLab API) | Arrived as `glpat-DUMMY-not-a-real-token-1` |
| git over HTTPS (`curl -u oauth2:placeholder`, `Authorization: Basic`) | Arrived as `Basic <base64(oauth2:glpat-DUMMY-…)>`. **The gateway prefixes but doesn't encode**, so the Secret must hold the pre-encoded value. |
| A request without the header | Forwarded untouched, nothing injected |
| **Claude Code through it** | `ANTHROPIC_BASE_URL=http://echo…`, `ANTHROPIC_API_KEY=placeholder-not-a-key`: Claude Code 2.1.330 ran `claude -p` to completion. The upstream received the injected dummy key, and Claude Code printed the reply. |
| Rotation | Re-saving the Secret applied to the very next request (02:15:55), with no sandbox restart. The provider caches for at most 10 s. |
| Refused host | `https://example.com` with no rule: the connection was closed (curl `000`). A port with no rule: `403`. The gateway's `ext-proc` logs `egress denied: no rule allows the destination` with the actor's name. **A name with no rule gets `NXDOMAIN` from the sandbox's DNS relay, and nothing logs that.** |
| https (MITM) injection | Works against a public upstream: `https://example.com` through an `https` rule gave 200, with node `fetch` and git trusting the projected bundle. **Against the self-signed in-cluster server it gave 503:** the gateway checks the upstream's certificate. A self-hosted GitLab with a private CA would need the gateway to trust that CA. |

**Notes for ASS-538:**
- **No SSH.** git must use HTTPS: every TCP that isn't HTTP(S) or TLS
  passthrough is blocked.
- **Untested: Claude's subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`,
  `Authorization: Bearer`). It should inject the same way, but a forge's
  `Authorization` rule on the same host would clash. They are different hosts
  in practice.
- **No real token was used anywhere.**

---

## Recommendations for the Substrate tickets

| Ticket | Verdict | Changes |
|---|---|---|
| **ASS-533** Cluster per project, set up and health-checked | **Changed** | Several changes:<br>• **Local microVM isn't possible under Docker Desktop.** Local means gVisor in Docker Desktop's kind, or a separate Lima VM with nested virtualization (12 GiB here, and slow).<br>• **Each cluster costs about 2.3 GiB fixed plus its stack.** A cluster per project multiplies that. Put to the operator: one local cluster per project as decided, or one cluster with a WorkerPool and atespace per project (the pool is the machine that belongs to one project).<br>• **Pin a release, and install from published images** (`--image-repo ghcr.io/agent-substrate/substrate --image-tag vX`). A source install takes 4 minutes with Go and ko.<br>• **The health check must cover more than pods:** the golden tag of the project's template, because a template error shows only in ate-api-server's log; rustfs and postgres; and Docker Desktop's VM memory.<br>• **GKE half: only after the operator approves a trial** (section 7). |
| **ASS-534** Golden environment also as a container image | **Go, with changes** | • The build runs `git.sh` and `provision.sh` from the same definition (shown). It adds curl and xz, the command server, and the repositories in place of `repositories.sh`.<br>• Skip `desktop.sh`, `memory.sh`, `registry.sh` and `images.txt`.<br>• Push to the project's zot, and pin by digest.<br>• amd64 for GKE through a native or remote builder.<br>• **AC3 ("passes the project's automated tests") must exclude Docker-needing tests, and allow for gVisor's speed.** |
| **ASS-535** Sandboxes as a machine kind | **Changed: hold until a GKE trial** | Several changes:<br>• **Command server:** there is no exec API, so `machine-substrate.js` needs a command server in the image (streaming output, detached long steps, the router's 5-minute response timeout), reached through `kubectl ate proxy` or the router.<br>• **Capabilities:** the template must add the allowed set so sudo works.<br>• **AC4 (full Build in one sandbox) can't hold for projects whose tests or CI checks need Docker**, and is impractical locally for process-heavy test steps (37 times slower). Let a project's mode send Docker or heavy script steps to a Lima, cloud VM or workstation seat, and keep agent turns and light steps in the sandbox. Or decide after measuring on GKE x86.<br>• **Seats:** count a sandbox's rootfs writes as its memory. |
| **ASS-536** Forwarder from sandboxes | **Go, with a change** | • **Locally** it works through `host.docker.internal` plus one egress rule (shown).<br>• **AC2 for GKE needs a reverse tunnel or relay** (section 5), built as the workstation reverse-forward is.<br>• **Reword "nothing else on the network can":** the egress policy keeps other sandboxes out, but any process in the Docker VM can reach the port, so the per-sandbox token stays the boundary. |
| **ASS-537** Hibernate when the seat is given up | **Go; drop AC4** | • **Verified:** processes, memory and files survive; resume takes 0.2 to 1.2 s locally; a hibernated ticket uses 0 memory and 0 CPU (AC1 to AC3).<br>• **Drop AC4 (mid-turn), for the spike's reason:** suspend resets every connection. Claude Code survives by retrying, but the in-flight model call is wasted and paid twice, and a forwarder call in flight could be cut half-done.<br>• **Hibernate only with no agent and no script running.**<br>• **Add:** the warm pool's k8s memory requests, and snapshot disk use (up to GBs per ticket), count in the budget. |
| **ASS-538** Credentials through the egress gateway | **Go, with changes** | • Injection, rotation and refusal all work (shown).<br>• **AC2:** sync each keychain item to a k8s Secret, which applies within 10 s.<br>• **git:** the Secret holds the pre-encoded Basic value, and git must use HTTPS (no SSH).<br>• **AC3:** gateway denials are logged, but **DNS refusals aren't**. Accept that, or log at the DNS relay upstream.<br>• **Private-CA forges** need the gateway to trust their CA.<br>• **AC4:** `credentials-status` checks the provider pod, its namespace policy, and that each Secret exists. |
| **ASS-539** Dashboard, warnings, docs | **Go, after the others** | **Add warnings:**<br>• a template with no golden snapshot (with the API server's reason);<br>• Docker Desktop's VM memory or the Lima nested VM down;<br>• snapshot disk use.<br><br>**Add docs:** the capabilities the template needs, and that Docker steps don't run in sandboxes. |

## Teardown (done)

- **kind cluster** `ass532`, its registry container `kind-registry` and the
  `kind` Docker network: deleted (`KIND_CLUSTER_NAME=ass532
  hack/delete-kind-cluster.sh`, `docker network rm kind`). Its kubectl context
  went with it.
- **Docker leftovers removed:** every image the spike pulled or built (the
  sandbox images, `kindest/node`, `registry:3`, `amazon/aws-cli`, which
  ate-setup used for the asset upload, `busybox`, `tonistiigi/binfmt`), two
  anonymous volumes, and the 11.2 GB of buildx cache. All of these were
  created during the spike; Docker held no images or containers before it.
- **Lima VM** `nested` (`LIMA_HOME=/tmp/ASS-532/lima`): stopped and deleted,
  and the folder removed. Its kind context, cluster and user were removed from
  `~/.kube/config`. The harness's Lima VMs under `/Volumes/PrimaryStorage/lima`
  were never touched.
- **Docker Desktop memory: back to the original.**
  - The spike had added `"MemoryMiB": 16384` to
    `~/Library/Group Containers/group.com.docker/settings-store.json`, after
    keeping a copy of the file.
  - The original had no `MemoryMiB` key: Docker's default, 7.748 GiB in
    `docker info`.
  - The original file was put back, and Docker Desktop restarted.
  - **The first restart failed.** Docker Desktop's VM "stopped unexpectedly"
    while quitting, and Desktop stood at its error dialog. `docker desktop
    stop --force` then `docker desktop start` brought it back, and
    `docker info` again shows **14 CPUs, 7.748 GiB**, with the original
    settings file. Nothing was reset.
- **kubectl's current context:** kind made `kind-ass532` the current context.
  Which context was current before the spike is unknown. None is set now. The
  operator's other two contexts are untouched.
- **Docker Desktop trouble during the spike:** for the last hour, new
  `docker run` containers stuck at `Created` (a runc pod in kind was used
  instead), and builds and the kind cluster kept working. That points to
  Docker Desktop under the Mac's memory pressure (23 GB compressed), not to
  Substrate. It cleared with the restart.
- **Left in place:** `go` and `kind` (Homebrew, approved), and
  `/tmp/ASS-532`: the Substrate and substrate-gke checkouts and the notes.
  Safe to delete.

## Reproducing

All of these are in [`docs/spikes/ASS-532/`](ASS-532/). Each script's header
says how to run it.

| File | What it is |
|---|---|
| `image/Dockerfile`, `image/provision.sh`, `build-image.sh` | The sandbox image from the harness golden definition (plus `git.sh`), arm64 or amd64 (`ARCH`) |
| `pool.yaml.tmpl`, `pool-microvm.yaml.tmpl`, `template.yaml.tmpl` | WorkerPools (gVisor, microVM) and the ActorTemplate (capabilities, trust bundle) |
| `up.sh`, `sx.sh` | Create, resume and proxy a sandbox; run a command in it |
| `per-file.sh`, `bench.sh` | Test files or the suite in a sandbox, and the process and file benchmark |
| `tlshold.mjs`, `resume-check.sh`, `midturn.sh` | The hibernation tests (held connections, in-flight request, Claude Code mid-turn) |
| `echo-server.mjs`, `echo-server.yaml` | The in-cluster upstream (echo, slow, a fake Messages API) |
| `egress.yaml`, `egress-policy.yaml` | Dummy credentials, the provider grant, a sandbox's egress policy |
| `fake-forwarder.mjs` | A forwarder stand-in on the Mac's loopback |
| `worker-mem.sh`, `density.sh` | Memory per worker pod, and the density run |
