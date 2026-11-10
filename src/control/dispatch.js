// Phase 8: putting agents on prompt steps — the runs' first (small, and
// counted toward max-agents but never max-tickets-in-progress), then the sprints' as
// plan.js plans them — each through assignments:create, agent:dispatch (the prompt
// queued in the inbox the process will read), startAgent, and
// assignments:set-process (the session id is recorded in finish.js once the
// process has said it). None for a variation its dependencies hold (ASS-355).
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { stepOf, engineSteps, resolveTarget, isActive, isManual } from './engine.js';
import { enginesFor, heldKinds } from './state.js';
import { planFor, grooming, refinementDue, seatsOf } from './plan.js';
import { rankBacklog } from './rank.js';
import { waitsForSeat } from './fast-track.js';
import { startAgent, CLAUDE } from '../agents/process.js';
import { mergedWindows } from '../agents/session-usage.js';
import { confineHostAgent } from '../agents/confinement.js';
import { memoryMcpConfig, memoryPort, memoryAnswers } from '../agents/memory.js';
import { accountOf, kindOfAccount } from '../agents/account.js';
import { sessionDir } from '../agents/session.js';
import { found, contextOf, ticketPath, isPaused, levelChanges, moveTicket, moveRun, mayMove, firstStepId, backgroundProject, weeklyLimit } from './moves.js';
import { problemOf, ticketOf, blockHistory, questionsOf } from './facts.js';
import { failed, waiting, held, ticketKey, runKey } from './backoff.js';
import { runsInVm, vmOf, REPOS, TICKET_FOLDER } from './vm.js';
import { awaitsVm, credentialKindOf } from './vm-lifecycle.js';
import { awaitsDependencies } from './dependencies.js';
import { repositoryName, nextRepository, visitOf } from './repositories.js';
import { overSpent, runningOn } from './spend.js';

const PHASE = 'dispatch';

// hasPendingTool(event) — an assistant turn that left background work still
// running (ASS-334): a `tool_use` of a tool the SDK runs in the background, so
// finish.js holds the agent instead of killing it mid-wait. The five shapes
// the SDK actually backgrounds, each with the input that makes it so:
// - Bash with run_in_background: true (a detached command),
// - Agent not run_in_background: false (sub-agents background by default),
// - ScheduleWakeup not stop: true (arming, not cancelling, a wakeup),
// - Monitor (always runs until its condition or timeout),
// - Workflow (runs in the background by contract).
// A tool not listed is the status quo (no hold), not a regression. Mirrors
// session.js's `content.flatMap(c => c.type === 'tool_use' ? …)` shape.
const PENDING_TOOLS = {
  Bash: input => input?.run_in_background === true,
  Agent: input => input?.run_in_background !== false,
  ScheduleWakeup: input => input?.stop !== true,
  Monitor: () => true,
  Workflow: () => true,
};
function hasPendingTool(event) {
  if (event.type !== 'assistant') return false;
  return [event.message?.content ?? []].flat().some(c => c.type === 'tool_use' && PENDING_TOOLS[c.name]?.(c.input));
}

// outputSchema(promptsDir, prompt) — prompts/<prompt>/prompt.json's `output`
// when it is an object with properties, else undefined: the agent command
// gets it as --json-schema, and finish.js reads `structured_output` from the
// result event.
export function outputSchema(promptsDir, prompt) {
  const file = join(promptsDir, prompt, 'prompt.json');
  if (!existsSync(file)) return undefined;
  const output = JSON.parse(readFileSync(file, 'utf8')).output;
  return output && typeof output === 'object' && Object.keys(output).length ? output : undefined;
}

// containerPath(mounts, folder) — where a host folder is seen inside a
// container whose bind mounts are `mounts` ([{ Source, Destination }], as
// docker inspect lists them): the longest mount under which the folder lies,
// its destination with the rest of the path appended; null when no mount
// holds it.
export function containerPath(mounts, folder) {
  const under = (mounts ?? []).filter(m => m.Source && (folder === m.Source || folder.startsWith(`${m.Source.replace(/\/$/, '')}/`))).toSorted((a, b) => b.Source.length - a.Source.length)[0];
  if (!under) return null;
  const rest = folder.slice(under.Source.replace(/\/$/, '').length);
  return `${under.Destination.replace(/\/$/, '')}${rest}`;
}

// agentFolder(ctx, project, variation, container) — where the agent is
// started, literally: the variation's build.worktree-folder when it has one,
// else the project's local-pc environment's folder (the workspace); as
// { folder, containerFolder } — containerFolder the same folder inside
// `container` (containerPath on ctx.mounts(container)) when there is one,
// else null. Throws when the project has neither, the folder is not on disk,
// or the container does not mount it: an agent never runs from control's
// own folder, and one working in the container must be told where it is.
export function agentFolder(ctx, project, variation, container) {
  const folder = variation?.build?.['worktree-folder'] ?? project.json['local-environments']?.find(e => e.type === 'local-pc')?.folder;
  if (!folder) throw new Error(`${project.id} has no worktree for the variation and no local-pc folder in project.json`);
  if (!existsSync(folder)) throw new Error(`${folder} does not exist`);
  if (!container) return { folder, containerFolder: null };
  const containerFolder = containerPath(ctx.mounts(container), folder);
  if (!containerFolder) throw new Error(`the dev container ${container} does not mount ${folder}`);
  return { folder, containerFolder };
}

// whereText(ctx, folder, container, containerFolder, repository) — the
// {where} of a prompt: where the agent is and where its commands run — in the
// dev container, through docker exec in the same folder as the container
// mounts it; for a project with none, here on the host. A step in one
// repository (ASS-119) is told that this checkout is the one it works in.
export function whereText(ctx, folder, container, containerFolder, repository) {
  const one = repository ? ` This step works in the repository ${repository} alone: this checkout is where you work.` : '';
  if (!container) return `Where you are: this checkout is ${folder}, on the host, with everything this project needs: run every command here.${one}`;
  return `Where you are: this checkout is ${folder} on the host.${one} Edit and read files here; ${join(ctx.root, 'agent.sh')} runs here. The application, its dependencies (node_modules), tooling and database live in the dev container ${container}, where this same folder is ${containerFolder}. Run every app, test, pnpm or database command inside the container, never on the host:\n  docker exec -w ${containerFolder} ${container} <command>`;
}

// confinedWhereText(folder, code) — the {where} of a confined host agent's
// prompt (ASS-108): where it runs, that the project's code is to read, and
// (ASS-182) that it writes only temp — the harness's data only through
// agent.sh, never piped (confinement.js: a piped command line runs sandboxed).
export const confinedWhereText = (folder, code) =>
  `Where you are: ${folder}, the harness's folder for this project, on the host. The project's code is ${code}: read it, never write it. You may write only temp; Claude Code refuses any other write. Change the harness's data — this folder, a ticket's folder, the backlog and sprints — only through the agent.sh commands you are given, the content on stdin from a heredoc (<<'EOF') or a temp file (< file): never pipe into or out of an agent.sh command that writes, or it runs sandboxed and its write is refused.`;

// vmWhereText(project, vm, repository) — the {where} of a run-location: vm
// step's prompt (ASS-74): the agent is in the variation's own VM, in /repos/,
// and each of the project's repositories (project.json repositories[]) is
// named with its url (what ticket:set-merge-request-plan takes, ASS-80), its
// description and its folder there — or, for a step in one `repository`
// (ASS-119), the agent is in that one's folder, /repos/<repo>/, told it
// alone; the ticket's folder is /mnt/ticket, read-only (ASS-182: every write
// goes through agent.sh, the content on stdin), and agent.sh, on the VM's PATH,
// runs harness commands on the Mac for this ticket variation alone, and
// (ASS-238) the forge token there is for git and package installs only,
// merge requests read and edited through agent.sh merge-request:*; last,
// project.json's "vm-full-checks", how to run the full checks there (ASS-229),
// when it has one. Throws when the project declares no such repository.
const repoName = r => repositoryName(r.url);
export function vmWhereText(project, vm, repository) {
  const all = project.json.repositories ?? [];
  const ticket = [`The ticket's folder is ${TICKET_FOLDER}, read-only: read the ticket's files there; write them only through agent.sh, the content on stdin. agent.sh, on your PATH, runs the harness commands you are given, for this ticket and variation only. The forge token in your environment is for git and package installs only. Read and update merge requests only through agent.sh merge-request:view, merge-request:update, merge-request:upload-image, merge-request:reply and merge-request:resolve; never call a forge or Jira API yourself. Run every other command here, in the VM.`, project.json['vm-full-checks']].filter(Boolean);
  if (repository) {
    const r = all.find(x => repoName(x) === repository);
    if (!r) throw new Error(`${project.id} declares no repository ${repository} (project.json repositories)`);
    return [`Where you are: in this ticket variation's own VM, ${vm}. You are in ${REPOS}${repository}/, the checkout of ${repository} (${r.url}); this step works in that repository alone. ${repository}: ${r.description ?? 'no description'}`, ...ticket].join('\n');
  }
  const repos = all.map(r => `- ${repoName(r)} (${r.url}), in ${REPOS}${repoName(r)}/: ${r.description ?? 'no description'}`);
  return [`Where you are: in this ticket variation's own VM, ${vm}. You are in ${REPOS}, which holds a checkout of each of the project's repositories:`, ...repos, ...ticket].join('\n');
}

// vmFolder(repository) — where an agent in the VM starts: /repos/<repo>/ for a step in one repository (ASS-119), else /repos/.
const vmFolder = repository => (repository ? `${REPOS}${repository}/` : REPOS);

// codeFolder(project, vm, folder, repository) — the {project-code-folder} of
// a prompt (ASS-106), the project's code for the ticket: in its VM, each
// repository's checkout, /repos/<repo>/ — or the one `repository`'s, for a
// step in one (ASS-119); on the host, the agent's folder — its worktree or
// the workspace (agentFolder).
export const codeFolder = (project, vm, folder, repository) => (!vm ? folder : repository ? vmFolder(repository) : (project.json.repositories ?? []).map(r => `${REPOS}${repoName(r)}/`).join(', ') || REPOS);

// vmFor(state, project, step, key, variation) — the VM a step of the ticket
// variation runs in: null for a step on the host; else the variation's VM's
// name, thrown when it has none (vm.js vmOf), before any assignment is made.
function vmFor(state, project, step, key, variation) {
  if (!runsInVm(step)) return null;
  const found = project.tickets.find(t => t.key === key)?.variations?.find(v => v.name === variation && !v['is-deleted']);
  return vmOf(found, `${key} ${variation} ${step.id}`);
}

// The agent for one record started: agent:dispatch queues its prompt (into
// an inbox cleared of any earlier session's) with {folder}, the variation's
// folder (agentFolder), {where} (whereText) and {project-code-folder}
// (codeFolder); the
// process starts from the record (its start-time, model, the prompt's
// schema) in that folder, on the host — or, for a run-location: vm step
// (`vm`, the variation's VM, vmFor), in that VM: in /repos/, told it by
// vmWhereText, its {ticket-folder} /mnt/ticket and its commands the VM's
// agent.sh; for a step in one `repository` (ASS-119, repositories.js), in
// /repos/<repo>/, that repository its {where} and {project-code-folder} — and
// assignments:set-process records its pid. Kept in ctx.agents as { name,
// project, record, agent, startedAt, result (the last result event), exited,
// cost and tokens (summed over its turns), sessionRecorded, rateLimit (the
// rate_limit_info of a rejected rate_limit_event it printed, see finish.js),
// vm (its VM, or null), payment (ASS-217: 'subscription' or 'api', as
// paymentFor chose — a host agent on api runs with the project's .claude-api,
// a VM agent with the other credential unset in its command — or null where
// the project declares one credential) and kind (its credential kind,
// ASS-215: claude or anthropic by its payment; else a VM agent's
// from its VM's vms.json row, null when it records none; a host agent's from
// its account's authMethod) }.
// ticketProjectOf(state, runId) — the project of the ticket a run is about,
// named by it or a parent run (parent.ticket-project, see sampleHealth); null
// when none is.
function ticketProjectOf(state, runId) {
  for (let r = state.transient.find(t => t.id === runId), seen = new Set(); r && !seen.has(r.id); r = state.transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    if (r.parent?.['ticket-project']) return r.parent['ticket-project'];
  }
  return null;
}

// configDir(ctx, project, payment) — the CLAUDE_CONFIG_DIR a project's agents run
// with (ASS-26): the full path of its data/projects/<id>/.claude, its own Claude
// login; undefined without the folder — the shared ~/.claude, as control's
// own environment has it. An agent paid by the API key (`payment` api,
// ASS-217) runs with its .claude-api, logged in with the key, instead.
export function configDir(ctx, project, payment) {
  const dir = resolve(ctx.paths.projects, project.id, payment === 'api' ? '.claude-api' : '.claude');
  return existsSync(dir) ? dir : undefined;
}

// accountHold(ctx, project) — why none of a project's agents may start
// (ASS-26): its project.json expected-account is not the account its config is
// logged in to (emails compared without case), or none is; null when it may,
// or it expects none. Asked at most once a minute; recorded in project.json
// (project:set-account-hold, cleared once it holds no more) for the
// dashboard, and logged when it changes.
const ACCOUNT_CHECK_MS = 60_000;
async function accountHold(ctx, project) {
  const expected = project.json['expected-account'];
  const memo = (ctx.memory.accounts ??= new Map()).get(project.id);
  const now = ctx.now().getTime();
  if (memo && memo.expected === expected && now - memo.at < ACCOUNT_CHECK_MS) return memo.hold;
  let hold = null;
  if (expected) {
    const dir = configDir(ctx, project);
    let account;
    try { account = await accountOf({ command: ctx.command, configDir: dir, env: ctx.env }); } catch (error) { account = { loggedIn: false, error: error.message }; }
    const actual = account.loggedIn ? account.email : null;
    if (actual?.toLowerCase() !== String(expected).toLowerCase()) hold = { expected, actual, dir, error: account.error };
  }
  const was = project.json['account-hold'];
  if (hold && (was?.expected !== hold.expected || was?.actual !== hold.actual)) {
    await ctx.cli(['project:set-account-hold', project.id, hold.expected, hold.actual ?? '-', hold.dir ?? '-']);
    ctx.log(PHASE, `${project.id} expects the Claude account ${hold.expected}; ${hold.actual ? `logged in as ${hold.actual}` : hold.error ?? 'not logged in'} — none of its agents start until it is (sign in: ${hold.dir ? `CLAUDE_CONFIG_DIR=${hold.dir} ` : ''}claude, then /login)`);
  } else if (!hold && was) {
    await ctx.cli(['project:clear-account-hold', project.id]);
    ctx.log(PHASE, `${project.id} is logged in as its expected account again; its agents start`);
  }
  ctx.memory.accounts.set(project.id, { at: now, expected, hold });
  return hold;
}

// The agent's Claude account, recorded on its assignment (ASS-25), from the
// config it will run with — with the payment method control chose for it,
// when it chose one (ASS-217) — and returned; not logged in, it is not started —
// thrown, so the dispatch is held and logged as any failure is.
async function recordAccount(ctx, project, name, payment) {
  const dir = configDir(ctx, project, payment);
  const account = await accountOf({ command: ctx.command, configDir: dir, env: ctx.env });
  await ctx.cli(['assignments:set-account', name, account.email ?? '-', account.org ?? '-', account.subscription ?? '-', ...(payment ? [payment] : [])]);
  if (!account.loggedIn) throw new Error(`${name}: the Claude account ${dir ?? 'in ~/.claude'} is not logged in; not started`);
  return account;
}

// hostKind(ctx, project) — the credential kind the project's host agents run
// on (ASS-215: kindOfAccount of its config's account), asked at most once a
// minute; 'claude' when claude auth status fails, as before kinds.
async function hostKind(ctx, project) {
  const memo = (ctx.memory.hostKinds ??= new Map()).get(project.id), now = ctx.now().getTime();
  if (memo && now - memo.at < ACCOUNT_CHECK_MS) return memo.kind;
  let kind;
  try { kind = kindOfAccount(await accountOf({ command: ctx.command, configDir: configDir(ctx, project), env: ctx.env })); } catch { kind = 'claude'; }
  ctx.memory.hostKinds.set(project.id, { at: now, kind });
  return kind;
}

// rateHeld(ctx, limited, project, step, key, variation) — whether the
// candidate's agent is held by a rate limit on its credential kind (ASS-215;
// `limited`: project id → the kinds held, heldKinds): a VM step's by its
// VM's recorded kind — one recording none is held while any kind is — a host
// step's by hostKind, asked only when the project has a kind held.
async function rateHeld(ctx, limited, project, step, key, variation) {
  const held = limited.get(project.id) ?? [];
  if (!held.length) return false;
  if (!runsInVm(step)) return held.includes(await hostKind(ctx, project));
  const kind = credentialKindOf(ctx, project.id, vmNameOf(project, key, variation));
  return !kind || held.includes(kind);
}

// The name of the VM a ticket variation of the project records, or undefined.
const vmNameOf = (project, key, variation) => project.tickets.find(t => t.key === key)?.variations?.find(v => v.name === variation)?.vm?.name;

// paymentFor(ctx, limited, project, step, key, variation, weekly) — how the
// candidate's agent pays (ASS-217), or null while it waits. Where the project
// declares both a subscription and an API key — a host step's project its
// .claude-api, a VM step's VM both credentials (vms.json credential-kind
// `both`) — { payment: 'subscription' } unless its claude kind is rate
// limited, else { payment: 'api' } unless the anthropic kind is too or an API
// cap holds (project.json api-cap-hold, superviseAgents); else null. Where it
// declares one, { payment: null } unless rateHeld holds it, as before.
// `weekly`: the candidate is grooming or background work of a project at its
// weekly usage limit with an API key (moves.js weeklyLimit 'api', ASS-327) —
// it skips the subscription, paid api as above or waiting; where this step
// cannot pay by the key (a VM with one credential), it waits, held as ASS-232
// holds a project with none.
async function paymentFor(ctx, limited, project, step, key, variation, weekly = false) {
  const both = runsInVm(step) ? credentialKindOf(ctx, project.id, vmNameOf(project, key, variation)) === 'both' : Boolean(configDir(ctx, project, 'api'));
  if (!both) return weekly || (await rateHeld(ctx, limited, project, step, key, variation)) ? null : { payment: null };
  const held = limited.get(project.id) ?? [];
  if (!weekly && !held.includes('claude')) return { payment: 'subscription' };
  return held.includes('anthropic') || project.json['api-cap-hold'] ? null : { payment: 'api' };
}

// A VM agent's credential is chosen by unsetting the other one in its command (ASS-217): both are in the VM's env.
const UNSET = { subscription: 'ANTHROPIC_API_KEY', api: 'CLAUDE_CODE_OAUTH_TOKEN' };

// worksOnCode(step, variation, record) — whether a host agent works on a
// ticket's code, so is not confined (ASS-108): its variation's worktree (the
// current engines', code:create-worktree), the workspace through the dev
// container, or a step that says so (works-on-code: a fix ticket's Apply Fix,
// in the repo its ticket names; grouped Blocked's Repair the Environment on
// the Host, in the ticket's own worktree and the project's containers), or a
// step in a named repository (run-in-repository, ASS-119: its checkout is
// where it works). Every other host agent — grooming, health checks,
// Blocked's other host steps — is confined: confinement.js. A step in a VM
// is neither: the VM holds it (ASS-74).
export const worksOnCode = (step, variation, record) =>
  Boolean(variation?.build?.['worktree-folder']) || record['working-in-dev-container'] === true || step?.action?.['works-on-code'] === true || Boolean(step?.['run-in-repository']);

// memoryFor(ctx, project, vm, dir) — the agent's --mcp-config (ASS-62): its
// project's Hindsight bank (memory.js), reached from the VM when `vm` names
// one; undefined for a project with none. A Hindsight not answering now is
// left out — the step runs without memory, never held for it (AC5) — and the
// agent's session log (in `dir`) says so first, as control's log does.
async function memoryFor(ctx, project, vm, dir) {
  const mcpConfig = memoryMcpConfig(project, { vm: Boolean(vm) });
  if (!mcpConfig || await memoryAnswers(memoryPort(project))) return mcpConfig;
  const note = `memory unavailable: ${project.id}'s Hindsight is not answering on 127.0.0.1:${memoryPort(project)}; this step runs without memory`;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'session.txt'), `[${note}]\n`);
  ctx.log(PHASE, note);
  return undefined;
}

async function startFor(ctx, state, project, record, vm, repository, step, payment = null) {
  const name = record['agent-name'];
  const account = await recordAccount(ctx, project, name, payment);
  const { variation } = found(state, record);
  const container = record['working-in-dev-container'] === true ? project.json['dev-container'] : undefined;
  const { folder: codeAt, containerFolder } = vm ? { folder: vmFolder(repository), containerFolder: null } : agentFolder(ctx, project, variation, container);
  // Confined, it runs in the harness's folder for the project; the code it reads stays codeAt.
  const confined = !vm && !worksOnCode(step, variation, record) ? confineHostAgent({ root: ctx.root, data: dirname(ctx.paths.agents), project: project.id }) : null;
  const folder = confined?.cwd ?? codeAt;
  // The inbox is named by the agent and its start time to the second: an
  // earlier process of the same name started in the same second left its
  // prompts there, which agent:dispatch drops, under the inbox's lock (ASS-179).
  const inbox = join(sessionDir(dirname(ctx.paths.agents), name, record['start-time']), 'inbox.jsonl');
  if (existsSync(inbox)) ctx.log(PHASE, `${name}: an earlier session's inbox is cleared by agent:dispatch`);
  const mcpConfig = await memoryFor(ctx, project, vm, dirname(inbox));
  // A harness run about another project's ticket (sampleHealth) tells its agent that project — and its limits and seat holders (ASS-240: plan.js seatsOf).
  const about = ticketProjectOf(state, record['transient-state-engine']), aboutProject = (state.allProjects ?? state.projects).find(p => p.id === about);
  const aboutArgs = about ? [`ticket-project=${about}`, `ticket-project-folder=${join(ctx.paths.projects, about)}`, `seats=${aboutProject ? JSON.stringify(seatsOf(state, aboutProject)) : '-'}`] : [];
  const dir = configDir(ctx, project, payment);
  // In a VM its ticket folder is the mount and agent.sh the VM's own: what the prompt's commands run.
  const vmArgs = vm ? [`ticket-folder=${TICKET_FOLDER}`, 'agent-sh=agent.sh'] : [];
  await ctx.cli(['agent:dispatch', name, `folder=${folder}`, `where=${vm ? vmWhereText(project, vm, repository) : confined ? confinedWhereText(folder, codeAt) : whereText(ctx, folder, container, containerFolder, repository)}`, `project-code-folder=${codeFolder(project, vm, codeAt, repository)}`, ...vmArgs, ...aboutArgs]);
  const live = { name, project: project.id, record, repository, startedAt: ctx.now(), result: null, exited: null, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessionRecorded: false, rateLimit: null, pending: null, pendingThisTurn: false,
    vm: vm ?? null, payment, kind: payment ? (payment === 'api' ? 'anthropic' : 'claude') : vm ? credentialKindOf(ctx, project.id, vm) : kindOfAccount(account) };
  live.agent = startAgent({
    name, root: dirname(ctx.paths.agents), cwd: folder, vm: vm ?? undefined, model: record.model,
    command: vm && payment ? ['env', '-u', UNSET[payment], ...(ctx.command ?? CLAUDE)] : ctx.command,
    jsonSchema: outputSchema(ctx.paths.prompts, record.prompt), mcpConfig,
    startTime: record['start-time'], confinedBy: confined?.settings,
    usage: { prices: state.harness['model-prices'] ?? {}, windows: mergedWindows(state.harness, state.contextWindows) },
    // limactl shell passes no environment into the VM: its own (vm:credentials) is the agent's there.
    env: vm ? ctx.env : dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env,
    onEvent: event => {
      if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') live.rateLimit = event.rate_limit_info;
      if (hasPendingTool(event)) live.pendingThisTurn = true;
    },
    onResult: event => {
      live.result = event;
      // The turn ended with a backgrounded task or a scheduled wakeup still
      // pending (ASS-334): hold finishing it (finish.js). Reset on every
      // result, so a later turn with nothing pending clears the hold and each
      // pending turn restarts the clock (an agent making progress is never
      // timed out).
      live.pending = live.pendingThisTurn ? { at: ctx.now().getTime() } : null;
      live.pendingThisTurn = false;
      live.cost += (event.total_cost_usd ?? 0) - live.agent.lastTotalCost;
      const usage = event.usage ?? {};
      live.tokens.input += usage.input_tokens ?? 0;
      live.tokens.output += usage.output_tokens ?? 0;
      live.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
      live.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      // Each model's context window, learned for the dashboard's next sessions
      // (ASS-190); not awaited — attempt logs a failure, never throws.
      for (const [model, info] of Object.entries(event.modelUsage ?? {})) {
        if (info?.contextWindow) ctx.attempt(PHASE, `${name}: ${model}'s context window`, () => ctx.cli(['harness:set-context-window', model, String(info.contextWindow)]));
      }
    },
    onExit: (code, signal) => { live.exited = { code, signal }; },
  });
  ctx.agents.set(name, live);
  await ctx.cli(['assignments:set-process', name, String(live.agent.pid), '-']);
  ctx.log(PHASE, `${name} (${record.model}) on ${record['work-item'] ?? record['state-engine']}${record.variation ? ` ${record.variation}` : ''} ${record.state}, pid ${live.agent.pid}, in ${folder}${container ? ` (${container}:${containerFolder})` : ''}${vm ? ` (VM ${vm})` : ''}${repository ? ` for ${repository}` : ''}${payment ? ` on the ${payment === 'api' ? 'API key' : 'subscription'}` : ''}`);
}

// assignments:create with the arguments, the records it printed.
const create = async (ctx, args) => JSON.parse(await ctx.cli(['assignments:create', ...args]));

// The workspace — the project's local-pc checkout, the one place the
// application runs, which the dev container mounts — goes to one assignment
// at a time per project: a step with run-in-dev-container, in a project with a dev container, has it, on the ticket's branch
// (code:checkout-in-workspace before the agent starts; released when the
// assignment ends, see moves.js releaseWorkspace). workspaceFree(ctx, state,
// step, project, key, variation) — whether a dispatch of the step may go
// now: true when the step does not need the workspace or nothing holds it;
// else false, logged once per waiting item while it waits.
// inContainer(step, project) — the step works in the project's dev container:
// it asks to, and the project has one. A project without one (the harness's
// own) works in its worktree on the host: its workspace is never checked out.
// A step in the variation's VM (run-location: vm, ASS-74) never is: it works in the VM.
const inContainer = (step, project) => !runsInVm(step) && step.action['run-in-dev-container'] === true && Boolean(project.json['dev-container']);

function workspaceFree(ctx, state, step, project, key, variation) {
  if (!inContainer(step, project)) return true;
  const holder = state.assignments.find(a => a.project === project.id && a['working-in-dev-container'] === true);
  const waiting = `workspace/${project.id}/${key}/${variation}`;
  if (!holder) { ctx.memory.warned.delete(waiting); return true; }
  if (!ctx.memory.warned.has(waiting)) { ctx.memory.warned.add(waiting); ctx.log(PHASE, `${key} ${variation} ${step.id} waits for the workspace (${holder['agent-name']} has it for ${holder['work-item'] ?? holder['state-engine']})`); }
  return false;
}
const takeWorkspace = (ctx, step, project, key, variation) =>
  (inContainer(step, project) && key != null ? ctx.cli(['code:checkout-in-workspace', project.id, key, variation]) : Promise.resolve());

// vmDown(ctx, state, step, project, key, variation, at) — whether a
// run-location: vm step's agent waits for the ticket variation's VM: so long
// as control has not seen it up (memory.vmsUp: Running and reached, ASS-169),
// it is never sent into it — after an outage (ASS-159: ASS-158 blocked so), or
// while it still starts or its vm:start is backed off (ASS-348: an agent sent
// into a VM whose credentials vm:start has not written yet fails "Not logged
// in" in seconds, and spends one of the step's tries). For VM_WAIT that is the
// wait its steps are judged under (vm-lifecycle.js awaitsVm, ASS-133), logged
// there; past it the steps are judged as they stand, but the agent still
// waits, logged once more per wait; once the wait reaches vmUpCeilingMs, the
// variation goes to Blocked instead (neverUp).
async function vmDown(ctx, state, step, project, key, variation, at) {
  if (!runsInVm(step)) return false;
  const v = found(state, { project, 'work-item': key, variation }), who = `${key} ${variation} ${at}`;
  if (awaitsVm(ctx, state, v.project, v.variation, who)) return true;
  const name = v.variation?.vm?.name, w = ctx.memory.vmWaits?.get(name);
  if (!name || ctx.memory.vmsUp?.has(name) || !w?.over) return false;   // up, or not a VM its step runs (no wait)
  const ceiling = vmUpCeilingMs(state);
  if (ctx.now().getTime() - w.since >= ceiling) await neverUp(ctx, v, name, ceiling);
  else if (!w.dispatching) { w.dispatching = true; ctx.log(PHASE, `${who}: waits for its VM ${name} to be up before an agent is dispatched into it`); }
  return true;
}

// vmUpCeilingMs(state) — how long a VM may take to come up before its
// variation goes to Blocked (vmDown, ASS-348), in ms: harness.json's
// vm-up-ceiling-seconds, else VM_UP_CEILING — far longer than any normal
// start (62–150 s seen, more queued behind the project's other VM jobs). Read
// through state.harness, which is the raw file, so the default applies with
// the key absent.
export const VM_UP_CEILING = 30 * 60_000;
export const vmUpCeilingMs = state => (state.harness['vm-up-ceiling-seconds'] != null ? state.harness['vm-up-ceiling-seconds'] * 1000 : VM_UP_CEILING);

// neverUp(ctx, at, name, ceiling) — the variation (`at`, found's) whose VM
// `name` did not come up within `ceiling` goes to Blocked — Blocked for Human
// when at Blocked already, as blockFailing sends a failing step inside it —
// when its engine has that step, it is a sprint ticket's and not worked by
// hand; its health (ai-feedback, short and long, set after the move, which
// clears it) naming the VM and that it never came up. Its wait is dropped, so
// a step there that runs in the VM waits afresh. Otherwise it waits on.
async function neverUp(ctx, at, name, ceiling) {
  const { project, ticket, variation, engine, backlog } = at;
  const from = variation['harness-status']?.state, to = from === 'blocked' ? 'blocked-for-human' : 'blocked';
  if (backlog || isManual(ticket) || from === 'blocked-for-human' || !stepOf(engine, to)) return;
  const why = `its VM ${name} never came up`;
  const short = `VM ${name} never came up: not running and reachable after ${held(ceiling)}`;
  const long = `${short}. Control dispatches no agent into a VM until it has seen it running and reached it (ASS-348), so no agent was sent; look at the VM's starts in the control log (vm:start failing, or still starting).`;
  await ctx.attempt(PHASE, `${ticket.key} ${variation.name}`, async () => {
    if (!await moveTicket(ctx, PHASE, project, ticket, variation, to, why)) return;
    ctx.memory.vmWaits?.delete(name);
    await ctx.cli(['ticket:set-ai-feedback', project.id, ticket.key, variation.name, short, long]);
  });
}

// heldOnFailure(ctx, key, fn) — fn, a dispatch; when it throws (the workspace
// would not take the branch, an agent would not start…), the item is held a
// while before it is tried again (backoff.js), and the error says how long.
const heldOnFailure = (ctx, key, fn) => async () => {
  try { await fn(); } catch (error) {
    const { until } = failed(ctx.memory, key, ctx.now().getTime(), error.message);
    throw new Error(`${error.message}; tried again in ${held(until - ctx.now().getTime())}`);
  }
};

// waitsOnAnswer(ctx, state) — the tickets an open blocking question holds
// (ASS-248: state.js asking), as "<project>/<key>": control starts no agent
// for them — not for a run under one (its sub-engine's steps, Blocked's), not
// at a sprint step (plan.js leaves them out, taking no seat), not in the
// backlog — the way it holds a paused one, until the tick after the answer.
// Each is logged once as its hold starts, again only after it lifts and
// comes back.
function waitsOnAnswer(ctx, state) {
  const held = new Set();
  for (const project of state.projects) for (const [key, questions] of project.asking ?? []) {
    const id = `${project.id}/${key}`, warned = `answer/${id}`;
    held.add(id);
    if (ctx.memory.warned.has(warned)) continue;
    ctx.memory.warned.add(warned);
    const named = [...questions.slice(0, 3), ...(questions.length > 3 ? ['…'] : [])].join('; ');   // the first few, for the log line
    ctx.log(PHASE, `${key} waits on the operator: ${questions.length} open blocking question${questions.length === 1 ? '' : 's'} (${named}); no agent until answered`);
  }
  for (const warned of ctx.memory.warned) if (warned.startsWith('answer/') && !held.has(warned.slice('answer/'.length))) ctx.memory.warned.delete(warned);
  return held;
}

// dispatch(ctx, state) — nothing while the agents are paused. Else each run
// at a prompt step with no agent on it gets one
// (work-item the ticket it works for, facts.js ticketOf — its context's, or
// the one a create-ticket step returned — variation from its context, {problem} the nearest
// analysis up its parents, see facts.js problemOf; with run-in-repository,
// in the repository repositories.js nextRepository gives — a ticket touching
// none passes the step over, skip) while max-agents allows — harness.json's,
// every agent counted, and its project's own (project.json), its agents counted — and, for a step that
// needs the workspace, while it is free (workspaceFree; the ticket's branch
// checked out there first — a failure, logged under error, dispatches
// nothing); then each project's sprint is ranked (rank.js) and planned
// (plan.js: harness.json's limits across every project, the project's own
// within it) and each planned dispatch made the same way. A run at a step
// of a sprint variation's sub-engine waits while the plan, made first, holds
// it (plan.js held: no slot of its kind, ASS-126, or a
// human to act). Between the two, each project's backlog (ASS-144), in
// refinement order (rankBacklog): a backlog ticket at a prompt step of its
// refinement engine with no agent on it gets one the same way — at the
// engine's first step only once it is due (plan.js refinementDue), the
// completed groom turn (not the dispatch) then stamping it (ticket:refined in
// finish.js, ASS-208) — while the backlog tickets with an
// agent are fewer than max-tickets-in-grooming, harness.json's over every
// project and its project.json's over its own (plan.js grooming; ASS-87,
// ASS-129: none set, no limit; 0, none). An item held after failing (backoff.js) waits its turn,
// and a run's or sprint step's in the variation's VM while control has not seen that VM up, however long —
// past a ceiling the variation goes to Blocked instead (vmDown, ASS-348); a run for
// a ticket at its spending limit (spend.js overSpent, ASS-191; its running agents' spend so far counted, ASS-270) waits, as the plan holds the ticket's steps.
// A fast-tracked ticket's run or step left without an agent, max-agents full,
// is remembered as waiting for an agent seat (fast-track.js, ASS-83); its
// backlog entry, after a failed join, is never groomed. An agent whose
// credential kind its project holds under a rate limit (rateHeld, ASS-215) is not dispatched; one of a
// project declaring both a subscription and an API key is dispatched on the one paymentFor picks, or waits (ASS-217).
// A project at its weekly usage limit (moves.js weeklyLimit, ASS-232) grooms
// nothing and puts no agent on a background run (moves.js backgroundProject):
// they wait; its sprint work goes on. One declaring an API key beside its
// subscription (ASS-327) is not held: that work is paid api (paymentFor's
// `weekly`), as any API dispatch held by the anthropic rate limit and the API
// caps, its sprint work on paymentFor's own rule. A ticket
// an open blocking question holds gets no agent anywhere (waitsOnAnswer, ASS-248); nor does a
// variation its dependencies hold (dependencies.js, ASS-355), at the top level or in a run under it —
// asked before its VM, which is stopped while it is held. An agent already running finishes its turn.
export async function dispatch(ctx, state) {
  const maxAgents = state.harness['max-agents'] ?? Infinity;
  const agentsOf = id => [...ctx.agents.values()].filter(l => l.project === id).length;
  // Every project's agents, this control's live ones and the others' records (each control its own project's, ASS-9).
  const mine = new Set(state.projects.map(p => p.id));
  const others = state.assignments.filter(a => !mine.has(a.project)).length;
  const allAgents = () => ctx.agents.size + others;
  // A project on the wrong Claude account starts none of its agents (accountHold).
  const accountHeld = new Set();
  for (const project of state.projects) if (await accountHold(ctx, project)) accountHeld.add(project.id);
  // Each project's credential kinds held by a rate limit (rateHeld).
  const limited = new Map(state.projects.map(p => [p.id, heldKinds(p, ctx.now().getTime())]));
  // Each project at its weekly usage limit (weeklyLimit: 'held' or 'api'), asked every tick so its hold is logged as it starts and lifts.
  const weekly = new Map(state.projects.map(p => [p.id, weeklyLimit(ctx, p)]));
  // Each project planned against its own limits and harness.json's, every other project's tickets in motion counted (plan.js planFor).
  const plan = (project, state) => planFor(state, project, { agentsRunning: allAgents(), projectAgentsRunning: agentsOf(project.id) });
  const holds = state.projects.filter(p => p.engine && p.sprint).flatMap(p => plan(p, state).held.map(h => ({ project: p.id, ...h })));
  const answering = waitsOnAnswer(ctx, state);
  for (const run of state.transient) {
    if (run['is-done'] || state.assignments.some(a => a['transient-state-engine'] === run.id)) continue;
    const step = stepOf(engineSteps(enginesFor(state, run.project), run['state-engine']), run.state);
    if (step?.action?.type !== 'prompt' || !isActive(step)) continue;   // switched off (ASS-192): passed by steps.js, no agent
    const at = ticketPath(run, state.transient);
    if (at && holds.some(h => h.project === run.project && h.key === at.workItem && h.variation === at.variation && h['state-engine'] === run['state-engine'] && h.state === run.state)) continue;
    const context = contextOf(run, state.transient);
    const project = state.projects.find(p => p.id === run.project);
    if (!project || accountHeld.has(project.id) || isPaused(state, run.project, context.workItem, context.variation, run.id)) continue;
    if (context.workItem != null && answering.has(`${run.project}/${context.workItem}`)) continue;
    const background = backgroundProject(state, run.id);
    const limit = background ? weeklyLimit(ctx, background) : null;   // its project's, which may be one this control does not run (allProjects)
    if (limit === 'held') continue;
    // A run for a ticket at its spending limit (ASS-191: a step's sub-engine's, Blocked's) starts no agent.
    if (context.workItem != null && overSpent(found(state, { project: run.project, 'work-item': context.workItem }).ticket, state.harness, project.json, runningOn(state.running, run.project, context.workItem))) continue;
    const key = runKey(run.id, run.state);
    if (waiting(ctx.memory, key, ctx.now().getTime())) continue;   // failing: held a while (backoff.js)
    // Its ticket waiting for what it depends on (ASS-195, ASS-355): the same predicate steps.js holds it with — asked
    // before its VM, which is stopped while it is held, so the wait is never taken for a VM that does not come up (ASS-348).
    const waits = found(state, { project: run.project, 'work-item': context.workItem, variation: context.variation });
    if (!waits.backlog && awaitsDependencies(ctx, state, project, waits.ticket, waits.variation, `run ${run['state-engine']} ${run.id.slice(0, 8)} ${run.state}`)) continue;
    if (await vmDown(ctx, state, step, run.project, context.workItem, context.variation, run.state)) continue;
    const pays = await paymentFor(ctx, limited, project, step, context.workItem, context.variation, limit === 'api');
    if (!pays) continue;
    const count = step.action['agent-count'] ?? 1;
    if (allAgents() + count > maxAgents || agentsOf(run.project) + count > (project.json['max-agents'] ?? Infinity)) {
      // A fast-tracked ticket's run held so waits for an agent seat (ASS-83, fast-track.js).
      const at = found(state, { project: run.project, 'work-item': context.workItem, variation: context.variation });
      if (at.ticket && at.variation && !at.backlog) waitsForSeat(ctx.memory, project, at.ticket, at.variation, 'agents');
      continue;
    }
    if (!workspaceFree(ctx, state, step, project, context.workItem ?? run.id.slice(0, 8), context.variation ?? '-')) continue;
    // The ticket it works for (the fix ticket once made); the variation only when that is the context's own,
    // and in the run's own project (a harness run about another project's ticket logs no dispatch on it).
    const ticket = ticketOf(run, state.transient);
    const elsewhere = (ticketProjectOf(state, run.id) ?? run.project) !== run.project;
    await ctx.attempt(PHASE, `run ${run.id.slice(0, 8)}`, heldOnFailure(ctx, key, async () => {
      const where = nextRepository(ctx.memory, step, found(state, { project: run.project, 'work-item': context.workItem, variation: context.variation }).variation, visitOf({ run, changes: run['state-changes'] ?? [] }));
      if (where?.skip) return skip(ctx, step, engineSteps(enginesFor(state, run.project), run['state-engine']), run['state-changes'] ?? [], `run ${run.id.slice(0, 8)} ${run.state}`, to => moveRun(ctx, PHASE, run, to));
      const vm = vmFor(state, project, step, context.workItem, context.variation);
      await takeWorkspace(ctx, step, project, context.workItem, context.variation);
      const records = await create(ctx, [run.project, run['state-engine'], run.state, step.action.prompt, String(count), String(inContainer(step, project)), ticket ?? '-', (ticket === context.workItem && !elsewhere ? context.variation : undefined) ?? '-', run.id, problemOf(run, state.transient, { harness: state.harness, project: ticketProjectOf(state, run.id) ?? run.project, history: blockHistory(found(state, { project: run.project, 'work-item': context.workItem, variation: context.variation }).variation) })]);
      for (const record of records) await startFor(ctx, state, project, record, vm, where?.repository, step, pays.payment);
    }));
    state = ctx.load();
  }
  for (const project of state.projects) {
    if (!project.refinement || accountHeld.has(project.id) || weekly.get(project.id) === 'held') continue;
    // A fast-tracked ticket (ASS-83) is never groomed: complete at creation, in the backlog only after a failed join, for the next.
    for (const t of rankBacklog(project.backlog ?? [])) for (const v of t['fast-track'] === true ? [] : t.variations ?? []) {
      if (v['is-deleted']) continue;
      const { ticket, variation, engine } = found(state, { project: project.id, 'work-item': t.key, variation: v.name });
      const step = stepOf(engine, variation?.['harness-status']?.state);
      if (step?.action?.type !== 'prompt' || !isActive(step) || isPaused(state, project.id, t.key, v.name) || answering.has(`${project.id}/${t.key}`)) continue;
      if (state.assignments.some(a => a.project === project.id && a['work-item'] === t.key && a['transient-state-engine'] == null)) continue;
      const key = ticketKey(project.id, t.key, v.name, step.id);
      if (waiting(ctx.memory, key, ctx.now().getTime())) continue;   // failing: held a while (backoff.js)
      const first = step.id === firstStepId(engine);
      if (first && !refinementDue(ticket, questionsOf(ctx, project.id, t.key), ctx.now().getTime())) continue;
      if (grooming(state) >= (state.harness['max-tickets-in-grooming'] ?? Infinity) || grooming(state, project.id) >= (project.json['max-tickets-in-grooming'] ?? Infinity)) continue;
      const count = step.action['agent-count'] ?? 1;
      if (allAgents() + count > maxAgents || agentsOf(project.id) + count > (project.json['max-agents'] ?? Infinity)) continue;
      if (!workspaceFree(ctx, state, step, project, t.key, v.name)) continue;
      const pays = await paymentFor(ctx, limited, project, step, t.key, v.name, weekly.get(project.id) === 'api');
      if (!pays) continue;
      await ctx.attempt(PHASE, `${t.key} ${v.name}`, heldOnFailure(ctx, key, async () => {
        await takeWorkspace(ctx, step, project, t.key, v.name);
        const records = await create(ctx, [project.id, variation['harness-status']['state-engine'] ?? project.refinementName, step.id, step.action.prompt, String(count), String(inContainer(step, project)), t.key, v.name, '-']);
        for (const record of records) await startFor(ctx, state, project, record, null, undefined, step, pays.payment);
      }));
      state = ctx.load();
    }
  }
  for (const project of state.projects) {
    if (!project.engine || !project.sprint || accountHeld.has(project.id)) continue;
    const planned = plan(project, state);
    // A fast-tracked ticket the plan left without an agent, max-agents full, waits for an agent seat (ASS-83, fast-track.js).
    for (const s of planned.short) { const at = found(state, { project: project.id, 'work-item': s.key, variation: s.variation }); waitsForSeat(ctx.memory, project, at.ticket, at.variation, 'agents'); }
    for (const item of planned.dispatch) {
      const step = stepOf(project.engine, item.state);
      if (isPaused(state, project.id, item.key, item.variation)) continue;
      const key = ticketKey(project.id, item.key, item.variation, item.state);
      if (waiting(ctx.memory, key, ctx.now().getTime())) continue;   // failing: held a while (backoff.js)
      const at = found(state, { project: project.id, 'work-item': item.key, variation: item.variation });
      const who = `${item.key} ${item.variation} ${item.state}`;
      // Waiting for what it depends on (ASS-195, ASS-355): the plan leaves such a one out already; asked again, as steps.js asks, before its VM.
      if (awaitsDependencies(ctx, state, project, at.ticket, at.variation, who)) continue;
      if (await vmDown(ctx, state, step, project.id, item.key, item.variation, item.state)) continue;
      const pays = await paymentFor(ctx, limited, project, step, item.key, item.variation);
      if (!pays) continue;
      if (!workspaceFree(ctx, state, step, project, item.key, item.variation)) continue;
      await ctx.attempt(PHASE, `${item.key} ${item.variation}`, heldOnFailure(ctx, key, async () => {
        const { ticket, variation } = at;
        const where = nextRepository(ctx.memory, step, variation, visitOf({ project, ticket, variation, changes: levelChanges(variation) }));
        if (where?.skip) return skip(ctx, step, project.engine, levelChanges(variation), who, to => mayMove(ctx, PHASE, state, project, variation, who, to) && moveTicket(ctx, PHASE, project, ticket, variation, to));
        const vm = vmFor(state, project, step, item.key, item.variation);
        await takeWorkspace(ctx, step, project, item.key, item.variation);
        const records = await create(ctx, [project.id, project.engineName, item.state, step.action.prompt, String(item.agentCount), String(inContainer(step, project)), item.key, item.variation, '-']);
        for (const record of records) await startFor(ctx, state, project, record, vm, where?.repository, step, pays.payment);
      }));
      state = ctx.load();
    }
  }
}

// skip(ctx, step, engine, changes, who, move) — a step run in each repository the
// ticket touches, when it touches none (ASS-119): no agent, the step passed
// over by its first exit, its pass (repositories.js), through `move`.
async function skip(ctx, step, engine, changes, who, move) {
  const to = resolveTarget(step['exit-events']?.[0] ?? {}, step, engine, changes);
  if (to == null) { ctx.log(PHASE, `${who}: the ticket touches no repository, and the step has no first exit to pass it by`); return; }
  ctx.log(PHASE, `${who}: the ticket touches no repository; the step is passed over to ${to}`);
  await move(to);
}
