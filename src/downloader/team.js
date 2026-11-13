// The downloader's team step (ASS-409): once a cycle, after the analytics
// syncs, cycle.js step 5d hands the project's team to `team:update
// <project>` (src/agent-cli/team/update.sh), which works it out from the
// analytics files and writes team.json under its lock. This module writes
// nothing itself; main.js passes it to runCycle as adapters.team.

// The last team:update failure logged, by projects folder and project: logged
// once, until the reason changes.
const notes = new Map();

// updateTeam({ key, project, call, log }) — key the project's folder; call
// cycle.js's agent.sh call; log takes a line. Each line team:update prints (a
// member added or linked) is logged. A failure is logged, never thrown: the
// cycle goes on.
export async function updateTeam({ key, project, call, log }) {
  try {
    const out = await call(['team:update', project]);
    for (const line of String(out ?? '').split('\n')) if (line.trim()) log(line.trim());
    notes.delete(key);
  } catch (err) {
    const text = `team: team.json not updated: ${String(err?.message ?? err).split('\n')[0]}`;
    if (notes.get(key) !== text) log(text);
    notes.set(key, text);
  }
}
