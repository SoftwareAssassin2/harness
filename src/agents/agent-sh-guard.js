#!/usr/bin/env node
// The confined host agent's agent.sh guard (ASS-463): a Claude Code
// PreToolUse hook on Bash, in the host-agent settings (confinement.js), that
// refuses — before it runs — any command line that calls the harness's
// agent.sh or off-board.sh but is not that call alone, and tells the agent the
// bare call to run instead.
//
// Why: the sandbox runs a command outside it only when every simple command on
// the line is covered by an excludedCommands pattern (Claude Code 2.1.325's
// matcher, as test/support/claude-rules.js models it), and never a cd, a
// shell, a wrapper (env, nohup, xargs…) or a line with a redirect, heredoc,
// $(…) or a variable set in one command and used in another. So `cd <dir> &&
// <harness>/agent.sh …`, `<harness>/agent.sh … ; echo $?`, a heredoc writing
// the content file and the agent.sh call in one Bash call, `./agent.sh …` —
// what host agents typed on 2026-11-15 — all ran sandboxed, and every write
// under data/ failed with "Operation not permitted" deep inside agent.sh,
// sending the ticket to the operator. No pattern can cover those lines
// safely (a `cd *` or `echo *` exclusion would never be honoured, or would let
// anything after it out of the sandbox), so the guard makes them harmless the
// other way: refused at once, with the bare call spelled out, the agent
// retries it as its own Bash call, which the exclusion matches.
//
// The guard only refuses; it never rewrites a command or lets one out of the
// sandbox. A line that names no agent.sh / off-board.sh call passes untouched
// (reading the script, grep for it, a heredoc body that mentions it).
//
// As a hook: node agent-sh-guard.js <harness-root>, the hook input JSON on
// stdin ({ tool_name, tool_input: { command }, cwd }); it prints nothing to let
// the call go on, or the PreToolUse deny decision with its reason.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { basename, isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = ['agent.sh', 'off-board.sh'];
// An output redirect word: dropped from the bare call suggested.
const OUTPUT = /^(?:\d*>>?&\d|\d*>>?\/dev\/null|&>>?\/dev\/null)$/;
// Words that run the next word as the command: the call is still agent.sh's, but the line is not bare.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'env', 'nohup', 'time', 'nice', 'stdbuf', 'timeout', 'sudo', 'doas', 'xargs',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'source', '.', 'then', 'do', 'else', 'elif', '!', '{', '(', 'noglob']);

// scan(line) — the line cut into simple commands at unquoted ; & | && || and
// newlines, heredoc bodies left out, with what makes it more than one bare
// command: { commands: [string], redirect, heredoc, substitution, variable, subshell }.
export function scan(line) {
  const out = { commands: [], redirect: false, heredoc: false, substitution: false, variable: false, subshell: false, operators: new Set() };
  let current = '', quote = null, i = 0, depth = 0;
  const heredocs = [];   // delimiters whose bodies start at the next newline
  const cut = op => { if (current.trim()) out.commands.push(current.trim()); current = ''; if (op) out.operators.add(op); };
  while (i < line.length) {
    const c = line[i], next = line[i + 1];
    if (quote === "'") { current += c; if (c === "'") quote = null; i++; continue; }
    if (quote === '"') {
      current += c;
      if (c === '\\') { current += next ?? ''; i += 2; continue; }
      if (c === '"') quote = null;
      else if (c === '`' || (c === '$' && next === '(')) out.substitution = true;
      else if (c === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(next ?? '')) out.variable = true;
      i++; continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; i++; continue; }
    if (c === '\\') { current += c + (next ?? ''); i += 2; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { while (i < line.length && line[i] !== '\n') i++; continue; }
    if (c === '\n') {
      cut(';');
      i++;
      // Heredoc bodies: skip each up to its delimiter line.
      for (const { word, strip } of heredocs.splice(0)) {
        while (i < line.length) {
          const end = line.indexOf('\n', i), row = line.slice(i, end === -1 ? line.length : end);
          i = end === -1 ? line.length : end + 1;
          if ((strip ? row.replace(/^\t+/, '') : row) === word) break;
        }
      }
      continue;
    }
    if (c === '<' && next === '<' && line[i + 2] !== '<') {
      out.heredoc = true; out.redirect = true;
      const m = /^<<(-?)\s*(['"]?)([^\s'";|&<>()]+)\2/.exec(line.slice(i));
      if (m) { heredocs.push({ word: m[3], strip: m[1] === '-' }); current += m[0]; i += m[0].length; continue; }
      current += '<<'; i += 2; continue;
    }
    if (c === '<' || c === '>') {
      if (next === '(') { out.substitution = true; depth++; current += c + next; i += 2; continue; }
      out.redirect = true;
      // >&2, 2>&1, &>: the & is the redirect's, not a background operator.
      const m = /^[<>]{1,2}&?[0-9-]*/.exec(line.slice(i));
      current += m[0]; i += m[0].length; continue;
    }
    if (c === '$' && next === '(') { out.substitution = true; depth++; current += '$('; i += 2; continue; }
    if (c === '`') { out.substitution = true; current += c; i++; continue; }
    if (c === ')' && depth > 0) { depth--; current += c; i++; continue; }
    if (c === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(next ?? '')) { out.variable = true; current += c; i++; continue; }
    if (c === '(' || c === ')') { out.subshell = true; cut(c); i++; continue; }
    if (c === ';') { cut(';'); i++; continue; }
    if (c === '&' && next === '&') { cut('&&'); i += 2; continue; }
    if (c === '|' && next === '|') { cut('||'); i += 2; continue; }
    if (c === '|') { cut('|'); i += next === '&' ? 2 : 1; continue; }
    if (c === '&' && next === '>') { out.redirect = true; current += '&>'; i += 2; continue; }
    if (c === '&') { cut('&'); i++; continue; }
    current += c; i++;
  }
  cut();
  return out;
}

// words(command) — a simple command's words, quotes taken off (good enough to name the command and its arguments).
export function words(command) {
  const found = [];
  let word = null, quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && /["\\$`]/.test(command[i + 1] ?? '')) word += command[++i];
      else word += c;
      continue;
    }
    if (/\s/.test(c)) { if (word !== null) found.push(word); word = null; continue; }
    word ??= '';
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') word += command[++i] ?? '';
    else word += c;
  }
  if (word !== null) found.push(word);
  return found;
}

const real = path => { try { return realpathSync(path); } catch { return null; } };

// guard(line, { root, cwd }) — null when the line may run as it is: it calls
// no agent.sh / off-board.sh of the harness at root, or is exactly one bare
// call by its absolute path. Else { reason }: why it would run sandboxed and
// the bare call to run instead, each as its own Bash call.
export function guard(line, { root, cwd = root }) {
  const scripts = Object.fromEntries(SCRIPTS.map(s => [s, join(root, s)]));
  const reals = new Map(SCRIPTS.map(s => [real(scripts[s]) ?? scripts[s], s]));
  const s = scan(String(line ?? ''));
  const calls = [];
  let at = cwd, cd = false, wrapped = false, relative = false;
  for (const command of s.commands) {
    const w = words(command);
    let k = 0;
    while (k < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]) || WRAPPERS.has(w[k]) || (k > 0 && WRAPPERS.has(w[k - 1]) && (/^-/.test(w[k]) || /^\d+[smhd]?$/.test(w[k]))))) k++;
    const word = w[k];
    if (w[0] === 'cd' || w[0] === 'pushd') { cd = true; if (w[1] && !/[$`]/.test(w[1])) at = resolve(at, w[1].replace(/^~(?=\/|$)/, process.env.HOME ?? '~')); continue; }
    if (!word || !SCRIPTS.includes(basename(word))) continue;
    // Which file it names: the harness's own (by its path, a relative path or a symlink), or a bare name PATH would find.
    const named = isAbsolute(word) ? word : word.includes('/') ? resolve(at, word) : null;
    const script = named === null ? basename(word) : reals.get(real(named) ?? named) ?? (named === scripts[basename(word)] ? basename(word) : null);
    if (!script) continue;   // another program of the same name: not the harness's
    if (k > 0) wrapped = true;
    if (word !== scripts[script]) relative = true;
    calls.push({ script, args: w.slice(k + 1), command, first: s.commands.indexOf(command) === 0 });
  }
  if (!calls.length) return null;
  const one = s.commands.length === 1 && calls.length === 1;
  if (one && !wrapped && !relative && !s.redirect && !s.substitution && !s.variable && !s.subshell && !s.heredoc) return null;

  const why = [];
  if (cd) why.push('a cd before it (the sandbox never exempts a line with cd on it)');
  if (s.operators.has('|')) why.push('a pipe');
  if ([';', '&&', '||', '&'].some(o => s.operators.has(o))) why.push('another command chained to it (;, &&, || or a second line)');
  if (s.heredoc) why.push('a heredoc');
  else if (s.redirect) why.push('a redirect (<, >, 2>&1)');
  if (s.substitution) why.push('a $(…) or backquote');
  if (s.variable) why.push('a shell variable ($f): put the absolute path or the text itself on the line');
  if (wrapped) why.push('a command in front of it (env, bash, nohup, xargs…)');
  if (relative) why.push(`a path other than ${calls.map(c => scripts[c.script]).filter((p, i, a) => a.indexOf(p) === i).join(' or ')}`);
  if (s.subshell) why.push('parentheses');
  // Each call as it would run bare: an output redirect (2>&1, >/dev/null) dropped; one that takes input another way (<, a heredoc, $(…), a variable) has none.
  const runnable = calls.map(c => ({ ...c, args: c.args.filter(a => !OUTPUT.test(a)) }))
    .filter(c => { const t = scan(c.args.join(' ')); return !/[<>]/.test(c.args.join(' ')) && !t.substitution && !t.variable && !t.heredoc; });
  const bare = runnable.map(c => [scripts[c.script], ...c.args].map(quoted).join(' '));
  const input = s.heredoc || /(^|[^<>&0-9])\d*<(?!\()/.test(calls.map(c => c.command).join('\n')) || s.variable || s.substitution || runnable.length < calls.length || (s.operators.has('|') && calls.some(c => !c.first));
  return {
    reason: [
      `Not run: this line calls ${calls.map(c => c.script).filter((p, i, a) => a.indexOf(p) === i).join(' and ')} with ${why.join(', ') || 'more on the line'}. The sandbox lets agent.sh write the harness's data only when the call is the whole command line — the script by its absolute path and its arguments, nothing else — so this line would run sandboxed and its write would fail ("Operation not permitted").`,
      bare.length ? `Run ${bare.length > 1 ? 'each of these' : 'this'} as a Bash call of its own, nothing before or after it:\n${bare.map(b => `  ${b}`).join('\n')}`
        : `Run the ${calls[0].script} call as a Bash call of its own, nothing before or after it: ${scripts[calls[0].script]} and its arguments alone.`,
      input
        ? 'Give agent.sh its content by file: write the content first to a temp file of your own (your Write tool, or a Bash call that does nothing else), then pass that file\'s absolute path itself as the file argument, in a separate Bash call.' : '',
      'Run anything else (echo $?, the next read) in its own Bash call too.',
    ].filter(Boolean).join('\n'),
  };
}

// quoted(word) — the word as a shell reads it back: bare when safe, else in single quotes.
const quoted = word => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// decision(input, root) — the hook's output for a PreToolUse input, or null to let the call go on.
export function decision(input, root) {
  if (input?.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return null;
  const refused = guard(input.tool_input.command, { root, cwd: input.cwd && existsSync(input.cwd) ? input.cwd : root });
  return refused && { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refused.reason } };
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const out = decision(JSON.parse(readFileSync(0, 'utf8')), process.argv[2] ?? resolve(fileURLToPath(import.meta.url), '..', '..', '..'));
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch { /* unreadable input: let the call go on, the sandbox still decides */ }
}
