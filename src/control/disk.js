// The disk watch (ASS-288): a full disk once took the harness and its data
// down with no warning, so control watches the free space on the volumes
// holding LIMA_HOME (the VMs) and the data folder, against harness.json's
// disk-free-warn-gb and disk-free-hold-gb:
//   - at most once a minute (DISK_EVERY) it reads them: harness:check-disk-space,
//     which runs df and records the level in disk-space.json (beside
//     harness.json), every control and the dashboard reading the same record;
//   - below the warn level it reclaims space harness-wide: vm:reclaim-all,
//     beside the tick (one at a time per control; the command itself lets one
//     run at a time across controls), deleting every project's stopped VMs no
//     variation in flight needs, least recently accessed first across all of
//     them, until the free space is back above the warn level — each
//     deletion logged; running or in-flight VMs are never touched;
//   - below the hold level (level hold: diskHeld) nothing new starts — no
//     agent (tick.js skips fast track, refinement and dispatch), VM (vm-lifecycle.js
//     neither recreates nor starts one), clone or golden build (steps.js
//     runs no script step that makes one; vm:build-golden-start refuses) —
//     until the free space is back above the warn level, when
//     harness:check-disk-space releases the hold by itself; agents already
//     running finish their turns.
// The level's changes are logged once each ("disk", and the hold under "hold"
// as a rate limit's is); a check that fails is logged once per failure streak,
// the last record standing. Off with DISK_SPACE_DISABLED=1 (the test fixtures'
// env, so a test's control never reads the real disk).
const DISK_EVERY = 60e3;
const PHASE = 'disk';
const GIB = 2 ** 30;

// gib(bytes) — the bytes in GiB, one decimal: "12.3".
export const gib = bytes => (bytes / GIB).toFixed(1);
// gb(bytes) — a threshold in harness.json's GB (10^9 bytes): "50".
export const gb = bytes => String(bytes / 1e9);

// diskHeld(state) — whether the disk hold is on: disk-space.json's level is
// hold (state.js loads it as diskSpace).
export const diskHeld = state => state?.diskSpace?.level === 'hold';

// The script steps a hold keeps from running: those that make a VM (vm:create's
// clone) or a golden image.
const MAKES_DISK = /\bvm:(create|build-golden|build-golden-start)\b/;
export const makesDisk = command => MAKES_DISK.test(command ?? '');

// holdText(disk) — the hold, as the log says it (the dashboard's frame.js diskText alike).
export const holdText = disk => `Disk nearly full — work held (${gib(disk['free-bytes'])} GiB free)`;

// checkDisk(ctx, state) — the check, when a minute has passed since the last
// (the first tick at once); its level logged as it changes; below the warn
// level, a reclaim started unless one runs (memory.disk.reclaim, awaited by
// tests); the hold's start and end logged.
export async function checkDisk(ctx) {
  if (ctx.env.DISK_SPACE_DISABLED === '1') return;
  const memory = (ctx.memory.disk ??= { at: null, level: null, failing: false, reclaim: null, short: false });
  const now = ctx.now().getTime();
  if (memory.at != null && now - memory.at < DISK_EVERY) return;
  memory.at = now;
  let disk;
  try {
    disk = JSON.parse(await ctx.cli(['harness:check-disk-space']));
  } catch (error) {
    if (!memory.failing) ctx.log('error', `${PHASE}: ${error.message}; the last record stands`);
    memory.failing = true;
    return;
  }
  memory.failing = false;
  const was = memory.level;
  memory.level = disk.level;
  if (disk.level !== was) {
    const free = gib(disk['free-bytes']), warn = gb(disk['warn-bytes']);
    if (disk.level === 'hold') ctx.log('hold', `${holdText(disk)}: no agent, VM, clone or golden build starts until ${warn} GB is free; running agents finish their turns`);
    else if (was === 'hold') ctx.log('hold', `disk space back above ${warn} GB (${free} GiB free): work resumes`);
    if (disk.level === 'warn' && was !== 'hold') ctx.log(PHASE, `Disk low: ${free} GiB free, below the ${warn} GB warning level — deleting stopped VMs no ticket needs, least recently accessed first, across every project`);
    if (disk.level === 'ok' && was === 'warn') ctx.log(PHASE, `${free} GiB free, back above the ${warn} GB warning level`);
  }
  if (disk.level === 'ok') { memory.short = false; return; }
  memory.reclaim ??= reclaim(ctx, memory).finally(() => { memory.reclaim = null; });
}

// reclaim(ctx, memory) — vm:reclaim-all, its deletions logged, and that nothing
// more can be deleted once per streak of reclaims left short; the next check
// is brought forward, so a hold lifts as soon as the space is there.
async function reclaim(ctx, memory) {
  let out;
  try {
    out = JSON.parse(await ctx.cli(['vm:reclaim-all']));
  } catch (error) {
    ctx.log('error', `${PHASE}: ${error.message}`);
    return;
  }
  if (out.skipped) return;
  for (const d of out.deleted ?? []) ctx.log(PHASE, `deleted ${d.name} (${d.project} ${d.ticket} ${d.variation}, last accessed ${d['last-accessed']}): ${d['freed-bytes']} bytes freed (${gib(d['freed-bytes'])} GiB)`);
  if (out.deleted?.length) memory.at = null;
  if (out.short && !memory.short) ctx.log(PHASE, `nothing more to delete: ${gib(out['free-bytes'])} GiB free on the volume holding the VMs, still below the ${gb(out['warn-bytes'])} GB warning level; every other VM runs or its variation is in flight — free space on the volume by hand`);
  memory.short = Boolean(out.short);
}
