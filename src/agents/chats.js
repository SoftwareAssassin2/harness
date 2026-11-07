// The chat screen's agents (ASS-33): one plain Claude process per chat the
// operator is talking to — no name, no assignment, no control — owned by the
// dashboard, its log in <data>/chats/<chat id>/session.txt, <data> the data
// folder (data/: src/data-folder.js). A chat whose
// process has ended starts again with `--resume <its session-id>`, so the
// conversation goes on.
import { join } from 'node:path';
import { startAgent, billed } from './process.js';
import { readUsage } from './session-usage.js';

// chatRunner({ data, command, systemPrompt }) — `command` the agent command
// instead of Claude (tests); `systemPrompt` the rules every chat's agent is
// started with, resumed or not (--append-system-prompt). Returns:
//   send(chat, text, { cwd, env, confinedBy, usage, onSession, onCost, onEstimate }) — text to the chat's
//     agent, started first when none runs (in cwd, with env, confined by the
//     settings file confinedBy when given, writing usage.json with usage
//     when given — see startAgent —, resuming
//     chat['session-id'] when it has one); onSession(id) once its init event
//     names its session; onCost(usd, billing) at the end of each turn, its own cost
//     (total_cost_usd starts over with each process: see startAgent), 0 on a
//     subscription, and what it was billed to (process.js billingOf; null
//     when its session never said); onEstimate(usd, billing) instead for a
//     turn its agent stopped or died in (ASS-271: the chat deleted, the
//     dashboard exiting) — called at once from stop and stopAll, so a
//     dashboard exiting can still record it, else on its exit —, its cost
//     estimated from usage.json (session-usage.js: the process's exact total
//     so far plus its tokens since priced) less the process's earlier turns,
//     0 on a subscription; given only with `usage` and once that turn has
//     priced an assistant event of this process, so a usage.json left by an
//     earlier one is never read as this one's, and never twice: once stopped,
//     whatever its agent still prints records nothing more;
//   running(id), dir(id) — whether its agent runs; its log folder;
//   stop(id), stopAll() — its agent's process group signalled; every one's.
export function chatRunner({ data, command, systemPrompt }) {
  const live = new Map();
  const dir = id => join(data, 'chats', id);
  // A turn caught mid-way (`unpriced`: an assistant event since its last
  // result) handed to onEstimate, once; `stopped` once stop has.
  const estimate = entry => {
    if (!entry.unpriced) return;
    entry.unpriced = false;
    const cost = readUsage(entry.agent.dir)?.costUsd;
    if (cost != null) entry.onEstimate(billed(entry.agent, Math.max(0, cost - entry.agent.lastTotalCost)), entry.agent.billing);
  };
  function start(chat, { cwd, env, confinedBy, usage, onSession = () => {}, onCost = () => {}, onEstimate = () => {} }) {
    const entry = { unpriced: false, stopped: false, onEstimate };
    entry.agent = startAgent({
      name: 'chat', root: data, dir: dir(chat.id), cwd, env, command, systemPrompt, confinedBy, usage, resume: chat['session-id'] ?? undefined,
      onEvent: event => {
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) onSession(event.session_id);
        if (event.type === 'assistant' && usage && !entry.stopped) entry.unpriced = true;
      },
      onResult: event => {
        entry.unpriced = false;
        if (!entry.stopped) onCost(billed(entry.agent, (event.total_cost_usd ?? entry.agent.lastTotalCost) - entry.agent.lastTotalCost), entry.agent.billing);
      },
      onExit: () => { estimate(entry); if (live.get(chat.id) === entry) live.delete(chat.id); },
    });
    live.set(chat.id, entry);
    return entry.agent;
  }
  const stop = entry => { if (!entry) return; estimate(entry); entry.stopped = true; entry.agent.stop(); };
  return {
    send(chat, text, options = {}) { (live.get(chat.id)?.agent ?? start(chat, options)).send(text); },
    running: id => live.has(id),
    dir,
    stop(id) { stop(live.get(id)); },
    stopAll() { for (const entry of live.values()) stop(entry); },
  };
}

// chatSpendArgs(chat, usd, billing, estimate) — the agent-cli command recording
// a chat-screen turn against the chat's project (ASS-271): chat:add-spend, with
// --estimate for onEstimate's, the billing left out when its session never said.
export const chatSpendArgs = (chat, usd, billing, estimate = false) =>
  ['chat:add-spend', ...(estimate ? ['--estimate'] : []), chat.project, chat.id, String(usd), ...(billing ? [billing] : [])];
