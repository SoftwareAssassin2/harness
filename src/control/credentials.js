// The credentials check (ASS-395): missing credentials found once, up front,
// for the whole project, rather than by its tickets blocking one by one.
// At control's first tick and then every CREDENTIALS_EVERY per project,
// project:check-credentials checks every credential the project is declared
// to need — its ~/.harness/vm-credentials.json keychain items, the host's gh
// or glab login its repositories need, the gcloud/glab logins
// check-for-expired-<tool>-auth has control probe (triggers.js), its Claude
// account (dispatch.js accountHold) — and records the hold in
// credentials-hold.json while any fails ({ since, problems: [{ credential,
// problem, fix }] }), removing it once none does. While the hold is on
// (credentialsHeld, from the record, so every control and the dashboard read
// the same) the project's new work waits: dispatch.js starts none of its
// agents — sprint, backlog grooming or runs — and steps.js runs no script step
// that sets up a VM or golden image (setupWaits); agents already running
// finish their turns. It lifts by itself when a check passes again. The hold's
// start, its problems' changes and its end are logged under "hold"; a check
// that cannot be run is logged once per failure streak, the record standing.
// Off with CREDENTIALS_CHECK_DISABLED=1 (the test fixtures' env, so a test's
// control never reads the real keychain or forge logins).
const CREDENTIALS_EVERY = 3 * 60e3;
const PHASE = 'hold';

// credentialsHeld(project) — its hold ({ since, problems }), null when none.
export const credentialsHeld = project => (project?.credentialsHold?.problems?.length ? project.credentialsHold : null);

// problemText(problem) — one problem as the log and the dashboard say it.
export const problemText = p => `${p.credential}: ${p.problem} — fix: ${p.fix}`;

// checkCredentials(ctx, state) — each project's check, when due; its changes logged.
export async function checkCredentials(ctx, state) {
  if (ctx.env.CREDENTIALS_CHECK_DISABLED === '1') return;
  const memory = (ctx.memory.credentials ??= new Map());
  const now = ctx.now().getTime();
  for (const project of state.projects) {
    const seen = memory.get(project.id);
    if (seen && now - seen.at < CREDENTIALS_EVERY) continue;
    const was = seen?.problems ?? credentialsHeld(project)?.problems ?? [];
    let out;
    try {
      out = JSON.parse(await ctx.cli(['project:check-credentials', project.id]));
    } catch (error) {
      if (!seen?.failing) ctx.log('error', `credentials ${project.id}: ${error.message}; the last record stands`);
      memory.set(project.id, { at: now, problems: was, failing: true });
      continue;
    }
    const problems = out.problems ?? [];
    memory.set(project.id, { at: now, problems, failing: false });
    if (JSON.stringify(problems) === JSON.stringify(was) && seen) continue;
    if (problems.length) ctx.log(PHASE, `${project.id} blocked by credentials: none of its agents or VM setups start until they pass; running agents finish their turns — ${problems.map(problemText).join('; ')}`);
    else if (was.length) ctx.log(PHASE, `${project.id}'s credentials pass again: the hold is lifted, its work resumes`);
  }
}
