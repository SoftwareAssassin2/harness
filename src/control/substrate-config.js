// ASS-533: a project's Substrate clusters — project.json's
// dev-environments.substrate.clusters, read here for control, the dashboard and,
// through agent-cli/substrate.js, the substrate:* commands. dev-environments.substrate
// is one object both tickets share: ASS-540's needs-docker (run-targets.js) beside
// this list; run-targets.js asks clusterHosts which kinds of host have a cluster.
//
//   "dev-environments": {
//     "substrate": {
//       "clusters": [
//         { "machine": "mac" },                 kind on the Mac (Docker Desktop), gVisor
//         { "machine": "<workstation id>" },    kind on that workstation, gVisor
//         { "machine": "<cloud VM id>" },       kind on that cloud VM, gVisor
//         { "machine": "gke", "gcp-project": "…", "location": "…", "cluster": "…" }
//       ],
//       "needs-docker": [ … ],                  ASS-540's
//       "egress": { "allow": [ "<host>", … ] }  ASS-538's: hosts its sandboxes may reach besides the defaults
//     }
//   }
//
// Each entry names the machine its cluster runs on: "mac", one of the
// project's own workstations or cloud VMs (dev-environments.workstations /
// cloud-vms, by id), or "gke". Machines are never shared between projects, so
// a remote machine's cluster is its project's alone. The Mac's is one kind
// cluster every project on the Mac shares (harness-substrate): Substrate's
// fixed cost is about 2.3 GiB (ASS-532 section 6), so one cluster for the
// three Mac projects saves two of those; each project gets its own WorkerPool
// (its workers, which run only its sandboxes: the project's machine), its own
// namespace and atespace (harness-<project>), and its own kubeconfig file
// under ~/.harness/ — the operator's decision of 2026-11-22 left the choice to
// the cheaper of the two, recorded here.
//
// A GKE entry is accepted by validation (its gcp-project, location and
// cluster are named) but refused at setup (substrate:up) until the operator
// approves a GKE trial (ASS-532 section 7): GKE_REFUSED.
//
// Optional per entry, the costs counted against the host's limits (AC5:
// seat-budget.js for the Mac, remote-seats.js for a remote machine) and the
// shape of its workers:
//   memory-gib (2.5)           the cluster's fixed memory: k8s, Substrate,
//                              postgres, rustfs, otel (2.3 GiB measured)
//   cpu-percent (30)           its fixed CPU, percent of one core (0.1–0.3 measured idle)
//   sandbox-memory-gib (1.5)   one active sandbox's memory (0.4–1.5 GiB measured); on the Mac
//                              the floor of the per-ticket estimate (ASS-570, ticket-estimate.js)
//   sandbox-cpu-percent (100)  one active sandbox's CPU; likewise its floor
//   warm-workers (1)           the WorkerPool's warm workers (its replicas)
//   worker-memory-gib (4), worker-cpus (4)   one worker's limits (a sandbox's ceiling)
// Validation names every bad field, as devEnvironmentsErrors does; a project
// with no substrate list has none and nothing changes for it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { egressErrors } from '../substrate/egress.js';

const at = 'dev-environments.substrate.clusters';
export const MAC = 'mac';
export const GKE = 'gke';
export const MAC_CLUSTER = 'harness-substrate';
export const SUBSTRATE_FILE = 'substrate.json';
export const GKE_REFUSED = 'GKE is not approved yet: a GKE cluster waits for the operator to approve a trial (docs/spikes/ASS-532-substrate.md section 7); until then only kind clusters (on the Mac, a workstation or a cloud VM) are set up';
export const GKE_FIELDS = ['gcp-project', 'location', 'cluster'];
export const DEFAULTS = Object.freeze({
  'memory-gib': 2.5, 'cpu-percent': 30, 'sandbox-memory-gib': 1.5, 'sandbox-cpu-percent': 100,
  'warm-workers': 1, 'worker-memory-gib': 4, 'worker-cpus': 4,
});
// Each optional number's bounds: [min, max, integer].
const NUMBERS = {
  'memory-gib': [0.5, 64, false], 'cpu-percent': [0, 1600, false], 'sandbox-memory-gib': [0.1, 64, false], 'sandbox-cpu-percent': [0, 1600, false],
  'warm-workers': [0, 32, true], 'worker-memory-gib': [0.5, 64, false], 'worker-cpus': [0.5, 64, false],
};
const isText = v => typeof v === 'string' && v.trim() !== '';
const GIB = 1024 ** 3;

// remoteIds(json) — the ids of project.json's workstations and cloud VMs, read from the file itself (not
// devEnvironments: a wrong dev-environments is reported there, and a substrate entry is judged on the ids it lists).
function remoteIds(json) {
  const d = json?.['dev-environments'] ?? {};
  const ids = new Map();
  for (const w of Array.isArray(d.workstations) ? d.workstations : []) if (isText(w?.id)) ids.set(w.id, 'workstation');
  for (const w of Array.isArray(d['cloud-vms']) ? d['cloud-vms'] : []) if (isText(w?.id) && !ids.has(w.id)) ids.set(w.id, 'cloud-vm');
  return ids;
}

// substrateErrors(json) — AC1: what is wrong with project.json `json`'s dev-environments.substrate.clusters, each naming the
// field: substrate not an object (ASS-540's shape), clusters not a list; an entry not an object, without a machine, or naming one that is neither mac, gke nor one of the
// project's workstations or cloud VMs; two entries for one machine; a GKE entry missing gcp-project, location or
// cluster; an optional number out of its bounds; an unknown field. [] when there is none or nothing is wrong.
export function substrateErrors(json) {
  const sub = json?.['dev-environments']?.substrate;
  if (sub === undefined || sub === null) return [];
  if (typeof sub !== 'object' || Array.isArray(sub)) return ['dev-environments.substrate is not an object'];
  const list = sub.clusters;
  // ASS-538: its egress allowlist's additions (src/substrate/egress.js).
  if (list === undefined || list === null) return egressErrors(json);
  if (!Array.isArray(list)) return [`${at} is not a list`, ...egressErrors(json)];
  const errors = [...egressErrors(json)], seen = new Set(), ids = remoteIds(json);
  for (const [i, e] of list.entries()) {
    const field = `${at}[${i}]`;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) { errors.push(`${field} is not an object`); continue; }
    const m = e.machine;
    if (!isText(m)) { errors.push(`${field}.machine is ${m === undefined ? 'missing' : 'not a non-empty string'}`); continue; }
    if (ids.has(m) && (m === MAC || m === GKE)) errors.push(`${field}.machine ${JSON.stringify(m)} is ambiguous: a ${ids.get(m)} has that id too`);
    else if (m !== MAC && m !== GKE && !ids.has(m)) errors.push(`${field}.machine ${JSON.stringify(m)} is not "mac", "gke" nor one of the project's workstations or cloud VMs (${[...ids.keys()].join(', ') || 'it has none'})`);
    if (seen.has(m)) errors.push(`${field}.machine ${JSON.stringify(m)} has an earlier entry too (one cluster per machine)`);
    seen.add(m);
    if (m === GKE) for (const f of GKE_FIELDS) if (!isText(e[f])) errors.push(`${field}.${f} is ${e[f] === undefined ? 'missing' : 'not a non-empty string'} (a GKE entry names its gcp-project, location and cluster)`);
    for (const [f, [min, max, integer]] of Object.entries(NUMBERS)) {
      const v = e[f];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) errors.push(`${field}.${f} is not ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    }
    for (const f of Object.keys(e)) if (f !== 'machine' && !(f in NUMBERS) && !(m === GKE && GKE_FIELDS.includes(f))) errors.push(`${field}.${f} is not a substrate setting (${['machine', ...Object.keys(NUMBERS), ...(m === GKE ? GKE_FIELDS : [])].join(', ')})`);
  }
  return errors;
}

// substrateEntries(json) — the project's clusters, each { machine, kind ('kind' or 'gke'), host ('mac', 'workstation',
// 'cloud-vm' or 'gke'), cluster (the kind cluster's name; GKE's own), namespace (its namespace and atespace,
// harness-<project id>, set by projectSubstrate), …DEFAULTS filled in, and a GKE entry's GKE_FIELDS }; [] when it has
// none. Throws, naming every bad field (substrateErrors), when they are wrong: nothing is set up on a guess.
export function substrateEntries(json) {
  const errors = substrateErrors(json);
  if (errors.length) throw new Error(`project.json: ${errors.join('; ')}`);
  const ids = remoteIds(json);
  return (json?.['dev-environments']?.substrate?.clusters ?? []).map(e => {
    const host = e.machine === MAC ? MAC : e.machine === GKE ? GKE : ids.get(e.machine);
    const numbers = Object.fromEntries(Object.keys(NUMBERS).map(f => [f, e[f] ?? DEFAULTS[f]]));
    return {
      machine: e.machine, kind: host === GKE ? 'gke' : 'kind', host,
      cluster: host === GKE ? e.cluster : MAC_CLUSTER,
      ...numbers,
      ...(host === GKE ? Object.fromEntries(GKE_FIELDS.map(f => [f, e[f]])) : {}),
    };
  });
}

// clusterHosts(json) — ASS-540's question: the kinds of host project.json `json` declares a kind cluster on, a Set of
// 'local' (a mac entry), 'workstation' and 'cloud-vm' (an entry naming one of its workstations or cloud VMs); a gke
// entry gives none until GKE is approved. Read leniently (entries substrateErrors finds wrong add nothing).
export function clusterHosts(json) {
  const list = json?.['dev-environments']?.substrate?.clusters, ids = remoteIds(json), hosts = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!isText(e?.machine)) continue;
    if (e.machine === MAC) hosts.add('local');
    else if (ids.has(e.machine)) hosts.add(ids.get(e.machine));
  }
  return hosts;
}

// projectSubstrate(projectsDir, project) — substrateEntries of <projectsDir>/<project>/project.json, each with its
// namespace (harness-<project>); throws without one, or when it is wrong.
export function projectSubstrate(projectsDir, project) {
  const file = join(projectsDir, project ?? '', 'project.json');
  if (!/^[A-Za-z0-9_-]+$/.test(project ?? '') || !existsSync(file)) throw new Error(`no project ${project}`);
  return substrateEntries(JSON.parse(readFileSync(file, 'utf8'))).map(e => ({ ...e, namespace: namespaceOf(project) }));
}

// namespaceOf(project) — its namespace and atespace in a cluster: harness-<project>, lower case (a k8s name).
export const namespaceOf = project => `harness-${String(project).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

// entriesOf(project) — a loaded project's (state.js: its json) substrate entries, [] while they are wrong.
export function entriesOf(project) {
  try { return substrateEntries(project?.json).map(e => ({ ...e, namespace: namespaceOf(project.id) })); } catch { return []; }
}

// loadSubstrate(dir, read) — the project's live data, data/projects/<p>/substrate.json: { "<machine>": { state,
// problems, checked-at, usage, up, … } } as substrate:health and substrate:up record it; {} without one, or while it is
// half-written.
export function loadSubstrate(dir, read = f => JSON.parse(readFileSync(f, 'utf8'))) {
  const file = join(dir, SUBSTRATE_FILE);
  try { return existsSync(file) ? read(file) ?? {} : {}; } catch { return {}; }
}

// SANDBOX_FAILURES_FILE — ASS-539 AC2: control's record of the variations whose sandbox could not be made or resumed
// (sandboxes.js recordSandboxFailures), data/projects/<p>/sandbox-failures.json; loadSandboxFailures(dir) its list, []
// without one or while it is half-written.
export const SANDBOX_FAILURES_FILE = 'sandbox-failures.json';
export function loadSandboxFailures(dir, read = f => JSON.parse(readFileSync(f, 'utf8'))) {
  const file = join(dir, SANDBOX_FAILURES_FILE);
  try { const list = existsSync(file) ? read(file)?.failures : []; return Array.isArray(list) ? list : []; } catch { return []; }
}

// SANDBOX_ARCHES, sandboxImageFiles(dir, arch) — ASS-539 AC2: the sandbox image's files substrate:build-image writes
// beside the project's sandbox folder (agent-cli/substrate/sandbox-image.bash): its label (sandbox-image-<arch>.json,
// the last image built) and its last build's run (sandbox-image-<arch>-build.json { hash, started-at, ended-at,
// exit-code }), and that build's log. loadSandboxImages(dir) — { <arch>: { label, run, log } } for each architecture
// with a run or a label; {} for a project that never built one.
export const SANDBOX_ARCHES = ['amd64', 'arm64'];
export const sandboxImageFiles = (dir, arch) => ({
  label: join(dir, `sandbox-image-${arch}.json`), run: join(dir, `sandbox-image-${arch}-build.json`), log: join(dir, `sandbox-image-build-${arch}.log`),
});
export function loadSandboxImages(dir, read = f => JSON.parse(readFileSync(f, 'utf8'))) {
  const out = {};
  for (const arch of SANDBOX_ARCHES) {
    const f = sandboxImageFiles(dir, arch);
    const get = file => { try { return existsSync(file) ? read(file) : null; } catch { return null; } };
    const label = get(f.label), run = get(f.run);
    if (label || run) out[arch] = { label, run, log: f.log };
  }
  return out;
}

// imageBuildFailed(image) — ASS-539 AC2: a project's sandbox image of one architecture (loadSandboxImages') whose last
// build ended without succeeding (an exit code, not 0) and has not been built since: no label of that build's inputs.
// A build still running, or cut short (no end), is not a failure here (substrate:image-status says "building").
export const imageBuildFailed = image => Boolean(image?.run?.['ended-at'] && image.run['exit-code'] != null && image.run['exit-code'] !== 0
  && image.run.hash !== image.label?.hash);

// sandboxUse(live) — ASS-535 AC3: the project's sandboxes on the cluster as its last check measured them
// (substrate:health's usage.sandbox-use: each one's worker pod cgroup, its rootfs writes included), [{ actor, state,
// memory (bytes), cpu (percent of one core) }]; [] with none measured.
export function sandboxUse(live) {
  const each = live?.usage?.['sandbox-use'];
  if (!each || typeof each !== 'object') return [];
  return Object.entries(each).map(([actor, u]) => ({ actor, state: u?.state ?? null, memory: Math.max(0, Number(u?.['memory-bytes']) || 0), cpu: Math.max(0, Number(u?.['cpu-percent']) || 0), snapshot: Math.max(0, Number(u?.['snapshot-bytes']) || 0) }));
}
const ACTIVE = new Set(['running', 'resuming', 'suspending']);

// activeSandboxes(entry, live) — AC3: each active sandbox's { actor, memory, cpu }: its measured use, or the entry's
// sandbox-memory-gib / sandbox-cpu-percent where none was measured (not checked since it started); a suspended
// (hibernated) one is not active and uses nothing. Without per-sandbox figures (a check before ASS-535), usage.sandboxes
// of them at the entry's figures.
export function activeSandboxes(entry, live) {
  const use = sandboxUse(live);
  const at = u => ({ actor: u.actor, memory: u.memory > 0 ? u.memory : entry['sandbox-memory-gib'] * GIB, cpu: u.memory > 0 ? u.cpu : entry['sandbox-cpu-percent'] });
  if (use.length) return use.filter(u => ACTIVE.has(u.state)).map(at);
  const n = Math.max(0, Number(live?.usage?.sandboxes) || 0);
  return Array.from({ length: n }, (_, i) => at({ actor: `#${i}`, memory: 0, cpu: 0 }));
}

// sandboxNeed(entry, live) — AC3: one more ticket's sandbox's expected use, { memory, cpu }: the average of the
// project's active sandboxes' measured use, the entry's sandbox-memory-gib / sandbox-cpu-percent with none measured.
// No longer what seats are sized by — idle sandboxes lowered it: ticket-estimate.js is, on the Mac (ASS-570) and on
// remote machines (ASS-574); kept for its tests and as the plain average.
export function sandboxNeed(entry, live) {
  const measured = sandboxUse(live).filter(u => ACTIVE.has(u.state) && u.memory > 0);
  if (!entry) return null;
  if (!measured.length) return { memory: entry['sandbox-memory-gib'] * GIB, cpu: entry['sandbox-cpu-percent'] };
  return { memory: Math.max(256 * 1024 ** 2, measured.reduce((a, u) => a + u.memory, 0) / measured.length), cpu: Math.max(10, measured.reduce((a, u) => a + u.cpu, 0) / measured.length) };
}

// WORKER_REQUEST — a worker's memory request when its check reported none: on-machine substrate.sh's WorkerPool's (256Mi).
export const WORKER_REQUEST = 256 * 1024 ** 2;

// warmPool(entry, live) — ASS-537 AC3: the project's WorkerPool's idle workers, { workers, idle, request (bytes each),
// memory (bytes) }. Kubernetes reserves each worker pod's memory request even while it is empty (ASS-532 section 6), so
// a warm worker — one running no sandbox: the pool's replicas less its active sandboxes; the pool grows with its
// sandboxes and never shrinks by itself, so a hibernated ticket's worker stays as a warm one — counts its request.
// A worker running a sandbox is counted as that sandbox's measured use instead (activeSandboxes, sandboxNeed). From
// the last check's usage.workers; before one (or a check before ASS-537), the entry's warm-workers at WORKER_REQUEST.
export function warmPool(entry, live) {
  if (!entry || entry.kind !== 'kind') return { workers: 0, idle: 0, request: 0, memory: 0 };
  const w = live?.usage?.workers;
  const workers = Number.isFinite(w?.replicas) && w.replicas >= 0 ? w.replicas : entry['warm-workers'];
  const request = Number.isFinite(w?.['memory-request-bytes']) && w['memory-request-bytes'] >= 0 ? w['memory-request-bytes'] : WORKER_REQUEST;
  const idle = Math.max(0, workers - activeSandboxes(entry, live).length);
  return { workers, idle, request, memory: idle * request };
}

// snapshotDisk(entry, live, harness) — ASS-537 AC3: the project's Substrate snapshots against the disk they live on (its
// cluster node's /var: Docker's disk, on the Mac Docker Desktop's), { bytes (its sandboxes' snapshots and its templates'
// golden ones: usage.snapshot-bytes), per (one more ticket's: the average of its sandboxes' snapshots, at least
// SNAPSHOT_FLOOR — a hibernated sandbox's snapshot holds its memory and rootfs writes, 372 KB to 1.1 GB measured), free
// (the disk's free bytes, null when not measured), hold (harness.json's disk-free-hold-gb, 15: the same floor the
// Mac's disk watch holds work at), full (free less one more ticket's snapshot would fall below hold: no new seat for
// its sandboxes) }. A snapshot stays while its sandbox runs again (it is its next resume's), so every sandbox's counts,
// whatever its state.
export const SNAPSHOT_FLOOR = 1024 ** 3;
export function snapshotDisk(entry, live, harness = {}) {
  const each = sandboxUse(live).map(u => u.snapshot).filter(b => b > 0);
  const bytes = Math.max(0, Number(live?.usage?.['snapshot-bytes']) || each.reduce((a, b) => a + b, 0));
  const per = Math.max(SNAPSHOT_FLOOR, each.length ? each.reduce((a, b) => a + b, 0) / each.length : 0);
  const free = Number.isFinite(live?.usage?.disk?.['free-bytes']) ? live.usage.disk['free-bytes'] : null;
  const hold = (harness['disk-free-hold-gb'] ?? 15) * 1e9;
  return { bytes, per, free, hold, full: entry?.kind === 'kind' && free != null && free - per < hold };
}

// clusterLoad(entry, live, { share = 1, sandboxes = true }) — AC5: what the cluster costs its host now, { memory (bytes),
// cpu (percent of one core), running }: its fixed memory and CPU (times `share`, the project's part of a shared
// cluster: the Mac's, split between the projects that declare it) plus — unless `sandboxes` is false (ASS-535: when
// its sandboxes are counted as the seats of the tickets in them instead) — each of its project's active sandboxes
// (activeSandboxes: ASS-535 AC3, its measured memory, rootfs writes included, and CPU; a hibernated one nothing).
// ASS-537 AC3: plus, either way, its WorkerPool's warm workers' memory requests (warmPool: the project's own pool, never
// split by `share`), as `pool` too. `running` — the cluster was up at its last check, so its use is in the host's
// measured figures already.
export function clusterLoad(entry, live, { share = 1, sandboxes: withSandboxes = true } = {}) {
  if (!entry || entry.kind !== 'kind') return { memory: 0, cpu: 0, running: false, pool: 0 };
  const active = withSandboxes ? activeSandboxes(entry, live) : [];
  const pool = warmPool(entry, live).memory;
  return {
    memory: entry['memory-gib'] * GIB * share + pool + active.reduce((a, u) => a + u.memory, 0),
    cpu: entry['cpu-percent'] * share + active.reduce((a, u) => a + u.cpu, 0),
    running: live?.node?.running === true,
    sandboxes: active.length,
    pool,
  };
}

// macLoad(project, all, options) — AC5: a project's part of the Mac's cluster (clusterLoad, given `options`), its fixed
// cost split equally between every project (`all`, each control sees them all) declaring a Mac entry; null when it
// declares none.
export function macLoad(project, all = [project], options = {}) {
  const mine = entriesOf(project).find(e => e.machine === MAC);
  if (!mine) return null;
  const sharing = Math.max(1, all.filter(p => entriesOf(p).some(e => e.machine === MAC)).length);
  return clusterLoad(mine, project.substrate?.[MAC], { ...options, share: 1 / sharing });
}

// remoteLoad(project, id, options) — AC5: the cluster on the project's remote machine `id` (clusterLoad, given
// `options`, whole: the machine is the project's alone); null when it has none there.
export function remoteLoad(project, id, options = {}) {
  const e = entriesOf(project).find(x => x.machine === id && x.kind === 'kind');
  return e ? clusterLoad(e, project.substrate?.[id], options) : null;
}

// clusterEntry(project, machine) — ASS-535: the project's kind cluster entry on `machine` (mac or a remote id), or null.
export const clusterEntry = (project, machine) => entriesOf(project).find(e => e.machine === machine && e.kind === 'kind') ?? null;
