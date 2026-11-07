import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviews, splitProposalLines, ticketScreenshots, ticketDocuments, riskLevel } from '../../src/tui/review.js';

// ASS-244: the ticket's screenshots for the ticket screen's panel — the ones
// each variation's Test step recorded, then any other image in the folder.
const shot = (n, file, shows) => ({ file, 'criteria-number': n, shows });
const variation = (name, screenshots, extra = {}) => ({ name, 'local-testing': { screenshots }, ...extra });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  const folder = join(dir, 'work', 'ABC-1', 'screenshots');
  mkdirSync(join(folder, '7'), { recursive: true });
  for (const file of ['criterion-1.png', '7/criterion-2.png', 'extra.png', '7/later.jpg', 'notes.txt']) writeFileSync(join(folder, file), '');
  return { dir, folder, images: Object.values(loadReviews(dir)['ABC-1'].screenshots).flat() };
};

test('ASS-244 AC1: the recorded screenshots, grouped under each variation\'s name in order, each "AC<n> · <shows>" with its file in the folder; a deleted variation or one with none has no group', () => {
  const { folder, images } = project();
  const t = { key: 'ABC-1', variations: [
    variation('A', [shot(1, 'criterion-1.png', 'the cite'), shot(2, '7/criterion-2.png', 'the list')]),
    variation('B', []), variation('C', [shot(3, 'extra.png', 'gone')], { 'is-deleted': true }), variation('D', [shot(1, '7/later.jpg', 'the menu')]),
  ] };
  assert.deepEqual(ticketScreenshots(t, folder, images), { folder, groups: [
    { name: 'A', shots: [{ label: 'AC1 · the cite', path: join(folder, 'criterion-1.png') }, { label: 'AC2 · the list', path: join(folder, '7', 'criterion-2.png') }] },
    { name: 'D', shots: [{ label: 'AC1 · the menu', path: join(folder, '7', 'later.jpg') }] },
    { name: 'Other', shots: [{ label: 'extra.png', path: join(folder, 'extra.png') }] },
  ] });
});

test('ASS-244 AC2: images no variation records come after, labelled by their path within the folder, sub-folders too', () => {
  const { folder, images } = project();
  assert.deepEqual(ticketScreenshots({ key: 'ABC-1', variations: [variation('A', [])] }, folder, images), { folder, groups: [
    { name: 'Other', shots: ['7/criterion-2.png', '7/later.jpg', 'criterion-1.png', 'extra.png'].map(label => ({ label, path: join(folder, label) })) },
  ] });
});

test('ASS-244 AC3: a ticket with no screenshots folder and none recorded has none; one with no project folder known has none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  const folder = join(dir, 'work', 'ABC-1', 'screenshots');
  const images = Object.values(loadReviews(dir)['ABC-1']?.screenshots ?? {}).flat();
  assert.equal(ticketScreenshots({ key: 'ABC-1', variations: [variation('A', [])] }, folder, images), null);
  assert.equal(ticketScreenshots({ key: 'ABC-1', variation: { name: 'A' } }, folder, []), null);
  assert.equal(ticketScreenshots({ key: 'ABC-1', variations: [variation('A', [shot(1, 'a.png', 'x')])] }, undefined, []), null);
});

// ASS-252: the proposal Split's agent recorded (ticket:propose-split's
// split-proposal.json) is the ticket's review's split, shown at the gate.
test('ASS-252 AC2: loadReviews reads a ticket\'s split proposal; one unreadable is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-'));
  mkdirSync(join(dir, 'work', 'ABC-1'), { recursive: true });
  mkdirSync(join(dir, 'work', 'ABC-2'), { recursive: true });
  const proposal = { ticket: 'ABC-1', tickets: [{ title: 'One', points: 2 }] };
  writeFileSync(join(dir, 'work', 'ABC-1', 'split-proposal.json'), JSON.stringify(proposal));
  writeFileSync(join(dir, 'work', 'ABC-2', 'split-proposal.json'), '{ half');
  const reviews = loadReviews(dir);
  assert.deepEqual(reviews['ABC-1'].split, proposal);
  assert.equal(reviews['ABC-2'], undefined);
});

// ASS-266: a proposal made after a partial apply shows the tickets already
// made — on the proposed ticket that reuses one, and, apart, those it leaves.
test('ASS-266 AC2: splitProposalLines shows a ticket already made beside the proposed one that reuses it, and those the proposal leaves under Already created', () => {
  const t = (title, covers) => ({ title, type: 'Story', points: 2, 'user-story': 'u', context: 'c', 'acceptance-criteria': ['works'], covers, 'depends-on': [] });
  const out = splitProposalLines({ summary: 's', tickets: [t('First piece', [1]), t('Fourth piece', [2, 3])],
    'already-created': [{ key: 'HD-10', title: 'First piece', place: 1 }, { key: 'HD-11', title: 'Second piece', place: null }] }, 200);
  assert.ok(out.includes('  1. First piece · 2 points · covers AC1 · already made: HD-10'), out.join('\n'));
  assert.ok(out.includes('  2. Fourth piece · 2 points · covers AC2, AC3'), out.join('\n'));
  assert.ok(out.includes('  Already created, not in this proposal: left as it is, outside the split'), out.join('\n'));
  assert.ok(out.includes('  HD-11 Second piece'), out.join('\n'));
  assert.ok(!splitProposalLines({ tickets: [t('A', [1]), t('B', [2])] }, 200).some(l => l.includes('Already created')));
});

// ASS-261: the ticket screen's panel links the variation's plans, root cause
// analysis and risk assessment (ticketDocuments, from loadReviews' documents)
// and shows its risk level (riskLevel) under the ticket number.
const work = files => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  const folder = join(dir, 'work', 'ABC-1');
  mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  return { dir, folder, review: loadReviews(dir)['ABC-1'] };
};
const docs = (review, name = 'A') => ticketDocuments({ key: 'ABC-1', variation: { name } }, review);

test('ASS-261 AC1: the Documents, in order — Execution plan, Test plan, Root cause analysis, Risk assessment — each the variation\'s own file, linked by its absolute path', () => {
  const { folder, review } = work({ 'risk-assessment-A.md': '# r', 'test-plan-A.md': '# t', 'root-cause-analysis-A.md': '# c', 'execution-plan-A.md': '# e', 'execution-plan-B.md': '# B\'s' });
  assert.deepEqual(docs(review).links, [
    { label: 'Execution plan', path: join(folder, 'execution-plan-A.md') },
    { label: 'Test plan', path: join(folder, 'test-plan-A.md') },
    { label: 'Root cause analysis', path: join(folder, 'root-cause-analysis-A.md') },
    { label: 'Risk assessment', path: join(folder, 'risk-assessment-A.md') },
  ]);
  assert.deepEqual(docs(review, 'B').links, [{ label: 'Execution plan', path: join(folder, 'execution-plan-B.md') }]);
});

test('ASS-261 AC1: a missing file is left out; the un-suffixed file stands in only when the variation\'s own is missing; reviews of reviews are not plans', () => {
  const { folder, review } = work({ 'execution-plan.md': '# old', 'execution-plan-A.md': '# new', 'test-plan.md': '# old', 'root-cause-analysis-review-A.md': '# rv', 'plan-review-A.md': '# pr' });
  assert.deepEqual(docs(review).links, [
    { label: 'Execution plan', path: join(folder, 'execution-plan-A.md') },
    { label: 'Test plan', path: join(folder, 'test-plan.md') },
  ]);
  assert.deepEqual(docs(review, 'C').links.map(l => l.path), [join(folder, 'execution-plan.md'), join(folder, 'test-plan.md')]);
});

test('ASS-261 AC1/AC3: a ticket with no work folder, or none of these files, has no Documents and no risk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  assert.equal(docs(loadReviews(dir)['ABC-1']), null);
  assert.equal(docs(work({ 'change-log-A.md': '# c' }).review), null);
  assert.equal(ticketDocuments({ key: 'ABC-1', variation: {} }, undefined), null);
});

test('ASS-261 AC3: the risk level is the fixed **Risk: …** line first after the title, from the variation\'s risk assessment, else the un-suffixed one', () => {
  for (const level of ['Low', 'Medium', 'High']) {
    assert.equal(riskLevel(`# ABC-1 — Risk assessment (variation A)\n\n**Risk: ${level}**\n\n**Verdict: ship. Not flagged.**\n`), level);
    assert.equal(docs(work({ 'risk-assessment-A.md': `# R\n**Risk: ${level}**\nVerdict: high stakes, low odds\n` }).review).risk, level);
  }
  assert.equal(docs(work({ 'risk-assessment.md': '# R\n\n**Risk: High**\n' }).review).risk, 'High');
  assert.equal(docs(work({ 'risk-assessment.md': '# R\n\n**Risk: High**\n', 'risk-assessment-A.md': '# R\n\n**Risk: Low**\n' }).review).risk, 'Low');
  assert.equal(docs(work({ 'execution-plan-A.md': '# e' }).review).risk, null);
});

test('ASS-261 AC3: an older file\'s verdict line shows a level only when it names exactly one of low/medium/high as a whole word', () => {
  const older = verdict => riskLevel(`# EX-1 — Risk assessment (variation A)\n\n${verdict}\n\n## Scope\nhigh blast radius, medium effort\n`);
  assert.equal(older('**Verdict: LOW risk, but flagged for human review.**'), 'Low');
  assert.equal(older('Verdict: low risk'), 'Low');
  assert.equal(older('**Verdict: MEDIUM risk.**'), 'Medium');
  assert.equal(older('**Verdict: LOW-MODERATE risk — flag for human review.**'), null);
  assert.equal(older('**Verdict: ship. Doc-only, zero blast radius. Not flagged.**'), null);
  assert.equal(older('Verdict: low likelihood, high impact'), null);
  assert.equal(older('Verdict: lowish risk'), null);
  assert.equal(riskLevel(''), null);
  assert.equal(riskLevel(undefined), null);
});
