// ASS-480: a step's end always runs on the machine its step ran on. A step
// run in a variation's VM (vm+workstation mode, workstation-steps.js) leaves
// its committed work there until vm:step-end pushes it, so the VM must not be
// stopped, deleted or reclaimed before that end has run (live, 2026-11-16: a
// VM was stopped and then deleted at QA before its last step's end ran, and
// control retried that end every 30 minutes, for ever, against a VM no longer
// there). Each such pending end is recorded in control's live data,
// data/projects/<p>/step-ends.json — { ends: { "<KEY> <variation>": { key,
// variation, vm, step, completed, since } }, recovered } — written (by a
// temporary file renamed over it) once a step goes on in the VM
// (workstation-steps.js readyVm) and dropped once its end has succeeded, or
// once its VM is found gone (AC2), so it outlives a restart of control (whose
// leases are memory only) and is read by:
//
// - the VM lifecycle (vm-lifecycle.js vmsOf): a VM a pending end is on is to
//   run whatever its step says — started when stopped, never stopped, deleted
//   or recreated meanwhile — logged once (AC1);
// - vm.bash reconcile_vms: never deletable, so neither make_room nor
//   reclaim-all deletes it to make room (AC1);
// - workstation-steps.js tendSteps: a pending end no lease holds (from before
//   a restart) taken up again as a lease in its VM, its end run once nothing
//   of the variation's uses the VM (AC1), or dropped, logged once as an error
//   and shown on the variation's Health, when its VM is gone (AC2).
//
// The migration (recover): before ASS-480 a pending end lived only in the
// memory of the control that ran its step, and control is stopped to take a
// harness update, so at the first start that finds no `recovered` here the
// project's control log is read once for VM step ends that failed and never
// succeeded after ("error workstation <KEY> <v>: ending its step on its VM
// failed (…): agent.sh vm:step-end <p> <KEY> <v> [--completed "<step>"]: …",
// with no later "<KEY> <v>: its step … ended on its VM"); each is recorded
// as pending, its VM the variation's recorded one, and so ended (its VM
// started when only stopped) or dropped (its VM gone) as any other.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STEP_ENDS_FILE = 'step-ends.json';
const same = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
export const endKey = (key, variation) => `${String(key).toUpperCase()} ${variation}`;

// loadEnds(dir) — the project's step-ends.json ({ ends: {}, recovered: null } without one, or one unreadable).
export function loadEnds(dir) {
  try {
    const file = join(dir, STEP_ENDS_FILE);
    if (!existsSync(file)) return { ends: {}, recovered: null };
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return { ends: json.ends ?? {}, recovered: json.recovered ?? null };
  } catch { return { ends: {}, recovered: null }; }
}

function save(ctx, dir, data) {
  const file = join(dir, STEP_ENDS_FILE), tmp = `${file}.tmp`;
  try { writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`); renameSync(tmp, file); } catch (error) { ctx.log('error', `workstation: ${file}: ${error.message}`); }
}

// pendEnd(ctx, dir, rec) — the step's end recorded as pending on its VM ({ key, variation, vm, step, completed }).
export function pendEnd(ctx, dir, rec) {
  const data = loadEnds(dir), k = endKey(rec.key, rec.variation), was = data.ends[k];
  const next = { key: rec.key, variation: rec.variation, vm: rec.vm, step: rec.step ?? null, completed: Boolean(rec.completed), since: was?.since ?? ctx.now().toISOString() };
  if (was && JSON.stringify(was) === JSON.stringify(next)) return;
  data.ends[k] = next;
  save(ctx, dir, data);
}

// endDone(ctx, dir, key, variation) — its pending end gone (it ran, or was dropped).
export function endDone(ctx, dir, key, variation) {
  const data = loadEnds(dir), k = endKey(key, variation);
  if (!data.ends[k]) return;
  delete data.ends[k];
  save(ctx, dir, data);
}

// pendingVmEnds(ctx, projectId) — Map VM name → its pending end: step-ends.json's, and those of the leases in memory
// whose step runs or ends in a VM (workstation-steps.js: `vm` set while it is in state vm or releasing).
export function pendingVmEnds(ctx, projectId) {
  const pending = new Map();
  for (const rec of Object.values(loadEnds(join(ctx.paths.projects, projectId)).ends)) if (rec?.vm) pending.set(rec.vm, rec);
  for (const l of ctx.memory.workstationSteps?.values() ?? []) {
    if (l.project === projectId && l.vm && (l.state === 'vm' || l.state === 'releasing') && !pending.has(l.vm)) pending.set(l.vm, { key: l.key, variation: l.variation, vm: l.vm, step: l.step ?? null, completed: Boolean(l.completed) });
  }
  return pending;
}

// vmGone(ctx, name) — the VM is gone (deleted, not merely stopped): limactl list, as the VM lifecycle last read it
// this run (memory.vmStatus), has no such instance. Unknown (not read yet) is not gone.
export const vmGone = (ctx, name) => Boolean(name) && ctx.memory.vmStatus instanceof Map && !ctx.memory.vmStatus.has(name);

// recover(ctx, project, dir) — the migration (see the module comment), once per project; returns how many it recorded.
const FAILED = /^\S+\s+\S+ error workstation (\S+) (\S+): ending its step on its VM failed \([^)]*\): agent\.sh vm:step-end (\S+) (\S+) (\S+)(?: --completed "([^"]*)")?:/;
const ENDED = /^\S+\s+\S+ workstation (\S+) (\S+): its step(?: \(not completed\))? ended on its VM/;
export function recover(ctx, project, dir) {
  const data = loadEnds(dir);
  if (data.recovered) return 0;
  const file = join(ctx.env?.HARNESS_HOME ?? join(homedir(), '.harness'), 'logs', `control-${project.id}.log`);
  const found = new Map();
  let text = '';
  try { if (existsSync(file)) text = readFileSync(file, 'utf8'); } catch (error) { ctx.log('error', `workstation ${project.id}: ASS-480's migration could not read ${file}: ${error.message}`); }
  for (const line of text.split('\n')) {
    let m = FAILED.exec(line);
    if (m && m[3] === project.id) { found.set(endKey(m[4], m[5]), { key: m[4].toUpperCase(), variation: m[5], step: m[6] ?? null, completed: m[6] != null }); continue; }
    m = ENDED.exec(line);
    if (m) found.delete(endKey(m[1], m[2]));
  }
  let n = 0;
  for (const [k, e] of found) {
    if (data.ends[k]) continue;
    const t = project.tickets?.find(x => same(x.key, e.key)), v = t?.variations?.find(x => x.name === e.variation);
    const vm = v?.vm?.name && (v.vm.kind ?? 'lima') === 'lima' ? v.vm.name : `${e.key}-${e.variation}`.toLowerCase();
    data.ends[k] = { ...e, key: t?.key ?? e.key, vm, since: ctx.now().toISOString(), recovered: true };
    ctx.log('workstation', `${e.key} ${e.variation}: its step${e.step ? ` "${e.step}"` : ''}'s end in its VM ${vm} failed before control restarted and never ran: taken up again (ASS-480's migration, from ${file})`);
    n++;
  }
  data.recovered = ctx.now().toISOString();
  save(ctx, dir, data);
  return n;
}
