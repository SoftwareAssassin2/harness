# Harness

The harness runs AI coding agents on a project's tickets, from backlog to
merged change, with a person approving at the gates.

- **Control** ([src/control/main.js](src/control/main.js)) is a long-lived
  process that ticks every couple of seconds: it finishes agents whose turns
  ended, runs the steps no agent works, and dispatches the next.
- **State engines** ([engines/](engines/)) describe a ticket's workflow as
  JSON: steps, the action each runs (a prompt for an agent, or a script),
  and where each exit goes. Grouped engines nest sub-engines; see
  [engines/grouped-engines.md](engines/grouped-engines.md).
- **Agents** are Claude Code (or other agentic CLI) sessions, given a prompt
  composed from [prompts/](prompts/) and a persona from [personas/](personas/).
  They report back through [agent.sh](agent.sh).
- **Lima VMs**: each ticket's work runs in its own VM, a copy-on-write clone of
  the project's golden image (Lima, `vmType: vz`, Apple's Virtualization
  framework). See [src/agent-cli/vm/build-golden.sh](src/agent-cli/vm/build-golden.sh).
- **Hindsight memory**: each project has a local Hindsight server the agents
  recall from and save to. See [src/agent-cli/memory/up.sh](src/agent-cli/memory/up.sh).
- **TUI**: a terminal dashboard that starts control and the downloader (which
  pulls tickets and merge requests from Jira, GitLab and GitHub) and shows the
  sprint, agents, tickets and spend. See [src/tui/](src/tui/).

## Prerequisites

- An Apple Silicon Mac, on a macOS version Lima's `vz` driver supports
- [Node.js](https://nodejs.org/) (a current LTS) and `jq`
- [Lima](https://lima-vm.io/) (`brew install lima`), with room for VMs in its
  folder (`vm-disk-limit-gb` in `data/harness.json`, 120 by default). Control
  watches the free space on that volume and the data folder's: below
  `disk-free-warn-gb` (50) it warns and deletes the stopped VMs no ticket
  needs; below `disk-free-hold-gb` (15) it starts no new work until there is
  room again
- Python 3.11 or newer, for Hindsight (`brew install python@3.12`)
- [Claude Code](https://claude.com/claude-code)
- `git`, plus whichever of `glab`, `gcloud` and `gh` your project uses
- Optional: [terminal-notifier](https://github.com/julienXX/terminal-notifier)
  (`brew install terminal-notifier`), for Operator Needed notifications you can
  click (see below)

`/install` checks these and tells you how to install what is missing.

## Quick start

A project's setup comes as a **preset bundle**, a `.tar.gz` a teammate who
already runs the project exports and hands you privately. Bundles never go in
this repo.

1. Clone this repo and check out the project's own code somewhere on your Mac.
2. Run `./harness.sh tui` in the harness folder. With no project installed
   yet, it runs `/install` first, in Claude Code in the same terminal, and
   starts the dashboard when that session ends. (Or open Claude Code in the
   harness folder and run `/install` yourself.)
3. Answer its questions: the bundle's path, your project checkout's folder,
   and the Lima folder (default `~/.lima`).
4. It installs the project into `data/projects/<project>/`, then walks you
   through the credentials (you create the keychain items and paste your own
   tokens; it never sees them), the `glab`/`gcloud` logins, building the
   golden VM image and starting Hindsight. If a step can't finish, it says
   which one is left and why.
5. Quit Claude Code when `/install` is done: the dashboard starts, with
   control and the downloader. If no project got installed, it asks whether
   to start the dashboard anyway. Afterwards, start the harness with:

   ```sh
   ./harness.sh tui
   ```

   It skips `/install` once a project is installed, when the terminal isn't
   interactive, or with `HARNESS_SKIP_INSTALL=1`.

`/install` does its file work through a command you can also run yourself:

```sh
./harness.sh install-project acme-shop-preset.tar.gz --project-root ~/src/acme-shop [--lima-home <folder>] [--force]
```

It writes the Lima folder to `data/harness.local.json`, this machine's own
settings, gitignored, so the tracked `data/harness.json` never shows a
change; `LIMA_HOME` still overrides it. It refuses to overwrite an installed
project without `--force`, keeps a
credentials entry you already have for the project (`--force` replaces it
with the bundle's placeholders), and leaves the remaining manual steps
printed for you.

## Operator Needed notifications

While the dashboard runs, each ticket that becomes Operator Needed (blocked
for a human, at a human step or gate, with a pending requirements change or
an open blocking question) gets its own macOS notification, with the default
sound: "<KEY> needs you", the project and ticket title, and one line written
by Claude (claude-haiku-5-5, on the project's own Claude login, the
subscription first; its cost counts toward the project's spend) saying what
you need to do and why. If that call fails or takes more than 20 seconds, the
notification carries a plain line instead, such as "Blocked for Human: …".
Tickets already waiting when the dashboard starts don't notify; a ticket
notifies again only after it has stopped waiting and starts again.

- With `terminal-notifier` on the PATH (`brew install terminal-notifier`), a
  newer notification for a ticket replaces the older one, and clicking it
  brings Ghostty, where the dashboard runs, to the front and opens that
  ticket's screen. Without it, or when it fails (for example without
  permission), notifications go through `osascript`, with no click action.
  The control screen (`c`) says which one the dashboard uses.
- macOS asks for permission the first time. If nothing shows, allow it in
  System Settings → Notifications → terminal-notifier (or Script Editor,
  for the `osascript` fallback).
- To turn them off for a project, set `"operator-needed-notifications": false`
  in its `data/projects/<project>/project.json`. They are on when it is
  absent.

## Exporting a project

To share a project you run with a teammate:

```sh
./harness.sh export-project acme-shop [<out-file>] [--as <key>] [--name <display name>] [--engine-prefix <from>=<to>]
```

It writes `./acme-shop-preset.tar.gz` (or `<out-file>`) and prints its path.
`--as` and `--name` export the project under another key and display name
(the default file then follows the new key): the key is replaced as a whole
word throughout the bundle, so `acme-shop` changes but `acmeshop` doesn't.
`--engine-prefix acme=engineering` renames the project's own engines
`acme-…` to `engineering-…`, with every reference to them. Both rename only
the bundle, never your own project or engines.
The bundle holds the project's setup (`project.json` without runtime state,
machine paths, emails or keychain names), its golden image definition, its
merge-request notes, its own state engines, a credentials template with
placeholders, and a manifest of the steps install must run. It never reads a
secret, and it fails if it finds anything token-shaped. Send it privately.

## The three CLIs

Each is a small dispatcher over a folder of scripts: `<command>` runs `src/<cli>/<command>.sh` and `<family>:<command>` runs
`src/<cli>/<family>/<command>.sh`. Add a script and it becomes a command. Run
any of them with `--help` to list its commands.

| CLI | Who uses it | Commands live in |
|---|---|---|
| [`./harness.sh`](harness.sh) | you: the TUI, the downloader, install and export | [src/harness-cli/](src/harness-cli/) |
| [`./agent.sh`](agent.sh) | control and the agents: assignments, VMs, memory, code, merge requests | [src/agent-cli/](src/agent-cli/) |
| [`./off-board.sh`](off-board.sh) | tickets kept in the harness rather than in Jira | [src/off-board-cli/](src/off-board-cli/) |

## Repo layout

| Path | What's there |
|---|---|
| [src/control/](src/control/) | control: ticks, planning, dispatch, VM lifecycle, spend |
| [src/tui/](src/tui/) | the dashboard |
| [src/agents/](src/agents/) | agent sessions, usage and accounts |
| [src/downloader/](src/downloader/) | Jira, GitLab, GitHub and off-board downloads |
| [src/harness-cli/](src/harness-cli/), [src/agent-cli/](src/agent-cli/), [src/off-board-cli/](src/off-board-cli/) | the CLIs' commands |
| [engines/](engines/) | the state engines every project can use |
| [prompts/](prompts/) | the prompt templates agents are dispatched with |
| [personas/](personas/) | the roles agents take (developer, tester, architect, …) |
| [data/](data/) | live data ([src/data-folder.js](src/data-folder.js)): `harness.json` settings, this machine's own in the untracked `harness.local.json`, and one folder per project, mostly gitignored |
| [test/](test/) | `npm test` |

A project's own data lives in `data/projects/<project>/`: its `project.json`,
golden image, merge-request notes and any state engines of its own
(`engines/<name>/state-engine.json`, looked up before the shared `engines/`).

## License

[MIT](LICENSE)
