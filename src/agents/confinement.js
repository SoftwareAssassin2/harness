// The rules that hold an agent the harness starts on the host and that is not
// working a ticket's code (ASS-108): backlog grooming, health checks, Blocked's
// host steps. (The chat and ticket-expert screens' agents are not confined:
// the chat rules, prompts/chat-rules, have them ask before any change.) They are Claude Code's own
// settings, which the harness writes in its own folder and starts the agent
// with (--settings), so a write anywhere but temp is refused by Claude Code,
// not by instruction (ASS-182): the harness's data, archive/ and src/off-board/
// change only through agent.sh and off-board.sh, which validate and lock every
// write — and nothing is written into a project's repository:
// - permissions (code.claude.com/docs/en/permissions): dontAsk refuses every
//   call no allow rule covers; Edit(path) rules cover every tool that edits
//   files (Edit, Write, NotebookEdit); `//path` is absolute; deny beats allow.
// - sandbox (code.claude.com/docs/en/sandboxing): every Bash command, and what
//   it starts, may write only its working directory, temp and allowWrite,
//   never denyWrite (Edit allow/deny rules are added to those lists); it never
//   runs a command outside the sandbox but the excludedCommands, and Claude
//   Code will not start without it (failIfUnavailable).
// The agent runs in data/projects/<id>/, a data folder, so the sandbox's own
// working-directory allowance never reaches a checkout, and the data folder's
// deny takes it back; it reads the project's code where its prompt says, and
// reading is not limited.
import { mkdirSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dataDir } from '../data-folder.js';

// The harness's data under its root, beside its data folder (src/data-folder.js): written only through its CLIs.
const ROOT_FOLDERS = ['archive', join('src', 'off-board')];
const SETTINGS = 'host-agent-settings.json';
// What the agent may use without being asked — everything but writing files,
// which only the Edit rules allow; the network as before (the sandbox's
// proxy takes WebFetch domain rules as its allow-list, `*` every host); and
// every tool of its project's memory, the hindsight MCP server (ASS-62).
const TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'TodoWrite', 'Agent', 'Task', 'Skill', 'mcp__hindsight'];
// Commands run outside the sandbox, matched on the whole command line (every
// command in it): the harness's own CLIs, which write its data, the VMs and
// the projects' ticket systems by design and are not the agent's to change;
// the forge and ticket CLIs, Go programs that fail TLS under macOS's sandbox
// (sandboxing.md, "Go-based CLIs fail TLS verification"); docker's read-only
// commands, which need its socket. Never a shell, interpreter, filter
// (ASS-182: an unsandboxed jq or grep could redirect into data/) or anything
// that writes a file it is given — so a command line that pipes an agent.sh
// write through anything runs it sandboxed, and its write is refused.
const EXCLUDED = root => [`${root}/agent.sh *`, `${root}/off-board.sh *`, 'gh *', 'glab *', 'acli *',
  'docker ps *', 'docker inspect *', 'docker images *', 'docker logs *', 'docker compose ps *', 'docker compose ls *'];

// hostAgentSettings(root, data) — the settings object for the host agents of
// the harness at root, its data folder `data` (dataDir(root) unless given).
export function hostAgentSettings(root, data = dataDir(root)) {
  // Temp as given and as it resolves (/var → /private/var): an Edit allow rule must match both.
  const tmp = [...new Set([tmpdir().replace(/\/$/, ''), realpathSync(tmpdir())])];
  const writable = [...tmp, '/tmp', '/private/tmp'];
  // The data folder — the agent's own working folder, every project's Claude login (ASS-26) and these settings in it — and the root's.
  const denied = [data, ...ROOT_FOLDERS.map(f => join(root, f))];
  const edit = path => `Edit(/${path}/**)`;
  return {
    permissions: { defaultMode: 'dontAsk', allow: [...TOOLS, ...writable.map(edit)], deny: denied.map(edit) },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      excludedCommands: EXCLUDED(root),
      filesystem: { allowWrite: writable, denyWrite: denied },
    },
  };
}

// confineHostAgent({ root, data, project }) — where a host agent of the
// project runs and the settings file it starts with (data as for
// hostAgentSettings): { cwd: <data>/projects/<project>/, settings:
// <data>/projects/<project>/host-agent-settings.json, written now, through a
// temp file renamed over it }.
export function confineHostAgent({ root, data = dataDir(root), project }) {
  const cwd = join(data, 'projects', project);
  mkdirSync(cwd, { recursive: true });
  const settings = join(cwd, SETTINGS);
  // Written beside and renamed over (ASS-288): a write cut short — a full disk — throws before the rename, never leaving half a file.
  const temp = `${settings}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(hostAgentSettings(root, data), null, 4)}\n`);
    renameSync(temp, settings);
  } catch (error) { rmSync(temp, { force: true }); throw error; }
  return { cwd, settings };
}
