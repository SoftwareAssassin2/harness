// A ticket's spending limit (ASS-191) and what it has spent against it — its
// recorded dispatches' costs and what its running agents have spent so far
// (ASS-270). Pure: control stops a ticket at its limit (plan.js planDispatch,
// dispatch.js's runs, steps.js stopAtSpendingLimit, supervise.js shutting its
// agents down) and the ticket screen shows it.

const DEFAULT = 'max-spend-per-ticket-usd';   // harness.json's and project.json's
const OWN = 'max-spend-usd';                  // the ticket's own (ticket:set-spending-limit)

// defaultSpendLimit(harness, project) — the dollars a project's tickets may
// spend: its project.json's max-spend-per-ticket-usd, else harness.json's;
// null, neither set, for no limit.
export const defaultSpendLimit = (harness, project) => project?.[DEFAULT] ?? harness?.[DEFAULT] ?? null;

// spendLimit(ticket, fallback) — the ticket's own max-spend-usd, over `fallback` (defaultSpendLimit's).
export const spendLimit = (ticket, fallback) => ticket?.[OWN] ?? fallback;

// ticketSpend(ticket) — the dollars every agent recorded on the ticket cost
// (assignments:remove's cost-usd): each variation not deleted, every state
// change of it — a step's agents, its runs' (Blocked's among them, logged on
// the variation by assignments:create) and a sub-engine's.
export const ticketSpend = ticket => (ticket?.variations ?? []).filter(v => !v['is-deleted'])
  .flatMap(v => v['state-changes'] ?? []).flatMap(c => c['agent-dispatch-log'] ?? [])
  .reduce((sum, d) => sum + (d['cost-usd'] ?? 0), 0);

// overSpent(ticket, harness, project, running = 0) — { spend, limit } once the
// ticket's spend — ticketSpend, plus `running`, what its running agents have
// spent so far (runningOn, ASS-270) — has reached its limit; null under it, or with none.
export function overSpent(ticket, harness, project, running = 0) {
  const limit = spendLimit(ticket, defaultSpendLimit(harness, project));
  if (limit == null) return null;
  const spend = ticketSpend(ticket) + running;
  return spend >= limit ? { spend, limit } : null;
}

// usageSpend(usage) — what a running agent has cost so far by its session's
// usage.json (ASS-270, session-usage.js): its costUsd — the finished turns
// exact, the unfinished one estimated from harness.json's model-prices — 0 on
// a subscription, which never charges (process.js billed), or with nothing
// priced yet. The dashboard's figure; control's is finish.js spentSoFar, which
// knows the live process too.
export const usageSpend = usage => (usage?.billing === 'subscription' ? 0 : usage?.costUsd ?? 0);

// runningSpend(agents) — what each ticket's running agents have cost so far
// (ASS-270), { <project>: { <work-item>: usd } }, from `agents`, [{ record,
// usd }]: each assignment record with what its agent has spent (spentSoFar,
// usageSpend). An agent counts on its ticket only when its record names a
// variation too — then assignments:create logged its dispatch there, where its
// cost is recorded once it ends (so never counted twice: its record and its
// running spend go together).
export function runningSpend(agents) {
  const running = {};
  for (const { record, usd } of agents) {
    if (record?.['work-item'] == null || record.variation == null) continue;
    const of = running[record.project] ??= {};
    of[record['work-item']] = (of[record['work-item']] ?? 0) + usd;
  }
  return running;
}

// runningOn(running, project, key) — runningSpend's dollars on the project's ticket `key`; 0 for none.
export const runningOn = (running, project, key) => running?.[project]?.[key] ?? 0;

// spendText(spend, limit) — "$8.20 of $10": the spend in cents, the limit as set.
export const spendText = (spend, limit) => `$${spend.toFixed(2)} of $${Number.isInteger(limit) ? limit : limit.toFixed(2)}`;

// spendRecords(tickets, collaborations, chatSpend, memory) — what a project has spent, one record
// per agent dispatch on `tickets` (its sprint's and backlog's, every
// variation: a ticket's sprint and backlog entries log different dispatches),
// per chat turn in `collaborations` (its collaboration.json's by ticket,
// ASS-216) and per chat-screen turn in `chatSpend` (its chat-spend.json, null
// for none, ASS-271: chat:add-spend's, an estimate among them): each
// { timestamp, billing, cost-usd, … } as logged, a subscription's at 0;
// then `memory`, its Hindsight's Claude spend (ASS-269: memory-spend.json's
// records, state.js loadMemorySpend), billed api, source memory — the
// project's, on no ticket. No ticket's spending limit reads these: ticketSpend
// sums its own dispatches.
export const spendRecords = (tickets, collaborations = {}, chatSpend = null, memory = []) => [
  ...tickets.flatMap(t => t.variations ?? []).flatMap(v => v['state-changes'] ?? []).flatMap(c => c['agent-dispatch-log'] ?? []),
  ...Object.values(collaborations).flatMap(c => c?.turns ?? []),
  ...(chatSpend?.turns ?? []),
  ...memory,
];

// The local (this computer's time zone) midnight starting the day of `date`, `days` on, in ms.
const midnight = (date, days = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
// The dollars of `records` timestamped from `from` up to `to` (ms); an undated one is in no period.
const spentBetween = (records, from, to) => records.filter(r => r.timestamp && Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) < to)
  .reduce((sum, r) => sum + (r['cost-usd'] ?? 0), 0);

// daySpend(records, at) — the dollars of `records` (spendRecords) on the local day of `at` (a Date).
export const daySpend = (records, at) => spentBetween(records, midnight(at), midnight(at, 1));

// sprintSpend(records, start, at) — the same from the local day `start`
// (YYYY-MM-DD, a sprint's) through the local day of `at`; 0 with no start.
export const sprintSpend = (records, start, at) => (start ? spentBetween(records, midnight(new Date(`${start}T00:00:00`)), midnight(at, 1)) : 0);

// apiCapReached(records, json, sprint, at, running = 0) — the API dollar cap
// (ASS-217: project.json's max-api-spend-per-day-usd, then
// max-api-spend-per-sprint-usd; null or missing for none) that the project's
// api-billed spend — `records` (spendRecords) billed api, plus `running`, what
// its agents still running on the API key have cost so far (ASS-270: their
// unfinished turns' estimate among it) — has reached, as
// { cap: 'day' | 'sprint', spend, limit }; null under both. The sprint cap
// applies only with an active `sprint` (its sprint.json).
export function apiCapReached(records, json, sprint, at, running = 0) {
  const api = records.filter(r => r.billing === 'api');
  const caps = [['day', json['max-api-spend-per-day-usd'], () => daySpend(api, at)], ['sprint', sprint ? json['max-api-spend-per-sprint-usd'] : null, () => sprintSpend(api, sprint.start, at)]];
  for (const [cap, limit, spent] of caps) {
    if (limit == null) continue;
    const spend = spent() + running;
    if (spend >= limit) return { cap, spend, limit };
  }
  return null;
}
