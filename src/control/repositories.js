// Where a prompt step runs among its project's repositories (ASS-119): a step
// with `run-in-repository` "<name>" works in that one repository —
// project.json repositories[], named by its url's last segment — and one with
// "each" once in each repository the ticket's planned merge requests touch
// (ticket:merge-request-plan, ASS-80), one after another, its agent in that
// repository alone. A step with neither runs where it always has.

export const EACH = 'each';

// repositoryName(url) — a repository's name: its url's last segment, without .git.
export const repositoryName = url => url.replace(/\.git$/, '').split('/').pop();

// touchedRepositories(variation) — the names of the repositories the
// variation's planned merge requests are in, each once, in plan order; the
// id-less entries of the array, which name no repository (ASS-321), are
// passed over.
export const touchedRepositories = variation => [...new Set((variation?.['merge-request'] ?? []).filter(m => m?.repository != null).map(m => repositoryName(m.repository)))];

// visitOf(place) — one visit of a step, whose per-repository runs are counted
// together: a run's (by its id, state and moves so far) or a ticket
// variation's (its project, key, name, state and changes at its level) —
// `place` as finish.js placeOf gives it, { run, project, ticket, variation, changes }.
export const visitOf = ({ run, project, ticket, variation, changes = [] }) =>
  (run ? `run/${run.id}/${run.state}` : `${project.id}/${ticket.key}/${variation.name}/${variation['harness-status']?.state}`) + `/${changes.length}`;

// passed(memory, visit) — the repositories whose runs passed on the visit, kept in memory.
const passed = (memory, visit) => (memory.repositories ??= new Map()).get(visit) ?? [];

// nextRepository(memory, step, variation, visit) — where the step's next run
// works: null for a step that declares no repository; { repository } — the
// one it names, or for "each" the first the variation touches
// (touchedRepositories) whose run has not passed on this visit; { skip: true }
// for "each" when the variation touches none.
export function nextRepository(memory, step, variation, visit) {
  const named = step?.['run-in-repository'];
  if (!named) return null;
  if (named !== EACH) return { repository: named };
  const touched = touchedRepositories(variation);
  if (!touched.length) return { skip: true };
  const done = passed(memory, visit);
  return { repository: touched.find(r => !done.includes(r)) ?? touched.at(-1) };
}

// anotherRepository(memory, step, variation, visit, repository, exit) — for
// an "each" step whose run in `repository` took `exit`: when that run passed
// — the exit is the step's first, its pass — and another touched repository
// has yet to run, that repository's name, the run remembered as passed and
// the step staying where it is. Otherwise null, and the visit forgotten: the
// step moves by the exit — the last run's pass, or any run's failure, which
// the later repositories' runs never reach.
export function anotherRepository(memory, step, variation, visit, repository, exit) {
  if (step?.['run-in-repository'] !== EACH || !repository) return null;
  const done = [...passed(memory, visit), repository];
  const following = exit && exit === step['exit-events']?.[0] ? touchedRepositories(variation).find(r => !done.includes(r)) : undefined;
  if (following) memory.repositories.set(visit, done);
  else memory.repositories.delete(visit);
  return following ?? null;
}
