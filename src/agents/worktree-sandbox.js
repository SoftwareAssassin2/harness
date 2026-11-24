// ASS-555 (operator decision, 2026-11-23): every agent that works outside a VM or a Substrate sandbox — on the run
// targets local-worktree, local-workspace (the Mac), workstation-worktree and cloud-vm-worktree (a remote machine's
// worktree, ASS-553) — runs inside Claude Code's own sandbox, so it can write only its worktree and reach only the hosts
// its project allows. Agents in Lima VMs and Substrate sandboxes are isolated already and are left as they are; the
// confined host agents (confinement.js, ASS-108) keep their own settings.
//
// What Claude Code's sandbox is (code.claude.com/docs/en/sandboxing and settings-reference, read for this ticket with
// Claude Code 2.1.330; sources in the ticket's change notes):
// - It wraps the Bash tool's commands and everything they start: Seatbelt on macOS (built in), bubblewrap on Linux
//   (the `bubblewrap` and `socat` packages; Ubuntu's AppArmor user-namespace restriction stops bwrap too). Writes:
//   the working directory, the per-user temp directory ($TMPDIR is set to it), --add-dir folders and
//   sandbox.filesystem.allowWrite; never the protected paths (.claude settings, skills, agents, commands, hooks,
//   .mcp.json, the working directory's .gitconfig, .bashrc, .git/hooks, .git/config, the Claude config folder). In a
//   linked git worktree the main repository's shared .git is writable too, so commits work. Reads: everywhere but
//   denyRead / credentials.files. Network: no direct route out — a proxy outside the sandbox checks each host against
//   sandbox.network.allowedDomains; non-HTTP tools (plain ssh, database drivers) cannot connect at all; on Linux each
//   command has its own loopback, on macOS localhost is refused unless allowLocalBinding.
// - What it does NOT wrap: the built-in file and web tools (Read, Edit, Write, WebFetch…), MCP servers (the project's
//   Hindsight, reached by the Claude Code process itself), hooks. So the file tools are held by
//   permissions.blockWritesOutsideWorkingDirectories (Write, Edit, NotebookEdit refuse paths outside the working
//   directories in every permission mode, bypassPermissions included; 2.1.314+), and WebFetch is denied (a bare deny
//   rule removes the tool; allowedDomains does not limit it).
// - Headless runs (claude -p --dangerously-skip-permissions, as the harness's agents): in bypassPermissions a host
//   outside the allowlist is ALLOWED and Claude may retry a refused command unsandboxed, unless strictAllowlist
//   (honoured from --settings) and allowUnsandboxedCommands: false (from --settings it also makes the sandbox
//   "admin-required": a repository's own .claude settings that would loosen it — its excludedCommands, allowWrite,
//   allowedDomains — are ignored). By default a sandbox that cannot start lets Claude Code run commands unsandboxed;
//   failIfUnavailable makes it exit at startup instead, and refuse each command should the sandbox fail later.
// - Settings come by --settings (a file or inline JSON), above the user's and the repository's files and below managed
//   settings; lists merge across scopes. The harness passes them inline, generated for each agent (sandboxSettings),
//   and keeps a copy in the agent's session folder (sandbox-settings.json) — no token is ever in them: the allowlist is
//   host names, the paths are folders, the credentials block names what to hide.
//
// The rules for a worktree agent (sandboxSettings):
// - writable: its worktree (the working directory; on a remote machine the variation folder's repos/, every
//   repository's checkout) and temp, plus the package managers' content-addressed caches (~/.npm, pnpm's store) so an
//   install in the worktree still works. The ticket's folder changes only through agent.sh, excluded from the sandbox
//   by its absolute path alone (the Mac's harness agent.sh and off-board.sh; a remote machine's
//   ~/harness/bin/agent.sh, the forwarder's client, which reaches the Mac's forwarder on the machine's loopback — out
//   of a Linux sandbox's reach otherwise). On the Mac the agent.sh guard (agent-sh-guard.js, ASS-463) refuses a line
//   that calls it but is not that call alone, which would run sandboxed and fail. An agent working in the project's
//   dev container runs `docker exec -w <its folder> <container> …` outside the sandbox (the container is the
//   project's own boundary; the docker socket is never opened to sandboxed commands).
// - network: the project's allowlist, ASS-538's (src/substrate/egress.js allowlist: its repositories' forges, the
//   model API, the declared GitLab / GitHub, the npm registry, dev-environments.substrate.egress.allow), strict.
//   The Mac's forwarder is reached through the excluded agent.sh and Hindsight through the MCP server, both outside
//   the sandbox; on the Mac allowLocalBinding lets a command bind and reach localhost (a test suite's own servers).
// - credentials: no more than a sandboxed agent gets. The model credentials (CLAUDE_CODE_OAUTH_TOKEN,
//   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN), which only Claude Code itself uses, are removed from every sandboxed
//   command's environment; the credential files of the machine's own logins (ssh keys, gh, glab, gcloud, docker, kube,
//   aws, netrc, ~/.harness; on the Mac the projects' project.json, which holds the Jira analytics token; on a remote
//   machine its runtime folder) are unreadable. A remote machine's forge token stays in the environment, as for every
//   agent there (its where-text: git and package installs only; it pushes its branch), within the allowlist.
//
// Where the sandbox cannot run, the agent runs unsandboxed in its worktree (ASS-564, operator decision 2026-11-23: "If
// it doesn't allow you to run Claude Code's sandbox then just do it in a worktree without the sandbox"): a remote
// machine whose setup found it unavailable (no bubblewrap or socat, or bwrap refused: setup.sandbox in
// workstations.json, remoteSandboxProblem) or has not probed it yet, and the Mac should Seatbelt be missing
// (macSandboxProblem). Such a machine stays a candidate for the worktree targets: the step is placed there as
// anywhere else, never refused or moved for it. workstation:setup still installs what the sandbox needs where it can
// (ASS-563), so this is rare. Its agent starts with unsandboxedSettings instead — no sandbox, so no
// failIfUnavailable to make Claude Code exit — keeping what holds outside the sandbox: the file tools held to its
// working directories (blockWritesOutsideWorkingDirectories), no token in its settings, the prompt's write rules
// (unsandboxedWhereText). Dispatch logs each such run once per machine and records it in the agent's session folder
// (sandbox.json, { sandboxed: false, why }), which the ticket screen and the footer's worktree lines show. Where the
// sandbox works nothing changes: its settings keep failIfUnavailable, so a sandboxed agent never silently loses it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The run targets whose agents run in Claude Code's sandbox.
export const SANDBOXED_TARGETS = Object.freeze(['local-worktree', 'local-workspace', 'workstation-worktree', 'cloud-vm-worktree']);
export const isSandboxedTarget = t => SANDBOXED_TARGETS.includes(t);
export const MAC_SANDBOXED = Object.freeze(['local-worktree', 'local-workspace']);

// The environment variables only Claude Code itself reads: never a sandboxed command's.
export const MODEL_CREDENTIALS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
// The credential files of a machine's own logins, unreadable to sandboxed commands (~ is the machine's home).
const LOGINS = ['~/.ssh', '~/.netrc', '~/.git-credentials', '~/.config/gh', '~/.config/glab-cli', '~/.config/gcloud', '~/.config/acli', '~/.docker/config.json', '~/.kube', '~/.aws', '~/.harness', '~/.claude/.credentials.json'];
export const CREDENTIAL_FILES = Object.freeze({
  mac: Object.freeze([...LOGINS, '~/Library/Application Support/glab-cli']),
  linux: Object.freeze(LOGINS),
});
// The package managers' caches, content-addressed: writable so an install in the worktree works.
export const CACHES = Object.freeze({ mac: Object.freeze(['~/.npm', '~/Library/pnpm', '~/Library/Caches/pnpm']), linux: Object.freeze(['~/.npm', '~/.local/share/pnpm', '~/.cache/pnpm']) });

const uniq = list => [...new Set(list.filter(Boolean).map(p => String(p).replace(/(.)\/+$/, '$1')))];

// sandboxSettings({ platform, worktree, writable, hosts, agentSh, container, guard, deniedReads }) — the Claude Code
// settings an agent on a sandboxed target starts with (see the module comment). `platform` 'mac' or 'linux';
// `worktree` its working directory; `writable` more folders it may write (a remote variation's repos/); `hosts` the
// project's allowlist (host names, `*.` wildcards); `agentSh` the absolute paths of the harness commands run outside
// the sandbox; `container` { name, folder } when it works in the project's dev container; `guard` the PreToolUse hook
// command (the Mac's agent.sh guard); `deniedReads` more paths it may not read. Never a secret: paths and host names.
export function sandboxSettings({ platform = 'mac', worktree, writable = [], hosts = [], agentSh = [], container = null, guard = null, deniedReads = [] } = {}) {
  if (!worktree) throw new Error('sandboxSettings: no worktree');
  const excluded = [...uniq(agentSh).map(p => `${p} *`), ...(container?.name && container?.folder ? [`docker exec -w ${container.folder} ${container.name} *`] : [])];
  return {
    permissions: { blockWritesOutsideWorkingDirectories: true, deny: ['WebFetch'] },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      excludedCommands: excluded,
      filesystem: { allowWrite: uniq([worktree, ...writable, ...CACHES[platform]]) },
      network: { allowedDomains: uniq(hosts), strictAllowlist: true, ...(platform === 'mac' ? { allowLocalBinding: true } : {}) },
      credentials: {
        files: uniq([...CREDENTIAL_FILES[platform], ...deniedReads]).map(path => ({ path, mode: 'deny' })),
        envVars: MODEL_CREDENTIALS.map(name => ({ name, mode: 'deny' })),
      },
    },
    ...(guard ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: guard }] }] } } : {}),
  };
}

// remoteSandboxProblem(entry) — why Claude Code's sandbox cannot run on a remote machine, from its workstations.json
// entry (workstation:setup's probe, setup.sandbox: { ok, why }); null when it can. A machine whose setup has not
// probed it (an older setup, or none yet) is "not checked yet": ASS-564, its worktree agents then run unsandboxed.
export function remoteSandboxProblem(entry) {
  const s = entry?.setup?.sandbox;
  if (s?.ok === true) return null;
  if (s?.ok === false) return s.why || 'its setup found it unavailable';
  return 'not checked yet (its setup predates the sandbox probe, or has not run)';
}

// SEATBELT — what Claude Code's sandbox runs commands through on macOS (Seatbelt's sandbox-exec, part of macOS).
export const SEATBELT = '/usr/bin/sandbox-exec';
// macSandboxProblem(exists) — ASS-564: why Claude Code's sandbox cannot run on the Mac (Seatbelt's sandbox-exec
// missing), or null; `exists` (fs existsSync) asked of SEATBELT.
export const macSandboxProblem = (exists = existsSync) => (exists(SEATBELT) ? null : `Seatbelt's ${SEATBELT} is missing`);

// unsandboxedSettings() — ASS-564: the settings of a worktree agent where the sandbox cannot run: Claude Code's
// sandbox off (so a repository's own settings can't turn it on with failIfUnavailable, making Claude Code exit), the
// file tools still held to its working directories, which Claude Code applies outside the sandbox too. No secret.
export const unsandboxedSettings = () => ({ permissions: { blockWritesOutsideWorkingDirectories: true }, sandbox: { enabled: false } });

// homeOf(folder) — the remote user's home, from a remote variation folder under <home>/harness/ (machine-workstation.js parts).
export const homeOf = folder => String(folder).replace(/\/harness(\/.*)?$/, '');
// remoteAgentSh(folder) — a remote machine's agent.sh by its absolute path: workstation:setup's wrapper, ~/harness/bin/agent.sh.
export const remoteAgentSh = folder => join(homeOf(folder), 'harness', 'bin', 'agent.sh');

// sandboxWhereText({ worktree, agentSh }) — what the agent is told of its sandbox, after its {where}.
export const sandboxWhereText = ({ worktree, agentSh }) =>
  `You run inside Claude Code's sandbox: your commands may write only ${worktree} (your worktree) and temp, and reach only this project's allowed hosts; anything else is refused ("Operation not permitted", or the proxy refusing the host) — say so in your result rather than work around it. Run ${agentSh} by that absolute path, each call a Bash call of its own and a bare command line (no cd before it, nothing chained after it, no pipe, redirect or heredoc): only that runs outside the sandbox; give it content by a file you wrote first.`;

// unsandboxedWhereText({ worktree, agentSh, why }) — ASS-564: what an agent told it runs without the sandbox is told,
// after its {where}: the same write rules, kept by the agent itself.
export const unsandboxedWhereText = ({ worktree, agentSh, why }) =>
  `Claude Code's sandbox is unavailable on this machine (${why}), so your commands run unsandboxed: all the same, write only inside ${worktree} (your worktree) and temp, reach only the hosts your work needs, and never read or copy credentials. Run ${agentSh} by that absolute path.`;
