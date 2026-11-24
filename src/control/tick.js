// One cycle of control (finish what ended before anything new is dispatched,
// so the top ticket keeps its seat). The
// phases run in this order, never interleaved, each on the data as it is
// when it starts:
//   1. finish ended agents       finish.js
//   2. image registries          registry.js; each project's golden image
//                                follow-up, golden-followup.js (ASS-427:
//                                a queued definition change written and
//                                rebuilt once its build ends); and each project's Hindsight
//                                memory, memory.js (ASS-62), backed up
//                                daily, memory-backup.js (ASS-148), its
//                                Claude spend read, memory-spend.js (ASS-269)
//   3. seats and memory          seat-budget.js: each project's Mac seats
//                                from the Mac's memory and CPU budget and
//                                its share of it (ASS-528);
//                                seats.js: each ticket in progress in a VM
//                                seat or a workstation seat, a free
//                                workstation seat taken first (ASS-469);
//                                seat-memory.js: a seat only when its
//                                VM fits in the Mac's memory (ASS-420)
//      VMs by state              vm-lifecycle.js
//      workstation connections   workstations.js: each GCP workstation's
//                                one SSH connection kept up while needed,
//                                closed once not (ASS-433)
//   4. fast-tracked tickets      fast-track.js: pre-empting running work
//                                for the seats they waited for (ASS-83)
//      non-agent steps           steps.js
//   5. gap detection             triggers.js
//   6. timers                    triggers.js; reverted tickets' memory
//                                reviews, reverts.js (ASS-146); the gcloud
//                                and glab logins, each project's Claude
//                                usage (usage.js), the Anthropic API
//                                cost (api-cost.js, ASS-153) and each
//                                project's push account (push-account.js,
//                                ASS-307)
//   7. dependencies              the priority raises a waiting ticket's
//                                dependencies are given and given back,
//                                dependencies.js (ASS-195), before
//                                refinement reaches a backlog one
//                                (triggers.js; ASS-450: the ticket health
//                                sampling that ran here is removed)
//   8. status nags + shutdowns   supervise.js
//   9. dispatch                  dispatch.js; then each project's seat
//                                queue written for the dashboard,
//                                seat-queue.js (ASS-525)
// A rate limit is held per (project, credential kind) (ASS-215): the tick runs
// in full, and only the held kind's agents of that project are not dispatched
// (dispatch.js), until the clock passes the reset recorded for it, which is
// then cleared (project:clear-rate-limit <project> <kind>).
// While a restart drains (startDrain, ASS-200) no agent starts: fast
// track, refinement and dispatch are skipped; the rest run — the non-agent
// steps and VM work too (ASS-236), so a ticket's scripts go on — so the
// running agents' ended turns are finished and paused ones shut down.
// While the disk is nearly full (disk.js, ASS-288: its hold, harness-wide)
// no agent starts either, and no VM, clone or golden build; it lifts by itself
// once the free space is back above the warn level.
// A project missing or failing a credential (credentials.js, ASS-395: checked
// at the first tick and every few minutes, with the disk) starts none of its
// agents or VM setups, until a check passes again.
import { spawnSync } from 'node:child_process';
import { paths, loadState, readDiskSpace } from './state.js';
import { troubleOf, UNREADABLE_CODES } from './read.js';
import { runCli, runScript, scriptSucceeds } from './cli.js';
import { finishEnded, spentSoFar } from './finish.js';
import { runningSpend } from './spend.js';
import { runSteps } from './steps.js';
import { detectGaps, fireTimers, checkGcloud, checkGlab, refineBacklog } from './triggers.js';
import { superviseAgents } from './supervise.js';
import { superviseRegistries } from './registry.js';
import { followGolden } from './golden-followup.js';
import { superviseMemory } from './memory.js';
import { backupMemory } from './memory-backup.js';
import { recordMemorySpend } from './memory-spend.js';
import { superviseVms } from './vm-lifecycle.js';
import { superviseWorkstations } from './workstations.js';
import { superviseSubstrate } from './substrate.js';
import { superviseSandboxes } from './sandboxes.js';
import { seatMemory } from './seat-memory.js';
import { assignSeats } from './seats.js';
import { recordSeatQueue } from './seat-queue.js';
import { budgetSeats } from './seat-budget.js';
import { budgetRemote } from './remote-seats.js';
import { dispatch } from './dispatch.js';
import { fastTrack } from './fast-track.js';
import { checkUsage } from './usage.js';
import { checkApiCost } from './api-cost.js';
import { checkPushAccount } from './push-account.js';
import { refreshCommitLists } from './commit-refresh.js';
import { detectReverts } from './reverts.js';
import { raiseDependencies } from './dependencies.js';
import { checkDisk, diskHeld } from './disk.js';
import { checkLimaHomes } from './lima-home-check.js';
import { readHostMemory } from './host-memory.js';
import { readHostCpu } from './host-cpu.js';
import { limaHomes } from './vm.js';
import { checkCredentials } from './credentials.js';
import { login } from './login.js';
import { sessionUsage, loginExpiry, refreshLogin } from '../agents/usage.js';
import { newTickTimes, timeCall, timeSync, timeHere, untimed, commandName } from './tick-stats.js';
import { monthCost } from '../agents/api-cost.js';
import { pushAccount } from '../agents/forge.js';

// createContext({ root, env, command, log, now }) — what every phase works
// with: `root` the repo (agent.sh lives there), `env` the agent-cli's path
// overrides (tests), `command` the agent command instead of Claude (tests),
// log(phase, detail) one line per action, now() the clock. Holds `agents`,
// the live agent processes by name (see dispatch.js), `scripts`, the script
// steps' commands running (cli.js runScript, ASS-328), `memory`, what control
// remembers between ticks (timers, scripts run, nags sent, state
// changes counted, the rate-limit reset last logged, each dev container's
// mounts, the failing steps backing off — see backoff.js; the script steps
// running in the background, steps.js), and the ways to act: cli(args), script(argv), succeeds(argv) (see
// cli.js; script and succeeds take a VM to run in, ASS-74, and script an env over its own, ASS-365), load() (see state.js), stopAgents(), stopScripts(), mounts(container) (docker
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
    agents: new Map(), scripts: new Set(),
    memory: { lastRun: new Map(), ran: new Set(), timers: new Map(), nagged: new Map(), warned: new Set(), holding: new Map(), mounts: new Map(), backoff: new Map(), staleEngines: new Set() },
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
  // lost (expired, revoked, missing). Neither prompts. See login.js (ASS-429:
  // a failure read as expired, offline or unknown). Tests replace them.
  ctx.gcloud = login('gcloud', ['auth', 'print-access-token']);
  ctx.glab = login('glab', ['auth', 'status']);
  // usage(configDir) — a Claude login's 5-hour session and weekly usage (ASS-47, ASS-65, see
  // src/agents/usage.js and usage.js); null with CLAUDE_USAGE_DISABLED=1 —
  // the test fixtures' env, as ACLI_DISABLED is — so a test's control never
  // reads a real token or calls the endpoint. Tests replace it.
  ctx.usage = env.CLAUDE_USAGE_DISABLED === '1' ? null : dir => sessionUsage(dir);
  // loginExpiry(configDir), refreshLogin(configDir) — ASS-571: when that login's token expires, and Claude Code
  // renewing it (one minimal `claude -p` turn with that config dir, the agent command), for usage.js keepFresh; null
  // with CLAUDE_USAGE_DISABLED=1 too. Tests replace them.
  ctx.loginExpiry = env.CLAUDE_USAGE_DISABLED === '1' ? null : dir => loginExpiry(dir);
  ctx.refreshLogin = env.CLAUDE_USAGE_DISABLED === '1' ? null : dir => refreshLogin(dir, { command: ctx.command, env: ctx.env });
  // apiCost(now, service) — an Anthropic API organization's spend in now's UTC
  // month, with the admin key in keychain item `service` (the harness org's
  // without one, ASS-221) (ASS-153, see src/agents/api-cost.js and api-cost.js); null with
  // ANTHROPIC_API_COST_DISABLED=1 — the test fixtures' env, as
  // CLAUDE_USAGE_DISABLED is — so a test's control never reads the admin key
  // or calls the Cost Admin API. Tests replace it.
  ctx.apiCost = env.ANTHROPIC_API_COST_DISABLED === '1' ? null : (now, service) => monthCost({ now, env, service });
  // pushAccount({ provider, host, service }) — the account a project's VM
  // token for its repositories' forge pushes as (ASS-307, see
  // src/agents/forge.js and push-account.js); null with PUSH_ACCOUNT_DISABLED=1
  // — the test fixtures' env, as ANTHROPIC_API_COST_DISABLED is — so a test's
  // control never reads a forge token or calls a forge. Tests replace it.
  ctx.pushAccount = env.PUSH_ACCOUNT_DISABLED === '1' ? null : args => pushAccount({ ...args, env });
  // commitLists — whether control keeps the ticket variations' commit lists fresh (ASS-558, commit-refresh.js); off
  // with COMMIT_LISTS_DISABLED=1 — the test fixtures' env, as PUSH_ACCOUNT_DISABLED is — so a test's control never
  // runs ticket:refresh-commits (a forge read). Tests set it.
  ctx.commitLists = env.COMMIT_LISTS_DISABLED !== '1';
  // hostMemory() — the Mac's memory now (ASS-398; ASS-404, see host-memory.js:
  // macOS's free percentage and pressure level, and each Lima VM's resident
  // size); null with HOST_MEMORY_DISABLED=1 — the test fixtures' env, as
  // DISK_SPACE_DISABLED is — so a test's control never holds a VM for the real
  // Mac's memory. Tests replace it.
  ctx.hostMemory = env.HOST_MEMORY_DISABLED === '1' ? null : () => readHostMemory(limaHomes(env))();   // ASS-578: every Lima folder in use
  // hostCpu() — the Mac's CPU now (ASS-528, see host-cpu.js: every process's CPU summed, its cores, each Lima VM's
  // CPU), for the seat budget (seat-budget.js); null with HOST_MEMORY_DISABLED=1 as hostMemory is. Tests replace it.
  ctx.hostCpu = env.HOST_MEMORY_DISABLED === '1' ? null : () => readHostCpu(limaHomes(env))();
  // ASS-494: within a deeper timed sub-routine (runSteps, finishEnded, detectReverts), each timed by command name,
  // its arguments dropped — '<parent key>/cli <command>', '…/script <command>' (tick-stats.js timeHere, commandName);
  // elsewhere just run. A script started and not awaited (steps.js's script steps) is started untimed (ctx.untimed):
  // timing assumes calls awaited in turn.
  ctx.cli = (args, env) => timeHere(ctx.tickTimes, `cli ${args[0]}`, () => runCli(ctx, args, env));
  ctx.script = (argv, vm, env) => timeHere(ctx.tickTimes, `script ${commandName(argv)}`, () => runScript(ctx, argv, vm, env));
  // ASS-493: a promise, run in the background (checks.js) and not awaited by the tick, so — ASS-494's rule — started
  // untimed: a slow check shows as its 'script' duration line, not in the tick's timings.
  ctx.succeeds = (argv, vm, who) => untimed(() => scriptSucceeds(ctx, argv, vm, who));
  // ASS-457/458: a load that fails — an fs error or a file that will not
  // parse, even read again (read.js readJson) — is the data failing to read:
  // marked (error.dataTrouble) and kept for the tick (ctx.trouble), which then
  // stops (see tick). A good load keeps harness.json's
  // data-unreadable-exit-seconds for while one does not.
  // ASS-494: within a deeper timed sub-routine, timed as '<parent key>/load' (tick-stats.js timeHere); tick() times
  // each phase's own load apart, as '<phase>/load'.
  ctx.load = () => timeHere(ctx.tickTimes, 'load', loadNow);
  const loadNow = () => {
    let state;
    try { state = loadState(ctx.paths); } catch (error) {
      if (error instanceof SyntaxError || UNREADABLE_CODES.has(error?.code)) ctx.trouble ??= (error.dataTrouble = { file: error.file ?? error.path ?? ctx.paths.assignments, reason: error.message });
      throw error;
    }
    ctx.memory.dataLimit = state.harness?.['data-unreadable-exit-seconds'] ?? DATA_UNREADABLE_EXIT_SECONDS;
    // A bad switched-off-steps entry (ASS-209: left on by loadState), logged once.
    for (const p of state.projects) for (const e of p.switchedOffErrors) if (!ctx.memory.warned.has(`switched-off/${p.id}/${e}`)) { ctx.memory.warned.add(`switched-off/${p.id}/${e}`); ctx.log('error', `project ${p.id}: ${e}`); }
    // A wrong dev-environments (ASS-431: refused by loadState, devEnvironments null), each error logged once.
    for (const p of state.projects) for (const e of p.devEnvironmentsErrors) if (!ctx.memory.warned.has(`dev-environments/${p.id}/${e}`)) { ctx.memory.warned.add(`dev-environments/${p.id}/${e}`); ctx.log('error', `project ${p.id}: ${e}`); }
    // ASS-540 AC3: a step its tickets can reach that can run on none of the project's run targets (run-targets.js), each logged once — never started.
    for (const p of state.projects) for (const e of p.runTargetErrors ?? []) if (!ctx.memory.warned.has(`run-targets/${p.id}/${e}`)) { ctx.memory.warned.add(`run-targets/${p.id}/${e}`); ctx.log('error', `project ${p.id}: ${e}`); }
    // An engine declaring keys the harness no longer reads (ASS-450: loadState's obsoleteEngineKeys, ignored), logged once per engine.
    // ASS-524: one only a state-engine.json (legacy: not read), with how to convert it.
    for (const { file, keys, legacy } of state.obsoleteEngineKeys ?? []) if (!ctx.memory.warned.has(`obsolete/${file}`)) { ctx.memory.warned.add(`obsolete/${file}`); ctx.log('engines', legacy ? `${file} is not read: engines are workflow.yaml since ASS-524; convert it with ./agent.sh engine:convert-to-yaml --all` : `${file}: ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} obsolete and ignored (ASS-450: the ticket health check is removed); remove ${keys.length === 1 ? 'it' : 'them'}`); }
    // ASS-460: an engine that failed to read, standing at its last good copy (loadState's staleEngines), logged once per failure streak; once it reads again, said so.
    const stale = new Set((state.staleEngines ?? []).map(({ file }) => file));
    for (const { file, error } of state.staleEngines ?? []) if (!ctx.memory.staleEngines.has(file)) { ctx.memory.staleEngines.add(file); ctx.log('engines', `${file} could not be read (${error}): its last good copy is used until it reads again`); }
    for (const file of ctx.memory.staleEngines) if (!stale.has(file)) { ctx.memory.staleEngines.delete(file); ctx.log('engines', `${file} reads again`); }
    const running = runningSpend([...ctx.agents.values()].map(live => ({ record: live.record, usd: spentSoFar(live) })));
    return { ...state, allProjects: state.projects, projects: project ? state.projects.filter(p => p.id === project) : state.projects, running };
  };
  ctx.stopAgents = () => { for (const live of ctx.agents.values()) live.agent.stop(); };
  // stopScripts() — each script step's command still running (cli.js
  // runScript, ctx.scripts; ASS-328: run in the background, so control can
  // exit while one runs), and each script-succeeds check (cli.js
  // scriptSucceeds, ASS-493: in ctx.scripts too), SIGTERMed, its process group with it: the next
  // control, remembering none of it, runs the step's script again
  // (steps.js), and the two never run at once.
  // scriptWait — how long a script step's command is waited for in the tick
  // that starts it before it is left running (steps.js, ASS-328): 5 seconds,
  // or SCRIPT_WAIT_MS (the test fixtures' env: a loaded machine's slow start).
  if (env.SCRIPT_WAIT_MS) ctx.scriptWait = Number(env.SCRIPT_WAIT_MS);
  ctx.stopScripts = () => { for (const child of ctx.scripts) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  // timed(phase, name, fn, { background }) — fn() awaited and timed into this tick's ctx.tickTimes under the
  // sub-routine '<phase>/<name>' (ASS-490, tick-stats.js timeCall): the one helper for every timing, so timing deeper
  // is wrapping more calls in it. `background` marks one that starts work it does not await.
  ctx.tickTimes = newTickTimes();
  ctx.timed = (phase, name, fn, options) => timeCall(ctx.tickTimes, phase, name, fn, options);
  // timedHere(name, fn) — ASS-494: fn() timed under '<parent key>/<name>' within a deeper timed sub-routine (its
  // helpers, its per-item loop bodies), just called elsewhere (tick-stats.js timeHere): synchronous or not, as fn is,
  // and nothing awaited that the caller does not await. untimed(fn): fn() and all it starts left untimed — for work
  // started in the background and not awaited, which timing must never wrap (its depth counting assumes calls awaited
  // in turn).
  ctx.timedHere = (name, fn) => timeHere(ctx.tickTimes, name, fn);
  ctx.untimed = untimed;
  // attempt(phase, what, fn) — fn() awaited; what it throws is logged under
  // "error" as "<phase> <what>: <message>", so one failing item leaves the
  // rest of its phase to run. ASS-457: but the data failing to read
  // (read.js troubleOf) is thrown on, kept for the tick (ctx.trouble), so the
  // phase stops there and the tick with it.
  ctx.attempt = async (phase, what, fn) => {
    try { await fn(); } catch (error) {
      const trouble = troubleOf(ctx, error);
      if (trouble) { ctx.trouble ??= trouble; throw error; }
      ctx.log('error', `${phase} ${what}: ${error.message}`);
    }
  };
  return ctx;
}

// The phases that start agents, skipped while a restart drains.
const NEW_WORK = new Set([fastTrack, refineBacklog, dispatch]);
const PHASES = [finishEnded, superviseRegistries, followGolden, superviseMemory, backupMemory, recordMemorySpend, budgetRemote, budgetSeats, assignSeats, seatMemory, superviseVms, superviseWorkstations, superviseSubstrate, superviseSandboxes, fastTrack, runSteps, detectGaps, fireTimers, detectReverts, checkGcloud, checkGlab, checkUsage, checkApiCost, checkPushAccount, refreshCommitLists, raiseDependencies, refineBacklog, superviseAgents, dispatch, recordSeatQueue];
// ASS-490: which of the header's nine phases (tick-stats.js TICK_PHASES) each phase function is timed under, and by
// what name (ctx.timed, as '<phase>/<name>'; named here, as checkGcloud and checkGlab are made, not declared); the
// hold, disk and credentials checks before fast track count under 'steps', the phase they gate. BACKGROUND: those that start work they do not await (vm-lifecycle.js's VM jobs, steps.js's script
// steps left running), timed for their awaited part only, and marked so.
const PHASE_OF = new Map(Object.entries({
  finish: { finishEnded },
  registries: { superviseRegistries, followGolden, superviseMemory, backupMemory, recordMemorySpend },
  'seats/VMs': { budgetRemote, budgetSeats, assignSeats, seatMemory, superviseVms, superviseWorkstations, superviseSubstrate, superviseSandboxes },
  steps: { fastTrack, runSteps },
  gaps: { detectGaps },
  timers: { fireTimers, detectReverts, checkGcloud, checkGlab, checkUsage, checkApiCost, checkPushAccount, refreshCommitLists },
  dependencies: { raiseDependencies, refineBacklog },
  supervise: { superviseAgents },
  dispatch: { dispatch, recordSeatQueue },
}).flatMap(([phase, calls]) => Object.entries(calls).map(([name, fn]) => [fn, { phase, name }])));
// ASS-497: CHECKS, the periodic checks that call out (background-checks.js), start their jobs and return a promise
// of them, which the tick does not await: only their start is timed, and they are marked background too.
const CHECKS = new Set([detectReverts, checkGcloud, checkGlab, checkUsage, checkApiCost, checkPushAccount, refreshCommitLists]);   // ASS-558: refreshCommitLists
const BACKGROUND = new Set([superviseVms, superviseSubstrate, runSteps, ...CHECKS]);   // ASS-533: its checks run as a job beside the tick
// ASS-494: those timed a level deeper — their helpers, per-item loop bodies, agent.sh calls, scripts and loads
// (ctx.timedHere, ctx.cli, ctx.script, ctx.load; ASS-493: ctx.succeeds runs untimed in the background). detectReverts
// is not one: ASS-497 runs its work as a background job, which is never timed.
const DEEPER = new Set([runSteps, finishEnded]);

// tick(ctx) — the twenty-five phases, in order, each reading the data afresh; a
// phase that throws is logged under "error" and the next still runs. The
// rate limits — recorded by the finish phase, so checked after it — are
// logged and cleared (checkRateLimits), the tick going on; ASS-460: guarded as
// every phase is, so a load that throws there (an engine caught half-written)
// is logged as "hold check: …" and the tick goes on. Then the disk
// (disk.js checkDisk, ASS-288, at most once a minute): while its hold is on
// no agent starts — fast track, refinement and dispatch are skipped, as while
// a restart drains — and the VM and step phases start no VM, clone or golden
// build (vm-lifecycle.js, steps.js); the rest runs, so running agents' turns
// are finished.
//
// ASS-457, ASS-458: the data failing to read — a load (ctx.load) or a phase's
// own read meeting an fs error or a file that will not parse even read again,
// or an agent.sh write failing for the data folder being gone (read.js
// troubleOf; ctx.trouble) — stops the tick there: no later phase acts on what
// could not be read, nothing takes the file as empty. The tick is logged as
// waiting for the data (waitForData) and the next tick tries again; once one
// runs through, that the data is back is logged (dataRecovered). Running
// agents are left be: no phase finishes, tends or stops them meanwhile.
//
// ASS-490: every call it makes is timed (ctx.timed), its times left in
// ctx.tickTimes (tick-stats.js newTickTimes) for main.js's figures. ASS-494:
// each phase's ctx.load() timed apart, as '<phase>/load' (timeSync, not
// awaited); runSteps and finishEnded timed a level deeper (DEEPER).
//
// ASS-497: the checks that call out — reverts, the gcloud and glab logins,
// Claude usage, API cost, push account (CHECKS) — start their due work as
// background jobs (background-checks.js) and the tick goes on without waiting
// for them; the credentials check stays awaited, as it gates this tick's dispatch.
export async function tick(ctx) {
  const now = ctx.now().getTime();
  let held = false;
  ctx.trouble = null;
  ctx.tickTimes = newTickTimes();
  try {
    for (const phase of PHASES) {
      if (phase === fastTrack) {
        await ctx.timed('steps', 'checkRateLimits', () => ctx.attempt('hold', 'check', () => checkRateLimits(ctx, now)));   // ASS-460: guarded as every phase is
        await ctx.timed('steps', 'checkDisk', async () => {
          await ctx.attempt('disk', 'check', () => checkDisk(ctx));
          held = diskHeld({ diskSpace: readDiskSpace(ctx.paths.diskSpace) });
        });
        // ASS-578: a project.json lima-home that can't be used named in the log (lima-home-check.js).
        await ctx.timed('steps', 'checkLimaHomes', () => ctx.attempt('lima-home', 'check', () => checkLimaHomes(ctx, ctx.load())));
        // ASS-395: a project held by its credentials starts no new work (dispatch.js, steps.js). ASS-497: so, unlike the
        // checks that call out (CHECKS), it stays awaited: this tick's dispatch reads the hold its check has just recorded.
        await ctx.timed('steps', 'checkCredentials', () => ctx.attempt('credentials', 'check', () => checkCredentials(ctx, ctx.load())));
        if (ctx.trouble) break;
      }
      if ((ctx.drain || held) && NEW_WORK.has(phase)) continue;
      try {
        const { phase: timedAs, name } = PHASE_OF.get(phase);
        const state = timeSync(ctx.tickTimes, timedAs, 'load', () => ctx.load());   // ASS-494: timed apart, in the phase's time and not its sub-routine's
        const call = CHECKS.has(phase) ? () => { phase(ctx, state); } : () => phase(ctx, state);   // ASS-497: a check's jobs not awaited
        await ctx.timed(timedAs, name, call, { background: BACKGROUND.has(phase), deeper: DEEPER.has(phase) });
      } catch (error) {
        const trouble = troubleOf(ctx, error);
        if (trouble) { ctx.trouble ??= trouble; break; }
        ctx.log('error', `${phase.name}: ${error.message}`);
      }
      if (ctx.trouble) break;
    }
  } catch (error) {
    const trouble = troubleOf(ctx, error);
    if (!trouble) throw error;
    ctx.trouble ??= trouble;
  }
  if (ctx.trouble) waitForData(ctx, ctx.trouble);
  else dataRecovered(ctx);
}

// waitForData(ctx, { file, reason }) — the data could not be read (see tick):
// "data waiting: …" logged when the wait starts and whenever what fails
// changes, not every tick; the dashboard shows it (app.js controlWaiting).
// Once it has failed longer than harness.json's data-unreadable-exit-seconds
// (DATA_UNREADABLE_EXIT_SECONDS by default; the last good load's), ctx.dataExit
// says why, and control exits (main.js, with DATA_EXIT_CODE) for the
// dashboard to start it again.
export const DATA_UNREADABLE_EXIT_SECONDS = 300;
export function waitForData(ctx, { file, reason }) {
  const now = ctx.now().getTime(), limit = ctx.memory.dataLimit ?? DATA_UNREADABLE_EXIT_SECONDS;
  const wait = ctx.memory.dataWait ??= { since: now, file: null, reason: null };
  if (wait.file !== file || wait.reason !== reason) ctx.log('data', `waiting: cannot read ${file} (${reason}); control skips its ticks until it reads, and exits if it cannot for ${limit}s`);
  Object.assign(wait, { file, reason });
  const waited = (now - wait.since) / 1000;
  if (waited > limit) ctx.dataExit = `its data has not read for ${Math.round(waited)}s, over data-unreadable-exit-seconds (${limit}s): ${file} (${reason})`;
}
// dataRecovered(ctx) — a tick ran through after the data could not be read:
// "data recovered …" logged, with how long it waited.
export function dataRecovered(ctx) {
  const wait = ctx.memory.dataWait;
  if (!wait) return;
  ctx.memory.dataWait = null;
  ctx.log('data', `recovered: it reads again after ${Math.round((ctx.now().getTime() - wait.since) / 1000)}s (${wait.file}); control carries on with its agents, VMs and workstations`);
}

// restartRequestedBy(request) — ASS-507: who asked for a restart, as control's
// log and the dashboard name it: "by the operator" for harness:request-restart's
// keyless request ("operator": true), "self-healing, <tickets>" for the fixes'
// (an old-shape request's one "ticket" too), both joined by "; " when they were;
// a request naming neither (none the command writes) is "no ticket named".
export function restartRequestedBy(request) {
  const tickets = (request?.tickets ?? [request?.ticket]).filter(t => typeof t === 'string' && t !== '');
  const by = [request?.operator === true ? 'by the operator' : null, tickets.length > 0 ? `self-healing, ${tickets.join(', ')}` : null].filter(Boolean);
  return by.length > 0 ? by.join('; ') : 'no ticket named';
}

// startDrain(ctx) — a restart was asked for (ASS-200): from now the ticks
// start no agent (see tick) while the running agents — every control's —
// end their turns, for up to harness.json's restart-drain-seconds (300 by default;
// ASS-460: also when the data cannot be read just then, which is logged).
export function startDrain(ctx) {
  let seconds = 300;
  try { seconds = ctx.load().harness['restart-drain-seconds'] ?? 300; } catch (error) { ctx.log('error', `restart drain: ${error.message}; draining for up to ${seconds}s`); }
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
// ASS-460: while the assignments cannot be read (logged), the others are
// counted as last seen, or as one when never seen, so the drain waits on —
// still up to restart-drain-seconds — rather than end or throw.
const agents = n => `${n} agent${n === 1 ? '' : 's'}`;
const alive = pid => { try { return pid != null && process.kill(pid, 0); } catch { return false; } };
export function drained(ctx) {
  const n = ctx.agents.size, { drain } = ctx;
  let others;
  try {
    others = ctx.load().assignments.filter(a => !ctx.agents.has(a['agent-name']) && alive(a['process-id'])).length;
  } catch (error) {
    ctx.log('error', `restart drain: ${error.message}`);
    others = drain.others ?? 1;
  }
  drain.others = others;
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
