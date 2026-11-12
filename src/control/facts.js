// The facts a step's exit conditions are evaluated against (see engine.js
// evaluateCondition), gathered for a ticket variation or a state engine run.
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillArgs } from './placeholders.js';
import { harnessProject, isHarnessProject } from './harness-project.js';

// A command's placeholders for a ticket's step; {merge-request-ids} - (every one: no run names a set, ASS-365).
export const ticketValues = (project, ticket, variation) => ({ ticket: ticket.key, project: project.id, variation: variation.name, 'merge-request-ids': '-' });

// runValues(run, context) — a command's placeholders for a run's step:
// {ticket} the key a create-ticket engine returned (the fix ticket) or else
// the ticket it works for (see moves.js contextOf), {work-item} that ticket
// it works for whichever the fix ticket is, {variation} that one's; {summary},
// {ticket-url}, {pause-tickets} (comma-separated), {human-action} and
// {missing-repository} (the url Blocked's Troubleshoot named, ASS-121) from
// its structured-output, - when it has none; {failing-repository} and
// {failing-job} the failing check Troubleshoot named (ASS-163, for
// project:check-on-master), - when none; {no-ticket-reason} and
// {no-ticket-why} why create-ticket-grouped's write-ticket ended with an
// empty key (ASS-316), - when none; {merge-request-ids} the merge requests
// the run works on (ASS-365: grouped-merge's set, its output's
// merge-request-ids, which grouped-build's Merge the Awaited hands it through
// pass-output) comma-separated, - (every one) when none; {fix-merge-request}
// the fix merge request grouped-blocked's Repair Project opened (ASS-390, its
// url), - when none; {project}; {run} its id.
export function runValues(run, context) {
  const output = run['structured-output'] ?? {};
  const ids = Array.isArray(output['merge-request-ids']) ? output['merge-request-ids'].filter(Number.isInteger) : [];
  return {
    ticket: output.key || context.workItem, 'work-item': context.workItem, variation: context.variation, summary: output.summary, 'ticket-url': output.url ?? '-', project: run.project,
    'pause-tickets': (output['pause-tickets'] ?? []).join(',') || '-', 'human-action': output['human-action'] || '-', 'missing-repository': output['missing-repository'] || '-',
    'failing-repository': output['failing-repository'] || '-', 'failing-job': output['failing-job'] || '-', 'no-ticket-reason': output['no-ticket-reason'] || '-', 'no-ticket-why': output.why || '-',
    'merge-request-ids': ids.join(',') || '-', 'fix-merge-request': output['fix-merge-request'] || '-', run: run.id,
  };
}

// ticketOf(run, transient) — the ticket a run works for: the key a
// create-ticket step returned (the fix ticket), nearest up its parents, else
// the work item of a ticket step up them (see moves.js contextOf); undefined
// when neither.
export function ticketOf(run, transient) {
  let workItem;
  for (let r = run, seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    if (r['structured-output']?.key) return r['structured-output'].key;
    workItem ??= r.parent?.['work-item'] ?? undefined;
  }
  return workItem;
}

const CAUSE_IN = {
  harness: 'the harness',
  project: 'the project',
  operator: 'the operator\'s own machine (not the harness, not the project)',
};

// blocks(value) — what an analysis says is blocked: the ticket keys a
// self-healing analysis lists, but plain true/false from assess-health
// (prompts/assess-health/prompt.json), which names no ticket; '' for neither.
const blocks = value => (Array.isArray(value) ? value.join(', ') : (value ? 'sprint tickets' : ''));

// fixTicketIn(issue, project, harness) — where the fix ticket for an issue
// classified harness, project or environment (prompts/classify-issue) goes
// (ASS-107): a project issue to `project`'s own ticket system; a harness or
// environment one to the harness project's backlog (an environment issue is
// ticketed only by a health check: Blocked repairs it, or hands it to a
// human). On the harness project the two are one place (AC3). As { project,
// where }; undefined with no issue, or no harness project named.
export function fixTicketIn(issue, project, harness) {
  if (!issue || issue === 'dependency') return undefined;   // ASS-390: a dependency is waited on at Build's Await Sequential Merge, never ticketed
  if (issue === 'project' && !isHarnessProject(harness, project)) return { project, where: 'its own ticket system' };
  const home = harnessProject(harness);
  return home ? { project: home, where: 'the harness project\'s backlog' } : undefined;
}

// ASS-390: a dependency — the block only waits for one of the ticket's own dependency merge requests to merge.
const ISSUE = { harness: 'a harness issue', project: 'a project issue', environment: 'an environment issue', dependency: 'a wait for a dependency merge request' };

// What grouped-blocked's Check on the Latest Master answered (ASS-163,
// project:check-on-master's on-master), for the prompts after it: present
// raises the project bug with that evidence; absent and unknown raise
// nothing — so no "Raise the fix ticket in" either.
const ON_MASTER = {
  present: e => `On the latest master: present — ${e}`,
  // ASS-390: the obstacle's fix is Repair Project's, in a separate fix merge request, never the ticket's own branch.
  absent: e => `Not on the latest master: ${e} — no project bug; fix the obstacle here, in a separate fix merge request (Repair Project), never the ticket's own branch`,
  unknown: e => `Not proven on the latest master: ${e} — no project bug raised`,
};

// problemOf(run, transient, context) — the {problem} a run's ticket prompts are given:
// the nearest analysis (a structured-output with a summary) up the run's
// parents — a create-ticket run has none of its own; its self-healing parent
// does — each field spelled out, one per line, and, once it is classified,
// where its fix ticket goes for the ticket's project (fixTicketIn; context
// { harness: harness.json, project: the ticket's project, the run's own
// when not given }); then context.history (blockHistory), after a blank
// line, alone when there is no analysis; - when there is neither.
export function problemOf(run, transient, { harness, project = run.project, history = '' } = {}) {
  const analysis = analysisOf(run, transient, harness, project);
  return [analysis, history].filter(Boolean).join('\n\n') || '-';
}

function analysisOf(run, transient, harness, project) {
  for (let r = run, seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    const a = r['structured-output'];
    if (!a?.summary) continue;
    const evidence = a.evidence ?? [], onMaster = ON_MASTER[a['on-master']];
    const fix = ['absent', 'unknown'].includes(a['on-master']) ? undefined : fixTicketIn(a.issue, project, harness);
    return [
      `Summary: ${a.summary}`,
      ...(a['root-cause'] ? [`Root cause: ${a['root-cause']}`] : []),
      ...(a['cause-in'] ? [`Cause is in: ${CAUSE_IN[a['cause-in']] ?? a['cause-in']}`] : []),
      // A repository the work needs that the project lacks (ASS-121): grouped-blocked's Repair adds it, so Classify's environment.
      ...(a['missing-repository'] ? [`Missing repository: ${a['missing-repository']} — the project does not list it: an environment issue, which Repair Environment adds when the harness can access it`] : []),
      ...(a['failing-job'] ? [`Failing check: ${a['failing-repository'] ?? '?'} job ${a['failing-job']}${a['failing-assertion'] ? ` — ${a['failing-assertion']}` : ''}`] : []),
      ...(evidence.length ? ['Evidence:', ...evidence.map(e => `- ${e}`)] : ['Evidence: none recorded']),
      `Blocks: ${blocks(a['blocks-tickets']) || 'no ticket shown to be blocked'}`,
      `Needs the operator: ${a['needs-human'] ? `yes — ${a['human-action']}` : 'no'}`,
      `Fixing it interrupts agent work: ${a['must-interrupt-work'] ? 'yes' : 'no'}`,
      `The top ticket can go on without the fix: ${a['can-continue-without-fix'] ? 'yes' : 'no'}`,
      `Tickets to pause for the fix: ${(a['pause-tickets'] ?? []).join(', ') || 'none'}`,
      ...(a.issue ? [`Classified: ${ISSUE[a.issue] ?? a.issue} — ${a.reasoning ?? ''}`] : []),
      ...(onMaster ? [onMaster(a['master-evidence'] ?? 'no evidence recorded')] : []),
      ...(fix ? [`Raise the fix ticket in: project ${fix.project} — ${fix.where}`] : []),
    ].join('\n');
  }
  return '';
}

// since(variation) — when the variation arrived at its state: its latest
// state change's timestamp, or nothing when it has none.
const arrived = variation => variation['state-changes']?.at(-1)?.timestamp;
// fresh(record, variation) — a human's record ({ timestamp }) made since the
// variation arrived at its state, else undefined: an earlier visit's choice
// does not decide this one.
const fresh = (record, variation) => (record && !(arrived(variation) > record.timestamp) ? record : undefined);

// ticketFacts(ctx, project, ticket, variation, since, vm) — the facts about a
// variation: ticketSystemStatus, humanReview and selectedVariation (each
// only when made since the variation arrived at its state, see fresh),
// variationCount (not deleted), variation; fileUpdated(file), whether
// data/projects/<project>/work/<ticket>/<file> was written after `since` (ms) —
// its {variation}, {ticket} and {project} filled — the variation's own: a
// file naming no {variation} is read as work:write writes it, -<variation>
// before its extension (ASS-181: execution-plan.md is A's
// execution-plan-A.md; no fallback to the unsuffixed one), one naming it as
// filled (ASS-118: explanation-{variation}.md);
// scriptSucceeds(command), whether the command, its placeholders filled,
// exits 0 (false, logged, when one cannot be filled) — run in the VM `vm`
// when given (a run-location: vm step's, ASS-74); questions(), the ticket's
// (questionsOf, ASS-144); fastTracked, whether the ticket is (ASS-83's
// fast-track: true; ASS-151).
export function ticketFacts(ctx, project, ticket, variation, since, vm) {
  return {
    questions: () => questionsOf(ctx, project.id, ticket.key),
    ticketSystemStatus: ticket['ticket-system-status'],
    fastTracked: ticket['fast-track'] === true,
    humanReview: fresh(variation['human-review'], variation),
    selectedVariation: fresh(ticket['selected-variation'], variation),
    variationCount: (ticket.variations ?? []).filter(v => !v['is-deleted']).length,
    variation,
    fileUpdated: file => {
      const own = file.includes('{variation}') ? file : file.replace(/(\.[^.]*)?$/, '-{variation}$1');
      try { return statSync(join(ctx.paths.projects, project.id, 'work', ticket.key, fillArgs(own, ticketValues(project, ticket, variation)).join(' '))).mtimeMs > since; } catch { return false; }
    },
    scriptSucceeds: command => {
      try { return ctx.succeeds(fillArgs(command, ticketValues(project, ticket, variation)), vm); } catch (error) { ctx.log('facts', `${ticket.key} ${variation.name}: ${error.message}`); return false; }
    },
  };
}

// blockHistory(variation) — what Blocked's prompts learn from (ASS-107,
// operator 2026-10-24): every entry into Blocked anew in the variation's
// state-changes, counted by the step it came from (cameFrom), a step it
// came from again and again called out; and each Blocked run it kept
// (`blocks`, the development engines' append-output-to), oldest first —
// where it came from, what it found, the issue, how it ended (resumed, and
// so blocked again, or not). '' for a variation with no run kept: one
// never blocked, or only by an engine that keeps none (the current ones).
const ENDED = {
  // ASS-384: a run that sent the ticket back to fix its own branch (ticket:own-branch-fix).
  // ASS-390: one whose check passed on re-check, whose fix merge request merged, or sent to wait for its dependency.
  done: b => `${b['recheck-passed'] === true ? 'passed on re-check, nothing to fix' : b['needs-fix'] === false ? 'nothing wrong found'
    : b['awaits-dependency'] === true ? `only waiting for its dependency merge request (${b.dependency?.key ?? b.dependency?.url ?? '?'}): sent to Await Sequential Merge`
    : b['fix-merge-request'] && b.landed === true ? `its fix merge request ${b['fix-merge-request']} merged`
    : b['own-branch-fix'] === true ? `the failure was in its own branch (${b['failing-file'] ?? '?'}): sent back to fix it there, at ${b['resume-at'] ?? 'the step it blocked at'}` : b.remediated ? `repaired in place (${b['ai-feedback-short'] ?? 'no note'})` : b.key ? `fix ticket ${b.key} landed` : 'left Blocked'}, resumed — blocked again`,
  retry: b => `fix ticket ${b.key ?? '?'} closed unmerged`,
  'blocked-for-human': b => `handed to the operator (${b['ai-feedback-short'] ?? 'no note'})`,
};
export function blockHistory(variation) {
  const changes = variation?.['state-changes'] ?? [];
  const entries = changes.flatMap((c, i) => (!c['sub-state-change'] && c['to-state'] === 'blocked' && c['from-state'] !== 'blocked' ? [cameFrom({ 'state-changes': changes.slice(0, i + 1) }, 'blocked') ?? '?'] : []));
  const kept = (variation?.blocks ?? []).filter(b => b && typeof b === 'object');
  if (!kept.length) return '';
  const counts = Object.entries(Object.groupBy(entries, e => e)).map(([at, list]) => `${list.length} at ${at}${list.length > 1 ? ' — the same step again and again' : ''}`);
  return [
    'Earlier blocks of this ticket (oldest first). Learn from them: a fix that did not hold at a step was not the real fix — find the deeper cause; never repeat what already failed.',
    `Entered Blocked ${entries.length} time${entries.length === 1 ? '' : 's'} (this stay included): ${counts.join('; ') || 'not recorded'}.`,
    ...kept.map(b => `- ${b.timestamp ?? '?'}, from ${b['came-from'] ?? '?'}: ${b.summary ?? 'no analysis'}.${b['root-cause'] ? ` Cause: ${b['root-cause']}.` : ''}${b.issue ? ` Issue: ${b.issue} — ${b.reasoning ?? ''}.` : ''} Ended: ${(ENDED[b['ended-at']] ?? (() => b['ended-at'] ?? '?'))(b)}.`),
  ].join('\n');
}

// cameFrom(variation, stateId) — the step the variation entered `stateId`
// from: the from-state of its latest top-level change into it, and beneath
// it, "/"-joined, the detailed step it was at there (the deepest to-state of
// the latest change within that state before it, ASS-67); undefined when its
// history does not say.
export function cameFrom(variation, stateId) {
  const changes = variation?.['state-changes'] ?? [];
  const at = changes.findLastIndex(c => !c['sub-state-change'] && c['to-state'] === stateId && c['from-state'] !== stateId);
  if (at < 0 || changes[at]['from-state'] == null) return undefined;
  const from = changes[at]['from-state'];
  const within = changes.slice(0, at).findLast(c => c['sub-state-change'] && c['to-state'] === from);
  const path = [from];
  for (let s = within?.['sub-state-change']; s; s = s['sub-state-change']) path.push(s['to-state']);
  return path.join('/');
}

// parseOutput(stdout) — a script's stdout as JSON when it parses, else undefined.
export function parseOutput(stdout) {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

// questionsOf(ctx, project, key) — the ticket's questions (its
// work/<key>/questions-and-answers.json's list), none for no file or one that
// does not parse.
export function questionsOf(ctx, project, key) {
  try { return JSON.parse(readFileSync(join(ctx.paths.projects, project, 'work', key, 'questions-and-answers.json'), 'utf8')).list ?? []; } catch { return []; }
}
