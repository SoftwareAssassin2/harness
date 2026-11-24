// A project's own Lima folder (ASS-578): project.json's optional lima-home, an
// absolute path where its VMs and golden image live instead of the harness-wide
// folder (machine-lima.js projectLimaHome, agent-cli/lima-home.bash). One that
// isn't an absolute path, or isn't writable (its nearest existing folder: an
// unmounted disk's /Volumes/<name> is not), fails validation: control names it
// in its log, once each time it appears or changes, and that it is fixed; the
// bash commands refuse to touch the project's VMs meanwhile (lima_home fails),
// and the harness-wide views leave it out.
import { limaHomeProblem } from './machine-lima.js';

const PHASE = 'lima-home';

// checkLimaHomes(ctx, state) — each of the state's projects' lima-home checked, its problem logged as it changes.
export function checkLimaHomes(ctx, state) {
  const seen = (ctx.memory.limaHome ??= new Map());
  for (const project of state?.projects ?? []) {
    const home = project.json?.['lima-home'];
    const problem = limaHomeProblem(home);
    const was = seen.get(project.id) ?? null;
    if (problem === was) continue;
    seen.set(project.id, problem);
    if (problem) ctx.log(PHASE, `${project.id}: project.json ${problem}; its Lima VMs and golden image are not touched until it is fixed (an absolute path to a folder that is, or can be made, writable)`);
    else if (was) ctx.log(PHASE, `${project.id}: project.json lima-home ${home == null ? 'unset: its VMs are in the harness-wide Lima folder' : `${JSON.stringify(home)} is usable again`}`);
  }
}
