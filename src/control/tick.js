// One cycle of control (finish what ended before anything new is dispatched,
// so the top ticket keeps its seat). The
// phases run in this order, never interleaved, each on the data as it is
// when it starts:
//   1. finish ended agents       finish.js
//   2. image registries          registry.js; and each project's Hindsight
//                                memory, memory.js (ASS-62), backed up
//                                daily, memory-backup.js (ASS-148), its
//                                Claude spend read, memory-spend.js (ASS-269)
//   3. VMs by state              vm-lifecycle.js
//   4. fast-tracked tickets      fast-track.js: pre-empting running work
//                                for the seats they waited for (ASS-83)
//      non-agent steps           steps.js
//   5. gap detection             triggers.js
//   6. timers                    triggers.js; reverted tickets' memory
//                                reviews, reverts.js (ASS-146); the gcloud
//                                and glab logins, each project's Claude
//                                usage (usage.js) and the Anthropic API
//                                cost (api-cost.js, ASS-153)
//   7. ticket health sampling    triggers.js; the priority raises a waiting
//                                ticket's dependencies are given and given
//                                back, dependencies.js (ASS-195), before
//                                refinement reaches a backlog one
//   8. status nags + shutdowns   supervise.js
//   9. dispatch                  dispatch.js
// A rate limit is held per (project, credential kind) (ASS-215): the tick runs
// in full, and only the held kind's agents of that project are not dispatched
// (dispatch.js), until the clock passes the reset recorded for it, which is
// then cleared (project:clear-rate-limit <project> <kind>).
// While a restart drains (startDrain, ASS-200) no agent starts: fast
// track, refinement and dispatch are skipped; the rest run — the non-agent
// steps and VM work too (ASS-236), so a ticket's scripts go on — so the
// running agents' ended turns are finished and paused ones shut down.
import { spawnSync, execFile } from 'node:child_process';
import { paths, loadState } from './state.js';
import { runCli, runScript, scriptSucceeds } from './cli.js';
import { finishEnded, spentSoFar } from './finish.js';
import { runningSpend } from './spend.js';
import { runSteps } from './steps.js';
import { detectGaps, fireTimers, checkGcloud, checkGlab, sampleHealth, refineBacklog } from './triggers.js';
import { superviseAgents } from './supervise.js';
import { superviseRegistries } from './registry.js';
import { superviseMemory } from './memory.js';
import { backupMemory } from './memory-backup.js';
import { recordMemorySpend } from './memory-spend.js';
import { superviseVms } from './vm-lifecycle.js';
import { dispatch } from './dispatch.js';
import { fastTrack } from './fast-track.js';
import { checkUsage } from './usage.js';
import { checkApiCost } from './api-cost.js';
import { detectReverts } from './reverts.js';
import { raiseDependencies } from './dependencies.js';
import { sessionUsage } from '../agents/usage.js';
import { monthCost } from '../agents/api-cost.js';

// createContext({ root, env, command, log, now }) — what every phase works
// with: `root` the repo (agent.sh lives there), `env` the agent-cli's path
// overrides (tests), `command` the agent command instead of Claude (tests),
// log(phase, detail) one line per action, now() the clock. Holds `agents`,
// the live agent processes by name (see dispatch.js), `memory`, what control
// remembers between ticks (timers, scripts run, nags sent, state
// changes counted, the rate-limit reset last logged, each dev container's
// mounts, the failing steps backing off — see backoff.js), and the ways to act: cli(args), script(argv), succeeds(argv) (see
// cli.js; script and succeeds take a VM to run in, ASS-74), load() (see state.js), stopAgents(), mounts(container) (docker
// inspect's Mounts, [{ Source, Destination }], asked once; tests replace it).
// With `project` (a project's id) the control is that project's alone
// (ASS-9): load() lists it alone in `projects` — every phase acts on it only —
// and every project in `allProjects`, for what spans them (harness.json's
// limits, the harness project's health checks); without, both are all of them.
// load() also gives `running`: what each ticket's agents running in this
// control have spent so far (ASS-270: spend.js runningSpend of finish.js
// spentSoFar, their unfinished turns estimated from usage.json), which its
// spending limit counts (spend.js runningOn) wherever it is checked.
export function createContext({ root, env = process.env, command, log = () => {}, now = () => new Date(), project = null }) {
  const ctx = {
    root, env, command, log, now, started: now(), project,
    paths: paths(root, env),
    agents: new Map(),
    memory: { lastRun: new Map(), ran: new Set(), timers: new Map(), changes: new Map(), health: [], nagged: new Map(), warned: new Set(), holding: new Map(), mounts: new Map(), backoff: new Map() },
  };
  ctx.mounts = container => {
    if (!ctx.memory.mounts.has(container)) {
      const out = spawnSync('docker', ['inspect', '--format', '{{json .Mounts}}', container], { encoding: 'utf8' });
      let mounts = [];
      try { mounts = JSON.parse(out.stdout); } catch { ctx.log('error', `docker inspect ${container}: ${(out.stderr || out.error?.message || '').trim() || 'no mounts'}`); }
      ctx.memory.mounts.set(container, Array.isArray(mounts) ? mounts : []);
    }
    return ctx.memory.mounts.get(container);
  };
  // gcloud() — whether the user's gcloud login is live (ASS-28), by gcloud
  // auth print-access-token; glab() whether glab is authenticated (ASS-61),
  // by glab auth status, which only reads the login and fails however it is
  // lost (expired, revoked, missing). Neither prompts. See login. Tests replace them.
  ctx.gcloud = login('gcloud', ['auth', 'print-access-token']);
  ctx.glab = login('glab', ['auth', 'status']);
  // usage(configDir) — a Claude login's 5-hour session and weekly usage (ASS-47, ASS-65, see
  // src/agents/usage.js and usage.js); null with CLAUDE_USAGE_DISABLED=1 —
  // the test fixtures' env, as ACLI_DISABLED is — so a test's control never
  // reads a real token or calls the endpoint. Tests replace it.
  ctx.usage = env.CLAUDE_USAGE_DISABLED === '1' ? null : dir => sessionUsage(dir);
  // apiCost(now, service) — an Anthropic API organization's spend in now's UTC
  // month, with the admin key in keychain item `service` (the harness org's
  // without one, ASS-221) (ASS-153, see src/agents/api-cost.js and api-cost.js); null with
  // ANTHROPIC_API_COST_DISABLED=1 — the test fixtures' env, as
  // CLAUDE_USAGE_DISABLED is — so a test's control never reads the admin key
  // or calls the Cost Admin API. Tests replace it.
  ctx.apiCost = env.ANTHROPIC_API_COST_DISABLED === '1' ? null : (now, service) => monthCost({ now, env, service });
  ctx.cli = (args, env) => runCli(ctx, args, env);
  ctx.script = (argv, vm) => runScript(ctx, argv, vm);
  ctx.succeeds = (argv, vm) => scriptSucceeds(ctx, argv, vm);
  ctx.load = () => {
    const state = loadState(ctx.paths);
    // A bad switched-off-steps entry (ASS-209: left on by loadState), logged once.
    for (const p of state.projects) for (const e of p.switchedOffErrors) if (!ctx.memory.warned.has(`switched-off/${p.id}/${e}`)) { ctx.memory.warned.add(`switched-off/${p.id}/${e}`); ctx.log('error', `project ${p.id}: ${e}`); }
    const running = runningSpend([...ctx.agents.values()].map(live => ({ record: live.record, usd: spentSoFar(live) })));
    return { ...state, allProjects: state.projects, projects: project ? state.projects.filter(p => p.id === project) : state.projects, running };
  };
  ctx.stopAgents = () => { for (const live of ctx.agents.values()) live.agent.stop(); };
  // attempt(phase, what, fn) — fn() awaited; what it throws is logged under
  // "error" as "<phase> <what>: <message>", so one failing item leaves the
  // rest of its phase to run.
  ctx.attempt = async (phase, what, fn) => {
    try { await fn(); } catch (error) { ctx.log('error', `${phase} ${what}: ${error.message}`); }
  };
  return ctx;
}

// login(command, args) — a probe of a CLI's login: 'live' when the command
// exits 0; 'expired' when it exits otherwise; 'unavailable' when it cannot be
// run or does not answer in 30 seconds.
const login = (command, args) => () => new Promise(done => execFile(command, args, { timeout: 30_000 }, error =>
  done(!error ? 'live' : error.code === 'ENOENT' || error.killed ? 'unavailable' : 'expired')));

// The phases that start agents, skipped while a restart drains.
const NEW_WORK = new Set([fastTrack, refineBacklog, dispatch]);
const PHASES = [finishEnded, superviseRegistries, superviseMemory, backupMemory, recordMemorySpend, superviseVms, fastTrack, runSteps, detectGaps, fireTimers, detectReverts, checkGcloud, checkGlab, checkUsage, checkApiCost, sampleHealth, raiseDependencies, refineBacklog, superviseAgents, dispatch];

// tick(ctx) — the twenty phases, in order, each reading the data afresh; a
// phase that throws is logged under "error" and the next still runs. The
// rate limits — recorded by the finish phase, so checked after it — are
// logged and cleared (checkRateLimits), the tick going on.
export async function tick(ctx) {
  const now = ctx.now().getTime();
  for (const phase of PHASES) {
    if (phase === fastTrack) await checkRateLimits(ctx, now);
    if (ctx.drain && NEW_WORK.has(phase)) continue;
    try {
      await phase(ctx, ctx.load());
    } catch (error) {
      ctx.log('error', `${phase.name}: ${error.message}`);
    }
  }
}

// startDrain(ctx) — a restart was asked for (ASS-200): from now the ticks
// start no agent (see tick) while the running agents — every control's —
// end their turns, for up to harness.json's restart-drain-seconds (300 by default).
export function startDrain(ctx) {
  const seconds = ctx.load().harness['restart-drain-seconds'] ?? 300;
  ctx.drain = { seconds, until: ctx.now().getTime() + seconds * 1000, waiting: null };
  drained(ctx);
}

// drained(ctx) — whether the drain is over: no agent left running, this
// control's or — every control draining at once, none dispatching — another's
// (an assignment not of this control's agents whose process is alive: a dead
// one's record is stale, for its control to remove; ASS-236: until the last
// control has drained, this one keeps running its steps rather than stand
// stopped), or restart-drain-seconds passed with some still running (logged;
// control's shut-down stops its own). While it waits, "restart waiting for N
// agents …" — N this control's — is logged each time N changes (with none
// of its own, each time the others' count does); the dashboard shows it.
const agents = n => `${n} agent${n === 1 ? '' : 's'}`;
const alive = pid => { try { return pid != null && process.kill(pid, 0); } catch { return false; } };
export function drained(ctx) {
  const n = ctx.agents.size, { drain } = ctx;
  const others = ctx.load().assignments.filter(a => !ctx.agents.has(a['agent-name']) && alive(a['process-id'])).length;
  if (!n && !others) return true;
  if (ctx.now().getTime() >= drain.until) {
    ctx.log('restart', n ? `${agents(n)} still running after ${drain.seconds}s: stopped with control` : `${agents(others)} of other controls still running after ${drain.seconds}s: this control exits all the same`);
    return true;
  }
  const waiting = `${n}/${n || others}`;
  if (drain.waiting !== waiting) ctx.log('restart', n ? `waiting for ${agents(n)} to end ${n === 1 ? 'its turn' : 'their turns'} (up to ${drain.seconds}s), dispatching none` : `waiting for 0 agents of its own and ${others} of other controls to end their turns (up to ${drain.seconds}s), dispatching none`);
  drain.waiting = waiting;
  return false;
}

// checkRateLimits(ctx, now) — each project's held kind logged under "hold"
// once per reset (memory.holding: "<project>/<kind>" → reset); each whose
// reset has passed cleared, and logged.
async function checkRateLimits(ctx, now) {
  for (const project of ctx.load().projects) for (const [kind, e] of Object.entries(project.rateLimit ?? {})) {
    const until = Date.parse(e?.['resets-at']), key = `${project.id}/${kind}`;
    if (!until) continue;
    if (until > now) {
      if (ctx.memory.holding.get(key) !== until) ctx.log('hold', `rate limited; ${project.id}'s ${kind} agents are not dispatched until ${new Date(until).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
      ctx.memory.holding.set(key, until);
      continue;
    }
    await ctx.attempt('hold', project.id, () => ctx.cli(['project:clear-rate-limit', project.id, kind]));
    ctx.log('hold', `${project.id}'s ${kind} rate limit has reset; its ${kind} agents are dispatched again`);
    ctx.memory.holding.delete(key);
  }
}
