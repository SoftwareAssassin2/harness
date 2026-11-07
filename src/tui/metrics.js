// Run-time metrics per state, from ticket variations' state-changes. A visit
// runs from a change into the state to the next change; only finished visits
// count, and the state a history starts in has no arrival time, so it is not
// one.
import { stateOf, levelChanges } from './status.js';

const FIELDS = ['visits', 'dispatches', 'finished', 'time', 'agent', 'cost', 'tokens', 'cacheRead'];

// stateMetrics(variations, steps) — { [step id]: { tickets, visitsPerTicket,
// visits, timePerVisit, agentPerVisit, dispatchesPerVisit, costPerDispatch,
// tokensPerDispatch, cacheReadPerDispatch } } for every step. Over every visit,
// open or finished, the start of a history among them: the tickets (variations)
// ever in the state, and the visits per ticket that visited it or one of higher
// sequence — null when none did. Over its finished visits — all null when none
// finished: the visits per ticket that finished one; per visit, the time in the
// state, the time its dispatches ran (both in ms) and how many were sent; per
// finished dispatch — null when none finished — the cost in dollars, tokens
// (input, output and cache writes) and cache reads. A dispatch still running is
// sent but has spent nothing yet.
export function stateMetrics(variations, steps) {
  const sequence = new Map(steps.map(s => [s.id, s.sequence]));
  // Each variation's states in the order it was in them.
  const paths = variations.map(v => {
    const changes = levelChanges(v);
    return changes.length ? [changes[0]['from-state'], ...changes.map(c => c['to-state'])] : [stateOf(v)].filter(Boolean);
  });
  const finished = Object.groupBy(variations.flatMap((v, ticket) => {
    const changes = levelChanges(v);
    return changes.slice(0, -1).map((c, i) => {
      const done = c['agent-dispatch-log'].filter(d => d['completed-timestamp']);
      const sum = f => done.reduce((total, d) => total + f(d), 0);
      return {
        state: c['to-state'],
        ticket,
        visits: 1,
        dispatches: c['agent-dispatch-log'].length,
        finished: done.length,
        time: Date.parse(changes[i + 1].timestamp) - Date.parse(c.timestamp),
        agent: sum(d => Date.parse(d['completed-timestamp']) - Date.parse(d.timestamp)),
        // A dispatch that finished without a result (killed, or died mid-turn) has usage.json's estimate (ASS-268), counted as any cost; none when nothing priced it.
        cost: sum(d => d['cost-usd'] ?? 0),
        tokens: sum(({ tokens: t }) => (t?.input ?? 0) + (t?.output ?? 0) + (t?.['cache-write'] ?? 0)),
        cacheRead: sum(d => d.tokens?.['cache-read'] ?? 0),
      };
    });
  }), v => v.state);
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
