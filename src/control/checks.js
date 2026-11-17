// ASS-493: a step's `script-succeeds` exit conditions, asked without blocking
// control. The exits are evaluated synchronously (engine.js), so the command a
// condition names (its placeholders filled, facts.js ticketFacts) is run in the
// background (ctx.succeeds, cli.js scriptSucceeds) and the evaluation that
// asked reads its answer once it has come:
// - an evaluation is the one reading of a step's exits — a ticket's or run's
//   step on a visit (steps.js), an agent's turn ending (finish.js) — named by
//   the key its facts carry (facts.checks.evaluation);
// - askCheck answers from that evaluation's results; one not there yet is
//   started, and while it runs the evaluation is held (facts.checks.pending):
//   no later script-succeeds of it starts another command (it would not have
//   been asked had this one said yes), and its caller leaves the variation or
//   run where it is (heldByChecks), its step neither moved nor run again — a
//   later tick evaluates the exits anew, reading the answer, in the same order;
// - a command and VM already running is never started again, whichever
//   evaluation started it: one for another evaluation is waited for, then run
//   for this one;
// - within an evaluation each filled command runs once (X and NOT X share its
//   answer), and an evaluation done — not held — forgets its answers, so the
//   next reading of those exits (a new turn ending, a new script exit, the next
//   tick's look at a waiting step) runs the command again. Answers an
//   evaluation never came back for (its variation moved meanwhile) are dropped
//   after FORGET_MS.
// Kept in ctx.memory: checks, evaluation → { results: command key → yes or
// no, at }; checking, command key → { evaluation it runs for, done: settled
// once its answer is kept }.
const FORGET_MS = 60 * 60_000;

// commandKey(argv, vm) — a filled command and the VM it runs in, as one key.
const commandKey = (argv, vm) => JSON.stringify([vm ?? null, ...argv]);

// askCheck(ctx, evaluation, argv, vm, who) — the command's yes or no for the
// evaluation, or undefined while it runs (started here when it is not; see
// the module comment). `who` names the ticket and variation in its logs. A
// ctx.succeeds that answers at once (a test's) is answered at once.
export function askCheck(ctx, evaluation, argv, vm, who) {
  const memory = (ctx.memory ??= {}), checks = (memory.checks ??= new Map()), checking = (memory.checking ??= new Map());
  const key = commandKey(argv, vm), mine = checks.get(evaluation);
  if (mine?.results.has(key)) return mine.results.get(key);
  if (checking.has(key)) return undefined;
  const now = Date.now();
  for (const [name, entry] of checks) if (now - entry.at > FORGET_MS) checks.delete(name);
  const keep = ok => {
    const entry = checks.get(evaluation) ?? { results: new Map() };
    entry.at = Date.now();
    entry.results.set(key, ok === true);
    checks.set(evaluation, entry);
    return ok === true;
  };
  let answer;
  try { answer = ctx.succeeds(argv, vm, who); } catch (error) { ctx.log('error', `script-succeeds check ${argv.join(' ')} (${who}): ${error.message}`); return keep(false); }
  if (typeof answer?.then !== 'function') return keep(answer);
  const done = answer.then(keep, error => { ctx.log('error', `script-succeeds check ${argv.join(' ')} (${who}): ${error.message}`); keep(false); })
    .finally(() => checking.delete(key));
  checking.set(key, { evaluation, done });
  return undefined;
}

// heldByChecks(ctx, facts) — whether the evaluation just made from `facts`
// asked a check still running, and so must be left (its caller moves nothing,
// the step stays); else the evaluation is done and its answers forgotten.
export function heldByChecks(ctx, facts) {
  const checks = facts?.checks;
  if (!checks) return false;
  if (checks.pending) return true;
  ctx.memory?.checks?.delete(checks.evaluation);
  return false;
}
