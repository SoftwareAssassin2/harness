// Ticket variations on GCP workstations, as control sees them (ASS-435):
// which variation holds which workstation, whether its machine there is up,
// where an unplaced one would go, and why one waits. The placement itself —
// a free workstation claimed, the variation's folder made and readied — is
// vm:create's (agent-cli/workstation-variation.bash); control keeps the
// workstation connected and set up (workstations.js) and acts on what this
// reads: the steps and the agents wait (vm-lifecycle.js awaitsVm), the
// holders are released, readied again or refreshed, and the Health says why
// one waits (workstations.js tend).
//
// The live data (workstations.json, workstation-connection.js) has each
// workstation's `holder`, { ticket, variation, folder, since, boot-id,
// started-at, credential-kind, credential-stamps }: the one ticket variation
// on it (one per workstation, operator decision 2026-11-14), recorded by
// vm:create under the project's pool lock, vm:start (its boot-id, its
// credential kind) and vm:credentials (its stamps); removed by
// workstation:release. The variation records it as its vm { kind:
// workstation, name: <id>, project, folder } (ticket:set-vm).
//
// For ASS-436's footer: a workstation's agents are the assignments on its
// holder's variation (state.assignments with that project, work-item and
// variation) — never more than one variation's — and its state the live
// data's (workstationState).
import { join } from 'node:path';
import { statusOf } from './engine.js';
import { loadWorkstations, workstationUsable, loginExpired, loginCommand } from './workstation-connection.js';

export const KIND = 'workstation';

// entriesOf(ctx, projectId) — the project's workstations.json entries by id.
export const entriesOf = (ctx, projectId) => loadWorkstations(join(ctx.paths.projects, projectId));

const sameKey = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
const useOf = (state, project, v) => statusOf(project.engines ?? state.engines, project.engineName, v).chain.findLast(l => l.step?.vm)?.step.vm;

// onWorkstationVariation(variation) — it records a workstation as its machine.
export const onWorkstationVariation = variation => variation?.vm?.kind === KIND && Boolean(variation.vm.name);

// busy(state, projectId, key, name) — an assignment is on the variation (its agent at work, or about to be).
export const busy = (state, projectId, key, name) => state.assignments.some(a => a.project === projectId && sameKey(a['work-item'], key) && a.variation === name);

// variationOf(project, key, name) — the live variation (not set aside), or undefined.
export const variationOf = (project, key, name) => project.tickets?.find(t => sameKey(t.key, key))?.variations?.find(v => v.name === name && !v['is-deleted']);

// inFlight(state, project, key, name) — the variation still needs its
// machine kept: an assignment on it, or live at a step whose `vm` is running
// or stopped (a VM so is not deletable, vm.bash reconcile_vms); one not in
// flight may have its workstation reclaimed by another's placement.
export function inFlight(state, project, key, name) {
  if (busy(state, project.id, key, name)) return true;
  const v = variationOf(project, key, name);
  const use = v && useOf(state, project, v);
  return use === 'running' || use === 'stopped';
}

// givesUp(state, project, key, name) — why the variation gives its
// workstation up now (AC1, AC6): gone from the sprint or set aside, Done (its
// top-level step is-done) or at a `vm: released` step; null while it keeps it
// (anything else, and always while an assignment is on it).
export function givesUp(state, project, key, name) {
  if (busy(state, project.id, key, name)) return null;
  const v = variationOf(project, key, name);
  if (!v) return 'gone from the sprint or set aside';
  const status = statusOf(project.engines ?? state.engines, project.engineName, v);
  if (status.step?.['is-done'] === true) return `${status.state}: done`;
  if (useOf(state, project, v) === 'released') return `at ${status.detail}: released`;
  return null;
}

// holds(entry, key, name) — the workstation's live data has the variation as its holder.
export const holds = (entry, key, name) => sameKey(entry?.holder?.ticket, key) && entry.holder.variation === name;

// machineUp(entry, key, name) — the variation's machine on the workstation
// is up (what a VM's Running-and-reached is, ASS-169): the workstation usable
// (connected, its login live, set up since: workstationUsable), held by the
// variation, and readied by vm:start since the workstation last started (the
// holder's boot-id the setup's: a restart empties the runtime folder, the
// credentials and token with it).
export const machineUp = (entry, key, name) => workstationUsable(entry) && holds(entry, key, name)
  && entry.holder['boot-id'] != null && entry.holder['boot-id'] === entry.setup?.['boot-id'];

// workstationState(entry) — ASS-436's word for a workstation's state: 'sign
// in needed', 'setup failed', 'connecting' (connected but not set up yet),
// 'running' (usable), or 'stopped'.
export function workstationState(entry) {
  if (loginExpired(entry)) return 'sign in needed';
  if (entry?.connected === true && entry.setup?.ok === false) return 'setup failed';
  if (workstationUsable(entry)) return 'running';
  if (entry?.connected === true) return 'connecting';
  return 'stopped';
}

// whyDown(settings, id, entry, key, name, home) — why the variation's machine
// there is not up, in words for its Health and the log (AC7), or null when it is.
export function whyDown(settings, id, entry, key, name, home) {
  if (machineUp(entry, key, name)) return null;
  const w = settings?.workstations?.find(x => x.id === id);
  if (loginExpired(entry)) return `the gcloud login of workstation ${id} needs reauthentication: run ${loginCommand(w?.['gcloud-config'], home)}`;
  if (entry?.connected === true && entry.setup?.ok === false) return `workstation ${id}'s setup failed: ${entry.setup.error ?? 'see the control log'}`;
  if (entry?.connected !== true) return `workstation ${id} is not connected (stopped, or starting)${entry?.['last-error']?.message ? `; its last connect failed: ${entry['last-error'].message}` : ''}`;
  if (!workstationUsable(entry)) return `workstation ${id} is being set up`;
  if (entry.holder && !holds(entry, key, name)) return `workstation ${id} is held by ${entry.holder.ticket} ${entry.holder.variation}`;
  if (!entry.holder) return `its folder on workstation ${id} is to be made again`;
  return `workstation ${id} has started since its folder was readied: its credentials and forwarder token are being given again`;
}

// freeOne(state, project, entries) — { id } of the first workstation in the
// project's list a variation could be placed on now (vm:create's
// wsv_place): no holder, or one no longer in flight; its login live; its
// setup not failed. { why } when none is, naming why each is not. One
// held by the variation asking (`key`, `name`: its vm:create claimed it, and
// has not yet recorded it on the variation) is free for it.
export function freeOne(state, project, entries, key, name) {
  const why = [];
  for (const w of project.devEnvironments?.workstations ?? []) {
    const e = entries[w.id], h = e?.holder;
    if (h && !(key && holds(e, key, name)) && inFlight(state, project, h.ticket, h.variation)) { why.push(`${w.id} is held by ${h.ticket} ${h.variation}`); continue; }
    if (loginExpired(e)) { why.push(`${w.id}'s gcloud login needs reauthentication`); continue; }
    if (e?.setup?.ok === false) { why.push(`${w.id}'s setup failed`); continue; }
    return { id: w.id };
  }
  return { why: why.join('; ') || 'it lists none' };
}

// placementWait(ctx, state, project, variation) — why an unplaced variation
// (no machine yet) of a project in workstation mode waits, at a step that
// needs its machine: no workstation of its pool is free (freeOne); null when
// one is, or it needs none now, or the project may use VMs. In vm+workstation
// mode it never waits: vm:create falls back to a VM.
export function placementWait(ctx, state, project, variation) {
  if (project.devEnvironments?.mode !== 'workstation' || variation?.vm?.name || useOf(state, project, variation) !== 'running') return null;
  const ticket = project.tickets?.find(t => t.variations?.includes(variation));
  const free = freeOne(state, project, entriesOf(ctx, project.id), ticket?.key, variation?.name);
  return free.id ? null : `no workstation of ${project.id}'s is free (${free.why})`;
}

// needsMacMemory(ctx, state, project, variation) — whether the variation's
// machine, when it starts, takes the Mac's memory (ASS-420's seat check,
// ASS-398's hold): not on a workstation, and not about to be placed on one
// (workstation mode; vm+workstation with one free).
export function needsMacMemory(ctx, state, project, variation) {
  if (onWorkstationVariation(variation)) return false;
  if (variation?.vm?.name) return true;
  const mode = project.devEnvironments?.mode ?? 'vm';
  if (mode === 'workstation') return false;
  const ticket = project.tickets?.find(t => t.variations?.includes(variation));
  return !(mode === 'vm+workstation' && freeOne(state, project, entriesOf(ctx, project.id), ticket?.key, variation?.name).id);
}
