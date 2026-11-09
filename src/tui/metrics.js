// Run-time metrics per state, from ticket variations' state-changes. A visit
// runs from a change into the state to the next change; only finished visits
// count, and the state a history starts in has no arrival time, so it is not
// one. A sub-flow's states are visited within a visit to the step above them
// (ASS-331): the parent's visit bounds theirs.
import { statusChain } from './status.js';
import { changePath } from '../control/engine.js';

const FIELDS = ['visits', 'dispatches', 'finished', 'time', 'agent', 'cost', 'tokens', 'cacheRead'];

// stateMetrics(variations, steps, parents) — { [step id]: { tickets, visitsPerTicket,
// visits, timePerVisit, agentPerVisit, dispatchesPerVisit, costPerDispatch,
// tokensPerDispatch, cacheReadPerDispatch } } for every step, at the level of
// the status `parents` names, the step ids above it top first ([], the top
// level; ASS-331: a sub-flow's, from its own parent path alone). Over every
// visit, open or finished, the start of a history among them: the tickets
// (variations) ever in the state, and the visits per ticket that visited it or
// one of higher sequence — null when none did. Over its finished visits — all
// null when none finished: the visits per ticket that finished one; per visit,
// the time in the state, the time its dispatches ran (both in ms) and how many
// were sent; per finished dispatch — null when none finished — the cost in
// dollars, tokens (input, output and cache writes) and cache reads. A dispatch
// still running is sent but has spent nothing yet.
export function stateMetrics(variations, steps, parents = []) {
  const sequence = new Map(steps.map(s => [s.id, s.sequence]));
  const visited = variations.map(v => visitsOf(v, parents));
  // Each variation's states in the order it was in them.
  const paths = visited.map(visits => visits.map(visit => visit.state));
  const finished = Object.groupBy(visited.flatMap((visits, ticket) => visits.filter(visit => visit.start && visit.end).map(({ state, start, end, log }) => {
    const done = log.filter(d => d['completed-timestamp']);
    const sum = f => done.reduce((total, d) => total + f(d), 0);
    return {
      state,
      ticket,
      visits: 1,
      dispatches: log.length,
      finished: done.length,
      time: Date.parse(end) - Date.parse(start),
      agent: sum(d => Date.parse(d['completed-timestamp']) - Date.parse(d.timestamp)),
      // A dispatch that finished without a result (killed, or died mid-turn) has usage.json's estimate (ASS-268), counted as any cost; none when nothing priced it.
      cost: sum(d => d['cost-usd'] ?? 0),
      tokens: sum(({ tokens: t }) => (t?.input ?? 0) + (t?.output ?? 0) + (t?.['cache-write'] ?? 0)),
      cacheRead: sum(d => d.tokens?.['cache-read'] ?? 0),
    };
  })), v => v.state);
  return Object.fromEntries(steps.map(({ id }) => {
    const visits = paths.reduce((sum, path) => sum + path.filter(state => state === id).length, 0);
    const reached = paths.filter(path => path.some(state => (sequence.get(state) ?? -Infinity) >= sequence.get(id))).length;
    return [id, {
      tickets: paths.filter(path => path.includes(id)).length,
      visitsPerTicket: reached ? visits / reached : null,
      ...finishedMetrics(finished[id] ?? []),
    }];
  }));
}

// visitsOf(v, parents) — the variation's visits at the level `parents` names
// (see stateMetrics), in order, each { state, start, end, log }: start, the
// change into the state, end, the next change at this level or the parent
// step's leaving (ASS-331) — none when unknown or still open — and log, the
// dispatches of the change into it and of every change made deeper within it.
// A change into the parent step starts its visit: the first state the sub-flow
// records in it arrives then, unless a change from no state names its arrival.
// Without a change at this level, the state its harness-status is in here.
function visitsOf(v, parents) {
  const depth = parents.length, visits = [];
  let open, arrived;        // the visit at this level under way, and when the parent step's began
  const leave = timestamp => { if (open) open.end = timestamp; open = undefined; };
  for (const change of v['state-changes'] ?? []) {
    const path = changePath(change);
    const under = parents.every((state, i) => path[i]?.['to-state'] === state);
    if (under && path.length === depth) { leave(change.timestamp); arrived = change.timestamp; continue; }   // into the parent step
    if (!under) { leave(change.timestamp); arrived = undefined; continue; }                                         // out of it
    const at = path[depth], log = change['agent-dispatch-log'] ?? [];
    if (path.length > depth + 1) { open?.log.push(...log); continue; }                                          // deeper: part of the visit
    if (!open && at['from-state'] != null) visits.push(open = { state: at['from-state'], start: arrived, log: [] });
    leave(change.timestamp);
    visits.push(open = { state: at['to-state'], start: change.timestamp, log: [...log] });
  }
  if (visits.length) return visits;
  const chain = statusChain(v).map(l => l.state);
  return parents.every((state, i) => chain[i] === state) && chain[depth] != null ? [{ state: chain[depth], log: [] }] : [];
}

// The averages over a state's finished visits (see stateMetrics).
function finishedMetrics(list) {
  if (!list.length) return Object.fromEntries(['visits', 'timePerVisit', 'agentPerVisit', 'dispatchesPerVisit', 'costPerDispatch', 'tokensPerDispatch', 'cacheReadPerDispatch'].map(k => [k, null]));
  const total = Object.fromEntries(FIELDS.map(field => [field, list.reduce((sum, v) => sum + v[field], 0)]));
  const perVisit = field => total[field] / total.visits;
  const perDispatch = field => (total.finished ? total[field] / total.finished : null);
  return {
    visits: total.visits / new Set(list.map(v => v.ticket)).size,
    timePerVisit: perVisit('time'),
    agentPerVisit: perVisit('agent'),
    dispatchesPerVisit: perVisit('dispatches'),
    costPerDispatch: perDispatch('cost'),
    tokensPerDispatch: perDispatch('tokens'),
    cacheReadPerDispatch: perDispatch('cacheRead'),
  };
}

// metricLines(metrics, prompted, width) — the lines under a station for its
// stateMetrics entry, each its label at the left and value at the right of
// `width`: tickets visited and visits per ticket, then, from its finished
// visits, the subset that visited's visits per ticket and time in the state per
// visit and, on a step that prompts an agent, agent time and dispatches per
// visit and cost, tokens and cache reads per dispatch.
export function metricLines(metrics, prompted, width) {
  const line = (label, value) => `${label} ${String(value).padStart(width - label.length - 1)}`;
  const either = (value, show) => (value == null ? '—' : show(value));
  const ratio = value => Number(value.toFixed(2));
  return [
    line('tickets visited', metrics.tickets),
    line('visits per ticket', either(metrics.visitsPerTicket, ratio)),
    ...(metrics.visits == null ? ['no finished visits'] : [
      line('↳ subset that visited', ratio(metrics.visits)),
      line('in state per visit', duration(metrics.timePerVisit)),
      ...(prompted ? [
        line('agent time per visit', duration(metrics.agentPerVisit)),
        line('dispatches per visit', ratio(metrics.dispatchesPerVisit)),
        line('cost per dispatch', either(metrics.costPerDispatch, cost => `$${cost.toFixed(2)}`)),
        line('tokens per dispatch', either(metrics.tokensPerDispatch, count)),
        line('cache reads per dispatch', either(metrics.cacheReadPerDispatch, count)),
      ] : []),
    ]),
  ];
}

// floorNotes(variations, width) — the notes nestedFloor gives each floor of
// stations in the metrics view (ASS-331: one path for S and B), as
// (steps, parents) => { [step id]: its metricLines }: the steps' stateMetrics
// at the level under `parents`, the step ids above them, each a `width` wide.
export const floorNotes = (variations, width) => (steps, parents) => {
  const metrics = stateMetrics(variations, steps, parents);
  return Object.fromEntries(steps.map(s => [s.id, metricLines(metrics[s.id], s.action?.type === 'prompt', width)]));
};

// "1d 4h", "2h 14m", "6m 30s" or "45s": `ms` in its two largest units.
export function duration(ms) {
  const s = Math.round(ms / 1000);
  const [days, hours, minutes, seconds] = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60];
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// "950", "742k", "67k" or "1.1M": three significant figures, or two where
// three would take more than four characters.
export function count(n) {
  const [value, unit] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, ''];
  const shown = `${Number(value.toPrecision(3))}${unit}`;
  return shown.length > 4 ? `${Number(value.toPrecision(2))}${unit}` : shown;
}
