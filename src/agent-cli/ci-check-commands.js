// The commands a project's CI checks need on the machine they run on (ASS-471),
// for workstation:setup to check by name before a ticket's CI Checks step would
// find one missing (exit 127, Blocked):
//
//   node ci-check-commands.js <ci-checks.json>
//
// prints one line per command, sorted, "<command>\t<the checks that need it>":
// the first word of each simple command of every check's command (bash split
// at ; & | && || newlines and parentheses; leading NAME=value assignments,
// redirections and keywords such as `if`, `then`, `do`, `!` or `exec` passed
// over), and each name in a check's optional "needs" (commands its scripts are
// known to run, which no command line shows: `"needs": ["sqlfluff"]`). Not a
// command to check: a bash builtin or keyword (export, cd, test…: in every
// bash), a word with a / (a script in the repository, there only once it is
// checked out) or one with $, ` or a glob character in it (known only when
// it runs). "the checks that need it" names each check by its "name" and the
// repositories declaring it, e.g. `static-policy-gate (example-project,
// example-corpus and 24 more)`. A file that is not JSON fails (exit 1, said on
// stderr); entries not of ci-checks:verify's shape are passed over — verify
// names those.
import { readFileSync } from 'node:fs';

const BUILTINS = new Set(`alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs
  disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd
  printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset
  ulimit umask unalias unset wait . : [ [[ ]] if then else elif fi case esac for select while until do done in function
  time { } ! coproc`.split(/\s+/));
// Words after which the next word is a command again (`if cmd`, `exec cmd`, `! cmd`); options after exec are passed over.
const PREFIXES = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time', 'exec']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// The first words of the simple commands in a bash command line: [{ word, plain }] — plain false when it had
// $, ` or a glob character outside single quotes (not knowable before it runs).
export function firstWords(line) {
  const out = [];
  let word = '', inWord = false, plain = true, start = true, skipNext = false, afterExec = false;
  const outer = [];   // the words $(…) interrupted: its commands are read, then the word goes on, not plain
  const flush = () => {
    if (!inWord) return;
    const w = word, p = plain;
    word = ''; inWord = false; plain = true;
    if (skipNext) { skipNext = false; return; }                         // a redirection's target
    if (!start) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w)) return;                 // NAME=value before the command
    if (afterExec && w.startsWith('-')) return;                         // exec's options
    if (PREFIXES.has(w)) { afterExec = w === 'exec'; return; }         // the next word is the command
    start = false; afterExec = false;
    out.push({ word: w, plain: p });
  };
  const boundary = () => { flush(); start = true; skipNext = false; afterExec = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { if (line[i + 1] === '\n') { i++; continue; } word += line[++i] ?? ''; inWord = true; continue; }
    if (c === "'") { const j = line.indexOf("'", i + 1); word += line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j; inWord = true; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) { word += line[++j]; continue; }
        if (line[j] === '$' || line[j] === '`') plain = false;
        word += line[j];
      }
      i = j; inWord = true; continue;
    }
    if (c === '#' && !inWord) { while (i < line.length && line[i] !== '\n') i++; boundary(); continue; }
    if (c === '$' && line[i + 1] === '(') { outer.push({ word, inWord, start, skipNext, afterExec }); word = ''; inWord = false; plain = true; i++; boundary(); continue; }
    if (c === '$' || c === '`' || c === '*' || c === '?' || c === '[') { plain = false; word += c; inWord = true; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(') { boundary(); continue; }
    if (c === ')') {
      flush();
      if (outer.length) { ({ word, start, skipNext, afterExec } = outer.pop()); word += '$()'; inWord = true; plain = false; } else start = false;   // a subshell's end: what follows is arguments
      continue;
    }
    if (c === '<' || c === '>') {
      if (/^[0-9]+$/.test(word)) { word = ''; inWord = false; plain = true; } else flush();
      while (i + 1 < line.length && /[<>&|]/.test(line[i + 1])) i++;
      if (/[0-9-]/.test(line[i + 1] ?? '') && line[i] === '&') { while (/[0-9-]/.test(line[i + 1] ?? '')) i++; continue; }
      skipNext = true; continue;
    }
    if (c === ' ' || c === '\t') { flush(); continue; }
    word += c; inWord = true;
  }
  flush();
  return out;
}

// The commands a command line needs on PATH: its first words that are names, not builtins or keywords.
export function commandsOf(line) {
  return [...new Set(firstWords(line).filter(w => w.plain && NAME.test(w.word) && !BUILTINS.has(w.word)).map(w => w.word))];
}

// ci-checks.json's contents to [[command, the checks that need it]], sorted by command.
export function neededCommands(declared) {
  const by = new Map();   // command -> check name -> [repository]
  const add = (cmd, name, repo) => {
    if (!by.has(cmd)) by.set(cmd, new Map());
    const checks = by.get(cmd);
    if (!checks.has(name)) checks.set(name, []);
    if (!checks.get(name).includes(repo)) checks.get(name).push(repo);
  };
  const repositories = declared && typeof declared.repositories === 'object' && !Array.isArray(declared.repositories) ? declared.repositories : {};
  for (const [repo, checks] of Object.entries(repositories)) {
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      if (!check || typeof check.name !== 'string' || typeof check.command !== 'string') continue;
      for (const cmd of commandsOf(check.command)) add(cmd, check.name, repo);
      for (const cmd of Array.isArray(check.needs) ? check.needs : []) if (typeof cmd === 'string' && NAME.test(cmd)) add(cmd, check.name, repo);
    }
  }
  const repos = r => (r.length <= 2 ? r.join(' and ') : `${r.slice(0, 2).join(', ')} and ${r.length - 2} more`);
  return [...by.keys()].sort().map(cmd => [cmd, [...by.get(cmd)].map(([name, r]) => `${name} (${repos(r)})`).join(', ')]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let declared;
  try { declared = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch (e) {
    process.stderr.write(`ci-check-commands: ${process.argv[2]}: not valid JSON (${e.message})\n`);
    process.exit(1);
  }
  for (const [cmd, checks] of neededCommands(declared)) process.stdout.write(`${cmd}\t${checks}\n`);
}
