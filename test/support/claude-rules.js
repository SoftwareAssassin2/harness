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
