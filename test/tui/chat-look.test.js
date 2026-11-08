// ASS-300: chatLines() unit tests — the Claude-Code look for one chat's log.
// Written first (AC6): src/tui/chat-look.js does not exist yet, so these run
// and fail red until the renderer lands. The module is loaded through a guarded
// dynamic import so a missing file does not abort the whole test file: each test
// then fails on its own call, rather than the file erroring at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visible } from '../../src/tui/text.js';

let chatLines;
try { ({ chatLines } = await import('../../src/tui/chat-look.js')); }
catch { chatLines = () => { throw new Error('src/tui/chat-look.js not built yet'); }; }

// SGR the AC names by colour/attribute, 16-colour + attrs only (AC5): the tests
// pin these where an AC requires a colour, and pin stripped text everywhere else.
const DIM = '\x1b[2m', BOLD = '\x1b[1m', ITALIC = '\x1b[3m', STRIKE = '\x1b[9m';
const GREEN = '\x1b[32m', RED = '\x1b[31m', CODE = '\x1b[94m', PROMPT_BG = '\x1b[100m';
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
// Render at a given width (Infinity by default so naming tests do not wrap).
const draw = (lines, opts = {}) => chatLines(lines, { width: 80, ...opts });
// The stripped rows, blanks kept (so message separation can be checked).
const rowsOf = (lines, opts) => draw(lines, opts).map(strip);
// The first rendered row (raw, with its SGR) whose stripped text has `sub`.
const row = (lines, sub, opts) => draw(lines, opts).find(r => strip(r).includes(sub));

// ── AC1: message structure, naming, result gutter, prompt, dim ──────────────

test('ASS-300 AC1: plain assistant text is a ⏺ bullet in the default fg, a blank row before the next message', () => {
  const out = draw(['hello', '▶ Bash {"command":"ls"}', '◀ ok']);
  const text = out.find(r => strip(r).includes('hello'));
  assert.ok(text.startsWith('⏺ '), text);
  assert.equal(strip(text), '⏺ hello');
  assert.ok(!/\x1b\[3[0-9]m/.test(text), `assistant text carries no fg colour: ${JSON.stringify(text)}`);
  const i = out.findIndex(r => strip(r) === '⏺ hello');
  assert.ok(out.slice(i + 1).some(r => r === ''), 'a blank row separates the text from the call');
});

test('ASS-300 AC1: a sent prompt is "> text" on a bright-black background, padded inside the SGR run; its continuation keeps the background', () => {
  const out = draw(['> tell me more', '  more'], { width: 20 });
  const head = out.find(r => strip(r).startsWith('> tell me more'));
  assert.ok(head.includes(PROMPT_BG), `prompt on bg 100: ${JSON.stringify(head)}`);
  assert.equal(visible(head), 20, 'the bg fills the width (padded inside the SGR run)');
  assert.ok(head.indexOf('\x1b[0m') > head.lastIndexOf(' '), 'the reset closes after the padding, not before it');
  const cont = out.find(r => strip(r).includes('more') && !strip(r).includes('tell'));
  assert.ok(cont.includes(PROMPT_BG), `the continuation keeps the bg: ${JSON.stringify(cont)}`);
});

test('ASS-300 AC1: the session-start line and the turn-end line are dim', () => {
  const start = row(['[session abc123 started on opus-5]'], 'session abc123');
  assert.ok(start.includes(DIM), start);
  const end = row(['■ turn ended (success) after 1.0s, $0.01 so far'], 'turn ended');
  assert.ok(end.includes(DIM), end);
  assert.equal(strip(end), '■ turn ended (success) after 1.0s, $0.01 so far');
});

test('ASS-300 AC1: every named tool call reads as Claude Code names it, from the parsed input JSON', () => {
  const cases = [
    ['▶ Bash {"command":"npm test"}', '⏺ Bash(npm test)'],
    ['▶ Read {"file_path":"src/tui/app.js"}', '⏺ Read(src/tui/app.js)'],
    ['▶ Grep {"pattern":"foo","path":"src"}', '⏺ Grep(pattern: "foo", path: "src")'],
    ['▶ Glob {"pattern":"*.js"}', '⏺ Glob(pattern: "*.js")'],
    ['▶ LS {"path":"/x"}', '⏺ LS(path: "/x")'],
    ['▶ Task {"description":"review","prompt":"do it"}', '⏺ Task(review)'],
    ['▶ WebFetch {"url":"https://x"}', '⏺ WebFetch(https://x)'],
    ['▶ WebSearch {"query":"foo"}', '⏺ WebSearch(foo)'],
    ['▶ mcp__hindsight__recall {"query":"q"}', '⏺ hindsight - recall (MCP)(query: "q")'],
    ['▶ Frob {"k":"v"}', '⏺ Frob(k: "v")'],
  ];
  for (const [line, want] of cases) {
    const r = draw([line]).map(strip).find(Boolean);
    assert.equal(r, want, line);
  }
});

test('ASS-300 AC1: a tool call bullet is green, red when its result is an error', () => {
  assert.ok(row(['▶ Bash {"command":"ls"}', '◀ ok'], 'Bash(ls)').includes(GREEN));
  assert.ok(row(['▶ Bash {"command":"ls"}', '◀ error: boom'], 'Bash(ls)').includes(RED));
});

test('ASS-300 AC1: a long argument summary is cut to the width with an ellipsis', () => {
  const r = row(['▶ Bash {"command":"echo a very long command line here"}'], 'Bash', { width: 16 });
  assert.ok(visible(r) <= 16, `${visible(r)} > 16: ${JSON.stringify(strip(r))}`);
  assert.ok(strip(r).endsWith('…'), strip(r));
});

test('ASS-300 AC1: a tool result sits under the call as "  ⎿  " at hang 5', () => {
  const out = rowsOf(['▶ Bash {"command":"ls"}', '◀ first line']);
  const gutter = out.find(r => r.includes('⎿'));
  assert.equal(gutter, '  ⎿  first line');
});

test('ASS-300 AC1: each tool has its own one-line result summary', () => {
  const read = ['▶ Read {"file_path":"f"}', ...Array.from({ length: 66 }, (_, i) => (i ? '  ' : '◀ ') + `l${i}`)];
  assert.ok(rowsOf(read).some(r => r.trim() === '⎿  Read 66 lines'), 'Read N lines');

  const grepCount = ['▶ Grep {"pattern":"x"}', '◀ a', '  b', '  c', '  d'];
  assert.ok(rowsOf(grepCount).some(r => r.trim() === '⎿  Found 4 matches'), 'Grep count → Found N matches');
  const grepContent = ['▶ Grep {"pattern":"x","output_mode":"content"}', '◀ a', '  b', '  c', '  d'];
  assert.ok(rowsOf(grepContent).some(r => r.trim() === '⎿  Found 4 lines'), 'Grep content → Found N lines');

  const glob = ['▶ Glob {"pattern":"*.js"}', '◀ a.js', '  b.js', '  c.js'];
  assert.ok(rowsOf(glob).some(r => r.trim() === '⎿  Found 3 files'), 'Glob → Found N files');

  const web = ['▶ WebFetch {"url":"https://x"}', '◀ ' + 'y'.repeat(1234)];
  assert.ok(rowsOf(web).some(r => r.trim() === '⎿  Received ~1.2KB'), 'WebFetch → Received ~size');

  const other = ['▶ Bash {"command":"ls"}', '◀ l1', '  l2', '  l3', '  l4', '  l5'];
  const lines = rowsOf(other).map(r => r.trim());
  assert.ok(lines.includes('⎿  l1') && lines.includes('l2') && lines.includes('l3'), 'first 3 lines kept');   // l1 sits on the gutter row, as the hang-5 test above pins
  assert.ok(!lines.includes('l4'), 'the rest are capped');
  assert.ok(lines.some(r => r === '… +2 lines (ctrl+o to expand)'), lines.join('\n'));
});

test('ASS-300 AC1: an error result turns the call bullet and the result rows red; a plain result leaves the bullet green', () => {
  const err = draw(['▶ Bash {"command":"ls"}', '◀ error: no such file', '  at open()']);
  assert.ok(err.find(r => strip(r).includes('Bash(ls)')).includes(RED), 'bullet red on error');
  assert.ok(err.find(r => strip(r).includes('no such file')).includes(RED), 'result rows red');
  const ok = draw(['▶ Bash {"command":"ls"}', '◀ done']);
  assert.ok(ok.find(r => strip(r).includes('Bash(ls)')).includes(GREEN), 'bullet green when no error');
});

test('ASS-300 AC1: an orphan result (session tail cut) renders without a preceding call, not dropped', () => {
  const out = rowsOf(['◀ pass 7', '  fail 0']);
  assert.ok(out.some(r => r.includes('pass 7')), out.join('\n'));
  assert.ok(!out.some(r => r.includes('⏺')), 'no bullet is invented for an orphan result');
});

test('ASS-300 AC1: an unanswered call (truncated tail) renders the call with no gutter', () => {
  const out = rowsOf(['▶ Bash {"command":"ls"}']);
  assert.ok(out.some(r => r === '⏺ Bash(ls)'), out.join('\n'));
  assert.ok(!out.some(r => r.includes('⎿')), 'no result gutter for an unanswered call');
});

test('ASS-300 AC1: calls pair with results FIFO — the second result pairs with the second call', () => {
  const out = draw(['▶ Bash {"command":"a"}', '▶ Read {"file_path":"b"}', '◀ ok', '◀ error: boom']);
  assert.ok(out.find(r => strip(r).includes('Bash(a)')).includes(GREEN), 'first call stays green');
  assert.ok(out.find(r => strip(r).includes('Read(b)')).includes(RED), 'second call red — its result errored');
});

test('ASS-300 AC1: a raw event line is hidden unless expanded', () => {
  const lines = ['hello', '{"type":"tool_progress"}'];
  assert.ok(!rowsOf(lines).some(r => r.includes('"type"')), 'hidden when expand=false');
  const shown = rowsOf(lines, { expand: true });
  assert.ok(shown.some(r => r.includes('"type"')), 'shown when expand=true');
});

test('ASS-300 AC1: a blank row separates adjacent messages', () => {
  const out = draw(['one', 'two', '▶ Bash {"command":"ls"}', '◀ ok']);
  assert.ok(out.includes(''), 'messages are separated by a blank row');
  // two assistant texts and one call → at least two blank separators
  assert.ok(out.filter(r => r === '').length >= 2, out.map(strip).join('|'));
});

// ── AC3: thinking and todos ─────────────────────────────────────────────────

test('ASS-300 AC3: thinking collapses to a dim italic "✻ Thinking…" line; its body is dropped unless expanded', () => {
  const lines = ['(thinking) Start from the plan', '           then the tests'];
  const out = draw(lines);
  const head = out.find(r => strip(r).includes('Thinking…'));
  assert.ok(head, out.map(strip).join('\n'));
  assert.ok(head.includes(DIM) && head.includes(ITALIC), `dim italic: ${JSON.stringify(head)}`);
  assert.ok(!out.some(r => strip(r).includes('Start from the plan')), 'body dropped when collapsed');
});

test('ASS-300 AC3: expanded, the thinking body shows dim italic, hung at 2', () => {
  const out = draw(['(thinking) Start from the plan', '           then the tests'], { expand: true });
  const body = out.find(r => strip(r).includes('Start from the plan'));
  assert.ok(body, out.map(strip).join('\n'));
  assert.ok(body.includes(DIM) && body.includes(ITALIC), body);
  assert.ok(strip(body).startsWith('  '), `hung at 2: ${JSON.stringify(strip(body))}`);
});

test('ASS-300 AC3: a TodoWrite call is titled "Update Todos", no JSON', () => {
  const line = '▶ TodoWrite {"todos":[{"content":"a","status":"pending"}]}';
  const call = draw([line]).map(strip).find(Boolean);
  assert.equal(call, '⏺ Update Todos');
});

test('ASS-300 AC3: the TodoWrite gutter is a checklist — one row per todo, not the raw JSON, no "+N lines"', () => {
  const line = '▶ TodoWrite {"todos":[{"content":"a","status":"pending"},{"content":"b","status":"in_progress"},{"content":"c","status":"completed"}]}';
  const out = draw([line]);
  const txt = out.map(strip);
  assert.ok(txt.some(r => r.includes('☐ a')), txt.join('\n'));
  const inProgress = out.find(r => strip(r).includes('◼ b'));
  assert.ok(inProgress.includes(BOLD), `in-progress bold: ${JSON.stringify(inProgress)}`);
  const done = out.find(r => strip(r).includes('☒ c'));
  assert.ok(done.includes(DIM) && done.includes(STRIKE), `done dim + struck: ${JSON.stringify(done)}`);
  assert.ok(!txt.some(r => r.includes('"content"')), 'no raw JSON');
  assert.ok(!txt.some(r => r.includes('ctrl+o to expand')), 'a checklist is never capped');
});

// ── AC4: edits (Edit, MultiEdit, Write) ─────────────────────────────────────

test('ASS-300 AC4: an Edit is "Update(path)" with a summary and a +/- line diff', () => {
  const line = '▶ Edit {"file_path":"a.js","old_string":"foo\\nbar","new_string":"foo\\nqux"}';
  const out = draw([line]);
  const txt = out.map(strip);
  assert.equal(out.map(strip).find(Boolean), '⏺ Update(a.js)');
  assert.ok(txt.some(r => r.trim() === '⎿  Updated a.js with 1 addition and 1 removal'), txt.join('\n'));
  const removed = out.find(r => strip(r).trim() === '-bar');
  const added = out.find(r => strip(r).trim() === '+qux');
  const context = out.find(r => strip(r).trim() === 'foo');
  assert.ok(removed.includes(RED), `removed red: ${JSON.stringify(removed)}`);
  assert.ok(added.includes(GREEN), `added green: ${JSON.stringify(added)}`);
  assert.ok(context && !/\x1b\[3[12]m/.test(context), `context default fg: ${JSON.stringify(context)}`);
});

test('ASS-300 AC4: a long Edit diff is capped at max(3, rows-4) with "+N lines"; expand uncaps it', () => {
  const old = Array.from({ length: 10 }, (_, i) => `o${i}`).join('\\n');
  const neu = Array.from({ length: 10 }, (_, i) => `n${i}`).join('\\n');
  const line = `▶ Edit {"file_path":"a.js","old_string":"${old}","new_string":"${neu}"}`;
  const capped = rowsOf([line], { width: 80, rows: 8 });
  assert.ok(capped.some(r => /… \+\d+ lines \(ctrl\+o to expand\)/.test(r)), capped.join('\n'));
  const full = rowsOf([line], { width: 80, rows: 8, expand: true });
  assert.ok(!full.some(r => r.includes('ctrl+o to expand')), 'expanded is uncapped');
});

test('ASS-300 AC4: a MultiEdit shows each edit in input order and one total summary', () => {
  const line = '▶ MultiEdit {"file_path":"a.js","edits":[{"old_string":"x","new_string":"y"},{"old_string":"m","new_string":"n"}]}';
  const txt = draw([line]).map(strip).map(r => r.trim());
  assert.ok(txt.some(r => r === '⎿  Updated a.js with 2 additions and 2 removals'), txt.join('\n'));
  const order = txt.filter(r => /^[-+]/.test(r));
  assert.deepEqual(order, ['-x', '+y', '-m', '+n']);
});

test('ASS-300 AC4: a Write is "Write(path)" with a "Wrote N lines" summary and all-green additions', () => {
  const line = '▶ Write {"file_path":"a.js","content":"line1\\nline2"}';
  const out = draw([line]);
  assert.equal(out.map(strip).find(Boolean), '⏺ Write(a.js)');
  assert.ok(out.map(strip).some(r => r.trim() === '⎿  Wrote 2 lines to a.js'), out.map(strip).join('\n'));
  assert.ok(out.find(r => strip(r).trim() === '+line1').includes(GREEN));
  assert.ok(out.find(r => strip(r).trim() === '+line2').includes(GREEN));
});

test('ASS-300 AC4: an Edit over the LCS cost bound falls back to all-removes then all-adds', () => {
  const old = ['same', ...Array.from({ length: 500 }, (_, i) => `a${i}`)].join('\\n');
  const neu = ['same', ...Array.from({ length: 500 }, (_, i) => `b${i}`)].join('\\n');   // 501 × 501 > 250000
  const line = `▶ Edit {"file_path":"a.js","old_string":"${old}","new_string":"${neu}"}`;
  const diff = draw([line], { expand: true }).map(strip).map(r => r.trim()).filter(r => /^[-+]/.test(r));
  assert.ok(diff.includes('-same') && diff.includes('+same'), 'the shared line is replaced, not kept as context (flat fallback)');
  const firstAdd = diff.findIndex(r => r.startsWith('+'));
  assert.ok(!diff.slice(firstAdd).some(r => r.startsWith('-')), 'all removes come before all adds');
});

test('ASS-300 AC4: an error on an Edit reds the call bullet and renders no diff', () => {
  const out = draw(['▶ Edit {"file_path":"a.js","old_string":"x","new_string":"y"}', '◀ error: cannot write']);
  assert.ok(out.find(r => strip(r).includes('Update(a.js)')).includes(RED));
  assert.ok(!out.some(r => /^[-+]/.test(strip(r).trim())), 'no diff on an errored edit');
});

// ── AC5: widths, frozen input ───────────────────────────────────────────────

test('ASS-300 AC5: at widths 20, 40, 80 every returned row fits the width', () => {
  const lines = [
    '> a prompt that is comfortably wider than twenty columns of text',
    'A reply with **bold**, `code`, a | table | and a long unbroken token ' + 'z'.repeat(60),
    '▶ Bash {"command":"echo a long command that should be cut to the width"}',
    '◀ ' + 'y'.repeat(120),
    '■ turn ended (success) after 1.0s, $0.01 so far',
  ];
  for (const width of [20, 40, 80]) {
    for (const r of draw(lines, { width })) assert.ok(visible(r) <= width, `${width}: ${JSON.stringify(strip(r))}`);
  }
});

test('ASS-300 AC5: the renderer never mutates its input array', () => {
  const lines = Object.freeze(['hello', '▶ Bash {"command":"ls"}', '◀ ok']);
  assert.doesNotThrow(() => draw(lines));
  assert.deepEqual([...lines], ['hello', '▶ Bash {"command":"ls"}', '◀ ok']);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test('ASS-300 edge: a ">" after assistant text is a block quote; at a message start or after a result it is a prompt', () => {
  const quote = draw(['Some reply text', '> quoted aside']);
  const q = quote.find(r => strip(r).includes('quoted aside'));
  assert.ok(!q.includes(PROMPT_BG), `a quote after text is not a prompt bg: ${JSON.stringify(q)}`);
  const prompt = draw(['> quoted aside']);
  assert.ok(prompt.find(r => strip(r).includes('quoted aside')).includes(PROMPT_BG), 'at message start it is a prompt');
});

test('ASS-300 edge: an empty / zero-row / absent-width render never throws', () => {
  assert.doesNotThrow(() => chatLines([], {}));
  assert.doesNotThrow(() => chatLines(['hello'], { rows: 0 }));
  assert.doesNotThrow(() => chatLines(['hello']));   // width defaults to Infinity
});
