// What Human Review shows on the ticket screen (ASS-118): the variation's
// plain-language explanation, its risk profile, every merge request linked
// with its screenshots, the test failures master has too, and its demo —
// read from the ticket's folder (loadReviews) and laid out (reviewLines).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { link, wrap } from './text.js';
import { isPlanned, mrStatus } from './status.js';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const isDir = path => existsSync(path) && statSync(path).isDirectory();
const read = path => readFileSync(path, 'utf8');
// The documents the ticket screen's panel links (ASS-261), in order, each
// [file name stem, label]: <stem>-<V>.md, or <stem>.md (the flat engines').
// A variation's name has no hyphen, so root-cause-analysis-review-A.md is no plan.
const DOCUMENTS = [['execution-plan', 'Execution plan'], ['test-plan', 'Test plan'], ['root-cause-analysis', 'Root cause analysis'], ['risk-assessment', 'Risk assessment']];
const DOCUMENT = new RegExp(`^(${DOCUMENTS.map(([stem]) => stem).join('|')})(-[^-]+)?\\.md$`);

// preExistingFailures(results) — the failures automated-tests:verify-success
// (ASS-99) named in automated-test-results-<variation>.md as failing on
// master too: each "- <name>" under a "Pre-existing failures" line, in order.
export function preExistingFailures(results) {
  return [...results.matchAll(/^Pre-existing failures, failing on master too:\n((?:- .*\n?)+)/gm)]
    .flatMap(m => m[1].trimEnd().split('\n').map(line => line.slice(2)));
}

// loadReviews(projectDir) — each ticket folder's review, by key: { explanations,
// risks, preExisting } by variation — explanation-<V>.md (Explain the
// Change), risk-assessment-<V>.md (the grouped Risk Assessment; '' the
// ticket's risk-assessment.md, the current engines'), the pre-existing
// failures of automated-test-results-<V>.md — and screenshots, the image
// files of screenshots/<id>/ by merge request id ('' screenshots/ itself,
// the ticket's own), as paths; and split, its split-proposal.json (ASS-252,
// ticket:propose-split), when it reads as JSON; and documents, the paths of
// its plans, root cause analysis and risk assessment by file name (ASS-261,
// see ticketDocuments), from the listing already made, nothing more read. A
// folder with none of these has no review.
export function loadReviews(projectDir) {
  const work = resolve(projectDir, 'work');
  const reviews = {};
  for (const key of isDir(work) ? readdirSync(work).toSorted() : []) {
    const folder = join(work, key);
    if (!isDir(folder)) continue;
    const review = { explanations: {}, risks: {}, preExisting: {}, screenshots: {}, documents: {} };
    for (const file of readdirSync(folder).toSorted()) {
      if (DOCUMENT.test(file)) review.documents[file] = join(folder, file);
      const [, kind, variation] = /^(explanation|risk-assessment|automated-test-results)(?:-(.+))?\.md$/.exec(file) ?? [];
      if (kind === 'explanation' && variation) review.explanations[variation] = read(join(folder, file));
      else if (kind === 'risk-assessment') review.risks[variation ?? ''] = read(join(folder, file));
      else if (kind === 'automated-test-results' && variation) review.preExisting[variation] = preExistingFailures(read(join(folder, file)));
    }
    if (existsSync(join(folder, 'split-proposal.json'))) {
      try { review.split = JSON.parse(read(join(folder, 'split-proposal.json'))); } catch { /* half written or broken: none */ }
    }
    const shots = join(folder, 'screenshots');
    const images = dir => readdirSync(dir).toSorted().filter(f => IMAGE.test(f)).map(f => join(dir, f));
    if (isDir(shots)) {
      if (images(shots).length) review.screenshots[''] = images(shots);
      for (const id of readdirSync(shots).toSorted().filter(d => isDir(join(shots, d)))) if (images(join(shots, id)).length) review.screenshots[id] = images(join(shots, id));
    }
    if (Object.values(review).some(part => Object.keys(part ?? {}).length)) reviews[key] = review;
  }
  return reviews;
}

// riskLevel(text) — a risk assessment's level, Low, Medium or High (ASS-261):
// the grouped prompt's fixed **Risk: <level>** line, first after the title;
// in an older file without it, the verdict line there when it names exactly
// one of low, medium and high as a whole word ("LOW-MODERATE" names none).
// null otherwise.
export function riskLevel(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const first = lines[0]?.startsWith('# ') ? lines[1] : lines[0];
  if (!first) return null;
  const fixed = /^\*\*Risk: (Low|Medium|High)\*\*$/.exec(first);
  if (fixed) return fixed[1];
  const named = new Set([...first.matchAll(/(?<![\w-])(low|medium|high)(?![\w-])/gi)].map(m => m[1].toLowerCase()));
  return named.size === 1 ? [...named][0].replace(/^./, c => c.toUpperCase()) : null;
}

// ticketDocuments(t, review) — ticket `t`'s variation's documents for the
// ticket screen's panel (ASS-261), from its `review` (loadReviews'): links,
// each { label, path } in DOCUMENTS' order — the variation's own file, else
// the un-suffixed one, only those there — and risk, riskLevel of the risk
// assessment linked. null with none.
export function ticketDocuments(t, review) {
  const files = review?.documents ?? {};
  const name = t.variation?.name;
  const links = DOCUMENTS.map(([stem, label]) => ({ label, path: (name && files[`${stem}-${name}.md`]) || files[`${stem}.md`] })).filter(d => d.path);
  if (!links.length) return null;
  const risks = review.risks ?? {};
  return { links, risk: riskLevel((name && risks[name]) ?? risks['']) };
}

// reviewLines(review, { variation, mrs, demo, width }) — the review at Human
// Review, `width` wide, under the Actions tab's choices (ASS-184): the explanation and the risk profile as written,
// each merge request created (not one only planned) linked with its status
// and its screenshots beneath, each linked to its file, then the ticket's
// own; the pre-existing test failures; and the demo — its Demo action, or
// that there is none and why. `review` is loadReviews' for the ticket (or
// undefined), `demo` the variation's demo plan (or undefined).
export function reviewLines(review, { variation, mrs = [], demo, width }) {
  const indent = (text, by = 2) => wrap(text, width - by).map(line => `${' '.repeat(by)}${line}`);
  const text = (value, missing) => (value ? value.trimEnd().split('\n').flatMap(line => (line ? indent(line) : [''])) : [`  ${missing}`]);
  const shot = path => `      screenshot ${link(basename(path), pathToFileURL(path).href)}`;
  const shots = review?.screenshots ?? {};
  const created = mrs.filter(m => !isPlanned(m));
  const failures = review?.preExisting?.[variation];
  return [
    'Explanation', ...text(review?.explanations?.[variation], 'none yet: Explain the Change has not written it'),
    '', 'Risk profile', ...text(review?.risks?.[variation] ?? review?.risks?.[''], 'none yet: Risk Assessment has not written it'),
    '', 'Merge requests and screenshots',
    ...(created.length ? created.flatMap(m => [`  ${link(m.key ?? `MR ${m.id}`, m.url)}  ${mrStatus(m)}`, ...(shots[m.id] ?? []).map(shot)]) : ['  none created']),
    ...(shots[''] ? ['  The ticket as a whole', ...shots[''].map(shot)] : []),
    '', 'Tests failing on master too',
    ...(failures == null ? ['  no test results yet'] : failures.length ? failures.flatMap(f => indent(`• ${f}`)) : ['  none']),
    '', 'Demo',
    ...indent(demo?.demo === true ? 'choose Demo above to bring it up in its VM' : `no demo: ${demo?.demo === false ? demo.why : 'no demo plan was written'}`),
  ];
}

// splitProposalLines(proposal, width) — what a split proposal (loadReviews'
// split, ASS-252) shows at the gate whose step shows it, `width` wide: its
// summary, then each proposed ticket — its place, title, points, type when
// not a Story, the original's criteria it covers and what it depends on (the
// proposal's places, other tickets' keys) — with its user story, context and
// criteria (AC<n>: put before one without, as ticket:apply-split writes it).
// ASS-266: a proposal made after a partial apply lists the tickets that apply
// already made (already-created): one a proposed ticket reuses is named on
// it ("already made: <KEY>"); those it leaves follow, under their own head,
// left as they are, outside the split.
export function splitProposalLines(proposal, width) {
  const indent = (text, by) => wrap(String(text ?? ''), width - by).map(line => `${' '.repeat(by)}${line}`);
  if (!proposal?.tickets?.length) return ['  no proposal recorded yet: Split has not written one'];
  const made = proposal['already-created'] ?? [];
  const reused = i => made.find(m => m.place === i + 1)?.key;
  const head = (t, i) => [`${i + 1}. ${t.title}`, `${t.points} points`, ...(t.type && t.type !== 'Story' ? [t.type] : []),
    `covers ${t.covers?.length ? t.covers.map(n => `AC${n}`).join(', ') : 'none'}`, ...(t['depends-on']?.length ? [`depends on ${t['depends-on'].join(', ')}`] : []),
    ...(reused(i) ? [`already made: ${reused(i)}`] : [])].join(' · ');
  const left = made.filter(m => m.place == null);
  return [
    ...(proposal.summary ? indent(proposal.summary, 2) : []),
    ...proposal.tickets.flatMap((t, i) => ['', ...indent(head(t, i), 2), ...indent(t['user-story'], 5), ...indent(t.context, 5),
      ...(t['acceptance-criteria'] ?? []).flatMap((c, j) => indent(/^AC\d+:/.test(c) ? c : `AC${j + 1}: ${c}`, 5))]),
    ...(left.length ? ['', ...indent('Already created, not in this proposal: left as it is, outside the split', 2), ...left.flatMap(m => indent(`${m.key} ${m.title}`, 2))] : []),
  ];
}

// ticketScreenshots(t, folder, images) — ticket `t`'s screenshots for the
// ticket screen's panel (ASS-244): each variation's (not soft deleted) the
// Test step recorded in local-testing.screenshots, { label "AC<n> · <shows>",
// path its file in `folder` }, grouped under the variation's name; then, as
// Other, the `images` (loadReviews' screenshots, as paths) none records,
// labelled by their path within `folder`. { folder, groups }, or null with
// none, or no folder known.
export function ticketScreenshots(t, folder, images = []) {
  if (!folder) return null;
  const groups = (t.variations ?? [t.variation]).filter(v => v && !v['is-deleted'])
    .map(v => ({ name: v.name, shots: (v['local-testing']?.screenshots ?? []).map(s => ({ label: `AC${s['criteria-number']} · ${s.shows}`, path: join(folder, s.file) })) }))
    .filter(g => g.shots.length);
  const recorded = new Set(groups.flatMap(g => g.shots.map(s => s.path)));
  const others = images.filter(path => !recorded.has(path)).map(path => ({ label: relative(folder, path), path }));
  if (others.length) groups.push({ name: 'Other', shots: others });
  return groups.length ? { folder, groups } : null;
}
