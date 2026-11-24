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
- [Node.js](https://nodejs.org/) (a current LTS) with npm, and `jq`. The
  harness's npm dependencies (the `yaml` package, which reads the engines'
  `workflow.yaml`) are pinned in `package-lock.json`: `npm ci` installs them,
  and `./harness.sh tui` and `install-project` run it themselves when
  `node_modules/` is missing
- [Lima](https://lima-vm.io/) (`brew install lima`), with room for VMs in its
  folder (`vm-disk-limit-gb` in `data/harness.json`, 120 by default). Control
  watches the free space on that volume (and on each project's own Lima
  folder's, below) and the data folder's: below
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

1. Clone this repo, run `npm ci` in it (the dashboard does it on its first
   start if you don't), and check out the project's own code somewhere on your Mac.
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
   then every running VM in every Lima folder in use (the harness's and each
   project's own) is stopped, a running
   golden image build is interrupted (the next build starts over), and the
   dashboard exits. Each VM gets `vm-stop-timeout-seconds` (in
   `data/harness.json`, 60 by default) to stop before it is force-stopped;
   press `Q` again to force-stop them all at once. VMs are only stopped,
   never deleted. A restart (a fix asking the harness to load new code)
   leaves the VMs running.

   To restart the harness yourself — to load a change, or just to restart —
   run `./agent.sh harness:request-restart` with no ticket key (ASS-507). It
   is the same restart a fix asks for: each control dispatches nothing more,
   lets its running agents end their turns (up to `restart-drain-seconds`),
   exits with 75, and the dashboard starts again on the new code, VMs left
   running. `~/.harness/restart-requested.json` records it as
   `"operator": true`; a fix's pending request and yours join into one
   restart, keeping its tickets. `./agent.sh harness:restarted` with no key
   says whether the latest request has been fulfilled (exit 1 while it is
   pending, 2 when there is none); control's log says the restart was
   requested "by the operator".

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
printed for you. A bundle never carries a project's own Lima folder (below):
a project reinstalled with `--force` keeps its own `lima-home`.

### A project's own Lima folder

All projects' VMs live in the one Lima folder above unless a project says
otherwise (ASS-578): an optional `lima-home` in its
`data/projects/<project>/project.json`, an absolute path, keeps that
project's golden image and ticket VMs there instead (say, a project with big
VMs on a disk of its own), while the others stay where they are. A project's
golden image and its VMs are always in the same folder: a ticket VM is an
APFS copy-on-write clone of the golden disk, and clones can't cross volumes.

- Every Lima call for the project's VMs (create, start, stop, delete, the
  golden build, credentials, ports, the code hand-over) runs with its folder
  as `LIMA_HOME`, per call: `src/agent-cli/lima-home.bash` (`lima_home
  <project>`, `lima_vm_home <instance>`) for the bash commands,
  `src/control/machine-lima.js` (`projectLimaHome`, `vmLimaHome`) for control
  and the dashboard.
- The harness-wide views cover every folder in use: the disk check (each
  folder's volume against `disk-free-warn-gb` and `disk-free-hold-gb`, the
  least free deciding), `vm:reclaim-all` (each volume below the warning level
  reclaimed from the VMs of the projects whose folder it holds), the memory
  and CPU readings, the VM inventories and statuses, `vm:ports` (ssh ports are
  the Mac's, so no two instances in any folder pin one), and the dashboard's
  shutdown.
- A `lima-home` that isn't an absolute path, or isn't writable (its nearest
  existing folder: an unmounted disk's `/Volumes/<name>` is not), is named in
  control's log (`lima-home …`), and the project's VM commands refuse to run
  until it is fixed.
- Lima keeps its config, SSH key and networks under `<folder>/_config`. A new
  folder gets its own key on first use; Lima 2.x gives a VM the key of the
  folder it starts from at every boot, and `vm:move-lima-home` also copies the
  old folder's key and `networks.yaml` into a new folder that has none, so a
  moved VM accepts SSH as before.

To move a project's VMs, stop the harness, then:

```sh
./agent.sh vm:move-lima-home <project> <folder> --dry-run   # what would move, the space it needs and the target has
./agent.sh vm:move-lima-home <project> <folder>
```

It moves the project's golden image(s), a leftover failed build, and its
ticket VMs, and sets its `lima-home` (or removes it, when the folder is the
harness-wide one). It refuses, moving nothing, while the harness runs, a
golden build of the project runs, any of those VMs isn't stopped, or the
target already holds one of their names. On another volume each instance is
copied whole and sparse-aware (macOS `cp`, which skips a disk's holes), so a
clone becomes a full copy: it adds up what each one allocates and refuses
unless the target's volume keeps `disk-free-hold-gb` free after it (deleting
VMs no ticket needs first, `vm:reclaim <project>` or `vm:delete`, makes it
smaller). Each copy is checked (every file there with its size, the small ones
byte for byte) and seen `Stopped` by `limactl list` under the new folder
before `lima-home` is set and the old copies deleted; a failure part way
leaves the old copies and the setting as they were. On the same volume each
instance is just renamed into place.

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
- `./agent.sh ticket:operator-needed [<project>]` prints the same Operator
  Needed set as JSON, whether or not the harness is running, and writes
  nothing: each ticket's reason, an open blocking question's `where` and
  `index` for `question:answer`, and the dashboard's choices, each with the
  `argv` to run (`./agent.sh <argv…>`; one marked `needs-reason` takes the
  reason last).

### Header warning notifications

The dashboard header's warnings notify the same way, for every project, not
only the one selected: "Project blocked by credentials", the gcloud and glab
logins to renew, a Substrate cluster broken (ASS-533) and the other Substrate
warnings (ASS-539: a template with no golden snapshot, Docker's memory low,
snapshot disk use high, a sandbox image build failed, a sandbox that could not
be set up), the Atlassian sign-in (ASS-561, below), "Out of memory", "Out of
disk space", "Restart to load … landed fixes", "No work in progress", and the banner's disk low, sign-in,
rate limit and self-healing. The notification's title is the warning, its
subtitle the project (or "All projects" for one the whole harness shares), and
its body says what to do, such as the credentials hold's first fix or
"Restart the harness to load …". Clicking it brings Ghostty forward and
selects that project.

- Each warning notifies once when it appears, and again only after it clears
  and comes back. Warnings already up when the dashboard starts don't notify
  (the seen set is kept in `data/header-warnings-seen.json`).
- "No work in progress" notifies only once it has stayed up for 5 minutes.
  It is up only while no agent works a sprint ticket and no sprint ticket is
  running a script (the sprint screen's 💻; one paused or held at a gate
  does not count).
- Warnings you caused yourself (Background work off, your own pause) never
  notify.
- Harness-wide warnings (Out of memory, Out of disk space, the disk low,
  Restart to load …) notify once, not once per project.
- `"operator-needed-notifications": false` turns these off for that project
  too.

### The Atlassian API token and the acli login (ASS-561)

A project with a jira work source needs two Jira sign-ins on the Mac: an
Atlassian API token, which the downloader's analytics (the `p` screen) use
with Jira's REST API, and the `acli` login, which the downloader's ticket
sync, `ticket:set-ticket-system-status` and `ticket:raise-bug` run under.
One command sets both:

```sh
# copy the token (id.atlassian.com, Security, API tokens), then
./agent.sh project:set-atlassian-token <project>          # or: … <project> --stdin < token-file
```

- It needs the project's `atlassian` entry in `~/.harness/vm-credentials.json`,
  `{ "keychain-service": "…", "site": "<site>.atlassian.net", "email": "…" }`,
  and says what to add when there is none.
- It reads the token from the clipboard (or stdin), saves it as that keychain
  item through `security -i` (the token on its stdin, never on a command
  line), clears the clipboard, runs `acli jira auth login --site <site>
  --email <email> --token` with the token on stdin, then runs
  `project:check-credentials` again. It never prints the token.
- The analytics read the token from that keychain item, with the entry's
  email. A project with no `atlassian` entry keeps using its jira work
  source's `api-email` and `api-token` in `project.json`.
- `project:check-credentials` (control runs it every ~3 minutes) reports the
  keychain item missing or unreadable (with no entry: no `api-token` in
  `project.json` either), `acli` not logged in, or logged in to another
  site. As for the forge logins (ASS-429), an `acli jira auth status` that
  fails only because the site can't be reached is unknown, not a problem.
  `ACLI_DISABLED=1` skips acli.
- These problems **hold nothing**: agent work goes on, and only the analytics
  and the Jira sync are degraded. They are kept apart from the credentials
  hold, in `data/projects/<project>/atlassian-needs.json`, which
  `project:credentials-status` prints as `atlassian`. The dashboard shows a
  red header chip, "Atlassian sign-in: run './agent.sh
  project:set-atlassian-token <project>'", with one notification. It clears
  at the next check that finds nothing, which the command runs itself.
- A token Jira rejects is still the "Jira API token rejected" chip (ASS-475).
  Its fix names the same command.

## Building a ticket two ways

To have a sprint ticket built a second way — say, following the other answer
to one of its questions — add a variation with its own brief:

```sh
./agent.sh ticket:add-variation <project> <ticket-key> --brief brief.md   # {"key":"ABC-123","variation":"B","state":"committed"}
```

The new variation (B, then C, …) starts at Committed (or `--at <state>`) and is
built beside A in its own VM, on its own branches. Its brief is kept as
`variation-brief-B.md` in the ticket's work folder; its agents read it first,
and where it conflicts with the ticket's answered questions it wins, for B
only. At Variation Selection, pick the one to keep (ticket:select-variation).
See "Building a ticket two ways" in `engines/grouped-engines.md`.

## Run targets: where each step runs (ASS-540)

A step that uses a machine (an AI step, or a script step that works on the
ticket's code) runs on one of ten **run targets**:

| Run target | Where | Seat |
|---|---|---|
| `local-substrate`, `workstation-substrate`, `cloud-vm-substrate` | the ticket variation's own Substrate sandbox on the Mac's cluster, a workstation's or a cloud VM's (ASS-535, "Substrate sandboxes" below); a project may list one only once it declares a cluster on that kind of host | its host's seat |
| `local-vm` | the ticket variation's own Lima VM | a Mac seat |
| `workstation`, `cloud-vm` | one of the project's GCP workstations or cloud VMs | that machine's seat |
| `workstation-worktree`, `cloud-vm-worktree` | the ticket variation's own worktree on one of the project's workstations or cloud VMs (ASS-553): a folder of its own there, `~/harness/worktrees/<KEY>[.<variation>]`, its own checkout, the machine's own toolchain, no VM; its agents in Claude Code's sandbox (ASS-555, below), unsandboxed where it can't run (ASS-564); kept between its steps, removed once the ticket is done | that machine's seat |
| `local-worktree` | a git worktree for the ticket variation on the Mac, made on first use from the harness's own clone (ASS-553: `data/projects/<p>/checkouts/<repo>`, never the operator's checkout) and removed once the ticket is done (or deleted); its agents in Claude Code's sandbox (ASS-555), unsandboxed where it can't run (ASS-564) | none |
| `local-workspace` | the project's checkout on the Mac itself, one ticket at a time per project; its agents in Claude Code's sandbox (ASS-555) | none |

`local-worktree` and `local-workspace` take no seat, but what they use is part
of the Mac's measured memory and CPU, so it counts against the seat budget.

Both steps and projects say which targets they take, with the same key:

- **A project**: `dev-environments.run-targets` in its `project.json` lists the
  targets it has and allows, in its default order. It replaces
  `dev-environments.mode`. Unset, it is derived from the mode, so nothing
  changes until a project opts in: `vm` is `[local-vm]`, `workstation` is
  `[workstation, cloud-vm]`, `vm+workstation` is `[workstation, cloud-vm,
  local-vm]`. Set it with `./agent.sh project:set-run-targets <project>
  <target>…` (validated, written whole under the file's lock). The one-off
  `./agent.sh project:migrate-run-targets [--dry-run]` writes every project's
  list from its mode and removes the mode.
- **A step**: `run-targets:` in a `workflow.yaml` step, one target or a list in
  order of preference. Only machine-using steps take it (validation fails it on
  a gate, a human step, a wait or a harness bookkeeping script). The shipped
  engines set it only where a step can't run somewhere (the VM-only scripts:
  `vm:refresh-repositories`, `merge-request:check-numbered-files`,
  `ticket:catch-up-base`…);
  everywhere else the project's list decides. Setup's steps (Check Setup
  Complete, Create VM, Mark Setup Complete) and Blocked's Add the Missing
  Repository take all six machine targets, substrate ones first (ASS-551): on a
  substrate target `vm:create` makes or resumes the variation's sandbox
  (`substrate:sandbox-up`) and clones into its `/repos` any repository its
  image predates, through the Mac (`relay.bash` `relay_clone`), and the setup
  marker is written in the sandbox.

No workflow step runs a project's CI checks (ASS-552): the project's own CI
pipeline runs them on the merge request, and the merge steps
(`merge-request:check`, Await, Merge in Turn) wait for it. `ci-checks:verify`
stays for running the checks a project declares in its golden-image
`ci-checks.json` by hand in a ticket's machine.

Tickets of a project merge side by side (ASS-560). Nothing serialises merges
across tickets: each ticket merges as soon as its own merge requests are
ready. Only a ticket variation's own merge requests keep their planned
depends-on order, a library before its consumer. A ticket that depends on
another still waits for it (`wait-for-dependencies`). When one ticket lands
first, the other's base has moved, and the harness handles it with a rebase:
- On a forge, the merge request needs a rebase. Address Merge Request
  Feedback rebases it, its review and pipeline run again at the new head, and
  the rounds are bounded by that step's `max-visits`.
- The harness's own merge gate (`merge-request:merge-in-turn`, v2-release)
  rebases each of the ticket's pull requests onto the latest main and runs
  the full suite before merging it. Several tickets' gates run at once, each
  under a lock of its variation's own (`work/<KEY>/merge-gate-<var>.lock`);
  ASS-197's project-wide `merge.lock` is gone. A gate whose main moves during
  its run says `base-moved`, and Merge Pull Request goes back into itself to
  rebase and test again. Each return is a visit, so after `max-visits` (5)
  the ticket goes to Blocked, saying why.

The trade-off: each change is tested on its own, on main as it was. Two
changes that are each green but conflict in meaning can both merge, and the
project's CI on main after the merge catches them, not the harness.

**The resolution rule:** a step runs on its own list filtered to the
project's, in the step's order (no list of its own: the project's, in its
order). It takes the first target with a free seat now, and waits only when
none is free. There is no other fallback. A step whose list shares nothing with
the project's is never started, and control logs it once; `./agent.sh
engine:validate <project>` fails on it too, naming the engine and the step
(ASS-551), so run it after changing a project's run targets. Two rules narrow
every list: a command that needs Docker (`src/control/machine-steps.js`
`DOCKER_COMMANDS`, or the project's `dev-environments.substrate.needs-docker`)
never runs on a substrate target, and a command that works only in the ticket's
machine (`MACHINE_ONLY`) never runs on the Mac targets. Listing one of those on
the step is a validation error.

**Worktrees on remote machines (ASS-553):** a step on `workstation-worktree`
or `cloud-vm-worktree` claims its seat's machine as a `workstation` /
`cloud-vm` step does (`workstation:claim --workstation <id> --worktree`), but
its folder is the variation's alone, `~/harness/worktrees/<KEY>[.<variation>]`,
not a numbered slot another ticket may get next: each repository is cloned into
it once (the machine's shared checkout as a reference), and what its steps
leave there (dependencies, build caches) stays its own between them. Its step's
end commits and pushes as any slot's, and keeps the folder. It holds one of the
machine's seats, so it counts against that machine's measured limits beside
its Substrate sandboxes and plain slots (ASS-529): a workstation running two
sandboxed stacks still takes worktree tickets while its memory and CPU allow.
The variation records it as `remote-worktrees`; once the ticket is done,
control runs `./agent.sh workstation:remove-worktree <project> <KEY> <var>`
while the machine is connected (it never starts one for that). A project lists
these targets only with such a machine. The engines' machine-only and Docker
steps list them too (a full machine).

**Worktree agents in Claude Code's sandbox (ASS-555):** every agent on
`local-worktree`, `local-workspace`, `workstation-worktree` or
`cloud-vm-worktree` runs inside Claude Code's own sandbox (Seatbelt on macOS,
bubblewrap on Linux; code.claude.com/docs/en/sandboxing), so outside a VM or a
Substrate sandbox an agent can still write only its worktree and reach only the
hosts its project allows. Agents in Lima VMs and Substrate sandboxes are
isolated already and keep their settings. Control generates the settings for
each agent (`src/agents/worktree-sandbox.js`) and starts it with them inline
(`--settings`), a copy kept as `sandbox-settings.json` in its session folder;
they hold paths and host names, never a token:

| | On the Mac | On a workstation or cloud VM |
|---|---|---|
| Writes (Bash and what it starts) | its worktree (or the workspace), temp, the npm and pnpm caches | the variation folder's `repos/`, temp, the npm and pnpm caches |
| Writes (Write, Edit tools) | its working directory only (`blockWritesOutsideWorkingDirectories`) | its `repos/` (`--add-dir`) |
| Network | the project's allowlist, strict: ASS-538's (its forges, `api.anthropic.com`, the declared GitLab/GitHub, `registry.npmjs.org`, `dev-environments.substrate.egress.allow`); localhost (a test suite's own servers) | the same allowlist; its own loopback |
| Outside the sandbox | the harness's `agent.sh` and `off-board.sh` by absolute path, a bare line (the ASS-463 guard refuses any other line calling them); `docker exec -w <folder> <container> …` for an agent in the dev container | `~/harness/bin/agent.sh` by absolute path (it reaches the Mac's forwarder on the machine's loopback) |
| Hidden | the model credentials from every command's environment; ssh keys, gh, glab, gcloud, docker, kube, aws, netrc, `~/.harness`, every `project.json` | the same, and the machine's runtime folder |

Settings that keep it closed in a headless `--dangerously-skip-permissions`
run: `strictAllowlist` (else a host off the list is allowed),
`allowUnsandboxedCommands: false` (else Claude retries a refused command
unsandboxed; from `--settings` it also makes a repository's own looser
`.claude` sandbox settings ignored), `failIfUnavailable` (else Claude Code runs
commands unsandboxed when the sandbox can't start), and WebFetch denied (the
built-in web and file tools are not sandboxed; the Hindsight MCP server is
reached by Claude Code itself). A refused write fails with "Operation not
permitted", a refused host with the proxy's 403. What it can't do from a
worktree: plain `ssh` (git over SSH on macOS), database drivers and other
non-HTTP tools, Docker (no socket), writing `.claude/` settings, skills or
hooks, `.git/hooks`, `.gitconfig` in the worktree (Claude Code's protected
paths), and WebFetch. A remote machine's forge token stays in the environment,
as for every agent there (it pushes its branch), within the allowlist.

On a remote machine the sandbox needs `bubblewrap` and `socat`, and bwrap
allowed to make user namespaces (Ubuntu's AppArmor restriction refuses it).
`workstation:setup` installs what it needs (ASS-563), on the machine as it is,
never changing how it is stood up (its infrastructure code, config, image or
machine type), and again at every start, since a Cloud Workstation keeps only
`/home`:
- `bubblewrap` and `socat`, when missing, as it installs rsync: their packages
  (and the dependencies the machine lacks) fetched once with `apt-get download`
  into `~/harness/tools/debs/sandbox`, then `sudo -n dpkg -i` from there;
- when `kernel.apparmor_restrict_unprivileged_userns` is 1 and bwrap is
  refused, an AppArmor profile allowing bwrap user namespaces, loaded with
  `sudo -n apparmor_parser -r` (in the kernel only): Ubuntu's own
  `bwrap-userns-restrict` when the apparmor package ships it, else a minimal
  one (`~/harness/tools/apparmor/bwrap`). The sysctl is never turned off.

Then it probes bwrap and records `setup.sandbox` (`{ ok, why }`) in
`workstations.json`. What it couldn't do (no passwordless sudo, a profile
`apparmor_parser` refuses, as in a container that can't load AppArmor policy)
is in `setup.sandbox.why` and in `setup.failed` (marked `sandbox: true`), and
never fails setup.

**Where the sandbox can't run, worktree agents run unsandboxed (ASS-564):**
the operator's decision of 2026-11-23 ("If it doesn't allow you to run Claude
Code's sandbox then just do it in a worktree without the sandbox"). A
workstation or cloud VM whose `setup.sandbox.ok` is false, or whose setup has
not probed it yet, and the Mac should Seatbelt (`/usr/bin/sandbox-exec`) be
missing, stay candidates for the `*-worktree` targets: the step is placed there
as anywhere else, never refused or moved for it. Its agent starts in its
worktree without the sandbox settings (Claude Code's sandbox off, so no
`failIfUnavailable` to make it exit). What still holds: the Write and Edit
tools only in its working directories
(`permissions.blockWritesOutsideWorkingDirectories`), no token in its settings,
and its prompt's write rules (it is told the sandbox is unavailable and to
write only its worktree). Where the sandbox works nothing changes: its settings
are as above, `failIfUnavailable` included, so a sandboxed agent never silently
loses it. To see an unsandboxed run:
- control's log: `dispatch worktree <KEY> <var> on <machine>: Claude Code's
  sandbox unavailable (<why>) — running unsandboxed`, once per machine while
  the reason stays, and the agent's start line says `unsandboxed (…)`;
- the agent's session folder (`data/agents/<agent>-<time>/`): `sandbox.json`,
  `{ "sandboxed": false, "why": …, "target": …, "machine": … }` (`true` for a
  sandboxed one);
- the ticket screen's Details: the agent marked `(unsandboxed)`, and a
  `Sandbox` line saying where and why;
- the `n` screen (compute network; the footer until ASS-566): the ticket's
  `🌿 <KEY> worktree` line on its machine's card (ASS-572) ends in
  `unsandboxed`.

**The harness's own clones (ASS-553):** `local-worktree` makes its worktrees
from the harness's own clone of the project's repository,
`data/projects/<project>/checkouts/<repo>` (gitignored), cloned once from the
workspace's origin and fetched as needed, as `<clone>/.worktrees/<KEY>`; the
operator's checkout is never fetched, branched or given a worktree for it (only
`local-workspace` uses it). A worktree made before the switch, in the
workspace's `.worktrees/`, is kept and goes on being used until the ticket is
done, then removed from the workspace it belongs to. A project with a dev
container must mount the clones folder for its `worktree-setup` to run there.

**Worktree steps (ASS-554):** a step that only reads code and writes text
carries `worktree: true` in its `workflow.yaml`, and runs on a worktree target
(`local-worktree`, `workstation-worktree`, `cloud-vm-worktree`), never in a
sandbox or VM, so the full machines are left for building and testing. The
shipped engines flag Plan's steps, Code Review and Security Review, Review's
Explain the Change, Risk Assessment and token check, Document's steps, Write
Steps to Test and Requirements Changed's two; any engine (a project's own too)
flags its own steps the same way, nothing is decided by an engine's or a
project's name.
- A flagged step takes only the worktree targets its project lists, in the
  project's order, by pool choice (`remote-first` by default: the remote
  machines' worktrees, the most headroom first, the Mac's last). Its own
  `run-targets`, if it has any, may name only worktree targets.
- A project needs at least one worktree target for its flagged steps:
  `./agent.sh project:set-run-targets <project> local-substrate local-worktree`
  (on the Mac), or `… cloud-vm-substrate workstation-substrate
  workstation-worktree cloud-vm-worktree` (remote machines). Without one,
  control logs each flagged step it can reach as never started and
  `engine:validate <project>` fails naming its engine and step. A project still
  on a `mode` (no `run-targets`) runs every step as before, flag or not.
- An unflagged step with no `run-targets` of its own keeps off the project's
  worktree targets while a sandbox, VM, workstation or cloud VM is left for it,
  so Build and Test wait for a sandbox rather than spill onto a worktree.
- The branch is handed over at each switch (`code:hand-over`). Plan's worktree
  branch holds only a place to stand (Plan writes work files, not commits), so
  it is never pushed; back on the worktree after Build, the worktree is moved
  onto Build's branch, and what Review or Document commit there goes back to
  the sandbox with the next hand-over.

**Work mode (ASS-556):** whether a ticket variation is built in a worktree
or on a full machine (a Substrate sandbox, a Lima VM, a workstation or cloud
VM), decided after planning so as much work as possible runs in worktrees
without compromising quality; what a worktree cannot catch, the merge
request's CI does.
- The shipped grouped and v2 Plans end with Choose Where to Work (an AI step
  weighing points, the files and lines the plan touches, risk, whether
  meaningful tests run without the stack, contracts others depend on, and
  Hindsight's recall of similar tickets and their CI) and Record Where to Work
  (`ticket:choose-work-mode`), which writes the variation's `work-mode`
  (`worktree` or `full`, by whom and why) and the ticket screen shows.
- Forced rules in `project.json` override the AI:
  ```json
  "work-mode": { "force-full": [ { "paths": ["db/migrations/**", "**/*.tf"], "why": "needs the database" }, { "min-points": 8 } ],
                 "force": "worktree" }
  ```
  A matching `force-full` rule beats `force`, which beats the AI. A project
  listing no worktree run target is always full.
- Worktree mode: every machine step takes the project's worktree targets (by
  pool, remote first); a step flagged `stack: required` in its engine (Take
  Screenshots) is skipped, recorded as skipped, not failed. Full mode changes
  nothing.
- One-way escalation to full: `ticket:escalate-work-mode <project> <KEY> <var>
  tests|review|ci "<why>"`, run by the build, test, review and merge request
  feedback agents (their `{work-mode-rule}` paragraph says when). Once, logged,
  never reversed automatically; `ci` also retains a Hindsight memory of why.
- The operator: `ticket:set-work-mode <project> <KEY> <var> worktree|full`, or
  `w` on the ticket screen.
- Metrics: each variation's `work-mode` (with its escalations and history) and
  `ci-results` (recorded by `merge-request:check`); the sprint flow screen's
  metrics view shows them by mode.

**Pool choice (ASS-553):** which of a step's candidates a ticket takes.
- `first`: the first with a free seat, in list order, as above. The default
  for a step none of whose candidates is a worktree target.
- `remote-first`: the project's remote machines (workstations and cloud VMs,
  their plain, substrate and worktree targets alike) whenever one has a free
  seat, the one with the most headroom among them; the Mac only when every
  eligible remote machine is full. The default for a step whose candidates
  include a worktree target. A stopped or starting machine counts as available:
  control starts it and the step waits for it up to `harness.json`'s
  `remote-boot-wait-seconds` (900 by default: a start of up to 5 minutes plus a
  first setup). Meanwhile its seats are only those given to the steps sent to
  it (ASS-529's rule for a machine not measured), so it is never over-filled
  before it can be measured. Past the wait it counts as lost until it is up
  (`seats <id> did not come up within …`): its steps go to the next remote
  machine with room, else the Mac. An unusable machine (login expired, setup
  failed, unreachable) is skipped at once. Control records each wait in the
  project's `boot-waits.json` (since when, when it runs out, whether it has;
  ASS-575), kept across a restart and read by the dashboard, whose planner and
  `n` screen then treat a machine past its wait as control does.
- `most-room`: of the candidates with a free seat, the one with the most
  headroom now, anywhere; ties keep list order.

Headroom is counted in tickets (`src/control/pool-choice.js`): how many more of
the project's tickets fit before a limit, by measured memory and CPU over one
ticket's expected use — a remote machine's against its own limits
(`remote-seats.json`), the Mac's against the smaller of the harness's budget and
the project's allotment (`seat-budget.json`). Set it per step (`pool-choice:` in
a `workflow.yaml` step) or per project (`./agent.sh project:set-pool-choice
<project> first|most-room|remote-first`, `dev-environments.pool-choice`); the
step's wins. Each placement it decides is logged once: `seats <KEY> <var>:
placed on <target> (<machine>) by pool choice <choice> — headroom now, in
tickets: …`.

**Moving between targets:** agents commit at a step's end. When a ticket's
next step runs on another target, control runs `code:hand-over` first: it
commits anything left, pushes the branch from where the last step ran and
pulls it where the next one runs (the worktree made, the workspace taken, or
the machine's checkout brought up to date). Between two machine targets
nothing moves beyond what their steps already push, unless one of them is a
Substrate sandbox: its branches then move through the Mac (ASS-535). A ticket's
Lima VM is stopped between steps, so a hand-over that reads from it (or brings
the branch into it) starts it with `vm:start`, does its work and stops it again
(ASS-577); while the Mac is out of memory the step waits instead (no failure
counted). A VM that no longer exists is said so, the branches are taken from
the forge, and what could not be recovered is logged. The hand-over runs in
the background, as a script step does (ASS-585): the tick goes on with every
other ticket, the step waits (`waiting for its hand-over`) and starts only once
it has succeeded, one hand-over per variation at a time; a failed one holds the
step with backoff and is run again. Its duration is logged as it ends
(`run-targets <KEY> <var>: handed over … in <n>s`). That start is the only one a
project whose run targets leave out `local-vm` ever gets (ASS-581): for such a
project control never makes, re-creates or starts a Lima VM, whatever old `vm`
record a variation carries from before run targets (Blocked's runs included);
its steps wait for a seat on the project's own targets, an old VM still running
is stopped once idle, and `vm:create` refuses, naming why. A step's agent on a Mac
target runs on the host in that folder, and its scripts are told
`HARNESS_RUN_TARGET`, so commands that fall back to the host work there.
`seats.json` records each holder's `target`, and the Mac-target holders in its
`local` list.

## Where a project's tickets run: VMs, GCP workstations and cloud VMs

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
  (both: a free workstation seat first, a VM seat otherwise — see "Seats"
  below).
- `workstations`: the pool, each with its workstation `id`, `gcp-project`,
  `region`, `cluster` and `config`, and optionally `gcloud-config`, the
  `CLOUDSDK_CONFIG` folder of the gcloud login that reaches it (a leading `~`
  or `$HOME` is expanded). Required, with at least one, in `workstation` and
  `vm+workstation` modes.
- `cloud-vms` (ASS-481): plain GCP Compute Engine VMs ("cloud VMs") used
  exactly as workstations are, each with its VM `id`, `gcp-project` and
  `zone`, optionally `gcloud-config` (as above) and `ssh-user` (its OS Login
  user; by default the one of the gcloud login's account,
  `ada.lovelace@example.com` → `ada_lovelace_example_com`). The harness never
  creates, resizes or stops one. With them, `workstation` and
  `vm+workstation` modes need at least one workstation or cloud VM. The
  example (the operator adds their own to a project.json by hand):

  ```json
  "cloud-vms": [
    {
      "id": "ada-vm",
      "gcp-project": "example-gcp-project",
      "zone": "us-central1-a",
      "gcloud-config": "~/.config/example/gcloud"
    }
  ]
  ```

Control logs an error naming the field, and uses neither, when the mode is
unknown, a workstation mode lists no workstations (nor cloud VMs), a
workstation or cloud VM misses a field, or two share an id (across both
lists). Which ticket holds a workstation and whether it is
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

A connect can find the forwarded ports still taken on the workstation: when
the Mac end of an earlier connection died, its sshd session there may live on,
listening on them, so the new connection fails with `remote port forwarding
failed for listen port <port>` (ASS-501). `workstation:connect` then clears
it, provided the Mac has no live connection to that workstation (no master
answering on its socket, none still running): it opens a short SSH session
with no forwards, lists the listening sockets (`sudo -n ss -ltnp`), ends only
the sshd sessions of the harness's own SSH user that listen on `127.0.0.1` at
one of the forward ports — never the session it runs in, another user's
session or any other process — logging each one's pid, port and start time
(control's log shows them), and connects once more. With a live connection it
ends nothing and fails as before; if the second try fails too, it fails with
the original error, saying it tried clearing a stale session.

Once connected, control sets the workstation up for the harness's agents —
`./agent.sh workstation:setup <project> <id>` does it by hand — installing
what is missing under `~/harness` only (agent.sh, jq, the Claude Code CLI)
and checking git, curl, Docker, the project's `golden-image.tools` and
(ASS-471) every command its `ci-checks.json` checks run or declare in
`needs` (for `ci-checks:verify` run by hand; no workflow step runs it), a
missing one named with the checks that need it. A
tool the workstation lacks is installed by the project's optional
`golden-image/workstation-tools.sh`, given the missing tools' names and
`HARNESS_BIN` to put them in; the golden-image folder's other top-level
files (not Lima's `provision.sh`, `template.yaml`…) are shipped beside it, so
it can source one it shares with `provision.sh`. (ASS-500) When Docker's
daemon is not running — no `dockerd`, as when it died at the workstation's
boot — setup starts it once (`sudo -n service docker start`) and waits up to
60 s for `docker info`; a running daemon is never restarted, and one that
still does not answer fails setup with the end of `/var/log/docker.log`. Until setup succeeds nothing is dispatched to
the workstation and the dashboard shows `Workstation <id> setup failed` (see
`engines/grouped-engines.md`, "A GCP workstation's setup").

In those modes a workstation is held only while one of a ticket's steps runs
on it (ASS-468). Setup's Create VM records the workstation on the ticket
variation, claiming nothing; then each step that runs on the machine — an
agent's, or a script's such as CI Checks — claims a free workstation as it
starts (`./agent.sh workstation:claim <project> <ticket> <variation>`):
the workstation's one shared set of repositories, `~/harness/repos`
(cloned once, kept across steps and restarts), is fetched and checked out on
the ticket's branches (each planned `change/<KEY>-<id>`, made from its base
when GitLab has none yet; every other repository on master at the latest),
and the ticket's read-only copy, credentials and forwarder token are written.
Every step commits and pushes its own work on the ticket's branch before it
finishes, and no repository takes a commit on master: a git hook refuses one,
naming the ticket's branch. When the step ends, whatever its outcome, control
gives the workstation back (`./agent.sh workstation:release <project> <id>`):
what a completed step left uncommitted is committed on its branch and pushed
(logged as a warning), what a step that did not complete left is discarded
(each file logged), committed work is pushed (never forced), a local master
ahead of GitLab's is reset to it (the discarded commits logged and on the
ticket's Health), every repository goes back to master at the latest, and
the step's containers, credentials and token are removed. A push that fails
is logged and shown on the ticket's Health. So a ticket waiting — Blocked,
waiting for a slot or a fix — never keeps the workstation from the others.
Agents there act as the workstation's user: on the test workstation, with
the owner's git identity and GitLab key (see `engines/grouped-engines.md`, "A
ticket variation on a GCP workstation" and "A workstation held one step at a
time").

**Seats (ASS-469).** A project has VM seats and workstation seats: its VM
seats are its seats on the Mac, from the seat budget (ASS-528, below), and
each workstation in its list has as many workstation seats as its own memory
and CPU carry (ASS-529, below; one each before). Its tickets at work are at
most its VM seats plus its usable workstations' seats; `vm` mode has VM seats only, `workstation` mode workstation
seats only. Each ticket entering progress takes a free workstation seat
first, else a free VM seat, else waits as before; a ticket in planning takes
a VM seat (a workstation one in `workstation` mode). A ticket in a VM seat moves into a
workstation seat as soon as one frees, between its steps (never while a step
runs), and the VM seat it leaves goes to the next ticket. Machines follow
seats: a workstation-seat ticket's steps run on its workstation, a VM-seat
ticket's on its VM (made when it has none). There are no bound seats: while
a workstation can't be used — its gcloud login lapsed, its setup failed, it
could not be reached or started — its seat is lost, the ticket in it is
taken out (logged and on its Health) and takes the next free seat of either
kind; the seat comes back when the workstation does — one that could not be
reached or started has its connect retried, with the usual backoff, even
while nothing needs it (ASS-502), so it comes back by itself once the cause
is gone. Control keeps a
workstation started, connected and set up while its seat is held or a ticket
waits for a seat it could take, and lets it stop itself (its 30-minute idle
stop) only when nobody needs it. Who holds which seat is in
`data/projects/<project>/seats.json`; the sprint screen's Machine and Runs in
columns (ASS-559) say where each ticket runs (`Mac` / `Lima VM`, `GCP
workstation <id>` / `slot`…), and the `n` screen's card for a workstation
that can't be used (ASS-572; the footer's box before ASS-566) says why, in red
(`no work: …`). No seat counts are shown (ASS-530): the budgets behind them instead
(below).

**A seat only while its step uses its machine (ASS-527).** A ticket holds a
seat, planning or in progress, only while its current step (the deepest one,
inside a group) uses its machine: an AI step, or a script step whose command
`src/control/machine-steps.js` declares as running in the machine
(`automated-tests:verify-success`, `ci-checks:verify`, `code:create-branch`,
`code:create-worktree`, `code:update-workspace`, `ticket:catch-up-base`,
`vm:refresh-repositories`, `merge-request:check-numbered-files`, `vm:create`
and a few more), or one with `run-location: vm`. At any other step — a
host-only script, a wait, a gate, a human step — it holds none: the seat goes
to the next ticket in rank order that tick, logged once (`releases its …
seat at …`), and its VM is stopped once no agent or in-machine script is at
work in it (an agent mid-turn is let finish; a `vm:hold` still keeps it
running). A ticket already at work moves into any step without a free seat
and, at a step that needs one, waits there (nothing run, no agent) until it
takes the next free seat in rank order; only leaving Committed for planning,
and a finished plan going on to Build, wait for a free seat before moving.
Blocked and the other detours take no seat, as before. Every script command
an engine runs must be declared there as in-machine or host: engine
validation fails one it does not list. A waiting `vm:refresh-repositories`
(its 5-minute timer) uses the machine, so it polls only while the ticket
holds a seat, never booting a stopped VM just to poll.

**Seats from the Mac's memory and CPU budget (ASS-528).** There are no seat
counts any more: `max-tickets-in-progress` and `max-tickets-in-planning` are
not read (the one-off `./agent.sh harness:migrate-seat-budget [--dry-run]`
removes them from `harness.json` and every `project.json`, logging each
change). Planning and building take one pool of seats, in control's rank
order; `max-tickets-ready-for-build` still caps the finished plans. How many
seats a project has on the Mac comes, every tick, from
`src/control/seat-budget.js`:
- The budget: `harness.json`'s `max-memory-percent` and `max-cpu-percent`
  (90 and 90 by default) of the Mac's memory and of its cores.
- Shares: a project's `share` in `project.json` is a percentage of the
  budget. Projects without one split what the set ones leave equally; set
  shares adding to more than 100 are scaled down to 100, logged.
- Machines are never shared: a project spends its share only on its own Lima
  VMs. Share it cannot use (no ticket wanting a seat, or only remote work, as
  in `workstation` mode) goes to the projects that can, in proportion to
  their shares, and on to the next when they are satisfied. When its demand
  returns it takes the next seats freed until it is back at its share;
  nothing running is ever stopped for it.
- One ticket's expected use is what the project's running VMs really use:
  memory as the memory hold measures it (the largest footprint plus the
  margin, the floor with none running), CPU the average of its VMs' CPU over
  a 5-minute window (at least `cpu-need-floor-percent`, one core). A new seat
  is given only while the Mac's measured use (memory in use; CPU averaged
  over the window), the seats given whose VMs have not started yet, and one
  more ticket stay within both limits. Over either limit no seat is given;
  CPU has hysteresis (`cpu-hysteresis-percent`, 5): once at the limit, no
  seat for CPU until it is that far back under.
- **Setting a share.** `./agent.sh project:set-share <project> <percent>`
  (a number from 0 to 100); `none` removes it, back to the equal split. It
  refuses a share that would make the projects' set shares add up to more
  than 100, naming each one. Control rereads it every tick, so no restart is
  needed; a share hand-edited to something that isn't a number from 0 to 100
  is ignored, logged. The budget itself, `harness.json`'s
  `max-memory-percent` / `max-cpu-percent`, is set with
  `./agent.sh harness:set-budget [--memory <percent>] [--cpu <percent>]`
  (each 1–100). Both commands (ASS-546) validate before they write, take the
  file's lock, write it whole and print what changed.
- Each project's result is in `data/projects/<project>/seat-budget.json`
  (its seats now, share, allotment, use — seats, and its VMs' measured memory
  and CPU — what it lends and borrows, demand, the Mac's figures), which
  the planner and the dashboard read; control logs (`budget …`) each change
  of a project's share, allotment or use, and the Mac going over or back
  under a limit. If the Mac's memory or CPU can't be read, only the other
  limit applies; if neither can, no new seat is given (seats held keep
  running), logged once per outage. Remote machines have budgets of their
  own (ASS-529, next).

**Several tickets per workstation and cloud VM (ASS-529).** A remote machine
takes as many of its project's tickets as its own memory and CPU allow
(`src/control/remote-seats.js`), outside the Mac's budget:
- Control measures each connected machine with a ticket on it once a minute
  over its SSH connection (`./agent.sh workstation:usage <project> <id>`:
  `/proc/meminfo`, or a container's cgroup limit, and two `/proc/stat`
  samples), recorded as `usage` in `workstations.json`; its CPU is averaged
  over 5 minutes.
- Its limits are its own `max-memory-percent` / `max-cpu-percent` in its
  `dev-environments` entry, else `harness.json`'s (90 and 90). It takes one
  more ticket while its measured use, plus one ticket's expected use for each
  seat given whose step has not reached it yet, plus one more ticket, stays
  within both (one ticket: the machine's use shared among its tickets, at
  least `memory-need-floor-gib` and `cpu-need-floor-percent`). A machine with
  none of the project's tickets always takes one; one not measured (stopped,
  not connected) keeps the seats it holds, at least one; one whose reading
  fails takes no new ticket (those held keep running), logged once. Machines
  are filled in list order, so idle ones stop themselves; a machine that
  can't be used loses all its seats; it disconnects only once no ticket on it
  needs it.
- **Its disk (ASS-557).** The same `workstation:usage` call reads the disk
  its tickets' work lives on (`df` of `~/harness`: a Cloud Workstation's
  `/home`, its only persistent disk; a cloud VM's root or data disk), recorded
  as `usage.disk` (folder, total, used, available) beside memory and CPU and
  carried into `remote-seats.json`'s `disk` (figures, levels, `held`). Below
  its hold, the machine's own `disk-free-hold-gb` else `harness.json`'s (15
  GB, as the Mac's disk hold), it takes no new ticket, not even a first; those
  it holds keep running. The hold lasts until its free space is back above its
  `disk-free-warn-gb` (else `harness.json`'s, 50 GB), never asking for more
  than half of what the hold leaves of the disk, so a small disk can come out
  of it. Its start and end are logged once each (`hold <project> <id>: its
  disk …`). A machine not measured since keeps a hold for 30 minutes, then
  may take a ticket again, which starts it and has it measured. A disk `df`
  can't read holds nothing. Set the levels per machine with
  `machine:set-limits … --disk-hold <gb> --disk-warn <gb>`.
- Each machine's seats and why are in `data/projects/<project>/remote-seats.json`,
  and logged (`remote …`) when they change.
- **Setting a machine's limits.** `./agent.sh machine:set-limits <project>
  <machine-id> [--memory <percent>] [--cpu <percent>] [--disk-hold <gb>]
  [--disk-warn <gb>] [--clear]` writes the machine's own `max-memory-percent`
  / `max-cpu-percent` (1–100) and (ASS-557) `disk-free-hold-gb` /
  `disk-free-warn-gb` (GB, the hold at most the warn) on its entry under
  `dev-environments`; `--clear` removes them first (alone: back on
  `harness.json`'s). An id that is neither a workstation nor a cloud VM of
  the project is refused. `./agent.sh project:set-ticket-isolation <project>
  one-at-a-time|separate` sets `ticket-isolation` (below). Control rereads
  them every tick.
- Each ticket's step there runs in a folder of its own, a **slot**: the shared
  root `~/harness` while free, else `~/harness/slots/<n>` (`workstation:claim`
  picks it; `workstation:release --slot <n>` ends it). Each slot has its own
  checkout (cloned once, kept clean on master between steps), ticket copy,
  machine name and forwarder token; the project's credentials are shared and
  removed with the last slot.
- **Keeping tests apart:** `dev-environments.ticket-isolation`.
  - `"one-at-a-time"`, the default when unset: the project's steps that run
    tests or CI checks (`automated-tests:verify-success`,
    `:verify-exist-and-runnable`, `ci-checks:verify`, `vm:test-repos`, or a
    step marked `runs-tests: true` in its engine) run one at a time per
    machine, the others waiting with a Health saying why. Nothing else
    changes: no environment is added to its sessions (slot 0 runs exactly as
    before ASS-529; a slot n only gets its own forwarder token file), so a
    project that hasn't opted in sees no difference with one ticket on a
    machine.
  - `"separate"`, opt-in: every session in a slot sources its `slot.env`:
    `HARNESS_TICKET`, `HARNESS_VARIATION`, `HARNESS_SLOT`,
    `HARNESS_PORT_OFFSET` (100 × the slot) and
    `COMPOSE_PROJECT_NAME=harness-slot<n>`, so each ticket's compose
    containers, volumes, networks and databases are named apart, and its
    tests may run side by side. The project's compose files and test scripts
    that bind host ports add `$HARNESS_PORT_OFFSET` to them. Choose it only
    once they do, and say so in the project's own notes.

**Focus on planning (ASS-531).** With one pool, nothing guarantees planning a
seat. When the operator takes on a lot of work and wants to plan it with the
AI first, `P` on the sprint screen (or `./agent.sh project:set-planning-focus
<project> on|off`) switches the project's focus on planning. It is kept, with
who set it and when, in `data/projects/<project>/planning-focus.json` (not
`project.json`), written whole under its lock; control reads it every tick,
so it survives restarts and needs no restart either way. While it is on:
- every variation at a planning step (in planning, or at Committed waiting to
  start it) ranks ahead of every other when control gives seats, moves tickets
  into seats and dispatches agents (top-level ones and sub-engine runs), with
  the usual ranking within each group. A ticket at Committed may enter planning
  while tickets in progress wait for a seat; the seat queue (`q` on the sprint
  screen) shows the same order;
- nothing running is cut off: a seat already held is kept, in plain rank order;
- `max-tickets-ready-for-build` does not hold planning back.

Off, ranking is exactly as without it. The sprint screen shows the switch under
the progress bar, and the header has a **Focus on planning** chip while it is
on (no notification), a reminder to switch it off before leaving the AI to build.

**Cloud VMs (ASS-481).** A cloud VM is a workstation in all but how it is
reached: control starts a stopped one (`gcloud compute instances start`, or
`resume` when suspended), waits for it to run and for its SSH to answer
through IAP (up to 5 and 3 minutes; past that it is `start timed out` — red on
the footer's machine health line and on its card on the `n` screen — and its seat is
lost until a connect works), and keeps one SSH
connection to it through IAP with OS Login (`ssh -o
ProxyCommand="gcloud compute start-iap-tunnel <id> 22 --listen-on-stdin …"`,
the key `~/.ssh/google_compute_engine`) — the same `./agent.sh
workstation:connect <project> <id>`, `workstation:status`, `workstation:ssh`,
`workstation:setup` and `workstation:disconnect` by hand. A stale SSH
session of its own still holding the forwarded ports is cleared as on a
workstation (above), through a short IAP session of the same OS Login user. Each cloud VM
has seats from its own memory and CPU (ASS-529, above), taken after the workstations' (in list order) and before a VM
seat; its steps are claimed and released, its images pulled and its setup
run as on a workstation, except that its disk persists across a stop, so
setup runs again only after a reboot or when its version changes. It needs
Docker for setup, as a workstation does. It stops itself after 60 idle
minutes; control never stops it, and its connection holds no terminal, so it
never keeps the VM up. The `n` screen has a card for each cloud VM (ASS-572;
the footer's box before ASS-566) with its state (running, stopped, starting,
connecting, sign-in needed, setup failed, start timed out, unreachable), its
use, its seats and what of the project is on it, and the sprint screen's Machine column shows
`Cloud VM <id>` (see `engines/grouped-engines.md`, "Cloud VMs"). Each
machine's card lists the project's tickets on it with `🤖x<n>` while agents
work on one and `💻` while one runs a script step there (the sprint screen's
💻), `idle` otherwise (ASS-485, ASS-572). Its tickets, memory and CPU against
its own limits (ASS-530, from `remote-seats.json`: its used memory against
`max-memory-percent` of its memory, its CPU — averaged over 5 minutes, shown
as a percent of the whole machine — against `max-cpu-percent`) are the card's
`Seats` line and gauges, red past a limit; its verdict says `full: …` when it
takes no more tickets, `stopped: starts on demand` while it is stopped, and
that its reading failed (it takes no new ticket).

**The compute network screen (ASS-557, ASS-572).** `n` on the dashboard
(listed in the `?` menu) answers three questions for the project on screen (the
one the left and right arrows pick; machines are never shared between
projects): where will its next ticket go, which of its machines have room, and
why a machine isn't taking work. It reads only what control already writes
(`seat-budget.json`, `remote-seats.json`, `workstations.json`,
`disk-space.json`, `substrate.json`) and refreshes with the dashboard.

```
Orbit · 3 machines · 2 can take work · 3 of 4 seats in use · next ticket → ws-east (sandbox; remote first, most room)

┌─ ws-east · workstation ───────────────────── ● running ─┐  ┌─ mac · shared by 2 projects ──────────────── ● running ─┐
│ CPU     ███░░░░░░░░░░░░│░ 18% · limit 90%               │  │ CPU     ██░░░░░░░░░░░░░│░ 12% · limit 90%               │
│ RAM     █████░░░░░░░░░░│░ 9.6 of 31.3 GiB · limit 28.2  │  │ RAM     ███████████░░░░│░ 30.2 of 48.0 GiB · limit 43.2 │
│ Disk    ███████░░░░░░░░░│ 80.0 of 196 GiB · 116 free    │  │ Disk    █████████████░░░│ 691 of 931 GiB · 240 free     │
│ Seats   ■■□  2 of 3 · can take 1 more                   │  │ Seats   none needed: worktrees on the Mac take no seat  │
│ Cluster ● healthy · 2.8 GiB · 4% CPU                    │  │ Cluster ● up · 1.4 GiB · 1% CPU                         │
│ Image   sandbox image amd64 built 2026-11-23 UTC        │  │ Image   sandbox image arm64 built 2026-11-20 UTC        │
│ On it   🌿 ORB-102 worktree · 🤖x2 Write Plan           │  │ On it   🌿 ORB-105 worktree · idle                      │
│         📦 ORB-103 sandbox · hibernated (0.4 GiB        │  │ Share   50% (split) · allotment 3 tickets · uses 1      │
│            snapshot)                                    │  │         lends 0 · borrows 0                             │
│         📦 ORB-104 sandbox · crashed (will be replaced) │  │         allotted 20.0 GiB, 39% CPU                      │
│                                                         │  │         used 4.0 GiB, 9% CPU                            │
└─────────────────────────────────────────────────────────┘  └─────────────────────────────────────────────────────────┘
```

- **The headline** names the machine the next ticket goes to and why
  (`remote first, most room`, `most room`, `first with room`, `remote
  machines full`), the planner's own answer (`plan.js` `nextPlacement`:
  `planDispatch` places one more holder after every ticket now, by the
  project's run targets and pool choice, ASS-553), with `it is stopped: starts
  on demand` for a stopped machine and `after N already waiting` when waiting
  tickets take the free seats first. When nothing has room it says why in red,
  machine by machine: `nothing can take work: ws-east full (memory), vm-west
  stopped (starts on demand)`.
- **One card per machine**, in placement order (the next ticket's machine
  first, then those that can take work as the pool choice would try them,
  then the rest), two a row from 120 columns, one a row narrower. The title
  has the machine, its kind and a status dot: `● running` (green), `●
  starting` / `connecting` (amber), `○ stopped` (gray: started on demand),
  `● unreachable`, `setup failed`, `sign-in needed`, `start timed out` (red).
- **Gauges**: CPU, RAM and Disk as bars of the whole machine, `│` at the
  harness's limit (`max-cpu-percent`, `max-memory-percent`, the machine's own
  or `harness.json`'s; a disk's where its free space reaches its hold), green
  well under, amber within 10 points, red over. CPU is a percent of the whole
  machine (its 5-minute average), never per core. A stopped or unreachable
  machine's last figures are gray, their age in its title.
- **Seats**: `■` per seat the project's tickets hold there, `□` per seat free
  under the current rule, then a plain verdict: `can take 2 more`, `full: one
  more would pass its memory limit`, `held: disk below its 15 GB hold …`,
  `stopped: starts on demand (up to 15 min)`, `starting · waited 4 of 15 min`
  (control waiting for it to boot, ASS-575), `no work: didn't come up within
  15 min; work goes elsewhere until it's up` (past its boot wait: never the
  headline's next machine), `no new work: its reading failed (…)`, `no work:
  its gcloud login needs reauthentication`.
- **Cluster**: the machine's Substrate cluster (its last check, red with its
  troubles: `cluster missing`, `Docker memory low`…) and the project's part of
  its memory and CPU.
- **Image** (ASS-580): the sandbox image that machine's cluster runs for the
  project: the Mac's card its own architecture's (arm64 on Apple silicon), a
  workstation's or cloud VM's the amd64 one, as `sandbox image <arch> built
  <day> UTC`, amber `building`, red `build failed` (the header chip's rule) or
  gray `none`. A machine with no Substrate cluster for the project has no image
  line, except the Mac's card, which still shows an image built for its
  architecture.
- **On it**: every one of the project's tickets there, one a line (cut with
  `…` to the card's width, never wrapped; ASS-590): `💺
  <KEY> Lima VM · running` (`creating` in gray before its VM exists), `📦 <KEY>
  sandbox · running 1.5 GiB 3% CPU` (`hibernated` with its snapshot's disk,
  `starting`, `resuming`, `hibernating`, red `crashed (will be replaced)`),
  `🌿 <KEY> worktree` (on the Mac or a remote machine), `📁 <KEY> slot`, `📂
  <KEY> workspace` (`workspace free`), each `🤖` / `💻` with its step while
  agents or a script work on it, else `idle`, and a gold `unsandboxed` while
  its agent runs without Claude Code's sandbox (ASS-564).
- **The Mac's card** shows for every project (ASS-580: the Mac runs control,
  the forwarder, Hindsight and the registry for all of them), titled `mac ·
  shared by N projects`: its gauges are the whole Mac's (what the seat budget
  measures), its seats, tickets and `Share` line the project's own — its share
  (`(split)` when unset), allotment and use in tickets (red `over` past its
  allotment), what it lends or borrows, and the memory and CPU behind them. A
  project that can't run work on the Mac (no Mac run target, no Mac Substrate
  cluster: one on remote machines alone) gets the card with the gauges and a
  gray `no work: none of its run targets is on the Mac`, no seats and no
  `Share` line; it comes after every other machine, counts in the headline's
  machine count, and is never the headline's next machine nor in its red
  "why" list.
- Under the cards **the project line** (`agents: <model> 🤖xN, …`, its golden
  image and the day it was built, and only a sandbox image no card shows, so
  no image appears twice) and a gray **legend**. On a short terminal
  the cards are cut a row at a time from the bottom and a gray
  `+N machines below` says what's hidden; the headline and the legend always show.

The table of ASS-557/ASS-569, ASS-566's machine boxes and the pool summary are
gone: the cards carry what they showed.

**The footer (ASS-566).** Under every screen but the flow screens, three
status lines for the project on screen, each within the dashboard's
120-column minimum (a wider screen spaces them out; a value that doesn't fit
is shortened with `…`, never wrapped — at 120 the provider gives way first,
its account naming it):

```
control: up (8s, pid: 7501)   hindsight: up (port 8892)   provider: GitLab   GitLab account: <push account>   claude account: <account>
local: healthy   gcp workstations: 1 healthy, 1 unhealthy (ws-2 setup failed)   cloud VMs: 1 healthy
session: 21%, resets 1d 12h   weekly: 90%, resets 2d 1h   disk free: 224.8 GiB   repos: 27 in <group>   day spend: $0.00   sprint spend: $1935.36
```

1. Control (`draining`, `restarting`, red `waiting for its data`; red
   `control: DOWN (exit <code>, restart in <n>s, crash <n>)` or `… given up
   after <n> crashes, press R` when down), Hindsight's state and port, the
   forge provider and its push account (red with the reason when the check
   fails), the Claude account.
2. Machine health, one summary per group the project has — `local` (the
   Mac), `gcp workstations`, `cloud VMs` — `healthy`, or its healthy and
   unhealthy machines counted, the unhealthy red with why: setup failed, sign
   in needed, unreachable or start timed out, a reading that failed, over its
   memory or CPU limit, its disk held, its Substrate cluster in trouble; for
   the Mac, over the harness budget or unreadable, the disk hold, a memory
   hold. Stopped and idle is healthy.
3. Claude's 5-hour session and weekly use with their resets (red while rate
   limited), or the API key's billing and budget figures for a project billed
   by API key; the free disk (amber below the warning level); the project's
   repositories; today's and the sprint's spend. ASS-571: a window whose reset
   has passed shows a gray `—` (its percent was of a window that is over); a
   reading more than 10 minutes old adds its age in gray (`as of 2d ago`); one
   control couldn't take adds a red `usage unreadable (token expired)` (or
   `token refused`, `no token`, `endpoint unreachable`…), shortened at 120
   columns to `unreadable, read 2d ago`.

**Keeping the Claude usage token fresh (ASS-571).** Control reads each
project's Claude usage every 2 minutes with its login's own OAuth token (the
keychain item `Claude Code-credentials[-<sha8 of the config dir>]`). Claude
Code renews that token only when it runs for that config dir, so a project
whose agents all run on remote machines or in sandboxes let it lapse, and its
usage went unread for days. Now, when the token expires within 10 minutes or
has expired, control has Claude Code renew it: one minimal non-interactive
turn (`claude -p "Reply with OK." --model haiku --tools "" --strict-mcp-config
--no-session-persistence`) with that `CLAUDE_CONFIG_DIR`, from the temp folder,
without `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in its environment
(they would take precedence over the saved login). Claude Code writes the
renewed credentials back to the same keychain item itself. This is Claude
Code's documented renewal ("Claude Code renews its saved claude.ai login
itself, and parallel sessions coordinate the renewal"); there is no documented
refresh endpoint for another program, and one of the harness's own could race
Claude Code's and revoke the login. Control logs `usage <p>: refreshed its
Claude login token (expired <when>)` once; no token is ever logged or written
anywhere but the keychain. A renewal that fails (the refresh token revoked, the
login ended) is tried again after 30 minutes. A reading that fails is recorded
in `claude-usage.json` as `failure: { why, at }`, keeping the last good figures
and their `as-of`; the next good reading clears it. `project:credentials-status`
then lists it under `warnings` (not a hold) with the fix:
`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login` if it asks.



**Restart imminent (ASS-504).** A cloud VM about to go down — a GCP Spot
preemption, about 30 seconds ahead, or any shutdown — tells every agent on
it at once to commit and push its work, change log and notes, so the agent
started there again when it is back picks up where it left off.
`workstation:setup` installs a restart watcher
(`~/harness/lib/restart-watcher.sh`, from
`src/agent-cli/workstation/on-workstation/restart-watcher.sh`) and keeps
exactly one running as the SSH user, detached, its pid and version in the
runtime folder (`restart-watcher.pid`): a rerun leaves it alone, a new
version replaces it, a reboot's setup starts it again, and it is part of
setup's version, so machines set up before pick it up at their next check.
It waits on the metadata server's `instance/preempted` (`wait_for_change`,
`Metadata-Flavor: Google`) and traps SIGTERM and SIGHUP; where there is no
metadata server (a GCP workstation, any other machine) it watches the
signals alone. Once a boot, on firing, it runs `agent.sh
machine:restart-imminent` through the forwarder, which appends the token's
ticket variation and machine itself (a VM names no ticket of its own) and
logs the command's line — `restart imminent on <machine>: told <agents>`
— in control's log; what the watcher did is in
`~/harness/restart-watcher.log`. The command queues
`prompts/restart-imminent/prompt.txt` (engine-independent) for every agent on
that ticket variation as an interrupt line in its inbox; the supervisor
(`src/agents/process.js`) sends Claude Code's stream-json interrupt control
request, which stops the turn under way, a long tool call included, then
the prompt, within about a second. The interrupted turn's result is not a
turn ending (no SIGTERM, no step completion); once the prompt's turn ends —
or the agent dies with the machine — control ends the agent without
completing its step or counting a failure (`finish ... its restart-imminent
turn ended`), and the step runs again when the machine is back. It can be
run by hand: `./agent.sh machine:restart-imminent <project> <ticket>
<variation>`.

**Local virtual machines (ASS-486, ASS-489, ASS-491, ASS-530).** In `vm` and
`vm+workstation` mode the `n` screen's Mac card (ASS-572; the footer's
rightmost box until ASS-566) lists the project's Lima VMs and says why a
ticket runs or waits (ASS-530, from `seat-budget.json`): its gauges are the
Mac's memory and CPU against the harness's budget (`max-memory-percent` of its
memory, `max-cpu-percent` of its cores, CPU averaged over 5 minutes; red past
a limit, when no seat is given; `● not read` in red while neither can be
read), its `Seats` line the project's seats and verdict, and its `Share` line
the project's share (`(split)` when `project.json` sets none), its allotment in
tickets (after reallocation — its share at least, plus what it borrows), its
use (the seats it holds; red with `over` while it holds more than its
allotment — nothing is stopped; it gets no new seat until back under), what it
lends while other projects use the part of its share it can't and borrows
while it uses part of theirs, then the memory and CPU allotted and used; `no
seat budget yet` before control has written the file.

Its `On it` has one `💺 <KEY> Lima VM · <state>` line per seat holder that
uses a local Lima VM: first the in-progress VM seats (`seats.json` kind `vm`),
oldest first, each its Lima VM's state (from
`data/projects/<project>/vms.json`), `creating` in gray while its VM is still
being made; then the planning holders the planner seats on a Lima VM, as the
sprint screen's Machine column has them (ASS-559). There are no free seat
lines and no `vm seats` count (ASS-530). A VM whose ticket holds no seat (at a
gate, blocked, or in a workstation or cloud VM seat) is left out.

**The Mac's own places (ASS-541).** While a project's run targets (its
`dev-environments.run-targets`, or its mode's) include `local-workspace` or
`local-worktree`, the `n` screen's Mac card (ASS-572; a `local` box before)
lists what runs on the Mac itself, from `seats.json`'s `local` list: one `🌿
<key>[ <variation>] worktree · <icon> <step>` line per ticket worktree on the
Mac (`idle` between steps) — the variations on `local-worktree` first, then
every other sprint variation with a worktree (`build.worktree-folder`), idle
because its work is elsewhere now — and, while `local-workspace` is allowed,
the project's checkout: `📂 <key> workspace · <icon> <step>` while the ticket
holding it has an agent (🤖) or a script (💻) working, `idle` between them,
a gray `📂 workspace free` while no ticket holds it. Its `Seats` line says
`worktrees take no seat`.

**The seat queue (ASS-525, ASS-566).** `q` on the sprint screen (listed in
the `?` menu and the key under the grid) draws the seat queue over the
screen; `q` or Esc closes it (the footer's `queue` box before ASS-566). It
lists the ticket variations control will give a seat to when one frees, first
in line first: `<n> <key>[ <variation>] <title…> <waits>`, where `<waits>` is
`build` (a build seat), `plan` (a planning seat; `plan, full` while
`max-tickets-ready-for-build` lets none enter planning) or `memory` (memory
for its VM) — as many as the screen has room for, then a gray `+N more`;
nobody waiting: a gray `empty`. Control writes the line at the end of each
tick to `data/projects/<project>/seat-queue.json` (only when it changes,
removed when nobody waits), in the planner's own order: those in motion at a
step that takes a seat but holding none (those waiting for memory in their
rank place), then those whose plan is finished, then those not yet started at
`committed`, each in rank order.

**A step's end runs where its step ran (ASS-480).** A step run in a
ticket's VM keeps its commits there until its end pushes them, so control
never stops, deletes or reclaims that VM until the end has run — it starts
a stopped one for it — recording each pending end in
`data/projects/<project>/step-ends.json` so a restart of control picks it up
again. A pending end whose VM was deleted anyway can never run: control
logs it once as an error, naming the step and the branches its unpushed
commits were on, shows it on the ticket's Health, and drops it. A step's end
pushes only its own ticket's branches (ASS-478); another ticket's local
branch in a workstation's shared repositories that has parted from GitLab's
(so it could never be pushed) is set aside under
`refs/harness/stray/<branch>/<time>` in that repository, never pushed, and
reported on that ticket's Health as a notice after its feedback
(`ticket:add-ai-notice`, ASS-510): a notice never replaces a variation's
feedback, so a block's reason stays shown first — on the Health, the
Blocked tab and the Operator Needed notification. Notices are cleared with
the feedback when the variation moves to another state.

## Substrate clusters (ASS-533)

A project can have its own [Agent Substrate](https://github.com/agent-substrate/substrate)
cluster, set up and health-checked by the harness, so its tickets can run in
Substrate sandboxes (gVisor). The findings behind it are in
[`docs/spikes/ASS-532-substrate.md`](docs/spikes/ASS-532-substrate.md).

**Declaring one.** `dev-environments.substrate.clusters` in `project.json`, a
list with one entry per machine (a hand edit, as for workstations), beside the
run targets' `needs-docker` in the same `substrate` object:

```json
"dev-environments": {
  "substrate": {
    "clusters": [
      { "machine": "mac" },
      { "machine": "<workstation or cloud VM id>" },
      { "machine": "gke", "gcp-project": "<p>", "location": "<zone>", "cluster": "<name>" }
    ],
    "needs-docker": []
  }
}
```

A cluster's machine is also what the run targets read: a `mac` entry lets the
project list `local-substrate`, a workstation's `workstation-substrate`, a cloud
VM's `cloud-vm-substrate`; a `gke` entry none, until GKE is approved.

- `mac`: kind in Docker Desktop on the Mac. Every Mac project shares one kind
  cluster (`harness-substrate`): Substrate's fixed cost is about 2.3 GiB, so one
  cluster for all of them is the cheaper choice. Each project still gets its own
  WorkerPool (its workers run only its sandboxes: its machine), namespace and
  atespace (`harness-<project>`), and kubeconfig.
- A workstation or cloud VM of the project: its own kind cluster on that
  machine, reached over the machine's one SSH connection.
- `gke`: accepted by validation, refused at setup until the operator approves
  a GKE trial (the spike's section 7).
- Optional per entry: `memory-gib` (2.5) and `cpu-percent` (30), the cluster's
  fixed cost; `sandbox-memory-gib` (1.5) and `sandbox-cpu-percent` (100), one
  active sandbox's (the floor of that machine's per-ticket estimate, ASS-570 / ASS-574); `warm-workers` (1); `worker-memory-gib` (4) and
  `worker-cpus` (4), one worker's limits.
- A wrong entry is logged by control naming the field, and nothing of the
  list is set up or checked until it is fixed.

**Setting one up.** `./agent.sh substrate:up <project> [<machine>]` (`mac` by
default) creates the kind cluster (or starts its node), installs or upgrades
Substrate to the pinned release from its published images (`ate-setup
--image-repo ghcr.io/agent-substrate/substrate --image-tag v1.0.1`, never a
source build), and makes the project's namespace, WorkerPool and atespace. It
is idempotent. It runs the same script on the Mac and, over SSH, on a remote
machine (`src/agent-cli/substrate/on-machine/substrate.sh`). The pinned
versions are in `src/agent-cli/substrate.bash`: raising `SUBSTRATE_RELEASE`
upgrades each cluster at its next `substrate:up`.

- **The kit.** What a machine runs the release with: `ate-setup` (built once
  on the Mac from the release's tag with Go: releases ship no binary of it),
  `kubectl-ate`, `kind` and `kubectl` (their releases', checksums checked), and
  the release's manifests. `./agent.sh substrate:kit [<platform>]` builds it
  ahead (it needs `go`, `git` and `curl`); `substrate:up` sends it to a remote
  machine over its SSH connection, so the machine needs no Go and fetches
  nothing from GitHub.
- **Kubeconfigs.** Each cluster's kubeconfig is its own file,
  `~/.harness/substrate/<project>/<machine>.kubeconfig` on the cluster's
  machine, and every `kind`, `kubectl`, `kubectl-ate` and `ate-setup` call is
  given it. `~/.kube/config` is never read or written, on the Mac or on a
  remote machine (the operator's other contexts are production clusters).
- **Workstations keep only `/home`.** The kit, the kubeconfigs and Docker's
  data-root (so the kind node, its postgres and rustfs, and Substrate's
  snapshots: the hibernated sandboxes) live under `/home`, so a restart keeps
  the cluster. Google's workstation images already keep Docker's data in
  `/home/.docker_data`. On one that doesn't, the harness sets `data-root` in
  `/etc/docker/daemon.json` and restarts Docker; one whose own config passes
  `--data-root` outside `/home` fails setup, named: the harness never changes
  how a machine is stood up. What the cluster needs outside `/home` (that
  `data-root`, the inotify limits kind needs, the node started again with its
  proxy ARP) is re-applied by `workstation:setup` at every start. A cloud VM
  keeps its whole disk; only the inotify limits and the node are re-applied.
- **Images.** `./agent.sh substrate:load-image <project> <machine>
  <archive|->` loads a `docker save` archive into the cluster's node, sent over
  the machine's SSH connection: the hook ASS-534's sandbox images, built on the
  Mac, come in by.
- `./agent.sh substrate:down <project> [<machine>] [--cluster]` removes the
  project's part, and the cluster once no other project uses it.
- **A cloud VM's idle stop.** A cloud VM stops itself when idle by its own
  check, which counts load as busy, and a running cluster keeps the load up
  (about 0.5 on 4 cores). So before control's idle disconnect of a cloud VM it
  runs `./agent.sh substrate:stop <project> <machine>`, which stops the
  cluster's node with its state kept; the next connect's setup starts it
  again. A workstation's idle stop doesn't count load, so its cluster runs on.

**Health.** Control runs `./agent.sh substrate:health <project> [<machine>]`
every 3 minutes (`substrate-check-seconds`) for each cluster. On a remote
machine it checks only while the machine is connected and set up: a check
never starts a machine. It checks Docker (answering; its memory, which on the
Mac is Docker Desktop's VM; its containers under 90% of it), the remote host's
free memory, the node and its proxy ARP, the API server, every system pod and
the project's, rustfs, postgres, the pinned release, the project's WorkerPool
and atespace, and each of the project's templates' golden snapshot (a
template's error shows only in ate-api-server's log, so its last line naming
the template says why). It records the result in
`data/projects/<project>/substrate.json`, with the cluster's memory and CPU and
the project's active sandboxes.
- A cluster missing, or whose node is down, is restarted at once (`substrate:up`
  with `HARNESS_SUBSTRATE_REPAIR=1`, which also deletes pods stuck not ready). One
  broken on two checks in a row is restarted too. A failed restart backs off.
  A node restarted within 5 minutes is `starting`, not broken.
- Docker down or short of memory, the host short of memory, or a template
  with no golden snapshot are reported only: a restart can't fix them.
- No restart while the disk hold or the project's credentials hold is on.
- The header shows a chip for each kind of trouble, naming the machine, each
  with its fix and each notifying once (ASS-539; `headerWarnings` in
  `src/tui/screens/frame.js`):
  - **Substrate `<machine>` broken** (or `cluster missing`, `Docker down`, `not
    checked`): any problem but the three below. It says whether control restarts
    it (a problem `substrate:up` fixes) or what to fix (Docker not answering).
  - **Substrate `<machine>` template: no golden snapshot**: no sandbox can be
    made from that template. It carries ate-api-server's reason. "No worker has
    room for the actor" means the template is bigger than a worker: raise the
    cluster entry's `worker-memory-gib`, then `substrate:up`. Otherwise fix the
    image and `./agent.sh substrate:build-image <project>`.
  - **Docker Desktop memory low** (on a workstation or cloud VM: **`<machine>`
    Docker memory low**): Docker has less memory than the cluster needs, its
    containers use over 90% of it, or the remote machine has under 1 GiB
    available. On the Mac: Docker Desktop, Settings, Resources, Memory.
  - **Substrate `<machine>` snapshot disk high**: the disk the hibernation
    snapshots live on (Docker's) is below `disk-free-warn-gb` (50) while the
    project has snapshots there. It says when no new sandbox seat is given
    (one more snapshot would take it below `disk-free-hold-gb`). Delete the
    sandboxes no ticket needs (`substrate:sandbox-delete`), or give Docker
    more disk.
  - **Sandbox image `<arch>` build failed**: the last `substrate:build-image`
    of that architecture failed and none of those inputs has been built since
    (from `sandbox-image-<arch>-build.json` beside its label). Read
    `sandbox-image-build-<arch>.log`, fix it, build again.
  - **Sandbox `<sandbox>` setup failed**: control could not make or resume a
    ticket variation's sandbox (control's `sandbox-failures.json`, written each
    tick, gone at the next bring-up that works). The step waits; control tries
    again with the step's backoff and sends the ticket to Blocked after 3 in a
    row. A sandbox that had crashed (after a Docker or node restart) is not
    one of these: control replaces it (ASS-568, "Crashed sandboxes" below);
    only a replacement that cannot be made counts. Nor is a bring-up on a
    machine not up yet (ASS-582): while the workstation or cloud VM is
    stopped, starting, connecting or being set up, or its cluster is not ready
    (not checked since the machine connected, starting, missing, Docker down,
    or broken for a problem control's restart fixes), the step waits, nothing
    counted, logged once as `sandbox <KEY> <var>: waits for <machine> to come
    up (<why>)`. The wait is the machine's boot wait: past
    `remote-boot-wait-seconds` it counts as lost and the step goes elsewhere
    by pool choice. The Mac's cluster has no boot wait: past the same time its
    bring-up runs, and counts, again.
  - A nested Lima VM (Substrate's microVM path) is not watched: the harness
    runs its clusters on gVisor only.
- `project:credentials-status` adds `substrate`: what the clusters need
  (Docker on the Mac, the kit buildable, each remote machine's gcloud login,
  GKE's approval). It never holds the project's work.

**Memory and CPU.** A cluster's fixed cost and its active sandboxes count
against its host's limits. On the Mac, a project's part of the shared cluster
(the fixed cost split between the projects declaring it, plus its own
sandboxes) comes off its share's allotment before its VM seats, and off the
Mac's room while the cluster isn't up yet (`seat-budget.json`'s
`used.substrate`). On a workstation or cloud VM it counts in the machine's use
and isn't taken for a ticket's (`remote-seats.json`'s `substrate`). Docker
Desktop needs memory for it: on a 48 GB Mac, all but 10 GB (38 GB) and all
CPUs. The `n` screen shows it on each machine's card (ASS-539, ASS-572): a
`Cluster` line with its last check's state (red with its troubles) and the
project's part of its memory and CPU (gray `○ not up` while the cluster
wasn't up at its last check). GKE's spend will show
there once GKE is approved; until then only the kind clusters' memory and CPU.

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

## Substrate sandbox images

A project's golden environment is also built as a container image for
Substrate sandboxes (ASS-534), so a sandbox starts with the same toolchain
and repositories as the project's Lima VMs, plus the services its stack
runs. The image is built on the Mac and kept in the project's zot; nothing
goes to a cloud registry.

**What a sandbox carries** is declared in
`data/projects/<project>/sandbox/services.yaml`, gitignored like the rest of
the project folder (a project's services and versions are its own):

```yaml
architectures: [amd64]             # amd64 and/or arm64
packages: [libexample1]            # optional Debian packages
files:                             # optional config overrides from this folder
  - { from: files/db.conf, to: /etc/sandbox/db/db.conf }
services:
  - name: db
    kind: service                  # service | job (runs once) | toolchain (files only)
    version: "18.6"
    image: registry.example.com/team/db:18.6.17   # the image the project's own stack pins ...
    digest: sha256:<64 hex>                        # ... by tag and digest
    paths:                         # copied out of that image
      - /usr/lib/db/18
      - { from: /, to: /opt/sandbox/rootfs/db }    # a whole filesystem, in a folder of its own
    env: { DBDATA: /var/lib/sandbox/db }
    start: "db -D $DBDATA"
    ready: "db-ready"
    after: []
    ports: [5432]
```

`src/substrate/services.js` documents every key. A wrong entry is named
(`services[3] (keycloak): digest must be sha256:<64 hex>`) by every command
that reads it. The folder may also hold `provision.sh`, run instead of the
golden one when that can't run in a container (`provision: provision.sh`).

**Building it:** `./agent.sh substrate:build-image <project> [--arch amd64|arm64]`
(every declared architecture without `--arch`). It runs the golden
definition's `provision.sh` and the shared `git.sh` as the VM build does,
bakes in the repositories, copies each service's paths out of its pinned
image (one under the project's registry upstream is fetched through its zot,
so the Mac's Docker never logs in), adds the command server sandboxes are
driven through (`src/substrate/image/command-server`) and the services'
launcher (`sandbox-services start|stop|status`), and pushes the result to the
zot as `0local/sandbox/<project>:<arch>-<hash>`, pinned by digest. amd64 builds
under Docker Desktop's emulation on Apple Silicon. Nothing is built when the
inputs haven't changed. The output goes to
`data/projects/<project>/sandbox-image-build-<arch>.log`.

**Status and rebuilds:** `./agent.sh substrate:image-status <project>` prints
each architecture's `status` (`current`, `building`, `stale`, `failed`),
`digest`, `ref` and why it is stale. The image's inputs are the golden
`provision.sh`, the shared steps it runs, the builder, every file of the
sandbox folder and the repositories, so it goes stale as the golden VM does.
`vm:golden-stale` and `vm:golden-status` include the sandbox images
(`sandbox-images`, per architecture), the health check's rebuild ticket
covers them, and `vm:build-golden` rebuilds them after the VM image.
`registry:sweep` never deletes the build a label pins.

**Into each cluster:** `./agent.sh substrate:deliver-image <project> [<machine>…]`
pushes the image of each cluster's architecture (the Mac's own for its
cluster, amd64 for GCP's machines) into the registry of each cluster that
`dev-environments.substrate.clusters` names (none named: none), digest kept,
only when its digest changed since that machine's last delivery
(`sandbox-deliveries.json`): the Mac's directly, a workstation's or cloud VM's
through a forward over its open SSH connection (ASS-535: Substrate pulls a
sandbox's image from a registry, never from the kind node, so `kind load`
was not enough). A machine that isn't connected is skipped and gets the image
next time. Control runs it with the registry's half-hourly maintenance, and
`substrate:sandbox-up` before it makes a sandbox.

## Substrate sandboxes (ASS-535)

With a cluster (above) and its image (above), a project's steps can run in
Substrate sandboxes: its `dev-environments.run-targets` lists
`local-substrate`, `workstation-substrate` or `cloud-vm-substrate` (and a step
lists them, or leaves it to the project). Operator decision (ASS-532): agent
turns and light steps run in sandboxes; steps that need Docker (tests, CI
checks) run on full machines (local VM, workstation, cloud VM), which the
run targets' Docker rule sees to.

- **One sandbox per ticket variation, never shared.** A Substrate actor named
  `<key>-<variation>` (lower case) in the project's atespace
  (`harness-<project>`), on the cluster of the machine its seat is on: the
  Mac's for `local-substrate`, the seat's workstation's or cloud VM's for the
  others. The variation records it as `sandbox` { name, project, machine,
  template, image, state } in its sprint file. Made from the project's image
  through a template (`sandbox-<digest>`, with the capabilities `sudo` needs:
  CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETUID, SETGID, SETFCAP, SETPCAP,
  SYS_CHROOT), its image named in the cluster's own registry
  (`harness-substrate-registry`, `kind-registry` on kind's network, on the
  machine's 127.0.0.1:5011). When no worker has room for it, the project's
  WorkerPool grows by one.
- **Running in it.** Substrate has no exec API, so every command goes through
  the image's command server, reached from the Mac through `kubectl ate proxy
  actor` (on a remote machine: there, forwarded over its SSH connection):
  `src/substrate/sandbox-exec.js` streams stdin in and output out, as
  `limactl shell` does, so agents' stream-json and scripts' exit codes work as
  in a VM. A TERM or INT to it at any moment, even before its job has started,
  stops the job in the sandbox too and exits 128 + the signal, as a local
  process would (ASS-550). Commands run as the image's user `agent`, in `/repos/<repo>`;
  `/mnt/ticket` is a read-only copy of the ticket folder, brought up to date
  before each agent and script, only into a running sandbox (ASS-567: a
  hibernated one is resumed first, and `substrate:sandbox-up` copies it as it
  resumes; `substrate:sandbox-sync-ticket` refuses a hibernated one, exit 3).
  Each copy is checked: one that leaves `/mnt/ticket` short exits 4, and
  control logs `harness fault: sandbox ticket folder empty`, holds the step and
  tries again; no agent or script starts there meanwhile. The machine layer names it
  `substrate:<project>:<machine>:<actor>` (`src/control/machine-substrate.js`
  documents the interface).
- **Lifecycle** (control does it; the commands are for looking and fixing):
  `./agent.sh substrate:sandbox-up <project> <KEY> <var> <machine>` (made or
  resumed; a new one brings the variation's branches in),
  `substrate:sandbox-stop` (hibernated: suspended, files and processes kept,
  no memory, CPU or seat), `substrate:sandbox-delete [--keep-work|--salvage]`,
  `substrate:sandbox-state|-endpoint|-suspend <project> <machine> <actor>`,
  `substrate:sandbox-sync-ticket`. A step on a substrate target waits until its
  sandbox is up (logged as `sandbox …`); off one (a gate, a human step, another
  target), it is stopped once no agent or script of it runs; a done ticket's is
  deleted; a seat moved to another machine moves it (its work pushed out
  first).
- **Branches.** `code:hand-over` moves a variation's branches onto and off a
  sandbox through the Mac: bundled in the machine, pushed to origin from the
  Mac, fetched there and bundled in (`src/agent-cli/substrate/relay.bash`). So
  a ticket whose agent steps run in a sandbox and whose Docker test step runs
  on the local VM keeps one branch moving between them. (Since ASS-538 a
  sandbox can reach its forges itself, below; the relay stays for now.)
  ASS-583: the Mac's side of every move (`ls-remote`, `fetch`, `push`,
  `clone`) authenticates with the project's declared forge credential (the
  `gitlab` / `github` keychain item in `vm-credentials.json`, the one its VMs
  and the egress gateway get), handed to that git call alone by a credential
  helper that reads the keychain when git asks (`src/agent-cli/forge-git.bash`):
  never in a git config, URL, file, argv or log. A forge that refuses it or
  can't be reached fails the hand-over naming the repository and why
  (`authentication failed`, `forge unreachable`), never read as "no branches".
- **Seats** are the host's (ASS-528, ASS-529): a Mac seat for
  `local-substrate`, the machine's own for the others. A project on sandboxes
  counts one ticket at a sandbox's measured use — its worker pod's memory
  (rootfs writes included, as they live in gVisor's memory) and CPU, which
  `substrate:health` measures every few minutes (`substrate.json`'s
  `sandbox-use`) — not a VM's 4 GiB; a hibernated sandbox counts nothing.
  On the Mac (ASS-570, `src/control/ticket-estimate.js`) only *working*
  sandboxes are sampled — `running`, with an agent turn or in-machine script
  of its variation running through the whole check interval — never idle,
  starting, hibernated or hibernating ones (an idle sandbox's 0.36 GiB once
  swung a project's allotment from 3 seats to 30 and back). One ticket counts
  at the larger of the last 50 working samples' 80th percentile and the
  cluster entry's `sandbox-memory-gib` / `sandbox-cpu-percent` (the floor, and
  all of it with no samples), moved at most ×1.1 a tick and kept across
  restarts in `data/projects/<p>/ticket-estimate.json`; the budget log line
  and `seat-budget.json`'s `per-ticket` (`source`, `samples`, `floor`,
  `target`) say where it came from. A workstation's or cloud VM's sandboxes
  (ASS-574) use the same estimate, one per machine from its own working
  samples, kept in `ticket-estimate-<machine>.json`; the machine's measured
  use per ticket still counts above it, and the `remote …` log line and
  `remote-seats.json`'s `per-ticket` say where the figure came from.
- **Hibernation (ASS-537).** A ticket that gives up its seat (a gate, a human
  step, a wait, a step on another target) has its sandbox hibernated — never
  deleted — once no agent turn and no in-machine script of it runs: suspending
  resets every connection in the sandbox, so a model call or a forwarder call
  in flight would be wasted or cut half-done (the ASS-532 spike's finding);
  an agent whose turn reached the gate finishes it first. Its files,
  processes (an app stack it started) and memory are kept in its snapshot; its
  forwarder binding, its egress rule sets (`mac`, `credentials`) and the
  namespace's credential Secrets stay (only `substrate:sandbox-delete` revokes
  or removes its own). When the ticket is seated again at a step on its machine, the
  step waits while `substrate:sandbox-up` resumes it (about a second on the
  Mac; logged `… resumed from hibernation`), then starts where it is: no step
  re-run, no visit spent. A resume that fails is a failure of that step:
  logged, tried again with the step's backoff, and after 3 in a row the ticket
  goes to Blocked, as any step failing that often. One resumed meanwhile (a
  command run in it, which the machine layer allows) is seen running by the
  next `substrate:health` and hibernated again. What a hibernated sandbox
  keeps counts where it lives: the project's WorkerPool's warm workers' memory
  requests (256Mi each, reserved even empty; the pool grows with its sandboxes
  and never shrinks by itself) are part of its cluster's reserve in the
  budget, and its snapshots' disk (`substrate.json`'s `snapshot-bytes`, each
  sandbox's under `sandbox-use`, and the node's `disk`) is checked against the
  cluster's disk: a project (or remote machine) on sandboxes whose cluster's
  disk would fall below `disk-free-hold-gb` with one more ticket's snapshot
  gets no new seat until there is room (logged once; `seat-budget.json` /
  `remote-seats.json`'s `substrate`: `pool-memory-bytes`, `snapshot-bytes`,
  `disk-free-bytes`, `disk-full`).
- **Crashed sandboxes (ASS-568).** After Docker Desktop restarts on the Mac
  (or a remote machine's cluster node restarts), every sandbox that was on
  that cluster comes back crashed: Substrate's `ACTOR_STATE_CRASHED`, its
  worker restarted or gone (a hibernated one whose snapshot was lost crashes
  the same way). No resume can bring one back, so control replaces it, each
  when its ticket next needs it (`src/control/sandboxes.js`):
  `substrate:sandbox-up` exits 4 for a crashed one (`substrate:sandbox-state`
  says `crashed`, with Substrate's reason in `crash`); control then runs
  `substrate:sandbox-delete <project> <KEY> <var> --salvage`, which pushes the
  variation's branches (what was left uncommitted committed first) through
  the Mac only while the sandbox's command server still answers — a crashed
  actor's files usually cannot be read, so this is best effort and never
  holds the delete — then deletes it and revokes its forwarder token. The
  step's next try makes a fresh sandbox from the branches on the forge, its
  app stack brought up as for any new one. Control logs it once per sandbox:
  `sandbox <KEY> <var>: its sandbox on <machine> had crashed (<state>);
  replaced. Lost: <what>`, judged from the variation's commits record
  (ASS-558: commits not on the forge, and whatever it committed after its
  last commit on the forge or left uncommitted in its step), adds a "Sandbox
  replaced" entry to its change log and a notice to its Health on the ticket
  screen. A replacement is not counted against Blocked: a ticket two failed
  resumes into its 3 is not sent there by a crash. If the new sandbox cannot
  be made, those failures count as usual (3 in a row, Blocked); and one that
  crashes again before any bring-up has worked since its replacement is
  replaced again and that time counted, so a sandbox that always crashes
  still ends in Blocked. A sandbox seen up that a later `substrate:health`
  measures crashed is no longer taken as up, so its next step replaces it the
  same way.
- **On the dashboard:** a ticket in its sandbox shows its machine in the sprint
  screen's Machine column and `Substrate sandbox` in Runs in (ASS-559; 📦 and
  "· sandbox on <machine>" before), with `hibernated` beneath while it is
  hibernated — in gray where a ticket at a gate parked it. Each machine
  card on the `n` screen (ASS-572; a **substrate sandboxes** box before, ASS-539)
  lists the project's sandboxes on that machine under `On it`, one line each:
  `📦 <KEY>[ <var>] sandbox · [🤖xN 💻 <step> ·] <state> <memory> <cpu>`. The
  state is `running`, `resuming`, `hibernating`, `hibernated`, `starting`
  (seated, not made yet) or `crashed (will be replaced)`, from the cluster's
  last check when it is newer than the variation's record. Memory and CPU (a
  percent of the machine) are the sandbox's measured use while it runs (`not
  measured` before the next check); a hibernated one shows its snapshot's disk
  instead. An actor a check found that no variation names is listed by its
  name. Every ticket is listed, one a line (ASS-590).
- **What the template needs.** Root in a gVisor sandbox has almost no
  capabilities by default (AUDIT_WRITE, KILL, NET_BIND_SERVICE), so `sudo -u
  agent` would fail. The harness's template (`sandbox-template` in
  `on-machine/substrate.sh`) adds the most Substrate allows: CHOWN,
  DAC_OVERRIDE, FOWNER, FSETID, SETUID, SETGID, SETFCAP, SETPCAP, SYS_CHROOT.
  SYS_ADMIN and NET_ADMIN are refused at admission, which is why Docker can't
  run in a sandbox. The template also mounts the egress gateway's trust bundle
  (`/run/ate/egress-trust-bundle`), names its image by digest (a changed image
  invalidates snapshots), and asks for 7/8 of a worker's memory
  (`worker-memory-gib`; one as large as its worker never places).
- **Docker steps never run in sandboxes.** A command that needs Docker
  (`machine-steps.js` `DOCKER_COMMANDS`, plus the project's
  `dev-environments.substrate.needs-docker`) is never given a substrate run
  target: its step runs on a local VM, workstation or cloud VM, and the
  branch is handed over to it and back (`code:hand-over`). So a project on
  `local-substrate` still needs a local VM (or remote) target for its Docker
  steps, and a golden image for it.
- **The Mac's forwarder and Hindsight (ASS-536).** An agent in a sandbox runs
  `agent.sh` on the Mac through the forwarder, and gets its project's
  Hindsight bank as its MCP endpoint, as an agent in a VM does. A sandbox's
  egress is default deny; `substrate:sandbox-up` gives it the rule set `mac`:
  one cleartext http rule for the forwarder's port (`harness.json`
  `forwarder-port`) and one for its project's Hindsight port, on the Mac's name
  as its cluster sees it, and nothing else of the Mac:
  - On the Mac's cluster that name is `host.docker.internal` (Docker Desktop's
    name for the Mac's loopback).
  - On a workstation's or cloud VM's cluster it is
    `harness-mac.harness-<project>.svc.cluster.local`: a Service with no
    selector whose EndpointSlice is the kind network's gateway address, where a
    relay container on the machine (`harness-substrate-mac-relay`, socat pinned
    by digest, host network) listens on just those two ports and relays each
    connection to the machine's loopback, where its SSH connection already
    reverse-forwards the Mac's forwarder and Hindsight. The registry port the
    connection also forwards is never relayed.
  - Each part of the harness that gives a sandbox egress rules keeps them as a
    named rule set (`~/.harness/substrate/egress/<project>/<actor>/<set>.json`
    on the cluster's machine), and the actor's one egress policy is always the
    union of its sets (on-machine `substrate.sh sandbox-egress <actor> <set>`),
    so the credentials rules of ASS-538 sit beside `mac` without either
    overwriting the other.
  - Any process in the Docker VM (or on the remote machine) can reach those
    ports too, as any VM can reach `host.lima.internal`'s, so the forwarder's
    token stays the boundary: every `substrate:sandbox-up` issues the sandbox a
    fresh one (its hash bound in `~/.harness/vm-tokens.json` under
    `substrate:<project>:<machine>:<actor>` to its ticket variation; the token
    and the forwarder's URL in the sandbox's `/run/harness`, the client at
    `/usr/local/bin/agent.sh`), so only the allowlisted commands work, for its
    own ticket variation. `substrate:sandbox-delete` revokes it. After each
    call the forwarder brings the sandbox's `/mnt/ticket` copy up to date.
- **The app stack:** see "The app stack in a ticket's sandbox" below (ASS-542).
- **Not yet:** GKE (its relay into the cluster) waits for approval.

## Credentials through the egress gateway (ASS-538)

A sandbox holds no Claude, Anthropic, GitLab or GitHub token. Substrate's
egress gateway, which every connection out of a sandbox goes through and which
refuses anything its policy doesn't allow, puts the credential into each
approved request instead (`src/substrate/egress.js` says the design).

- **The tokens** are the same keychain items `~/.harness/vm-credentials.json`
  declares for VMs (`claude`, `anthropic`, `gitlab`, `github`; never
  `atlassian`). `./agent.sh substrate:credentials <project> [<machine>]` reads
  them and keeps one Kubernetes Secret per kind, `harness-credential-<kind>`,
  in the project's namespace (`harness-<project>`) of that cluster, sent to the
  cluster's machine on stdin only. It grants the project's atespace its own
  namespace in the credential provider's namespace policy (the provider reads
  it only at start, so it is restarted when that changes), and deletes the
  Secret of a kind no longer declared.
- **What gets injected where** (the gateway replaces a header only when the
  request carries it, so the sandbox sends placeholders):

  | Host | Header | Value |
  |---|---|---|
  | `api.anthropic.com` | `Authorization` | `Bearer ` + the `claude` token (Claude Code with `CLAUDE_CODE_OAUTH_TOKEN`) |
  | `api.anthropic.com` | `x-api-key` | the `anthropic` key (`ANTHROPIC_API_KEY`) |
  | the GitLab host | `Authorization` | `Basic ` + base64(`oauth2:<token>`): git over HTTPS, and npm (`_auth`) |
  | the GitLab host | `PRIVATE-TOKEN` | the token (glab, the API) |
  | `github.com` | `Authorization` | `Basic ` + base64(`x-access-token:<token>`): git over HTTPS |
  | `api.github.com` | `Authorization` | `Bearer ` + the token (gh) |

  The gateway prefixes but never encodes, so the Secret holds git's Basic
  value already encoded (ASS-532). One header has one value per host, so on
  the GitLab host npm's registries authenticate with `_auth` (Basic, as git
  does) rather than `_authToken`.
- **In the sandbox** (written as root at each `substrate:sandbox-up`):
  `/etc/profile.d/harness-credentials.sh` sets each declared kind's
  placeholder (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GH_TOKEN`,
  `GITLAB_TOKEN` + `GITLAB_HOST`), the gateway's trust bundle for node, git,
  curl and Python (the template projects it at
  `/run/ate/egress-trust-bundle/trust-bundle.pem`: an `https` rule makes the
  gateway terminate the sandbox's TLS), and turns Claude Code's non-essential
  traffic off. `/etc/harness/gitconfig` (included from git's system config)
  has the git identity, a credential helper per forge answering a placeholder
  password, and `insteadOf` rules turning SSH remotes into HTTPS: no SSH
  leaves a sandbox. `/etc/harness/npmrc` has the GitLab npm registries.
- **The allowlist.** Each sandbox's rule set `credentials` (beside ASS-536's
  `mac`; its egress policy is their union) lets it reach, over HTTPS
  on 443: each repository's forge host (and, on github.com,
  `api.github.com`, `codeload.github.com`, `*.githubusercontent.com`), the
  model API (`api.anthropic.com`), the declared GitLab host (where its npm
  registries are), GitHub's hosts when `github` is declared, and the npm
  registry (`registry.npmjs.org`). A project adds hosts in
  `dev-environments.substrate.egress.allow` (host names, or `*.` as the first
  label), e.g. `"egress": { "allow": ["pypi.org", "files.pythonhosted.org"] }`.
  Anything else is refused.
- **Rotation (AC2).** Re-save the keychain item, as for VMs. Control compares
  each item's keychain modification time with the one the cluster's last sync
  recorded (`substrate.json`'s `<machine>.credentials.stamps`), at most every
  `credential-stamp-interval-seconds` (300), and syncs again; the provider
  serves a new Secret within 10 s. No sandbox is restarted (seen on the real
  cluster: the next request carried the new token about a second after the
  sync). Control also syncs when the allowlist or the declaration changes (the
  policy's hash), when a Secret is missing, and after a failed sync (with
  backoff). A sandbox's changed egress policy applies within seconds.
- **Refusals are logged, mostly.** The gateway logs what it refuses (a listed
  host on another port, an address dialled directly) in its ext-proc;
  `substrate:health` reads the project's lines into `substrate.json`'s
  `<machine>.egress.denied`, and control logs each once: `substrate <p>
  <machine>: egress refused: egress denied: no rule allows the destination
  (sandbox <actor>, <host>, port <n>)`. **A host no rule lists is refused
  earlier, by the sandbox's DNS relay (NXDOMAIN), which Substrate does not
  log**: that gap is Substrate's (its relay can't be configured to log), so an
  agent's "could not resolve host" is the only trace. Add the host to the
  allowlist if it is needed.
- **Checks.** `./agent.sh project:credentials-status <project>`'s `substrate`
  field covers each cluster's gateway credentials, as its last health check
  and sync found them: the credential provider's pod ready (fix: `substrate:up`
  with repair), its namespace policy granting the project, and each declared
  kind's Secret (fix: `substrate:credentials`), and a failed sync. They hold
  nothing (a cluster's trouble must not hold VM work); a missing keychain item
  is the usual credentials hold.
- **Private CAs.** The gateway checks each upstream's certificate against
  public roots, so a self-hosted forge with a private CA can't be reached
  through an `https` rule (503) until the gateway trusts that CA, which
  Substrate v1.0.1 has no setting for. Such a project keeps its forge work on
  VMs or workstations.
- **Branches could now move by the sandbox's own git.** With forge
  credentials injected, a sandbox could push and fetch its branches itself, as
  a VM does, instead of through the Mac's relay. The relay stays until a
  ticket changes `code:hand-over` (it also serves projects with no forge
  credential declared, local-path origins and private-CA forges).

## The app stack in a ticket's sandbox (ASS-542)

A project can run its whole local app stack — its database, identity server,
proxies, queues, APIs and the app — in every ticket's own sandbox, at its real
local hostnames. Each sandbox has its own network, services and host map, so
several tickets run the app, use their own database and sign in side by side
on one workstation, cloud VM or the Mac, and nothing takes turns.

- **Declared** in the project's `data/projects/<p>/sandbox/services.yaml`
  (gitignored; `src/substrate/services.js` documents every key): each service
  and one-shot job with its start command, `after` (its dependencies), `ready`
  (a health check; without one, its `ports` answering), `ports`, `env`,
  `aliases` (its other names, a compose service name say); a service of what
  the image has already (the app's dev server, run from its repository)
  declares no image. Beside them: `hosts` (the project's local hostnames),
  `ca` (its local CA's certificate and the service that writes it), `app` (the
  app's real URL, which must answer), `login` (how an agent's browser signs
  in: the seeded user, never a real account), `prepare` (build-time steps, a
  `pnpm install` say: a sandbox has no egress; `npm: true` gives one the
  project's GitLab npm registries as a BuildKit secret) and `suites` (below).
  Validation names a bad entry, a dependency cycle, two services on one port
  and a host name mapped twice. Config overrides a stack needs live beside it
  (`files:`), never in the project's repositories.
- **Brought up** when a ticket's sandbox first starts: control runs
  `./agent.sh substrate:stack-up <project> <KEY> <var>` right after
  `substrate:sandbox-up`. In the sandbox `sandbox-services up` writes the host
  map (every service's name and aliases and the hosts → 127.0.0.1 in
  `/etc/hosts`), starts each service in dependency order, each waiting for its
  dependencies' health checks, runs each job once per sandbox (migrations in
  their declared order; a job done is never run again, a failed one is), trusts
  the CA (the system's store, `NODE_EXTRA_CA_CERTS`, the agent's NSS database
  for Chromium) and waits for the app's URL. Then `sandbox-login` signs the
  agent's headless browser (Playwright's Chromium) in as the seeded user and
  keeps its session. A failing service or job stops the start: its log and
  every other one go to the ticket's folder (`work/<KEY>/sandbox-stack-<var>/`)
  and the ticket goes to Blocked with that reason; the stack is tried again
  once the ticket has left Blocked.
- **Hibernation.** A hibernated sandbox keeps its processes, so after a resume
  `stack-up` finds every service running, checks the app and that the kept
  session still loads it signed in (a fresh sign-in when not). The time to
  first start and to resume are in `work/<KEY>/sandbox-times-<var>.json`
  (each run in `sandbox-times-<var>.jsonl`).
- **Its cost** is the sandbox's measured memory and CPU, which count against
  its host's limits (seats) and which the `n` screen's machine cards show (ASS-539, ASS-572). A
  cluster entry's `worker-memory-gib` must hold a whole stack.
- **Suites.** A project's compose-based test suites can run inside the sandbox
  against its own stack: `./agent.sh substrate:suite <project> <KEY> <var>
  <suite>` runs a declared suite (its env, workdir, what must be up), with
  `sandbox-docker` as its `docker` when it says `docker: true` — `compose up`
  starts the named services, `exec` and `run` run the command with the
  service's env, `ps` and `logs` read the stack, `down` does nothing, and
  anything else (`docker run`, `build`, `cp`) is refused. A suite that needs
  more than that, or a change to the project's code, is one the project lists
  as not runnable in a sandbox, with its reason.

## How long control's ticks take

Each control times every tick (from the start of the tick to its end, a tick
that fails included, the pause between ticks not) and keeps, since it
started: the number of ticks, the lowest, highest and average time, the last
tick's, and when the highest happened. It keeps the same figures for each of
the tick's phases (finish, registries, seats/VMs, steps, gaps, timers,
dependencies, supervise, dispatch) and, under each phase, for each call the
tick makes in it (its sub-routines, such as `seats/VMs/superviseVms` or
`timers/checkUsage`, with how many calls a tick makes). Each phase's read of
the data is timed apart, as `<phase>/load`: it counts in the phase's time but
not in its sub-routine's. Three sub-routines are timed a level deeper.
`steps/runSteps` and `finish/finishEnded` (`timers/detectReverts` runs in the
background since ASS-497, and isn't timed deeper): under them are their helpers
and the turn of each variation, run or ended agent (such as
`steps/runSteps/runVariation` or `finish/finishEnded/finishOne`). Within those
are the `agent.sh` calls control makes and the scripts it runs, grouped by
command name without arguments (such as
`steps/runSteps/runVariation/cli ticket:change-state`), and their data reads
(`…/load`). Script steps left running in the background aren't timed, only the
tick's wait for them (`…/scriptExit`), and nor are step-exit `script-succeeds`
checks, which run in the background (ASS-493; one over 30 s logs its
duration). And `dispatch/dispatch` (ASS-496): each `agent.sh` command it waits
for, as `dispatch/dispatch/cli <command>`, and the Claude login check, as
`dispatch/dispatch/claude auth status`. Starting an agent waits for two
`agent.sh` commands, `assignments:create` (which records the agent's Claude
account too) and `agent:dispatch`, plus `code:checkout-in-workspace` for a
step in the dev container; recording the agent's process
(`assignments:set-process`) and a model's context window run without the
tick waiting, a failure logged as an `error` line. They are written to
`data/projects/<project>/tick-stats.json` (`~/.harness/tick-stats.json` for a
control run without `--project`; `HARNESS_HOME` moves it) at most every 30
seconds and when control stops. To read them:

```sh
./agent.sh harness:tick-stats [<project>]
```

It prints each project's figures (or the one named) in seconds, then a table
of the phases with their sub-routines indented under each, and each deeper
one indented 2 more spaces under its parent, slowest average first at each
level. Work the tick starts and doesn't wait for, such as the VM lifecycle
jobs, isn't included: a sub-routine marked `(awaited part)` is timed only for
what the tick waits on. A project whose control hasn't recorded any yet says
so.

To see at a glance that control is alive, the dashboard's bottom-right corner
shows a counter (ASS-526): the loops the selected project's control has
finished since it started, modulo 100 (so 99 goes straight to 0). It goes up
by one with every loop, one that throws too. Control writes the count to
`data/projects/<project>/loop-count.json` after every loop, and 0 when it
starts, so a restarted control starts again at 0; while a control is down the
counter keeps its last value.

The periodic checks that call out to other services (the hourly revert check,
the gcloud and glab logins, Claude usage, API cost and the push account) run
in the background: the tick starts one when it's due and goes on without
waiting, at most one of each running at a time per project, and reads what the
last finished one recorded. The revert check asks the forges about 4
repositories at once. A background check that takes over 10 seconds logs a
`timers` line with how long it took. The credentials check still runs inside
the tick, because it decides whether this tick starts any of the project's
agents. When control stops or restarts, the background checks are stopped and
waited for, so none writes anything after control exits. A tick over 30 seconds also logs a `tick` line in the control log with
its three slowest phases and sub-routines.

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
| [test/](test/) | `npm test`; `npm run test:stress [-- -n <runs>] [<files>]` runs it 4 times at once (ASS-545), to show no test depends on the machine's speed. `test/run.sh` fails a run whose test file was cut short, its tests missing from the totals (ASS-549, `test/support/run-guard.js`) |

A project's own data lives in `data/projects/<project>/`: its `project.json`,
golden image, merge-request notes and any state engines of its own
(`engines/<name>/workflow.yaml`, looked up before the shared `engines/`).

Every state engine is a `workflow.yaml` (ASS-524; a `state-engine.json`
before): YAML, so a step can carry a `#` comment saying why it is there, with
the same fields and structure the JSON had. The harness reads them all
through one loader, `src/workflow/engine-file.js`. jq can't read YAML, so
`./agent.sh engine:show <project|-> <engine>` prints an engine as JSON, and
`./agent.sh engine:validate <project|-> [<engine>]` checks the engines a
project sees, naming the file, line and reason of a malformed one, and (for a
project, ASS-551) each machine step its tickets can reach that can run on none
of its run targets. The bash
commands keep each engine's JSON in `data/cache/engines/` (ASS-548), checked
against the file's exact text on every read, so they don't start node to
read one; the folder is safe to delete. A
project's own engines still in `state-engine.json` are converted, once, by
`./agent.sh engine:convert-to-yaml --project <project>` (or `--all`), and a
bundle made before ASS-524 is converted when it is installed.

## License

[MIT](LICENSE)
