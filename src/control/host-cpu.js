// The Mac's CPU, as the seat budget reads it (ASS-528, seat-budget.js). A
// reading (readHostCpu) is `ps -axo pid=,%cpu=,comm=` — every process's CPU
// in percent of one core (macOS's own decaying average over up to a minute),
// summed for the whole Mac — and `sysctl -n hw.ncpu`, its cores; the
// Virtualization framework VM processes among them (one per Lima vz instance)
// matched to their instances by the files they hold open (lsof, as
// host-memory.js matches their memory), so each running VM's CPU is known by
// name. Readings are taken at most every CPU_READ_EVERY and kept for
// CPU_WINDOW_MS (cpuReading): the Mac's use and each VM's are their averages
// over that window, so a build's burst does not make a seat appear and vanish
// tick by tick — seat-budget.js adds hysteresis on top. Off with
// HOST_MEMORY_DISABLED=1 (the test fixtures' env, ctx.hostCpu null), as the
// memory reading is: a test's control never reads the real Mac. Tests replace
// ctx.hostCpu.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { matchInstances } from './host-memory.js';

export const CPU_READ_EVERY = 15e3;
export const CPU_WINDOW_MS = 5 * 60e3;
const VZ_PROCESS = /com\.apple\.Virtualization\.VirtualMachine$/;

// parsePsCpu(text) — { totalPercent (every process's %cpu summed), vz (pid → %cpu of each Virtualization framework
// VM process) } from `ps -axo pid=,%cpu=,comm=`'s output.
export function parsePsCpu(text) {
  let totalPercent = 0;
  const vz = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pct = Number(m[2].replace(',', '.'));
    totalPercent += pct;
    if (VZ_PROCESS.test(m[3])) vz.set(Number(m[1]), pct);
  }
  return { totalPercent, vz };
}

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 10_000, maxBuffer: 16 * 2 ** 20 }, (error, stdout) => {
  if (error && !stdout) reject(new Error(`${command}: ${error.message}`));
  else resolve(stdout);
}));

// readHostCpu(home) — a reading now: { ncpu, totalPercent, vms (Lima instance name → its VM process's %cpu, for the
// instances in `home`, LIMA_HOME; null when they could not be matched, vmsError saying why) }.
export const readHostCpu = home => async () => {
  const ncpu = Number(String(await run('sysctl', ['-n', 'hw.ncpu'])).trim());
  if (!(ncpu > 0)) throw new Error('sysctl hw.ncpu: unexpected output');
  const { totalPercent, vz } = parsePsCpu(await run('ps', ['-axo', 'pid=,%cpu=,comm=']));
  const reading = { ncpu, totalPercent };
  try {
    let real = home;
    try { real = realpathSync(home); } catch { /* not there: no instance matches */ }
    reading.vms = vz.size ? matchInstances(await run('lsof', ['-nP', '-Fpn', '-p', [...vz.keys()].join(',')]), real, vz) : new Map();
  } catch (error) {
    reading.vms = null;
    reading.vmsError = error.message;
  }
  return reading;
};

// smooth(samples) — the window's averages: { ncpu, capacity (ncpu × 100), percent (the Mac's use, averaged), vms
// (name → its average over the samples it appears in), samples (how many) }, or null with none.
export function smooth(samples) {
  if (!samples.length) return null;
  const ncpu = samples.at(-1).ncpu, vms = new Map(), seen = new Map();
  for (const s of samples) for (const [name, pct] of s.vms ?? []) { vms.set(name, (vms.get(name) ?? 0) + pct); seen.set(name, (seen.get(name) ?? 0) + 1); }
  for (const [name, sum] of vms) vms.set(name, sum / seen.get(name));
  // Only the VMs in the latest reading are running now; the others have stopped since.
  const now = samples.at(-1).vms;
  if (now) for (const name of [...vms.keys()]) if (!now.has(name)) vms.delete(name);
  return { ncpu, capacity: ncpu * 100, percent: samples.reduce((a, s) => a + s.totalPercent, 0) / samples.length, vms, samples: samples.length };
}

// cpuReading(ctx) — the smoothed reading (smooth), a new sample taken at most every CPU_READ_EVERY and kept for
// CPU_WINDOW_MS (memory.hostCpu); null without ctx.hostCpu or before a first good reading (a failure logged once per streak).
export async function cpuReading(ctx) {
  if (!ctx.hostCpu) return null;
  const c = (ctx.memory.hostCpu ??= { at: null, samples: [], failing: false });
  const now = ctx.now().getTime();
  if (c.at == null || now - c.at >= CPU_READ_EVERY) {
    c.at = now;
    try {
      const r = await ctx.hostCpu();
      c.samples.push({ at: now, ncpu: r.ncpu, totalPercent: r.totalPercent, vms: r.vms ?? null });
      c.failing = false;
    } catch (error) {
      if (!c.failing) ctx.log('error', `cpu: ${error.message}; seats are not limited by CPU till it reads`);
      c.failing = true;
    }
  }
  c.samples = c.samples.filter(s => now - s.at < CPU_WINDOW_MS);
  return smooth(c.samples);
}
