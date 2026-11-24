// Ticket variations on GCP workstations, as control sees them (ASS-435,
// ASS-468): which variation holds which workstation, whether a variation
// takes the Mac's memory, and a workstation's state for the TUI. A
// workstation is claimed for one step of a variation at a time and given
// back at the step's end (workstation:claim, workstation:release, driven by
// control's workstation-steps.js); control keeps it connected and set up
// while a step needs it (workstations.js).
//
// The live data (workstations.json, workstation-connection.js) has each
// workstation's `holder`, { ticket, variation, folder, since, boot-id,
// started-at, credential-kind, credential-stamps }: the ticket variation
// whose step runs in its shared root (ASS-529: and `holders` { "<n>": … } those
// in its other slots, ~/harness/slots/<n> — several tickets' steps at once,
// workstation-connection.js holdersOf; one at a time before, operator decision 2026-11-14),
// recorded by workstation:claim under the project's pool lock, vm:start (its
// boot-id, its credential kind) and vm:credentials (its stamps); removed by
// workstation:release. The variation records the claim as its `workstation`
// { name: <id>, project, folder } — its machine for the step (machine.js
// machineOf) — and Create VM's choice of workstation as its vm { kind:
// workstation, name: <id>, project, folder } (ticket:set-vm).
//
// For ASS-436's footer: a workstation's agents are the assignments on its
// holder's variation (state.assignments with that project, work-item and
// variation) — never more than one variation's — and its state the live
// data's (workstationState).
import { join } from 'node:path';
import { loadWorkstations, workstationUsable, loginExpired, holderOf } from './workstation-connection.js';
import { seatOf, seatCapacity, isRemoteSeat } from './seat-kinds.js';

export const KIND = 'workstation';

// entriesOf(ctx, projectId) — the project's workstations.json entries by id.
export const entriesOf = (ctx, projectId) => loadWorkstations(join(ctx.paths.projects, projectId));

const sameKey = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

// onWorkstationVariation(variation) — it records a workstation — or, ASS-481, a cloud VM — as its machine (Create VM's choice).
export const onWorkstationVariation = variation => (variation?.vm?.kind === KIND || variation?.vm?.kind === 'cloud-vm') && Boolean(variation.vm.name);

// busy(state, projectId, key, name) — an assignment is on the variation (its agent at work, or about to be).
export const busy = (state, projectId, key, name) => state.assignments.some(a => a.project === projectId && sameKey(a['work-item'], key) && a.variation === name);

// holds(entry, key, name) — the workstation's live data has the variation as its holder.
// ASS-529: any of its holders (several tickets' steps on one machine, each in a slot of its own).
export const holds = (entry, key, name) => Boolean(holderOf(entry, key, name));

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

// cloudVmState(entry) — ASS-481 AC5: the "cloud virtual machines" box's word
// (ASS-485 retitled it) for a cloud VM's state, workstationState's with two
// more: 'start timed out' (its last connect's start or SSH wait ran out:
// last-error kind timeout) and 'starting' (workstation:connect starting it or
// waiting for it now: the live data's state starting, recorded since its last
// failure).
export function cloudVmState(entry) {
  const word = workstationState(entry);
  if (word !== 'stopped') return word;
  if (entry?.['last-error']?.kind === 'timeout') return 'start timed out';
  if (entry?.state === 'starting' && (entry['state-at'] ?? '') >= (entry['last-error']?.at ?? '')) return 'starting';
  return 'stopped';
}

// usableOne(project, entries) — { id } of the first workstation in the
// project's list Create VM would record a variation on (its login live, its
// setup not failed), or { why }, naming why each is not. Who holds one does
// not matter: a variation claims one per step (ASS-468).
export function usableOne(project, entries) {
  const why = [];
  for (const w of project.devEnvironments?.workstations ?? []) {
    const e = entries[w.id];
    if (loginExpired(e)) { why.push(`${w.id}'s gcloud login needs reauthentication`); continue; }
    if (e?.setup?.ok === false) { why.push(`${w.id}'s setup failed`); continue; }
    return { id: w.id };
  }
  return { why: why.join('; ') || 'it lists none' };
}

// needsMacMemory(ctx, state, project, variation) — whether the variation's
// machine, when it starts, takes the Mac's memory (ASS-420's seat check,
// ASS-398's hold): not on a workstation, not holding a workstation seat
// (ASS-469), and — holding no VM seat (ASS-469) — not about to be recorded on
// one (workstation mode; vm+workstation with one usable).
export function needsMacMemory(ctx, state, project, variation) {
  if (onWorkstationSeat(project, variation)) return false;
  const ticket = project?.tickets?.find(t => t.variations?.includes(variation));
  if (ticket && project.devEnvironments?.mode === 'vm+workstation' && seatOf(project.seats, ticket.key, variation.name)?.kind === 'vm') return true;   // ASS-469: a VM seat's steps run on its VM, made if need be
  if (onWorkstationVariation(variation)) return false;
  if (variation?.vm?.name) return true;
  const mode = project.devEnvironments?.mode ?? 'vm';
  if (mode === 'workstation') return false;
  return !(mode === 'vm+workstation' && usableOne(project, entriesOf(ctx, project.id)).id);
}

// onWorkstationSeat(project, variation) — ASS-469: the variation holds a seat on one of its project's workstations
// (seats.json, seats.js), so its steps run there and its VM, if it has one, is not needed.
export function onWorkstationSeat(project, variation) {
  const ticket = project?.tickets?.find(t => t.variations?.includes(variation));
  return Boolean(ticket && isRemoteSeat(seatOf(project.seats, ticket.key, variation.name)) && seatCapacity(project).workstations.length);
}
