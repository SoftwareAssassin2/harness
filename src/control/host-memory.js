// The memory hold (ASS-398): a VM once failed to stay running because the Mac
// had about 60 MB free while other VMs ran, and its ticket blocked. So before
// control starts or creates a VM — vm-lifecycle.js's vm:start and vm:create,
// and a script step running either (steps.js, the Setup group's Create VM) —
// it reads the Mac's available memory (vm_stat: free, inactive and
// speculative pages times the page size; at most every MEMORY_READ_EVERY, the
// reading shared) and compares it with what the VM needs:
//   - harness.json's memory-free-hold-gib, when set (GiB, 2^30 bytes);
//   - else the VM's configured memory — the `memory:` of the project's golden
//     image template.yaml (project.json golden-image.folder), Lima's 4 GiB
//     when it says none — plus harness.json's memory-free-margin-gib (2 by
//     default).
// Below it the VM is not started: its variation waits as for a slot
// (awaitsVm says so, with no VM_WAIT, so its steps are not judged and no
// agent is dispatched into it), no failure counted (no backoff), and the
// project's hold is on — logged under "hold" with why, once per hold, and
// recorded in data/projects/<p>/memory-hold.json, which the dashboard reads
// to flag "Out of memory" in the header. Every tick while it is on
// (liftMemoryHolds, superviseVms) the memory is read again, and once there is
// enough the hold lifts by itself, logged with why and when, the file
// removed; one left by an earlier control is removed too. Off with
// HOST_MEMORY_DISABLED=1 (the test fixtures' env: ctx.availableMemory null),
// so a test's control never reads the real Mac's memory; tests replace
// ctx.availableMemory.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const PHASE = 'hold';
const GIB = 2 ** 30;
export const MEMORY_READ_EVERY = 10e3;
export const LIMA_DEFAULT_MEMORY = 4 * GIB;
export const DEFAULT_MARGIN_GIB = 2;

// gib(bytes) — the bytes in GiB, one decimal.
export const gib = bytes => (bytes / GIB).toFixed(1);

// parseVmStat(text) — the bytes available from vm_stat's output: free (which
// excludes speculative), inactive and speculative pages, times its page size.
export function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1]);
  const [free, inactive, speculative] = ['free', 'inactive', 'speculative'].map(pages);
  if (!page || Number.isNaN(free) || Number.isNaN(inactive)) throw new Error('vm_stat: unexpected output');
  return (free + inactive + (Number.isNaN(speculative) ? 0 : speculative)) * page;
}

// readAvailableMemory() — the Mac's available memory now, in bytes (vm_stat).
export const readAvailableMemory = () => new Promise((resolve, reject) => execFile('vm_stat', { timeout: 10_000 }, (error, stdout) => {
  if (error) return reject(new Error(`vm_stat: ${error.message}`));
  try { resolve(parseVmStat(stdout)); } catch (e) { reject(e); }
}));

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

// memoryNeed(ctx, state, project) — { bytes, why }: the available memory a
// VM of the project needs to start.
export function memoryNeed(ctx, state, project) {
  const h = state.harness ?? {};
  if (h['memory-free-hold-gib'] != null) return { bytes: h['memory-free-hold-gib'] * GIB, why: "harness.json's memory-free-hold-gib" };
  const vm = vmMemoryBytes(ctx, project), margin = h['memory-free-margin-gib'] ?? DEFAULT_MARGIN_GIB;
  return { bytes: vm + margin * GIB, why: `its configured ${gib(vm)} GiB plus a ${margin} GiB margin` };
}

// available(ctx) — the available memory, read at most every MEMORY_READ_EVERY
// (memory.hostMemory), or null when it cannot be read (logged once per streak).
async function available(ctx) {
  const c = (ctx.memory.hostMemory ??= { at: null, bytes: null, failing: false });
  const now = ctx.now().getTime();
  if (c.at != null && now - c.at < MEMORY_READ_EVERY) return c.bytes;
  c.at = now;
  try {
    c.bytes = await ctx.availableMemory();
    c.failing = false;
  } catch (error) {
    if (!c.failing) ctx.log('error', `memory: ${error.message}; no VM held for memory till it reads`);
    c.failing = true;
    c.bytes = null;
  }
  return c.bytes;
}

const holdFile = (ctx, id) => join(ctx.paths.projects, id, 'memory-hold.json');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function record(ctx, id, hold) {
  const file = holdFile(ctx, id), tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ since: iso(hold.since), 'available-bytes': hold.available, 'need-bytes': hold.need, vm: hold.first }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (error) { ctx.log('error', `memory: ${file}: ${error.message}`); }
}

// lift(ctx, id, hold, bytes) — the hold lifted, logged with why and when, its record removed.
function lift(ctx, id, hold, bytes) {
  const now = ctx.now().getTime();
  ctx.log(PHASE, `memory back: ${gib(bytes)} GiB available, at or above the ${gib(hold.need)} GiB a ${id} VM needs — the out-of-memory hold lifted at ${iso(now)} (held since ${iso(hold.since)}); VMs start again`);
  ctx.memory.memoryHolds.delete(id);
  rmSync(holdFile(ctx, id), { force: true });
}

// memoryShort(ctx, state, project, name) — whether a VM of the project
// (`name`, null when not known yet: a vm:create step) must not start now for
// want of memory: the hold put on (logged, recorded) or kept, the VM noted as
// held (memory.memoryHolds: id → { since, need, available, first, vms }); or,
// with enough, false, a hold on lifting.
export async function memoryShort(ctx, state, project, name) {
  if (!ctx.availableMemory) return false;
  const bytes = await available(ctx);
  const holds = (ctx.memory.memoryHolds ??= new Map());
  const hold = holds.get(project.id);
  if (bytes == null) return false;
  const need = memoryNeed(ctx, state, project);
  if (bytes >= need.bytes) {
    if (hold) lift(ctx, project.id, hold, bytes);
    return false;
  }
  if (!hold) {
    const h = { since: ctx.now().getTime(), need: need.bytes, available: bytes, first: name, vms: new Set() };
    holds.set(project.id, h);
    ctx.log(PHASE, `Out of memory: ${gib(bytes)} GiB available on this Mac, below the ${gib(need.bytes)} GiB a ${project.id} VM needs (${need.why}): ${name ?? 'its VM'} not started — no ${project.id} VM starts or is created until there is; its variation waits as for a slot, no failure counted`);
    record(ctx, project.id, h);
  }
  if (name) holds.get(project.id).vms.add(name);
  return true;
}

// memoryHeldVm(ctx, project, name) — whether the VM waits for memory (awaitsVm: it waits as for a slot).
export const memoryHeldVm = (ctx, project, name) => Boolean(name && ctx.memory.memoryHolds?.get(project.id)?.vms.has(name));

// liftMemoryHolds(ctx, state) — each tick: every hold on read again and
// lifted once there is enough memory; a record no hold of this control's
// stands behind (an earlier control's) removed.
export async function liftMemoryHolds(ctx, state) {
  const holds = (ctx.memory.memoryHolds ??= new Map());
  for (const project of state.projects) {
    const hold = holds.get(project.id);
    if (!hold) {
      if (existsSync(holdFile(ctx, project.id))) rmSync(holdFile(ctx, project.id), { force: true });
      continue;
    }
    if (!ctx.availableMemory) continue;
    const bytes = await available(ctx);
    if (bytes != null && bytes >= memoryNeed(ctx, state, project).bytes) lift(ctx, project.id, hold, bytes);
  }
}

// STARTS_VM — the script steps that start or create a VM (steps.js memoryWaits).
const STARTS_VM = /\bvm:(create|start)\b/;
export const startsVm = command => STARTS_VM.test(command ?? '');
