// ASS-556: a ticket variation's work mode — whether it is built in a worktree or on a full machine. Operator decisions,
// 2026-11-23: as much work as possible runs in worktrees (remote machines first, the Mac last: ASS-553's pool choice),
// without compromising quality; what a worktree cannot catch, the merge request's CI catches (ASS-552: CI checks never
// run locally), and the CI improves over time.
//
// - Choose Where to Work (the shipped grouped-plan and v2-plan, after Review Plan approves the plans): an AI step
//   (prompts/choose-work-mode-grouped) weighs the plan — points, the files and lines it touches, its risk (migrations,
//   auth, billing, infrastructure, security-sensitive paths), whether meaningful tests run without the app stack, the
//   contracts other services or e2e tests depend on, and Hindsight's recall of similar tickets and how their CI went —
//   and answers `work-mode` (worktree or full) with its reasons. Record Where to Work (ticket:choose-work-mode, on the
//   host) then decides (decideWorkMode) and records it on the variation as `work-mode` (below).
// - The project's forced rules override the AI (forcedRules): project.json `work-mode.force-full`, a list of rules
//   each forcing full when it matches — `paths` (globs: a file the plan touches matches one), `min-points` (the
//   ticket's points at least that) — with an optional `why`; and `work-mode.force` (worktree or full) for every
//   ticket. A full-forcing rule beats `force`, which beats the AI. A project that lists no worktree run target (or
//   whose list is still derived from its mode) has nothing to build a worktree on: always full.
// - In worktree mode (run-targets.js candidates' `mode`) every machine step runs on the project's worktree targets,
//   by pool (remote-first), when its list has any — the build steps too, which ASS-554 otherwise keeps off them —
//   and a step flagged `stack: required` in its engine (it needs the running app stack: screenshots of the app, say)
//   is skipped, recorded as skipped (moves.js STACK_SKIPPED, the history's "(skipped: …)"), not failed: it takes no
//   seat and gets no agent (plan.js, dispatch.js), and steps.js passes it by its first exit, as a switched-off step.
//   Unit tests, lint and type checks still run (the build's own steps). In full mode, or with none recorded (a
//   variation planned before ASS-556), nothing changes.
// - One-way escalation to full (ticket:escalate-work-mode <tests|review|ci> "<why>"): tests that cannot run in the
//   worktree (the build and test prompts), a review or security review that flags risk a worktree cannot check
//   (Code Review, Security Review), or the merge request's CI failing for a reason that needs the stack (Address
//   Merge Request Feedback) — each prompt is told so by its {work-mode-rule} (prompt.bash). It moves a worktree
//   variation to full once, recorded with its trigger and why, and logged by control (workModeNews); on a variation
//   already full it changes nothing. Nothing moves it back automatically: a later Choose Where to Work keeps an
//   escalated variation full (decideWorkMode), and only the operator may set worktree again.
// - The operator's override: ticket:set-work-mode <project> <KEY> <var> worktree|full [<why>], and the ticket screen's
//   `w` key (or its Actions tab). An operator's choice is kept by a later Choose Where to Work too.
// - Metrics: the variation's `work-mode` (mode, by, reasons, the AI's own choice, the forced rules that matched, each
//   escalation, its history) and `ci-results` (merge-request:check records each CI run it sees fail at a new head,
//   and each merge request merged — a pass — with the mode at the time). The ticket screen's Details show them; the
//   flow screens' metrics view (S) shows tickets, escalations, CI pass rate, rounds and time by mode
//   (src/tui/metrics.js workModeMetrics). A worktree variation escalated for its CI retains a Hindsight memory of why
//   (ticket:escalate-work-mode ci), which the next Choose Where to Work recalls.
// Every flag and rule is in an engine or a project's config: nothing here names an engine or a project.
//
// The variation's record, project.json's sprint entry:
//   "work-mode": { mode, by (ai | rule | operator | escalation), reasons: [..], at, files: [..],
//                  ai: { mode, reasons, at } | null, forced: [<rule text>..],
//                  escalations: [{ trigger, why, at, step, memory? }], history: [{ mode, by, reasons, at }] }
//   "ci-results": [{ mr, key, head, result (failed | passed), at, mode }]
import { projectRunTargets, isWorktreeTarget } from './run-targets.js';

export const WORK_MODES = ['worktree', 'full'];
export const ESCALATION_TRIGGERS = ['tests', 'review', 'ci'];
// STACK_VALUES — what a step's `stack` may say: required (it needs the running app stack; skipped in worktree mode).
export const STACK_VALUES = ['required'];

// workModeOf(variation) — the variation's recorded mode, worktree or full; null when none is recorded (full's behaviour).
export const workModeOf = variation => (WORK_MODES.includes(variation?.['work-mode']?.mode) ? variation['work-mode'].mode : null);
// stackRequired(step) — the engine flags the step as needing the running app stack.
export const stackRequired = step => step?.stack === 'required';
// skipsForStack(step, variation) — the step is passed, not run, for this variation: it needs the stack, and the
// variation is built in a worktree.
export const skipsForStack = (step, variation) => stackRequired(step) && workModeOf(variation) === 'worktree';

// worktreeCapable(json) — the project can build in a worktree: its own run-targets list (not one derived from its
// mode) names a worktree target.
export function worktreeCapable(json) {
  const project = projectRunTargets(json);
  return !project.derived && project.targets.some(isWorktreeTarget);
}

// stepWorkModeErrors(step) — what is wrong with a step's `stack` (validate.js names the file and step): not one of
// STACK_VALUES; on a step that also asks for a worktree (worktree: true, ASS-554), which a stack step can never use.
export function stepWorkModeErrors(step) {
  const value = step?.stack;
  if (value === undefined) return [];
  if (!STACK_VALUES.includes(value)) return [`stack ${JSON.stringify(value)} is not one of ${STACK_VALUES.join(', ')}`];
  if (step.worktree === true) return ['stack: required is set on a worktree step (worktree: true), which never has the running stack'];
  return [];
}

// projectWorkModeErrors(json) — what is wrong with project.json's `work-mode`, each naming the field: not an object;
// force not worktree or full; force-full not a list; a rule not an object, with neither paths nor min-points, paths
// not a list of non-empty globs, min-points not a positive number, why not text.
export function projectWorkModeErrors(json) {
  const w = json?.['work-mode'];
  if (w === undefined) return [];
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return ['work-mode is not an object'];
  const errors = [];
  if (w.force !== undefined && !WORK_MODES.includes(w.force)) errors.push(`work-mode.force ${JSON.stringify(w.force)} is not one of ${WORK_MODES.join(', ')}`);
  const rules = w['force-full'];
  if (rules !== undefined && !Array.isArray(rules)) errors.push('work-mode.force-full is not a list');
  for (const [i, r] of (Array.isArray(rules) ? rules : []).entries()) {
    const at = `work-mode.force-full[${i}]`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) { errors.push(`${at} is not an object`); continue; }
    if (r.paths === undefined && r['min-points'] === undefined) errors.push(`${at} has neither paths nor min-points`);
    if (r.paths !== undefined && !(Array.isArray(r.paths) && r.paths.length && r.paths.every(p => typeof p === 'string' && p.trim() !== ''))) errors.push(`${at}.paths is not a list of globs`);
    if (r['min-points'] !== undefined && !(typeof r['min-points'] === 'number' && r['min-points'] > 0)) errors.push(`${at}.min-points is not a positive number`);
    if (r.why !== undefined && typeof r.why !== 'string') errors.push(`${at}.why is not text`);
  }
  return errors;
}

// globRegExp(glob) — a path glob as a RegExp over a whole repository-relative path: `**` any run of folders (none
// too, `**/` included), `*` any run within one name, `?` one character of a name; the rest literal.
export function globRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; } }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
// A path as the rules see it: no leading ./ or /.
const clean = path => String(path).trim().replace(/^\.?\//, '');
export const globMatches = (glob, path) => globRegExp(clean(glob)).test(clean(path));

// forcedRules(json, { files, points }) — the project's full-forcing rules that match, each as text (its why, else
// what it matched), in the config's order.
export function forcedRules(json, { files = [], points = null } = {}) {
  const rules = Array.isArray(json?.['work-mode']?.['force-full']) ? json['work-mode']['force-full'] : [];
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const hit = Array.isArray(r.paths) ? files.find(f => r.paths.some(g => typeof g === 'string' && globMatches(g, f))) : undefined;
    const big = typeof r['min-points'] === 'number' && typeof points === 'number' && points >= r['min-points'];
    if (hit === undefined && !big) continue;
    const what = hit !== undefined ? `${hit} matches ${r.paths.join(', ')}` : `${points} points, at least ${r['min-points']}`;
    out.push(typeof r.why === 'string' && r.why.trim() ? `${r.why} (${what})` : `forced full by the project: ${what}`);
  }
  return out;
}

// planFiles(text) — the repository paths a plan names: words with a folder and a name, or a name with an extension
// (`src/a.js`, migrations/001_x.sql, README.md), unquoted from backticks; each once, in order.
export function planFiles(text) {
  const out = new Set();
  for (const [, word] of String(text ?? '').matchAll(/(?:^|[\s`'"(\[])((?:[\w@.-]+\/)+[\w@.-]+|[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'"),:;\]])/gm)) {
    const path = word.replace(/[.,]+$/, '');
    if (/^https?:|^\d+(\.\d+)+$/.test(path) || /-[A-Z]\.(?:md|json|txt)$/.test(path)) continue;   // a URL, a version, a variation's work file
    out.add(path);
  }
  return [...out];
}

// decideWorkMode({ ai, files, points, json, current, now }) — the mode Record Where to Work records: { mode, by,
// reasons, forced, kept } — in this order:
//   the project cannot build in a worktree (worktreeCapable): full, by rule;
//   the variation was escalated (any escalation, or its mode by escalation): full kept — never back automatically;
//   the operator set it: the operator's mode kept;
//   a full-forcing rule matches (forcedRules): full, by rule, the rules its reasons;
//   the project forces one mode (work-mode.force): that, by rule;
//   the AI's mode, worktree or full, with its reasons;
//   none given: full, by rule ("no valid mode from the AI").
// `ai` is { mode, reasons } from the AI step's output; the caller records it beside the decision either way.
export function decideWorkMode({ ai = {}, files = [], points = null, json = {}, current = null } = {}) {
  const forced = forcedRules(json, { files, points });
  if (!worktreeCapable(json)) return { mode: 'full', by: 'rule', reasons: ['the project lists no worktree run target (dev-environments.run-targets)'], forced };
  if ((current?.escalations ?? []).length || current?.by === 'escalation') return { mode: 'full', by: 'escalation', reasons: ['escalated to full earlier; never back to a worktree automatically', ...(current?.reasons ?? [])], forced, kept: true };
  if (current?.by === 'operator' && WORK_MODES.includes(current.mode)) return { mode: current.mode, by: 'operator', reasons: current.reasons ?? [], forced, kept: true };
  if (forced.length) return { mode: 'full', by: 'rule', reasons: forced, forced };
  const force = json?.['work-mode']?.force;
  if (WORK_MODES.includes(force)) return { mode: force, by: 'rule', reasons: [`the project forces ${force} (work-mode.force)`], forced };
  if (WORK_MODES.includes(ai?.mode)) return { mode: ai.mode, by: 'ai', reasons: asReasons(ai.reasons), forced };
  return { mode: 'full', by: 'rule', reasons: ['no valid work mode from Choose Where to Work; full by default'], forced };
}
// asReasons(value) — reasons as a list of text: a list kept (its text items), a string one item, else none.
export const asReasons = value => (Array.isArray(value) ? value.filter(r => typeof r === 'string' && r.trim()).map(String) : typeof value === 'string' && value.trim() ? [value] : []);

// workModeNews(variation) — the variation's latest work-mode change to log, { key (its own, to log once), text },
// or null with none.
export function workModeNews(variation) {
  const w = variation?.['work-mode'];
  const last = Array.isArray(w?.history) ? w.history.at(-1) : null;
  if (!last || !WORK_MODES.includes(last.mode)) return null;
  const reasons = asReasons(last.reasons);
  const verb = last.by === 'escalation' ? `escalated to ${last.mode}${last.trigger ? ` (${last.trigger})` : ''}` : `work mode ${last.mode} (by ${last.by ?? 'ai'})`;
  return { key: `${last.at ?? ''}/${w.history.length}`, text: `${verb}${reasons.length ? `: ${reasons.join('; ')}` : ''}` };
}
