// The memory hold (ASS-398, reworked by ASS-404): a VM once failed to stay
// running because the Mac had about 60 MB free while other VMs ran, and its
// ticket blocked. So before control starts or creates a VM — vm-lifecycle.js's
// vm:start and vm:create, and a script step running either (steps.js, the
// Setup group's Create VM) — it reads the Mac's memory (ctx.hostMemory: at
// most every MEMORY_READ_EVERY, the reading shared) and decides (memoryVerdict):
//   - the supply is macOS's own signal (ASS-404: vm_stat's free + inactive
//     pages left out what macOS can reclaim and compress, and read 8 GiB
//     where macOS said 33% free, about 16): its free percentage
//     (sysctl kern.memorystatus_level) of the Mac's memory (hw.memsize), and
//     its pressure level (kern.memorystatus_vm_pressure_level: 1 normal,
//     2 warn, 4 critical);
//   - the need (memoryNeed) is what a VM of the project really uses (ASS-404:
//     Virtualization framework VMs take memory as the guest uses it, not their
//     configured size up front): the largest physical footprint (ASS-419) of
//     the project's running VMs' Virtualization framework processes
//     (com.apple.Virtualization.VirtualMachine, matched to their Lima
//     instances by the instance files they hold open, lsof), plus
//     harness.json's memory-free-margin-gib (2 by default), at least
//     memory-need-floor-gib (4 by default) and at most the VM's configured
//     memory — the `memory:` of the project's golden image template.yaml
//     (project.json golden-image.folder), Lima's 4 GiB when it says none — or
//     that footprint when larger (ASS-419). Once a VM of the project has been
//     seen at its configured memory, the need is never less than it again
//     (ASS-419, for as long as control runs). With none of its VMs running to
//     measure, the floor. harness.json's memory-free-hold-gib, when set, is
//     the need instead, as before. vmNeed is the need for one new VM of a
//     project, reading the Mac (cached) itself (ASS-419, for seats by capacity).
//   - ASS-419: a VM's cost is its physical footprint, compressed pages
//     included — what `top`'s MEM column shows — read with `footprint -f bytes
//     --noCategories -p <pid> …` (its phys_footprint). ASS-404 read the
//     resident size (ps rss), which leaves compressed and swapped pages out:
//     on 2026-11-12 a 10 GiB case-law VM had 0.96 GiB resident while top
//     showed it at 10G MEM, 17G CMPRS. Compared on this Mac that day: top's
//     MEM 10G (291M, 76M for two other processes); footprint 10759519712 B
//     (305546752, 80200616); proc_pid_rusage's ri_phys_footprint, from a test
//     C helper, byte for byte the same; footprint's peak 10764205536 B — a
//     live figure, 22 MB above the configured 10 GiB, not the configured
//     size. footprint took 0.03 s per VM, top -l 1 -pid 0.67 s with whole-unit
//     figures ("10G"), and the helper would need building with clang; so
//     footprint. When it cannot be read the resident size is used, and the
//     need says so (reading.measure 'footprint' or 'resident').
// A VM is held while macOS reports warn or critical pressure, or free memory
// below the need; under normal pressure with that much free nothing is held.
// Held, the VM is not started: its variation waits as for a slot (awaitsVm
// says so, with no VM_WAIT, so its steps are not judged and no agent is
// dispatched into it) and holds no planning or in-progress seat meanwhile
// (ASS-404: plan.js, which reads the held variations from the hold's
// record), no failure counted (no backoff); the project's hold is on —
// logged under "hold" with the figures (macOS's free percentage and pressure
// level, the need and how it was made, the VM held), once per hold, and
// recorded in data/projects/<p>/memory-hold.json (rewritten as the held
// variations or the figures change), which the dashboard reads to flag "Out
// of memory" in the header and plan.js to free the seats. Every tick while
// it is on (liftMemoryHolds, superviseVms) the memory is read again, a held
// variation that has moved off the step it was held at (or was paused, set
// aside or left the sprint) is dropped, and once there is room the hold
// lifts by itself, logged with the figures and when, the file removed — its
// variations take a seat again as any variation does, no step re-run, no
// visit spent; one left by an earlier control is removed too. Off with
// HOST_MEMORY_DISABLED=1 (the test fixtures' env: ctx.hostMemory null), so a
// test's control never reads the real Mac's memory; tests replace
// ctx.hostMemory.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isHeld } from './engine.js';

const PHASE = 'hold';
const GIB = 2 ** 30;
export const MEMORY_READ_EVERY = 10e3;
export const LIMA_DEFAULT_MEMORY = 4 * GIB;
export const DEFAULT_MARGIN_GIB = 2;
export const DEFAULT_FLOOR_GIB = 4;   // ASS-404: harness.json memory-need-floor-gib

// gib(bytes) — the bytes in GiB, one decimal.
export const gib = bytes => (bytes / GIB).toFixed(1);

// ASS-404: kern.memorystatus_vm_pressure_level's values.
const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

// parseSysctl(text) — { freePercent, pressure, totalBytes } from `sysctl
// kern.memorystatus_level kern.memorystatus_vm_pressure_level hw.memsize`'s
// output (ASS-404); pressure 'unknown' for a level it does not name.
export function parseSysctl(text) {
  const value = name => Number(new RegExp(`^${name.replaceAll('.', '\\.')}:\\s*(\\d+)`, 'm').exec(text)?.[1]);
  const freePercent = value('kern.memorystatus_level'), level = value('kern.memorystatus_vm_pressure_level'), totalBytes = value('hw.memsize');
  if (Number.isNaN(freePercent) || Number.isNaN(totalBytes)) throw new Error('sysctl: unexpected output');
  return { freePercent, pressure: PRESSURE[level] ?? 'unknown', totalBytes };
}

// VZ_PROCESS — the process of a Virtualization framework VM (one per Lima vz instance).
const VZ_PROCESS = /com\.apple\.Virtualization\.VirtualMachine$/;

// parseVzProcesses(text) — `ps -axo pid=,rss=,comm=`'s Virtualization
// framework VM processes: pid → resident bytes (ps gives KiB; ASS-419: the
// fallback when their footprint cannot be read).
export function parseVzProcesses(text) {
  const procs = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && VZ_PROCESS.test(m[3])) procs.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return procs;
}

// matchInstances(lsof, home, procs) — each Lima instance's VM process's
// resident bytes, instance name → bytes: `lsof -Fpn` lists the files each
// process holds open, and a VM process holds its instance's (<home>/<name>/disk,
// cidata.iso, serialv.log …); Lima's own folders (_config, _cache) are not instances.
export function matchInstances(lsof, home, procs) {
  const vms = new Map(), root = `${home.replace(/\/+$/, '')}/`;
  let pid = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && procs.has(pid) && line.slice(1).startsWith(root)) {
      const name = line.slice(1 + root.length).split('/')[0];
      if (name && !name.startsWith('_') && !vms.has(name)) vms.set(name, procs.get(pid));
    }
  }
  return vms;
}

// parseFootprint(text, pids) — ASS-419: `footprint -f bytes --noCategories
// -p <pid> …`'s phys_footprint per process, pid → bytes, for the pids asked
// for only (footprint takes a -p it cannot find as a process name, which may
// list others).
export function parseFootprint(text, pids) {
  const want = new Set(pids), out = new Map();
  let pid = null;
  for (const line of text.split('\n')) {
    const head = /\[(\d+)\]:/.exec(line);
    if (head) { pid = Number(head[1]); continue; }
    const m = /^\s*phys_footprint:\s*(\d+)\s*B\b/.exec(line);
    if (m && want.has(pid) && !out.has(pid)) out.set(pid, Number(m[1]));
  }
  return out;
}

// footprints(procs) — ASS-419: procs (pid → resident bytes) with each
// process's footprint instead, and the measure: 'footprint' when every one
// was read, else the resident sizes as they were, 'resident', and why.
async function footprints(procs) {
  if (!procs.size) return { procs, measure: 'footprint' };
  try {
    const read = parseFootprint(await run('footprint', ['-f', 'bytes', '--noCategories', ...[...procs.keys()].flatMap(pid => ['-p', String(pid)])]), procs.keys());
    const missing = [...procs.keys()].filter(pid => !read.has(pid));
    if (!missing.length) return { procs: read, measure: 'footprint' };
    return { procs, measure: 'resident', error: `footprint: no phys_footprint for ${missing.join(', ')}` };
  } catch (error) { return { procs, measure: 'resident', error: error.message }; }
}

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 10_000, maxBuffer: 16 * 2 ** 20 }, (error, stdout) => {
  if (error && !stdout) reject(new Error(`${command}: ${error.message}`));   // lsof exits 1 when a file is not listable, its listing given all the same
  else resolve(stdout);
}));

// readHostMemory(home) — ASS-404: a reading of the Mac's memory now, {
// freePercent, pressure, totalBytes, freeBytes (ASS-419), vms (Lima instance
// name → its VM process's footprint bytes, ASS-419, for the instances in
// `home`, LIMA_HOME; null when they could not be measured, vmsError saying
// why), measure (ASS-419: 'footprint', or 'resident' when only ps rss could
// be read, footprintError saying why) } — sysctl, ps, footprint and lsof,
// each well under a second.
export const readHostMemory = home => async () => {
  const reading = parseSysctl(await run('sysctl', ['kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level', 'hw.memsize']));
  reading.freeBytes = freeBytes(reading);
  try {
    const measured = await footprints(parseVzProcesses(await run('ps', ['-axo', 'pid=,rss=,comm=']))), procs = measured.procs;
    reading.measure = measured.measure;
    if (measured.error) reading.footprintError = measured.error;
    let real = home;
    try { real = realpathSync(home); } catch { /* not there: no instance matches */ }
    reading.vms = procs.size ? matchInstances(await run('lsof', ['-nP', '-Fpn', '-p', [...procs.keys()].join(',')]), real, procs) : new Map();
  } catch (error) {
    reading.vms = null;
    reading.vmsError = error.message;
  }
  return reading;
};

// parseMemory(value) — a Lima memory size ("4GiB", "10GiB", "4096MiB", "8G":
// binary units, as Lima reads them) in bytes, or null.
export function parseMemory(value) {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * 1024 ** ' KMGT'.indexOf((m[2] || ' ').toUpperCase()));
}

// vmMemoryBytes(ctx, project) — the memory its VMs are configured with: its
// golden image template.yaml's `memory:`, else Lima's default.
export function vmMemoryBytes(ctx, project) {
  const folder = project.json?.['golden-image']?.folder;
  if (!folder) return LIMA_DEFAULT_MEMORY;
  const file = join(isAbsolute(folder) ? folder : join(dirname(ctx.paths.projects), folder), 'template.yaml');
  try {
    const m = /^memory:\s*["']?([^"'#\s]+)/m.exec(readFileSync(file, 'utf8'));
    return parseMemory(m?.[1]) ?? LIMA_DEFAULT_MEMORY;
  } catch { return LIMA_DEFAULT_MEMORY; }
}

// projectVms(ctx, project) — the names of the project's VMs (ASS-404): its
// inventory's (vms.json) and those its sprint's variations record.
function projectVms(ctx, project) {
  const names = new Set();
  try { for (const name of Object.keys(JSON.parse(readFileSync(join(ctx.paths.projects, project.id, 'vms.json'), 'utf8')))) names.add(name); } catch { /* none */ }
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) if (v.vm?.name) names.add(v.vm.name);
  return names;
}

// MEASURE — ASS-419: the words for a reading's measure of a VM.
const MEASURE = { footprint: 'footprint (compressed pages included)', resident: 'resident (ps rss, its footprint not read)' };

// memoryNeed(ctx, state, project, reading) — { bytes, why, measure }: the
// free memory a new VM of the project needs (ASS-404, see the module
// comment): the largest footprint (ASS-419) of its running VMs in `reading`
// plus the margin, at least the floor — the configured memory once a VM of
// the project has been seen at it (ASS-419: memory.memorySeenFull) — and at
// most its configured memory or that footprint, whichever is larger; the
// floor with none running.
export function memoryNeed(ctx, state, project, reading) {
  const h = state.harness ?? {};
  if (h['memory-free-hold-gib'] != null) return { bytes: h['memory-free-hold-gib'] * GIB, why: "harness.json's memory-free-hold-gib", measure: 'configured' };
  const ceiling = vmMemoryBytes(ctx, project), margin = h['memory-free-margin-gib'] ?? DEFAULT_MARGIN_GIB, floorGib = h['memory-need-floor-gib'] ?? DEFAULT_FLOOR_GIB;
  const measure = reading?.measure ?? 'footprint';
  const names = projectVms(ctx, project);
  const used = [...(reading?.vms ?? new Map())].filter(([name]) => names.has(name)).map(([, bytes]) => bytes);
  const largest = used.length ? Math.max(...used) : 0;
  const seen = (ctx.memory ??= {}).memorySeenFull ??= new Set();   // ASS-419: projects with a VM seen at its configured memory
  if (measure === 'footprint' && used.length && largest >= ceiling) seen.add(project.id);
  const full = seen.has(project.id);
  const floor = full ? ceiling : Math.min(floorGib * GIB, ceiling);
  const floorWords = full ? `its configured ${gib(floor)} GiB, a VM of it once seen using that much` : `the ${gib(floor)} GiB floor`;
  if (!used.length) {
    const none = reading?.vms ? `none of its VMs running to measure` : `its VMs not measured${reading?.vmsError ? ` (${reading.vmsError})` : ''}`;
    return { bytes: floor, why: `${none}: ${floorWords}`, measure: 'floor' };
  }
  const cap = Math.max(ceiling, largest), estimate = largest + margin * GIB;
  const bytes = Math.min(cap, Math.max(floor, estimate));
  const bound = bytes === cap && estimate > cap ? (cap === ceiling ? `, capped at its configured ${gib(ceiling)} GiB` : `, capped at that footprint, above its configured ${gib(ceiling)} GiB`) : bytes > estimate ? `, raised to ${floorWords}` : '';
  return { bytes, why: `the largest of its ${used.length} running VM${used.length === 1 ? '' : 's'}, ${gib(largest)} GiB ${MEASURE[measure] ?? measure}, plus a ${margin} GiB margin${bound}`, measure };
}

// vmNeed(ctx, state, project) — ASS-419: { bytes, why, measure }, the free
// memory one new VM of the project needs now (memoryNeed), the Mac read as
// the hold reads it (at most every MEMORY_READ_EVERY); with memory not read
// (HOST_MEMORY_DISABLED, or a failed reading) the floor.
export async function vmNeed(ctx, state, project) {
  return memoryNeed(ctx, state, project, ctx.hostMemory ? await reading(ctx) : null);
}

// freeBytes(reading) — the free memory macOS reports: its free percentage of the Mac's memory.
export const freeBytes = reading => Math.round(reading.totalBytes * reading.freePercent / 100);

// memoryVerdict(reading, need) — ASS-404: { short, why }: whether a new VM is
// held — macOS's pressure warn or critical, or its free memory below the need —
// and why, in words with macOS's figures.
export function memoryVerdict(reading, need) {
  const free = freeBytes(reading);
  const macos = `macOS: pressure ${reading.pressure}, ${reading.freePercent}% free, ${gib(free)} of ${gib(reading.totalBytes)} GiB`;
  if (reading.pressure === 'warn' || reading.pressure === 'critical') return { short: true, why: `memory pressure ${reading.pressure} (${macos})` };
  if (free < need.bytes) return { short: true, why: `${gib(free)} GiB free, below the ${gib(need.bytes)} GiB a VM needs (${macos})` };
  return { short: false, why: `pressure ${reading.pressure}, ${gib(free)} GiB free (${reading.freePercent}% of ${gib(reading.totalBytes)} GiB), at or above the ${gib(need.bytes)} GiB a VM needs` };
}

// reading(ctx) — the Mac's memory, read at most every MEMORY_READ_EVERY
// (memory.hostMemory), or null when it cannot be read (logged once per streak).
async function reading(ctx) {
  const c = (ctx.memory.hostMemory ??= { at: null, reading: null, failing: false });
  const now = ctx.now().getTime();
  if (c.at != null && now - c.at < MEMORY_READ_EVERY) return c.reading;
  c.at = now;
  try {
    c.reading = await ctx.hostMemory();
    c.failing = false;
  } catch (error) {
    if (!c.failing) ctx.log('error', `memory: ${error.message}; no VM held for memory till it reads`);
    c.failing = true;
    c.reading = null;
  }
  return c.reading;
}

const holdFile = (ctx, id) => join(ctx.paths.projects, id, 'memory-hold.json');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// record(ctx, id, hold) — the hold's memory-hold.json, written when it changes
// (ASS-404: the held variations, which plan.js frees the seats of, and the figures).
function record(ctx, id, hold) {
  const r = hold.reading, body = `${JSON.stringify({
    since: iso(hold.since),
    pressure: r.pressure, 'free-percent': r.freePercent, 'free-bytes': freeBytes(r), 'total-bytes': r.totalBytes,
    'need-bytes': hold.need.bytes, 'need-why': hold.need.why, 'need-measure': hold.need.measure, why: hold.why,
    vm: hold.first, held: [...hold.variations.values()],
  }, null, 2)}\n`;
  if (body === hold.written) return;
  const file = holdFile(ctx, id), tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    hold.written = body;
  } catch (error) { ctx.log('error', `memory: ${file}: ${error.message}`); }
}

// lift(ctx, id, hold, verdict) — the hold lifted, logged with why and when, its record removed.
function lift(ctx, id, hold, verdict) {
  const now = ctx.now().getTime();
  ctx.log(PHASE, `memory back: ${verdict.why} for ${id} — the out-of-memory hold lifted at ${iso(now)} (held since ${iso(hold.since)}); VMs start again`);
  ctx.memory.memoryHolds.delete(id);
  rmSync(holdFile(ctx, id), { force: true });
}

// heldName(held) — a held variation's key in its hold: "<KEY> <variation>".
const heldName = held => `${held.key} ${held.variation}`;

// memoryShort(ctx, state, project, name, held) — whether a VM of the project
// (`name`, null when not known yet: a vm:create step) must not start now for
// want of memory: the hold put on (logged, recorded) or kept, the VM and its
// variation (`held`: { key, variation, state }, its top-level step) noted as
// held (memory.memoryHolds: id → { since, need, reading, why, first, vms,
// variations }); or, with room, false, a hold on lifting.
export async function memoryShort(ctx, state, project, name, held = null) {
  if (!ctx.hostMemory) return false;
  const r = await reading(ctx);
  const holds = (ctx.memory.memoryHolds ??= new Map());
  const hold = holds.get(project.id);
  if (r == null) return false;
  const need = memoryNeed(ctx, state, project, r), verdict = memoryVerdict(r, need);
  if (!verdict.short) {
    if (hold) lift(ctx, project.id, hold, verdict);
    return false;
  }
  if (!hold) {
    holds.set(project.id, { since: ctx.now().getTime(), first: name, vms: new Set(), variations: new Map() });
    ctx.log(PHASE, `Out of memory: ${verdict.why}; a ${project.id} VM needs ${gib(need.bytes)} GiB (${need.why}): ${name ?? 'its VM'}${held ? ` (${heldName(held)})` : ''} not started — no ${project.id} VM starts or is created until macOS reports normal pressure and that much free; its variation waits as for a slot, holding no seat, no failure counted`);
  }
  const h = holds.get(project.id);
  Object.assign(h, { need, reading: r, why: verdict.why });
  h.variations ??= new Map();
  if (name) h.vms.add(name);
  if (held) h.variations.set(heldName(held), { ...(name ? { vm: name } : {}), ...held });
  record(ctx, project.id, h);
  return true;
}

// memoryHeldVm(ctx, project, name) — whether the VM waits for memory (awaitsVm: it waits as for a slot).
export const memoryHeldVm = (ctx, project, name) => Boolean(name && ctx.memory.memoryHolds?.get(project.id)?.vms.has(name));

// unhold(ctx, id, name, key, variation) — the VM, and its variation, no
// longer held (started, or stopped for another reason: ASS-400), its record rewritten.
export function unhold(ctx, id, name, key, variation) {
  const h = ctx.memory.memoryHolds?.get(id);
  if (!h) return;
  h.vms.delete(name);
  if (key != null && h.variations?.delete(`${key} ${variation}`) && h.reading) record(ctx, id, h);
}

// memoryHeldIn(project) — ASS-404: whether a variation of the project waits
// for memory, by its hold's record (state.js memoryHold: any control's), (ticket, variation) → bool; plan.js frees its seat.
export const memoryHeldIn = project => {
  const held = project?.memoryHold?.held;
  if (!Array.isArray(held) || !held.length) return () => false;
  return (ticket, variation) => held.some(h => h.key === ticket.key && h.variation === variation.name);
};

// prune(ctx, project, hold) — ASS-404: held variations that have left the
// step they were held at, been paused, set aside or left the sprint dropped.
function prune(ctx, project, hold) {
  let dropped = false;
  for (const [k, held] of hold.variations ?? []) {
    const t = project.tickets.find(x => x.key === held.key), v = t?.variations?.find(x => x.name === held.variation);
    if (v && !v['is-deleted'] && !isHeld(t, v) && v['harness-status']?.state === held.state) continue;
    hold.variations.delete(k);
    if (held.vm) hold.vms.delete(held.vm);
    dropped = true;
  }
  if (dropped && hold.reading) record(ctx, project.id, hold);
}

// liftMemoryHolds(ctx, state) — each tick: every hold on pruned, read again
// and lifted once there is room; a record no hold of this control's stands
// behind (an earlier control's) removed. Returns whether any record went or changed (the state to load again).
export async function liftMemoryHolds(ctx, state) {
  const holds = (ctx.memory.memoryHolds ??= new Map());
  let changed = false;
  for (const project of state.projects) {
    const hold = holds.get(project.id);
    if (!hold) {
      if (existsSync(holdFile(ctx, project.id))) { rmSync(holdFile(ctx, project.id), { force: true }); changed = true; }
      continue;
    }
    const before = hold.written;
    prune(ctx, project, hold);
    if (hold.written !== before) changed = true;
    if (!ctx.hostMemory) continue;
    const r = await reading(ctx);
    if (r == null) continue;
    const need = memoryNeed(ctx, state, project, r), verdict = memoryVerdict(r, need);
    if (!verdict.short) { lift(ctx, project.id, hold, verdict); changed = true; continue; }
    Object.assign(hold, { need, reading: r, why: verdict.why });
    hold.variations ??= new Map();
    record(ctx, project.id, hold);   // the figures as read now
  }
  return changed;
}

// STARTS_VM — the script steps that start or create a VM (steps.js memoryWaits).
const STARTS_VM = /\bvm:(create|start)\b/;
export const startsVm = command => STARTS_VM.test(command ?? '');
