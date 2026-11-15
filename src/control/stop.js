// How control stops what it started (ASS-460: moved from main.js, so a crash
// stops it the same way a normal shut-down does). See main.js.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// stopStarted(ctx, say, graceMs) — every script step's command still running
// stopped, its group SIGTERMed (ASS-328: run in the background, a step's
// script may still be running; the next control runs it again, so the two
// never run at once); every agent's group SIGTERMed, given up to `graceMs`
// (5 seconds) to end, the rest SIGKILLed, each logged.
export async function stopStarted(ctx, say, graceMs = 5000) {
  if (ctx.scripts.size) {
    say('shutdown', `stopping ${ctx.scripts.size} script${ctx.scripts.size === 1 ? '' : 's'}; their steps run them again when control starts`);
    ctx.stopScripts();
  }
  if (!ctx.agents.size) return;
  say('shutdown', `stopping ${ctx.agents.size} agent${ctx.agents.size === 1 ? '' : 's'}`);
  ctx.stopAgents();
  for (const end = Date.now() + graceMs; Date.now() < end && [...ctx.agents.values()].some(l => !l.exited);) await pause(100);
  for (const live of ctx.agents.values()) {
    if (live.exited) continue;
    try { process.kill(-live.agent.pid, 'SIGKILL'); } catch { /* gone */ }
    say('shutdown', `${live.name} killed`);
  }
}

// killStarted(ctx) — the last resort, synchronous, for process 'exit' (an
// exit no shut-down ran before, or an agent started while one ran): every
// agent's and script's group still running SIGKILLed, so none is left behind.
export function killStarted(ctx) {
  for (const live of ctx.agents.values()) if (!live.exited) try { process.kill(-live.agent.pid, 'SIGKILL'); } catch { /* gone */ }
  for (const child of ctx.scripts) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
}
