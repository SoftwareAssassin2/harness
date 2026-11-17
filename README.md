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

Once connected, control sets the workstation up for the harness's agents —
`./agent.sh workstation:setup <project> <id>` does it by hand — installing
what is missing under `~/harness` only (agent.sh, jq, the Claude Code CLI)
and checking git, curl, Docker, the project's `golden-image.tools` and
(ASS-471) every command its `ci-checks.json` checks run or declare in
`needs`, a missing one named with the checks that need it. A
tool the workstation lacks is installed by the project's optional
`golden-image/workstation-tools.sh`, given the missing tools' names and
`HARNESS_BIN` to put them in; the golden-image folder's other top-level
files (not Lima's `provision.sh`, `template.yaml`…) are shipped beside it, so
it can source one it shares with `provision.sh`. Until setup succeeds nothing is dispatched to
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

**Seats (ASS-469).** A project has VM seats and workstation seats:
`project.json`'s `max-tickets-in-progress` is its VM seats, and each
workstation in its list is exactly one workstation seat (there is no setting
for it). Its tickets in progress are at most its VM seats plus its usable
workstations (`harness.json`'s `max-tickets-in-progress` still caps every
project together); `vm` mode has VM seats only, `workstation` mode
workstation seats only. Each ticket entering progress takes a free
workstation seat first, else a free VM seat, else waits as before; planning
has no seat kinds and runs on VMs. A ticket in a VM seat moves into a
workstation seat as soon as one frees, between its steps (never while a step
runs), and the VM seat it leaves goes to the next ticket. Machines follow
seats: a workstation-seat ticket's steps run on its workstation, a VM-seat
ticket's on its VM (made when it has none). There are no bound seats: while
a workstation can't be used — its gcloud login lapsed, its setup failed, it
could not be reached or started — its seat is lost, the ticket in it is
taken out (logged and on its Health) and takes the next free seat of either
kind; the seat comes back when the workstation does. Control keeps a
workstation started, connected and set up while its seat is held or a ticket
waits for a seat it could take, and lets it stop itself (its 30-minute idle
stop) only when nobody needs it. Who holds which seat is in
`data/projects/<project>/seats.json`; the sprint screen marks a VM seat 💺
and a workstation seat ⛅, the footer's gcp workstations box shows
`seat lost` on a workstation that can't be used, and the models box, in
`vm+workstation` mode, `vm seats: <used>/<VM seats>`.

**Cloud VMs (ASS-481).** A cloud VM is a workstation in all but how it is
reached: control starts a stopped one (`gcloud compute instances start`, or
`resume` when suspended), waits for it to run and for its SSH to answer
through IAP (up to 5 and 3 minutes; past that the footer says `start timed
out` and its seat is lost until a connect works), and keeps one SSH
connection to it through IAP with OS Login (`ssh -o
ProxyCommand="gcloud compute start-iap-tunnel <id> 22 --listen-on-stdin …"`,
the key `~/.ssh/google_compute_engine`) — the same `./agent.sh
workstation:connect <project> <id>`, `workstation:status`, `workstation:ssh`,
`workstation:setup` and `workstation:disconnect` by hand. Each cloud VM is
one seat, taken after the workstations' (in list order) and before a VM
seat; its steps are claimed and released, its images pulled and its setup
run as on a workstation, except that its disk persists across a stop, so
setup runs again only after a reboot or when its version changes. It needs
Docker for setup, as a workstation does. It stops itself after 60 idle
minutes; control never stops it, and its connection holds no terminal, so it
never keeps the VM up. The footer's `cloud virtual machines` box, after `gcp
workstations`, shows each cloud VM's agents, state (running, stopped,
starting, connecting, sign in needed, setup failed, start timed out) and
lost seat, and the sprint screen marks a cloud VM seat 🌐 (see
`engines/grouped-engines.md`, "Cloud VMs"). Each line of both boxes reads
`<id> <activity> <state>` (ASS-485): `🤖x<n>` while agents work on the
ticket holding the machine, `💻` while it runs a script step there (the
sprint screen's 💻), nothing when idle — e.g. `ws-1 💻 running`.

**Local virtual machines (ASS-486, ASS-489, ASS-491).** In `vm` and
`vm+workstation` mode the footer's rightmost box, `local virtual machines`,
has one line per seat that uses a local Lima VM. First the in-progress VM
seats: the tickets holding one (`seats.json` kind `vm`), oldest first, each
its Lima VM (from `data/projects/<project>/vms.json`) in the same
`<id> <activity> <state>` lines — e.g. `vm-1 🤖x2 running`, or `vm-1-a
creating` in gray while its VM is still being made — then a gray `free build
seat` line per seat left, up to `max-tickets-in-progress`. Then the planning
seats (planning always runs on local VMs), as the sprint screen's 💺 has
them: the tickets holding one, in the same lines, then a gray `free planning
seat` line per seat left, up to `max-tickets-in-planning`. With no limit only
the holders show, or a gray `none` with no lines at all. A VM whose ticket
holds no seat (at a gate, blocked, or in a workstation or cloud VM seat) is
left out.

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
reported on that ticket's Health.

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
| [test/](test/) | `npm test` |

A project's own data lives in `data/projects/<project>/`: its `project.json`,
golden image, merge-request notes and any state engines of its own
(`engines/<name>/state-engine.json`, looked up before the shared `engines/`).

## License

[MIT](LICENSE)
