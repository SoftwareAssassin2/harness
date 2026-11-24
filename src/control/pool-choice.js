// ASS-553: pool choice — where a step goes among its eligible run targets when the step (or its project) chooses
// `most-room` (run-targets.js poolChoiceOf): the machine with the most headroom now, so a loaded Mac sends work to a
// remote machine with room, and a busy workstation to an idle cloud VM. Operator decision, 2026-11-23. Pure: the
// planner (plan.js seatFor) asks, seats.js places and logs the decision.
//
// Headroom is counted in tickets — how many more of the project's tickets fit before a limit is reached — so a big
// machine and a small one compare by what they can take, not by a percentage:
// - The Mac (local-vm, local-substrate, local-worktree, local-workspace): the smaller of the Mac's room under the
//   harness's budget (seat-budget.json `mac`: its measured memory and CPU against max-memory-percent and
//   max-cpu-percent) and the project's room under its allotment (its share after reallocation, less what its own work
//   uses), each over one ticket's expected use (`per-ticket`), memory and CPU each, the fewer of the two. ASS-540's Mac
//   targets take no seat but count in the Mac's measured use, so they share this figure.
// - A workstation or cloud VM (workstation, cloud-vm, their -substrate and -worktree targets): its remote-seats.json
//   entry (remote-seats.js): its measured memory and CPU against its own limits, over its per-ticket use, less its
//   seats given whose step has not claimed it yet (`pending`). One not measured (stopped, or no fresh reading) counts
//   its free seats (1 when nothing of the project's is on it: an idle machine is all room); one whose reading failed
//   counts 0. Of a kind, the machine with a free seat and the most room is the one taken (the target's `machine`).
// - Unknown (no reading of the Mac yet, as in tests with HOST_MEMORY_DISABLED): null, ranked after every known figure;
//   ties — two equal, or every one unknown — keep the step's list order, so nothing moves without a reading.
// - Within one planning pass each ticket placed takes one ticket's room off its host (`placed`), so two tickets in
//   one tick do not both go to the machine that had room for one.
import { seatCapacity } from './seat-kinds.js';
import { HOST_OF } from './run-targets.js';

const finite = n => typeof n === 'number' && Number.isFinite(n);

// fit(free, per) — how many tickets of `per` fit in `free`, over the dimensions known ({ memory, cpu }); null with none.
function fit(free, per) {
  const each = ['memory', 'cpu'].filter(d => finite(free[d]) && finite(per[d]) && per[d] > 0).map(d => Math.max(0, free[d]) / per[d]);
  return each.length ? Math.min(...each) : null;
}

// macRoom(budget) — the Mac's headroom in tickets for the project, from its seat-budget.json (`budget`), or null.
export function macRoom(budget) {
  if (!budget) return null;
  const mac = budget.mac ?? {}, allot = budget.allotment ?? {}, used = budget.used ?? {}, per = budget['per-ticket'] ?? {};
  const room = d => {
    const [u, b, a, mine] = d === 'memory'
      ? [mac['memory-used-bytes'], mac['memory-budget-bytes'], allot['memory-bytes'], used['memory-bytes']]
      : [mac['cpu-percent'], mac['cpu-budget-percent'], allot['cpu-percent'], used['cpu-percent']];
    const free = [finite(u) && finite(b) ? b - u : null, finite(a) ? a - (finite(mine) ? mine : 0) : null].filter(finite);
    return free.length ? Math.min(...free) : null;
  };
  return fit({ memory: room('memory'), cpu: room('cpu') }, { memory: per['memory-bytes'], cpu: per['cpu-percent'] });
}

// machineRoom(entry) — a remote machine's headroom in tickets, from its remote-seats.json entry, or null.
export function machineRoom(entry) {
  if (!entry) return null;
  if (entry.state === 'unread') return 0;
  if (entry.state !== 'measured') return Math.max(0, (entry.seats ?? 1) - (entry.held ?? 0));
  const per = entry['per-ticket'] ?? {};
  const room = fit({ memory: entry['memory-budget-bytes'] - entry['memory-used-bytes'], cpu: entry['cpu-budget-percent'] - entry['cpu-percent'] }, { memory: per['memory-bytes'], cpu: per['cpu-percent'] });
  return room == null ? null : Math.max(0, room - (entry.pending ?? 0));
}

// headroomOf(project) — (target, placed) → { room, machine? }: the target's headroom now (see the module comment);
// `placed` a Map host ('mac', or a machine id) → tickets placed there in this pass. For a remote target, the machine of
// its kind with a free seat and the most room (ties: the pool's order), or { room: null } with none free.
export function headroomOf(project) {
  const capacity = seatCapacity(project), records = project?.seats ?? [];
  const mac = macRoom(project?.seatBudget);
  return (target, placed = new Map()) => {
    const host = HOST_OF[target];
    if (host === 'local') return { room: mac == null ? null : mac - (placed.get('mac') ?? 0) };
    let best = null;
    for (const w of capacity.workstations) {
      if (w.lost || (w.kind === 'cloud-vm' ? 'cloud-vm' : 'workstation') !== host) continue;
      const on = records.filter(s => s.workstation === w.id).length + (placed.get(w.id) ?? 0);
      if (on >= w.seats) continue;
      const r = machineRoom(project?.remoteBudget?.[w.id]);
      const room = r == null ? null : r - (placed.get(w.id) ?? 0);
      if (!best || rank(room) > rank(best.room)) best = { room, machine: w.id };
    }
    return best ?? { room: null };
  };
}

// rank(room) — a room for comparing: unknown below every known figure.
export const rank = room => (room == null ? -Infinity : room);

// mostRoom(rated) — of [{ target, room, machine? }] in the step's order, the one with the most room; ties keep the order.
export function mostRoom(rated) {
  let best = null;
  for (const r of rated) if (!best || rank(r.room) > rank(best.room)) best = r;
  return best;
}

// roomWords(rated) — the decision in words for the log: "workstation-worktree on ws-1 2.4, local-worktree 0.3".
export const roomWords = rated => rated.map(r => `${r.target}${r.machine ? ` on ${r.machine}` : ''} ${r.room == null ? 'unknown' : (Math.round(r.room * 10) / 10).toString()}`).join(', ');
