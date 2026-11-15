// How Claude Code decides a write against a settings object, as its docs say
// (code.claude.com/docs/en/permissions, /sandboxing, /settings-reference), for
// the tests of the settings the harness writes (ASS-108). Only what those
// settings use: absolute paths.
//
// Edit tool (permissions): rules are checked deny first, then allow; `Edit`
// rules cover every tool that edits files (Edit, Write, NotebookEdit);
// `//path` is absolute, gitignore-style, `*` within one segment, `**` across
// them. In dontAsk mode a write no allow rule covers is refused; in the other
// modes it is asked or allowed, so only a deny refuses it.
//
// Bash (sandbox): a sandboxed command may write the working directory, the
// temp folder and filesystem.allowWrite (plus Edit allow rules' paths), never
// filesystem.denyWrite (plus Edit deny rules' paths), which wins inside an
// allowed folder; a trailing /** is dropped, `*` works on macOS.

const glob = pattern => new RegExp(`^${pattern.split(/(\*\*|\*)/).map(part => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
// under(path, pattern) — the path is the pattern's file, or inside its folder; ~/ is home.
const under = (path, pattern) => {
  const bare = pattern.replace(/^~(?=\/)/, process.env.HOME).replace(/\/\*\*$/, '');
  return glob(bare).test(path) || glob(`${bare}/**`).test(path);
};
const editPaths = rules => (rules ?? []).map(r => /^Edit\(\/(\/.*)\)$/.exec(r)?.[1]).filter(Boolean);

// editAllowed(settings, path) — whether the Edit/Write tool may write the path.
export function editAllowed(settings, path) {
  const { allow, deny, defaultMode } = settings.permissions ?? {};
  if (editPaths(deny).some(p => under(path, p))) return false;
  if (defaultMode !== 'dontAsk') return true;
  return editPaths(allow).some(p => under(path, p));
}

// bashWriteAllowed(settings, path, { cwd, tmp }) — whether a sandboxed command may write the path.
export function bashWriteAllowed(settings, path, { cwd, tmp }) {
  const fs = settings.sandbox?.filesystem ?? {};
  const denied = [...(fs.denyWrite ?? []), ...editPaths(settings.permissions?.deny)];
  const allowed = [cwd, tmp, ...(fs.allowWrite ?? []), ...editPaths(settings.permissions?.allow)].filter(Boolean);
  return !denied.some(p => under(path, p)) && allowed.some(p => under(path, p));
}

// Bash (sandbox, excludedCommands): which command lines run outside the
// sandbox — Claude Code 2.1.325's own rule, read from the matcher bundled in
// its binary for ASS-463 (its shouldUseSandbox → excluded-command check), and
// not run here. It parses the line into simple commands, split at ; && || |
// & and newlines; a line it cannot split safely (a heredoc, $(…), backquote,
// a control character) runs sandboxed. Then it runs the line outside only
// when EVERY command on it is covered: not a variable set in one command and
// used in another; a first word that is no cd/chdir/pushd/popd, no shell or
// eval/source/exec, no wrapper (env, sudo, xargs, nohup, time, timeout, nice,
// command, builtin…) and holds no $, quote, backslash or glob; and an
// excludedCommands pattern matching it — `<prefix> *` the prefix alone or
// followed by a space and anything, whitespace runs taken as one space;
// otherwise the whole command. A redirect is modelled as sandboxed: the
// harness saw ABC-1770's `agent.sh vm:golden-write … < provision.sh` refused
// (ASS-428) and the 2026-11-15 `agent.sh … ; echo exit=$?` and `f=…; cat >
// "$f" <<'EOF' … EOF` + `agent.sh work:append … "$f"` lines too (ASS-463),
// while bare agent.sh calls wrote under data/. Run for real once for ASS-463
// (claude -p 2.1.325 under the generated settings, a temp data folder): the
// bare `agent.sh assignments:status-update …` wrote, `…; echo next` and
// `cd /tmp && …` ran sandboxed and failed with "Operation not permitted";
// with the guard hook (agent-sh-guard.js) both were refused before running
// and the agent ran the bare calls it named, which wrote.
const NEVER = new Set(['cd', 'chdir', 'pushd', 'popd', 'eval', 'source', '.', 'exec', 'fc', 'coproc', 'trap', 'alias', 'let', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish',
  'env', 'sudo', 'doas', 'su', 'xargs', 'sed', 'awk', 'gawk', 'nohup', 'time', 'timeout', 'nice', 'stdbuf', 'command', 'builtin', 'noglob', 'nocorrect', 'watch', 'flock', 'script', 'setsid', 'chroot']);
// commands(line) — the line's simple commands, or null where it is not split safely (or redirects).
export function commands(line) {
  const out = [];
  let current = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], next = line[i + 1];
    if (/[\x00-\x08\x0B-\x1F\x7F]/.test(c)) return null;
    if (quote === "'") { current += c; if (c === "'") quote = null; continue; }
    if (quote === '"') {
      current += c;
      if (c === '\\') { current += next ?? ''; i++; } else if (c === '"') quote = null; else if (c === '`' || (c === '$' && next === '(')) return null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === '\\') { current += c + (next ?? ''); i++; continue; }
    if (c === '`' || (c === '$' && next === '(') || c === '<' || c === '>' || c === '(' || c === ')') return null;
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (current.trim()) out.push(current.trim());
      current = '';
      if ((c === '|' || c === '&') && next === c) i++;
      continue;
    }
    current += c;
  }
  if (quote) return null;
  if (current.trim()) out.push(current.trim());
  return out;
}
// bare(line) — the line is one simple command Claude Code splits safely.
export const bare = line => commands(line)?.length === 1;
const setIn = command => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command)?.[1];
const covered = (command, patterns) => {
  const first = command.split(/[ \t]+/, 1)[0];
  if (NEVER.has(first.split('/').pop()) || /[$`\\'"*?[]/.test(first) || /^[^ \t\n/=[]*=/.test(first)) return false;
  const c = command.replace(/[ \t]+/g, ' ');
  return patterns.some(p => (p.endsWith(' *') ? c === p.slice(0, -2) || c.startsWith(p.slice(0, -1)) : c === p));
};

// runsUnsandboxed(settings, line) — whether the sandbox lets the command line run outside it.
export function runsUnsandboxed(settings, line) {
  const parts = commands(line.trim());
  if (!parts?.length) return false;
  const set = parts.map(setIn);
  if (set.some((name, i) => name && parts.some((p, j) => j !== i && new RegExp(`\\$\\{?${name}\\b`).test(p)))) return false;
  return parts.every(p => covered(p, settings.sandbox?.excludedCommands ?? []));
}
