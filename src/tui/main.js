#!/usr/bin/env node
// Terminal shell for the dashboard: owns the whole screen, turns keypresses
// into state, redraws. All behaviour lives in app.js.
import { emitKeypressEvents } from 'node:readline';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { initialState, handleKey, render, decided, controlStarted, controlExited, controlDraining } from './app.js';
import { loadProjects, loadWorkflows, loadPauses, loadSelfHealing, loadAssignments, loadTransientEngines, loadChats, loadHarness, loadModelUsage, loadDiskSpace, watchFiles, dataFiles, keepSame, projectsChanged } from './load.js';
import { startControl } from '../control/process.js';
import { ender, stillNamed } from './shutdown.js';
import { sessionDir, readSession, readSessionTail, sessionModified } from '../agents/session.js';
import { readUsage } from '../agents/session-usage.js';
import { chatRunner, chatSpendArgs } from '../agents/chats.js';
import { configDir } from '../control/dispatch.js';
import { ticketChat, opening, briefing, chatId, problems } from './collaboration.js';
import { memoryLoaded, healthPoller, memoryChecked } from './memory.js';
import { loadFeatures, featureOn } from './features.js';
import { settlePending, refused } from './screens/agents.js';
import { refinementSteps } from './status.js';
import { listMemories, deleteMemory, memoryHealthy } from '../agents/memory.js';
import { dataDir } from '../data-folder.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DATA = dataDir(ROOT);
const ASSIGNMENTS = join(DATA, 'assignments.json');
const CHATS = join(DATA, 'chats.json');
const { stdin, stdout } = process;

if (!stdin.isTTY) {
  console.error('tui: needs an interactive terminal');
  process.exit(1);
}

let state = { ...initialState({
  projects: loadProjects(join(DATA, 'projects')),
  workflows: loadWorkflows(join(ROOT, 'engines'), join(DATA, 'projects')),
  assignments: loadAssignments(ASSIGNMENTS),
  transientEngines: loadTransientEngines(ASSIGNMENTS),
  pauses: loadPauses(ASSIGNMENTS),
  selfHealing: loadSelfHealing(ASSIGNMENTS),
  chats: loadChats(CHATS),
  agentsGrid: loadHarness(join(DATA, 'projects')),
  modelUsage: loadModelUsage(join(DATA, 'projects')),
  disk: loadDiskSpace(DATA),
  menuHidden: true,   // / shows it
  features: loadFeatures(),   // read once, here (ASS-262)
}), updatedAt: {} };
// When each project's own data last changed (see projectsChanged): from now, for every project at start.
state = { ...state, updatedAt: Object.fromEntries(state.projects.map(p => [p.id, Date.now()])) };

// Each line is written at its own row and cleared to the end, never with a
// newline, so the terminal cannot scroll. Only changed lines are rewritten.
let frame = [];
function draw() {
  const lines = render(state, { columns: stdout.columns, rows: stdout.rows, now: new Date() });
  const out = lines.map((line, i) => (line === frame[i] ? '' : `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`)).join('');
  frame = lines;
  if (out) stdout.write(out);
}

// When each agent's session log was last written, and the open one as it is
// on disk now (see src/agents/session.js), read again on every key and every
// second so they keep up as the agents work.
// Every tiled agent's log tail (ASS-188) beside them: the grid draws the last
// lines of each, so all of them are followed, not just the open one — read
// again only once a log's mtime has changed, the rest kept as they were.
// Tails are keyed as the tiles are: an assignment's by its agent-name, a
// chat's by its id. `was` is when each was last written before this read.
// Each one's usage.json (ASS-190: its context and cost) too, read every time:
// it is a few hundred bytes.
const withSession = s => {
  const dir = a => a['start-time'] && sessionDir(DATA, a['agent-name'], a['start-time']);
  const sessionWritten = Object.fromEntries(s.assignments
    .map(a => [a['agent-name'], dir(a) && sessionModified(dir(a))])
    .filter(([, at]) => at != null));
  const open = s.agent?.start && sessionDir(DATA, s.agent.name, s.agent.start);
  // The chat screen's chats (ASS-33) the same way: which run, when each log was last written, the open one's log.
  const chatsWritten = Object.fromEntries(s.chats.map(c => [c.id, sessionModified(chats.dir(c.id))]).filter(([, at]) => at != null));
  const chatsRunning = s.chats.map(c => c.id).filter(chats.running);
  const was = key => s.sessionWritten[key] ?? s.chatsWritten[key];
  const tailed = [
    ...s.assignments.filter(a => dir(a)).map(a => [a['agent-name'], dir(a), sessionWritten[a['agent-name']]]),
    ...s.chats.filter(c => chatsRunning.includes(c.id)).map(c => [c.id, chats.dir(c.id), chatsWritten[c.id]]),
  ];
  const sessionTails = Object.fromEntries(tailed.map(([key, folder, at]) =>
    [key, at != null && at === was(key) && s.sessionTails[key] !== undefined ? s.sessionTails[key] : readSessionTail(folder)]));
  const usage = Object.fromEntries(tailed.map(([key, folder]) => [key, readUsage(folder)]).filter(([, u]) => u));
  return settlePending({
    ...s, sessionWritten, chatsWritten, chatsRunning, sessionTails, usage,
    ...(s.agent ? { agentLog: open ? readSession(open) : null } : {}),
    ...(s.chat ? { chatLog: s.chat.id ? readSession(chats.dir(s.chat.id)) : null } : {}),
    ...(s.ticket && featureOn(s, 'ticket-chat-tab') ? { ticketChatLog: readSession(chats.dir(chatId(s.projects[s.project]?.id, s.ticket.key))) } : {}),
  });
};

// The chat screen's agents (ASS-33): plain Claude processes this dashboard owns
// (stopped when it exits), each in its project's workspace on the project's
// own Claude login (ASS-26), resumed by its session id once ended. Each is
// started with the chat rules (prompts/chat-rules): full access, but no change
// without the operator's yes.
const chats = chatRunner({ data: DATA, systemPrompt: readFileSync(join(ROOT, 'prompts', 'chat-rules', 'prompt.txt'), 'utf8').trim().replaceAll('{root}', ROOT) });
process.on('exit', () => chats.stopAll());
// Where a project's chats run: in its folder data/projects/<id>/, on its own
// Claude login, not confined (ASS-108's host-agent rules hold the other host
// agents): the chat rules, not a sandbox, keep a change waiting for the operator.
function workspace(id) {
  const dir = configDir({ paths: { projects: join(DATA, 'projects') } }, { id });
  const cwd = join(DATA, 'projects', id);
  mkdirSync(cwd, { recursive: true });
  return { cwd, env: dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env };
}
// Each turn's cost recorded against the chat's project (chat:add-spend,
// ASS-271), as a ticket chat's is; a turn stopped mid-way (the chat deleted,
// the dashboard exiting) at its usage.json estimate, recorded before this
// returns, since an exiting dashboard runs no callback after.
function sendChat(chat, text) {
  const agent = join(ROOT, 'agent.sh');
  chats.send(chat, text, {
    ...workspace(chat.project),
    usage: state.modelUsage,
    onSession: session => {
      if (session === chat['session-id']) return;
      execFile(agent, ['chat:set-session', chat.id, session], () => reload());
    },
    onCost: (usd, billing) => execFile(agent, chatSpendArgs(chat, usd, billing), () => reload()),
    onEstimate: (usd, billing) => { try { execFileSync(agent, chatSpendArgs(chat, usd, billing, true), { stdio: 'ignore' }); } catch { /* recorded nowhere: never block the exit */ } },
  });
}

// A ticket's chat on its screen (ASS-35), on the same runner: one session for
// the ticket's whole life, kept in work/<KEY>/collaboration.json through the
// agent-cli (see collaboration.js). Opening the screen briefs it the first
// time, and after that sends what changed since (opening), then asks it about
// what is off with the ticket when that changed (problems, ASS-36); nothing
// else starts it.
const ticketIn = (project, key) => {
  const sprint = project?.sprint;
  const inSprint = ['features', 'bugs', 'spikes'].flatMap(type => sprint?.[type] ?? []).find(t => t.key === key);
  return inSprint ? { ticket: inSprint, sprint } : { ticket: project?.backlog?.find(t => t.key === key), sprint: null };
};
function recordTicketChat(args) {
  execFile(join(ROOT, 'agent.sh'), args, (error, _out, stderr) => {
    if (error) state = { ...state, ticketChatMessage: stderr.trim() || error.message };
    reload();
    draw();
  });
}
function sendTicketChat(id, key, text) {
  const project = state.projects.find(p => p.id === id);
  ticketChat(chats, { project: id, key, collaboration: project?.collaborations?.[key] ?? null, ...workspace(id), record: recordTicketChat }).send(text);
}
function openTicketChat({ project: id, key }) {
  const project = state.projects.find(p => p.id === id);
  const { ticket, sprint } = ticketIn(project, key);
  if (!ticket) return;
  const questions = (project.questions ?? []).filter(q => q.source.toUpperCase() === key.toUpperCase());
  // A backlog ticket's steps are its refinement engine's (ASS-144).
  const steps = sprint ? state.workflows.find(w => w.name === project.stateEngine)?.steps ?? [] : refinementSteps(state.workflows, project.stateEngine);
  const off = problems({ project: id, ticket, steps, questions, selfHealing: state.selfHealing });
  const first = opening({ collaboration: project.collaborations?.[key] ?? null, running: chats.running(chatId(id, key)), ticket, questions, briefing: briefing(ROOT, { project: id, ticket, sprint }), problems: off });
  if (!first) return;
  if (first.text) sendTicketChat(id, key, first.text);
  if (first.snapshot) recordTicketChat(['collaboration:set-briefed', id, key, JSON.stringify(first.snapshot)]);
  if (first.raised) recordTicketChat(['collaboration:set-raised', id, key, JSON.stringify(first.raised)]);
}

// Alternate screen, cleared, cursor hidden, autowrap off; restored on exit.
stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?7l');
process.on('exit', () => stdout.write('\x1b[?7h\x1b[?25h\x1b[?1049l'));

// This process is the supervisor: it runs control for as long as the
// dashboard is open — one control per project (ASS-9), each ticking only its
// own — keeping their latest output for the control screen, each line marked
// with its project; each control's also goes to its own log file. One
// control exiting leaves the others running, shown down (controlExited).
const CONTROL_LINES = 1000 * Math.max(1, state.projects.length);
const LOGS = join(homedir(), '.harness', 'logs');
const controlLogFiles = Object.fromEntries(state.projects.map(p => [p.id, join(LOGS, `control-${p.id}.log`)]));
state = { ...state, controlLogFiles };
const controlIds = state.projects.map(p => p.id);
const controls = state.projects.map(p => startControl({
  args: ['--project', p.id],
  logFile: controlLogFiles[p.id],
  // A control exits with 75 when a fix asks for a restart (harness:request-restart, which names every control), once it has drained its agents (ASS-200):
  // once no control the request names still runs, the dashboard stops the rest and waits for them, then exits with 75, and harness-cli/tui.sh starts it again on the new code (ASS-193).
  onExit: code => {
    ended.add(p.id);
    const quitting = state.quitting;
    state = controlExited(state, p.id, code, restartWaitsFor());
    if (state.quitting && !quitting) quit(75);
    draw();
  },
  // Its drain's "restart waiting for N agents" goes on the legend (controlDraining).
  onLine: line => {
    const drain = controlDraining(state, p.id, line.text);
    const legend = drain !== state;
    state = { ...drain, controlLog: [...state.controlLog, { ...line, project: p.id }].slice(-CONTROL_LINES) };
    if (state.screen === 'c' || legend) draw();
  },
}));
// Each running control's process id and when it started go on the state, for the footer's control box (ASS-310);
// they all start in this tick, so one start time stands for them all, and controlExited drops each as it ends.
const startTime = new Date();
controls.forEach((c, i) => { state = controlStarted(state, controlIds[i], { pid: c.pid, startTime }); });
// restartWaitsFor() — the controls still running that harness:request-restart's request names (stillNamed).
const ended = new Set();
const RESTART = join(process.env.HARNESS_HOME ?? join(homedir(), '.harness'), 'restart-requested.json');
function restartWaitsFor() {
  let request = null;
  try { request = JSON.parse(readFileSync(RESTART, 'utf8')); } catch { /* none */ }
  return stillNamed(request, controls.filter((c, i) => !ended.has(controlIds[i])).map(c => c.pid));
}
// The downloader, started the same way; its lines join control's on the
// control screen, marked, and go to their own log file.
const DOWNLOADER_LOG = join(LOGS, 'downloader.log');
const downloader = startControl({
  script: join(ROOT, 'src', 'downloader', 'main.js'),
  logFile: DOWNLOADER_LOG,
  onLine: line => {
    state = { ...state, controlLog: [...state.controlLog, { ...line, text: `downloader  ${line.text}` }].slice(-CONTROL_LINES) };
    if (state.screen === 'c') draw();
  },
});
process.on('exit', () => { for (const c of controls) c.stop(); downloader.stop(); });
process.on('SIGTERM', () => process.exit(0));

// Q, or a control's restart: control and the downloader stopped and waited for
// (control stops its agents), then nothing of the harness left running (see
// shutdown.js); what it does is shown on the control screen, and the dashboard
// exits — with 75 for a restart. Only the first one runs (ender).
// Alive, and an agent (src/agents/process.js's command): a stale record's
// process id may since have gone to something else, which is left alone.
const alive = pid => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('--output-format stream-json'); } catch { return false; } };
const log = text => {
  state = { ...state, controlLog: [...state.controlLog, { text: `dashboard  ${text}`, stream: 'stderr', at: new Date() }].slice(-CONTROL_LINES) };
  draw();
};
const end = ender({
  children: [...controls, downloader],
  agentPids: () => { try { return loadAssignments(ASSIGNMENTS).map(a => a['process-id']); } catch { return []; } },
  alive, kill: (pid, signal) => process.kill(pid, signal), log,
}, code => process.exit(code));
function quit(code = 0) {
  log(code === 75 ? 'restarting: a control asked for it' : 'shutting down');
  end(code);
}

emitKeypressEvents(stdin);
stdin.setRawMode(true);
// Space's pause commands still running; until they finish, the banner shows what was pressed.
let pausing = 0;

// Every file the dashboard reads is watched (see dataFiles — of the sprints,
// only the one on show), and read again once it changes. Only what changed is
// replaced (see keepSame); when nothing did, nothing is drawn. A file caught
// half-written by hand is read again on its next change.
function reload() {
  let loaded;
  try {
    loaded = {
      projects: loadProjects(join(DATA, 'projects')),
      workflows: loadWorkflows(join(ROOT, 'engines'), join(DATA, 'projects')),
      assignments: loadAssignments(ASSIGNMENTS),
      transientEngines: loadTransientEngines(ASSIGNMENTS),
      ...(pausing ? {} : { pauses: loadPauses(ASSIGNMENTS) }),
      selfHealing: loadSelfHealing(ASSIGNMENTS),
      chats: loadChats(CHATS),
      modelUsage: loadModelUsage(join(DATA, 'projects')),
      disk: loadDiskSpace(DATA),
    };
  } catch { return; }
  const changed = Object.entries(loaded).map(([key, value]) => [key, keepSame(state[key], value)]).filter(([key, value]) => value !== state[key]);
  if (!changed.length) return;
  const next = { ...state, ...Object.fromEntries(changed) };
  const moved = projectsChanged(state, next);   // the footer moves only for a project whose own data changed (ASS-10)
  state = { ...next, updatedAt: { ...state.updatedAt, ...Object.fromEntries(moved.map(id => [id, Date.now()])) } };
  rewatch();
  draw();
}
// Watches the files the state on show reads, again only when that list changes
// — a day or project chosen, a sprint made active, a ticket's questions added.
let watcher, watching = '';
function rewatch() {
  const files = dataFiles(ROOT, state);
  if (files.join('\n') === watching) return;
  watcher?.close();
  watcher = watchFiles(files, reload);
  watching = files.join('\n');
}
rewatch();

stdin.on('keypress', (_, key) => {
  // The time the screens size themselves at, as render draws the footer (ASS-295).
  let next = handleKey(state, key, { columns: stdout.columns, rows: stdout.rows, now: new Date() });
  if (next.quit) process.exit(0);
  if (next.quitting && !state.quitting) quit();
  // Space holds or releases the human's pause: the banner flips at once; the
  // file is the truth once the command finishes (the watcher waits till then).
  // space (the selected project) and ! (all agents): the scope whose human pause flipped.
  for (const scope of new Set([...Object.keys(next.pauses), ...Object.keys(state.pauses)])) {
    const holds = Boolean(next.pauses[scope]?.human);
    if (holds === Boolean(state.pauses[scope]?.human)) continue;
    pausing++;
    execFile(join(ROOT, 'agent.sh'), [holds ? 'assignments:pause' : 'assignments:start', scope, 'human'], () => {
      pausing--;
      reload();
    });
  }
  // An answer is saved by the agent-cli, which locks the file; the screen
  // shows the file as it is once the command finishes, or what went wrong —
  // read at once, not waiting on the watcher.
  if (next.submit) {
    const { project, source, index, answer, 'why-this-answer': why, scope } = next.submit;
    execFile(join(ROOT, 'agent.sh'), ['question:answer', project, source, String(index), answer, why, scope], (error, _out, stderr) => {
      state = { ...state, message: error ? stderr.trim() || error.message : '' };
      reload();
      draw();
    });
    next = { ...next, submit: null };
  }
  // A human gate's choice is saved by the agent-cli command it names, which
  // locks sprint.json; the screen shows the sprint as it is once the command
  // finishes, or what went wrong — or, for one that closes it (Delete ticket,
  // ASS-104), goes back where the ticket was opened from (decided).
  if (next.decide) {
    const closes = next.decideCloses;
    execFile(join(ROOT, 'agent.sh'), next.decide, (error, _out, stderr) => {
      state = decided(state, error ? stderr.trim() || error.message : null, closes);
      reload();
      draw();
    });
    next = { ...next, decide: null, decideCloses: false };
  }
  // The Demo action (ASS-76): vm:demo runs for minutes — the VM restarted, the
  // setup, the ready-check — and the ticket screen says it is starting until
  // it ends: ready, or what went wrong.
  if (next.demoRun) {
    const at = `${next.demoRun[2]}.${next.demoRun[3]}`;
    execFile(join(ROOT, 'agent.sh'), next.demoRun, (error, _out, stderr) => {
      state = { ...state, demos: { ...state.demos, [at]: error ? { status: 'failed', message: stderr.trim() || error.message } : { status: 'ready' } } };
      reload();
      draw();
    });
    next = { ...next, demoRun: null };
  }
  // A prompt goes to its agent through the agent-cli, which queues it for the
  // supervisor; the screen says where it went, or what went wrong.
  if (next.agentPrompt) {
    const [, name] = next.agentPrompt;
    execFile(join(ROOT, 'agent.sh'), next.agentPrompt, (error, _out, stderr) => {
      state = error
        ? { ...state, agentMessage: stderr.trim() || error.message, pending: refused(state.pending, name) }
        : { ...state, agentMessage: `queued for ${name}` };
      draw();
    });
    next = { ...next, agentPrompt: null };
  }
  // A chat's message (ASS-33): to its agent, the chat made first (chat:create,
  // titled by the message) when it is new; the screen says what went wrong.
  if (next.chatSend) {
    const { project, id, text } = next.chatSend;
    const fail = (error, stderr) => { state = { ...state, chatMessage: stderr?.trim() || error.message }; draw(); };
    if (id) {
      const chat = state.chats.find(c => c.id === id);
      try { sendChat(chat, text); } catch (error) { fail(error); }
    } else {
      execFile(join(ROOT, 'agent.sh'), ['chat:create', project, text.split('\n')[0].slice(0, 60)], (error, out, stderr) => {
        if (error) return fail(error, stderr);
        const chat = JSON.parse(out);
        state = { ...state, chats: [...state.chats, chat], chat: state.chat && !state.chat.id ? { id: chat.id } : state.chat };
        try { sendChat(chat, text); } catch (failure) { fail(failure); }
        reload();
        draw();
      });
    }
    next = { ...next, chatSend: null };
  }
  // A chat deleted: its agent stopped, its entry removed from chats.json; its log stays on disk.
  if (next.chatDelete) {
    chats.stop(next.chatDelete);
    execFile(join(ROOT, 'agent.sh'), ['chat:delete', next.chatDelete], (error, _out, stderr) => {
      state = { ...state, chatMessage: error ? stderr.trim() || error.message : '' };
      reload();
      draw();
    });
    next = { ...next, chatDelete: null };
  }
  // The memory screen (ASS-62): opened, the project's memories fetched from its
  // Hindsight; one deleted there, then fetched again — or what went wrong said.
  const loadMemories = (id, port) => listMemories(port, id).then(items => ({ items }), error => ({ error: error.message }))
    .then(result => { state = memoryLoaded(state, id, result); draw(); });
  if (next.memoryLoad) {
    const id = next.memoryLoad;
    loadMemories(id, next.projects.find(p => p.id === id).hindsight.port);
    next = { ...next, memoryLoad: null };
  }
  if (next.memoryDelete) {
    const { project, port, document } = next.memoryDelete;
    deleteMemory(port, project, document).then(() => { state = { ...state, memoryMessage: `deleted ${document}` }; }, error => { state = { ...state, memoryMessage: error.message }; })
      .then(() => loadMemories(project, port));
    next = { ...next, memoryDelete: null };
  }
  // A ticket's screen opened: its chat briefed or caught up; a message typed there, to its agent (ASS-35).
  if (next.ticketChatOpen) {
    const open = next.ticketChatOpen;
    next = { ...next, ticketChatOpen: null };
    try { openTicketChat(open); } catch (error) { next = { ...next, ticketChatMessage: error.message }; }
  }
  if (next.ticketChatSend) {
    const { project, key, text } = next.ticketChatSend;
    next = { ...next, ticketChatSend: null };
    try { sendTicketChat(project, key, text); } catch (error) { next = { ...next, ticketChatMessage: error.message }; }
  }
  state = withSession(next);
  rewatch();
  draw();
});
stdout.on('resize', () => {
  frame = [];
  stdout.write('\x1b[2J');
  draw();
});
// Each project's Hindsight, checked by the dashboard itself (ASS-293: see
// tui/memory.js healthPoller), polled with the clock; an answer that changes
// the control box's hindsight line is drawn at once.
const health = healthPoller({
  check: port => memoryHealthy(port),
  onResult: (id, result) => {
    const next = memoryChecked(state, id, result);
    if (next === state) return;
    state = next;
    draw();
  },
});
setInterval(() => { // keeps the clock and an open session log current
  health.poll(state.projects, Date.now());
  state = withSession(state);
  draw();
}, 1000);
health.poll(state.projects, Date.now());
state = withSession(state);
draw();
