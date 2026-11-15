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

   `Q` quits: control and the downloader stop (control stops its agents),
   then every running VM in the harness's Lima folder is stopped, a running
   golden image build is interrupted (the next build starts over), and the
   dashboard exits. Each VM gets `vm-stop-timeout-seconds` (in
   `data/harness.json`, 60 by default) to stop before it is force-stopped;
   press `Q` again to force-stop them all at once. VMs are only stopped,
   never deleted. A restart (a fix asking the harness to load new code)
   leaves the VMs running.

   A control that crashes is started again by the dashboard after 5 s, 30 s,
   2 min, then every 5 min; after 5 crashes in 10 minutes it stays down until
   you press `R` on the control screen. Either way the header shows it in red
   and you get one notification. A control that cannot read its data (the
   drive dropped out, a file caught half-written) skips its ticks and waits,
   its running agents left alone, for up to `data-unreadable-exit-seconds`
   (in `data/harness.json`, 300 by default) before it exits.

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

### Header warning notifications

The dashboard header's warnings notify the same way, for every project, not
only the one selected: "Project blocked by credentials", the gcloud and glab
logins to renew, "Out of memory", "Out of disk space", "Restart to load …
landed fixes", "No work in progress", and the banner's disk low, sign-in,
rate limit and self-healing. The notification's title is the warning, its
subtitle the project (or "All projects" for one the whole harness shares), and
its body says what to do, such as the credentials hold's first fix or
"Restart the harness to load …". Clicking it brings Ghostty forward and
selects that project.

- Each warning notifies once when it appears, and again only after it clears
  and comes back. Warnings already up when the dashboard starts don't notify
  (the seen set is kept in `data/header-warnings-seen.json`).
- "No work in progress" notifies only once it has stayed up for 5 minutes.
- Warnings you caused yourself (Background work off, your own pause) never
  notify.
- Harness-wide warnings (Out of memory, Out of disk space, the disk low,
  Restart to load …) notify once, not once per project.
- `"operator-needed-notifications": false` turns these off for that project
  too.

## Where a project's tickets run: VMs and GCP workstations

By default each ticket variation runs in a Lima VM of its own. A project can
instead say, in its `data/projects/<project>/project.json`, that its tickets
run on existing GCP Cloud Workstations, reached over SSH (the harness reuses
them, it never creates them):

```json
"dev-environments": {
  "mode": "vm+workstation",
  "workstations": [
    {
      "id": "ada-dev",
      "gcp-project": "example-gcp-project",
      "region": "us-central1",
      "cluster": "example-workstations",
      "config": "example-config",
      "gcloud-config": "~/.config/example/gcloud"
    }
  ]
}
```

- `mode`: `vm` (VMs only, as without `dev-environments`; the default when
  missing), `workstation` (workstations only) or `vm+workstation`
  (a free workstation first, a VM only when none is free).
- `workstations`: the pool, each with its workstation `id`, `gcp-project`,
  `region`, `cluster` and `config`, and optionally `gcloud-config`, the
  `CLOUDSDK_CONFIG` folder of the gcloud login that reaches it (a leading `~`
  or `$HOME` is expanded). Required, with at least one, in `workstation` and
  `vm+workstation` modes.

Control logs an error naming the field, and uses neither, when the mode is
unknown, a workstation mode lists no workstations, a workstation misses a
field or two share an id. Which ticket holds a workstation and whether it is
running are live data, never kept in `project.json`. Commands read these
settings through `src/agent-cli/dev-environments.bash`, control and the
dashboard through `src/control/dev-environments.js`.

Control reaches a workstation over one SSH connection it keeps open while
the workstation is needed, starting the workstation when it is stopped:
`./agent.sh workstation:connect <project> <id>`, `workstation:status`,
`workstation:ssh` and `workstation:disconnect` do the same by hand (see
`engines/grouped-engines.md`, "A GCP workstation's connection"). The
forwarder, the project's Hindsight and its zot appear on the workstation's
own localhost at their usual ports. When the workstation's gcloud login has
lapsed the dashboard says `run 'CLOUDSDK_CONFIG=~/.config/example/gcloud
gcloud auth login' asap`; run it, and control connects again within two
minutes.

Once connected, control sets the workstation up for the harness's agents —
`./agent.sh workstation:setup <project> <id>` does it by hand — installing
what is missing under `~/harness` only (agent.sh, jq, the Claude Code CLI)
and checking git, curl, Docker and the project's `golden-image.tools`. A
tool the workstation lacks is installed by the project's optional
`golden-image/workstation-tools.sh`, given the missing tools' names and
`HARNESS_BIN` to put them in; the golden-image folder's other top-level
files (not Lima's `provision.sh`, `template.yaml`…) are shipped beside it, so
it can source one it shares with `provision.sh`. Until setup succeeds nothing is dispatched to
the workstation and the dashboard shows `Workstation <id> setup failed` (see
`engines/grouped-engines.md`, "A GCP workstation's setup").

In those modes Setup's Create VM places each ticket variation on a free
workstation (one variation per workstation; a VM only when none is free in
`vm+workstation` mode, a wait in `workstation` mode) and readies its own
folder there, `~/harness/<KEY>-<variation>`: the repositories, a read-only
copy of the ticket folder kept up to date, the credentials and forwarder
token in the setup's runtime folder. Its agents run there over the
connection; it keeps the workstation until it is Done, when control removes
the folder (`./agent.sh workstation:release <project> <id>` does it by hand).
While the workstation cannot be used the ticket waits and its Health says
why. Agents there act as the workstation's user: on the test workstation,
with the owner's git identity and GitLab key (see
`engines/grouped-engines.md`, "A ticket variation on a GCP workstation").

## Arm64 builds of images a project publishes for amd64 only

Ticket VMs are arm64 (Lima `vz` on Apple Silicon). An image a project pins
but publishes for amd64 only runs in them emulated, far slower: a database
gate replaying hundreds of migrations may not finish within a step. The
harness can build an arm64 variant of such an image itself and serve it from
the project's zot under the unchanged pinned name, so VMs run it natively.

Declare each image in `data/projects/<project>/project.json`. `image` is its
name in the golden image's `images.txt`, without the tag: the tag is always
the one `images.txt` pins, so bumping the pin there builds the new tag. Give
exactly one way to build it:

```json
"arm64-images": [
  {
    "image": "us-central1-docker.pkg.dev/example-gcp-project/containers/example-db",
    "build": {
      "repository": "example-db-images",
      "ref": "v{tag}",
      "context": "db",
      "dockerfile": "Dockerfile",
      "args": { "PG_VERSION": "{tag}" }
    }
  },
  {
    "image": "us-central1-docker.pkg.dev/example-gcp-project/containers/example-tools",
    "base-swap": { "base": "debian:13-slim", "copy": ["/opt/tools"] }
  }
]
```

- `build`: the image's own Dockerfile. `repository` is the name of one of
  the project's `repositories`, or any git URL the Mac's git can clone;
  `ref` a branch, tag or commit; `context` the folder in it (default `.`),
  `dockerfile` the file in the context (default `Dockerfile`), `args` its
  build args. `{tag}` in `ref` or an arg is the pinned tag.
- `base-swap`: for an image that is a thin layer over a multi-arch base. The
  base's arm64 image with each `copy` path taken from the pinned amd64 image;
  its command and environment are the base's.

A declaration naming an image `images.txt` does not pin by tag, or giving no
build source, is refused with every problem named
(`./agent.sh registry:arm64-status <project>` shows them).

Control runs `./agent.sh registry:arm64-build <project>` every 30 minutes,
and `vm:build-golden` runs it before it builds. It builds only a pinned tag
that has no variant yet (a new tag, or one the registry sweep removed), for
`linux/arm64` with the Mac's Docker (Docker Desktop must be running and able
to pull the base images, and for a base swap the pinned image:
`gcloud auth configure-docker <upstream host>`). It pushes into the project's
zot, as `0local/<path>:<tag>`, a multi-arch index of the upstream amd64 image
(its manifest unchanged) and the arm64 build. A VM's Docker asks `0local`
first (`registry:hosts-toml`), gets the index and takes its `linux/arm64`
image; without a variant it falls through to zot's cache and gets amd64, as
before. A failed build is reported per image with the end of its build log
(`<registry storage>/arm64/<path>.log`, in control's log too) and never
blocks a pull: the image stays amd64 until a later run builds it. The golden
image counts each variant among its inputs, so a new one makes it stale and
the next build bakes it in; until then each VM pulls it at its next start.

`./agent.sh registry:arm64-status <project>` prints, per declared image, the
pinned `tag`, `arm64` (true when the variant is served; false when VMs get
amd64; null when the zot is not answering), `built-at`, `digest` (the arm64
image's) and the last build `log`.

**Dropping a ticket's CI-only stopgap.** When a gate was made CI-only for a
ticket because its image ran emulated (a note in the ticket's execution
plan), declare the image, then wait until `registry:arm64-status` shows
`"arm64": true` for the tag the project pins. Remove the note from the
execution plan so the gate runs in the VM again; the VM has the arm64 image
from its next start (or at once with `docker pull <image>:<tag>` in it), and
`docker image inspect --format '{{.Architecture}}' <image>:<tag>` there says
`arm64`. If the project later publishes a multi-arch image itself, drop the
declaration: `registry:arm64-build` reports such an image as `upstream` and
builds nothing.

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
