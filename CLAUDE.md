# CLAUDE.md

This repo is a customizable AI agent harness. It orchestrates agentic work, from backlog to merged change, across one or more projects, with a human operator approving at the gates. The README covers the architecture and setup. This file is for a Claude session working **beside the operator**: running the harness, filing tickets, and clearing what waits on them.

## Map

- `src/control/`: control, the long-lived process that ticks, dispatches agents and runs script steps.
- `src/tui/`: the dashboard (`./harness.sh tui`), which also starts control and the downloader.
- `src/downloader/`: pulls tickets and merge requests from Jira, GitLab and GitHub.
- `src/agent-cli/`, `src/off-board-cli/`, `src/harness-cli/`: the commands behind the three CLIs.
- `engines/`: shared workflows (state engines, each a `workflow.yaml`). See `engines/grouped-engines.md`.
- `prompts/`, `personas/`: what agents are told, and who they are.
- `data/`: live state, gitignored apart from `harness.json` and `agent-names.json`.
  - `data/harness.json`: harness-wide settings. `data/harness.local.json` holds this machine's, among them `lima-home`, the harness-wide Lima folder.
  - `data/projects/<project>/`: one folder per project (see below). Its `project.json` may set its own `lima-home` (ASS-578), where its Lima VMs and golden image live instead (see "Where agents run", `local-vm`).
  - `data/cache/engines/`: the engines as JSON for the bash commands (ASS-548), checked against each `workflow.yaml` on every read. Safe to delete.
- `src/off-board/<project>/`: off-board ticket bodies (gitignored).
- `~/.harness/`: run pids, logs, backups, `restart-requested.json`.
- `test/`: `npm test` (node:test). Run one file with `npm test -- test/<file>.test.js`. `npm run test:stress [-- -n <runs>] [<files>]` runs it 4 times at once, as a loaded Mac would (ASS-545): a test waits for the event it checks, never a fixed time, and any time limit left is a commented hang guard (`test/support/until.js`). `test/run.sh` also fails a run in which a test file was cut short (its reports lost, or a `process.exit()` mid-run), so the totals are whole (ASS-549).

## The CLIs: use them, don't hand-edit JSON

Change the harness's state only through its CLIs, never by editing a JSON file in `data/`. The CLIs take the file locks, keep histories, and sync the ticket system. A hand edit races control and can corrupt state. Run `--help` to list each CLI's commands with their usage:

- `./harness.sh --help`: run the dashboard, install or export a project bundle, the downloader.
- `./agent.sh --help`: everything control and agents do (tickets, questions, VMs, memory, restarts…).
- `./off-board.sh --help`: off-board tickets (create, list, get, edit).

The only exceptions are the settings no CLI covers, such as adding a workstation or cloud VM to `dev-environments` in a `project.json`. Edit those only with the operator's go-ahead, and only by hand. The seat-budget settings have commands (ASS-546): `project:set-share`, `machine:set-limits`, `project:set-ticket-isolation` and `harness:set-budget` (see "Seats and machines").

## Restarting the harness

Code changes (a merged ticket, an engine or prompt change) load only after a restart. Restart **as soon as** something needs loading. The dashboard also warns "Restart to load … landed fixes".

```sh
./agent.sh harness:request-restart [<ticket-key>]   # no key: the operator's own restart
./agent.sh harness:restarted [<ticket-key>]          # whether it has happened yet
```

Each control drains its agents' turns (up to `restart-drain-seconds`), exits with code 75, and the dashboard starts again on the new code. VMs keep running.

## Is the harness healthy?

The dashboard (`./harness.sh tui`) starts one control per project and the downloader, and supervises them. It restarts a crashed control after 5 s, 30 s, 2 min, then every 5 min; after 5 crashes in 10 minutes the control stays down until `R` on the control screen. Its header shows every problem in red. From a session:

| Component | How to check |
|---|---|
| Dashboard, controls, downloader | Pid files `~/.harness/run-tui.pid`, `run-<project>.pid`, `run-downloader.pid`. Check each is alive (loop below). |
| What they're doing | `~/.harness/logs/control-<project>.log`, `downloader.log` (`tail`; look for errors and `slow tick`) |
| Control's speed | `./agent.sh harness:tick-stats [<project>]` |
| Control ticking | The dashboard's bottom-right counter goes up by one per finished loop (mod 100). From a session: `jq .loops data/projects/<project>/loop-count.json` |
| Last download | `data/projects/<project>/last-data-download` (a timestamp, normally within `download-updates-interval-in-minutes`) |
| Hindsight | `curl -s localhost:<hindsight.port>/health` should say `"status":"healthy"`. Control restarts it, or run `./agent.sh memory:up <project>`. |
| Image registry (zot) | `curl -s -o /dev/null -w '%{http_code}' localhost:<registry.port>/v2/` should give 200. Restart with `./agent.sh registry:up <project>`. |
| Credentials and logins | `./agent.sh project:credentials-status <project>`, where `held: true` means new work is held (its `atlassian` field, the Jira token and acli login, holds nothing). Also `data/projects/<project>/gcloud-requires-reauthentication` (`true` means run the `gcloud auth login` the dashboard names). |
| Pauses, self-healing | `jq '.status, .pauses, ."self-healing"' data/assignments.json` |
| Pending restart | `~/.harness/restart-requested.json`, and `./agent.sh harness:restarted` |
| Golden VM image | `./agent.sh vm:golden-status <project>` (`current`, building, failed…). With a sandbox declared it covers the Substrate sandbox images too (`sandbox-images`); one alone: `./agent.sh substrate:image-status <project>` |
| Disk, memory | `data/disk-space.json` (`level`), `harness:check-disk-space`, and see "Watch the machine" |
| Every machine at a glance | The dashboard's `n` screen (compute network, ASS-557; redesigned by ASS-572), for the project on screen (the arrows switch): a headline saying where its next ticket goes (the planner's own placement) or, in red, why nothing can take work; then a card per machine (the Mac always, its workstations and cloud VMs), next ticket's machine first: CPU, RAM and disk gauges against their limits, its seats (■ in use, □ free) with a plain verdict (`can take 2 more`, `full: …`, `held: …`, `stopped: starts on demand`, `starting · waited 4 of 15 min` while control waits for it to boot, `no work: didn't come up within 15 min; work goes elsewhere until it's up` past that wait, ASS-575), its Substrate cluster, the sandbox image it runs (ASS-580), and what of the project is on it. |
| Workstations, cloud VMs | See "Seats and machines" |
| Substrate clusters | `./agent.sh substrate:health <project> [<machine>]` (records `data/projects/<project>/substrate.json`; `jq . data/projects/<project>/substrate.json` for the last check). See "Substrate clusters". |
| Substrate sandboxes | The `n` screen's machine cards (ASS-572), each sandbox under `On it` on its machine's card with its state, memory and CPU (`📦 <KEY> sandbox · running 1.5 GiB 3% CPU`, `hibernated`, `crashed (will be replaced)`). `jq '.[] \| .usage."sandbox-use"' data/projects/<project>/substrate.json`; one actor: `./agent.sh substrate:sandbox-state <project> <machine> <actor>`. Ones control couldn't make or resume: `jq . data/projects/<project>/sandbox-failures.json`. |
| Sandbox images | `./agent.sh substrate:image-status <project>` (current, building, stale, failed; its log). |

```sh
# every harness process, alive or not
for f in ~/.harness/run-*.pid; do pid=$(tr -dc 0-9 < "$f"); printf '%-28s ' "$(basename "$f")"; ps -o etime= -p "$pid" >/dev/null 2>&1 && echo "up $(ps -o etime= -p "$pid")" || echo DOWN; done
# every project's Hindsight and registry
for p in data/projects/*/; do n=$(basename "$p"); h=$(jq -r '.hindsight.port // empty' "$p/project.json"); r=$(jq -r '.registry.port // empty' "$p/project.json")
  echo "$n hindsight:$(curl -s -m 3 localhost:$h/health | jq -r .status 2>/dev/null) registry:$(curl -s -m 3 -o /dev/null -w '%{http_code}' localhost:$r/v2/)"; done
```

### Dashboard header warnings

They all come from `headerWarnings` in `src/tui/screens/frame.js`. Red chips sit beside the sprint day box, a banner sits on top, and an amber disk line and red control lines sit under it. Each warning sends a macOS notification once when it appears, unless marked "no notification" below. "Harness-wide" ones notify once, for all projects. When the operator asks about one, explain it and give the fix:

| Warning | Means | Effect | Fix |
|---|---|---|---|
| **Project blocked by credentials** | `project:check-credentials` (control runs it every ~3 min) found a problem: a missing or locked keychain item, a failing gh/glab login, an expired gcloud/glab login, or a Claude account mismatch. Its file is `credentials-hold.json`. | No new agents, VMs or golden builds for the project. Running agents finish. It also counts as Operator Needed. | `./agent.sh project:credentials-status <project>` lists each problem with its fix. The hold lifts on the next passing check. |
| **run 'gcloud auth login' asap**, or `run 'CLOUDSDK_CONFIG=<cfg> gcloud auth login' … asap` | Control's gcloud check (every 2 min), or a workstation connect, found the login expired. Its flag file is `gcloud-requires-reauthentication`. | A credentials hold (when the check is on). Nothing is dispatched to an expired workstation. | Run the exact command shown. The next check clears it. |
| **run 'glab auth login' asap** | The glab check (every 2 min) found the login expired. | A credentials hold. | `glab auth login` |
| **Workstation `<id>` setup failed** / **Cloud VM `<id>` setup failed** | `workstations.json` says `setup.ok: false`, with the error. | Nothing is dispatched to that machine. Its seat is lost, and control retries with backoff. | Fix the cause in the error (`./agent.sh workstation:status <project> <id>`, control's log). The next retry clears it. |
| **Substrate `<machine>` broken** (or `cluster missing`, `Docker down`, `not checked`) | Control's check (every 3 min, `substrate:health`) found that project's Substrate cluster on that machine down, for any problem but the three below. Its file is `substrate.json`. | Its sandboxes can't run there. Control restarts a missing cluster or a stopped node at once, and one broken on two checks in a row (`substrate:up`, with backoff). | The chip says whether control restarts it or what to fix (Docker not answering, a check that can't run). `./agent.sh substrate:health <project> <machine>` for the detail. |
| **Substrate `<machine>` template: no golden snapshot** | A sandbox template on that cluster never got its golden snapshot. The chip carries ate-api-server's reason. | No sandbox can be made from it; steps on that target wait, then fail (see "Sandbox setup failed"). | "No worker has room for the actor": the template is bigger than a worker, so raise `worker-memory-gib` in the project's `dev-environments.substrate.clusters` entry (operator's go-ahead), then `./agent.sh substrate:up <project> <machine>`. Otherwise fix the sandbox image and `./agent.sh substrate:build-image <project>`. |
| **Docker Desktop memory low** (remote: **`<machine>` Docker memory low**) | The cluster's check: Docker has less memory than the cluster needs, its containers use over 90% of it, or a workstation or cloud VM has under 1 GiB available. | Sandboxes there may fail or be killed. Control doesn't restart for it. | Mac: Docker Desktop, Settings, Resources, Memory, then Apply & restart (it should have all but 10 GB). Remote: fewer tickets on the machine (`machine:set-limits`), or a bigger one. |
| **Substrate `<machine>` snapshot disk high** | The disk the hibernation snapshots live on (the cluster's Docker disk) is below `disk-free-warn-gb` (50) and the project has snapshots there. The chip says when it's full: one more snapshot would take it below `disk-free-hold-gb`. | When full, no new seat for the project's sandboxes on that cluster. Those held keep running. | Delete sandboxes no ticket needs (`./agent.sh substrate:sandbox-delete <project> <KEY> <var>`), or give Docker more disk (Mac: Docker Desktop, Settings, Resources, Disk usage limit). |
| **Sandbox image `<arch>` build failed** | The last `substrate:build-image` of that architecture failed, and those inputs have not built since. Files: `sandbox-image-<arch>-build.json` beside its label. | New sandboxes keep the last good image (or none). | Read `data/projects/<project>/sandbox-image-build-<arch>.log`, fix the cause (often `sandbox/services.yaml` or its `provision.sh`), then `./agent.sh substrate:build-image <project> --arch <arch>`. |
| **Sandbox `<sandbox>` setup failed** | Control couldn't make or resume a ticket variation's sandbox (`<key>-<variation>`). Its file is `sandbox-failures.json`, written by control. | That step waits. Control retries with the step's backoff; after 3 failures in a row the ticket goes to Blocked. A sandbox that had **crashed** (after a Docker or node restart, `substrate:sandbox-up` exit 4) isn't counted: control replaces it itself (ASS-568, "Substrate clusters" below), and only a replacement that can't be made counts. Nor is a bring-up on a machine that isn't up yet (ASS-582): while its workstation or cloud VM is stopped, starting, connecting or being set up, or its Substrate cluster isn't ready (not checked since the machine connected, starting, missing, Docker down, or broken for a problem control's restart fixes), the step waits, no failure counted, logged once as `sandbox <KEY> <var>: waits for <machine> to come up (<why>)`; control starts and connects the machine for its seat, and past `remote-boot-wait-seconds` the machine counts as lost (its `boot-waits.json` entry, ASS-575) and the step goes elsewhere by pool choice, never to Blocked for it. Only a bring-up that fails on a machine up with its cluster ready counts. | The chip gives the error. Look with `./agent.sh substrate:health <project> <machine>` and control's log (`sandbox …`); try by hand with `./agent.sh substrate:sandbox-up <project> <KEY> <var> <machine>`. It clears at the next bring-up that works. No need to delete a crashed sandbox by hand any more. |
| **Background work off** (no notification) | `project.json` has `background-work: false`, which the operator set. | No health checks, memory checks, appeals or self-healing. | `./agent.sh project:set-background-work <project> on` |
| **Focus on planning** (no notification) | The operator switched the project's focus on planning on (`P` on the sprint screen, or `project:set-planning-focus`). Its file is `planning-focus.json` (who, when). | Tickets at planning steps (Committed included) get seats and agents first; nothing running is cut off; `max-tickets-ready-for-build` doesn't hold planning back. | When the planning is done: `P` again, or `./agent.sh project:set-planning-focus <project> off`. No restart needed. |
| **Out of memory** (harness-wide) | Before starting a VM, control found too little memory free on the Mac (macOS memory pressure against the VMs' footprint plus margin). Its file is `memory-hold.json`. | No VM starts or is created. Tickets wait without a seat, and no failure is counted. | Free memory on the Mac. Control rechecks every tick. |
| **Out of disk space** (harness-wide), with the amber line "Disk nearly full — work held" | A Lima volume (the harness-wide folder's, or a project's own `lima-home`'s) or the data volume is below `disk-free-hold-gb` (15). It stays on until free space is back above `disk-free-warn-gb` (50). | Nothing new starts: no agents, VMs, clones or golden builds. | Free disk (`vm:reclaim-all --dry-run`, `vm:inventory`). It releases by itself. |
| **Disk low** (amber line, harness-wide) | Free space is below `disk-free-warn-gb` (50). | Control deletes stopped VMs no ticket needs. | Usually nothing. Free space if it keeps falling. |
| **Restart to load N landed fix(es)** (harness-wide) | A harness fix merged, but the running controls predate it. Tickets wait at fix-landed. | Those tickets wait. | Restart: `./agent.sh harness:request-restart` |
| **No work in progress** | An active sprint, but no agent working any sprint ticket. It notifies only after 5 minutes. | Nothing is being built. | Check the sprint for what holds the tickets: paused, blocked, Operator Needed, seats full, a hold above. |
| **Jira API token rejected** | The downloader's analytics sign-in was refused. Its file is `jira-token-rejected.json`. | Analytics (the `p` screen) stop updating. Work goes on. | A new Atlassian API token, copied, then `./agent.sh project:set-atlassian-token <project>`. It clears on the next good sign-in. |
| **Atlassian sign-in: run './agent.sh project:set-atlassian-token `<project>`'** | `project:check-credentials` (every ~3 min) found, for a project with a jira work source, the Atlassian keychain item (its `atlassian` entry in `vm-credentials.json`) missing or unreadable (with no entry: no `api-token` in `project.json` either), or `acli` not logged in to the work source's site. A network failure is unknown, not a problem. Its file is `atlassian-needs.json`. | **Not a hold.** Agent work goes on; the analytics and the Jira ticket sync are degraded. | Copy the Atlassian API token, then `./agent.sh project:set-atlassian-token <project>`. It clears at the next check, which that command runs itself. |
| **SIGN IN** (banner) | The project's Claude login isn't its `expected-account` (`account-hold`). | None of the project's agents start, and it is also a credentials hold. | The banner's command: `[CLAUDE_CONFIG_DIR=<dir>] claude`, then `/login` as the expected account. It clears within ~1 min. |
| **RATE LIMITED** (banner) | Claude's 5-hour or 7-day limit was hit (and the API key's cap too, when there is one). Its file is `rate-limit.json`. | Agents of that kind get nothing until the reset time shown. | Nothing. It lifts by itself at the reset. |
| **SELF HEALING** (banner) | Control is fixing a harness or project problem itself. | Only the tickets listed under "Paused" are paused. | Nothing. It clears when the fix ends (`self-healing:stop`). |
| **PAUSED BY HUMAN** (banner, no notification) | The operator paused the project, or all projects. | Agents commit and stop. | `space` on the dashboard for the project, or `!` for all. |
| **PAUSED BY AI** (banner, no notification) | An agent paused work (`assignments:pause … ai`), with a reason and ETA. | Agents commit and stop. | Control releases it after the ETA. Only the AI releases it earlier. |
| **CONTROL DOWN — `<project>` — …** (red line) | That project's control exited. The line says when it restarts, or that it gave up after 5 crashes in 10 minutes. | No ticks for that project. | Wait for the restart, or press `R` on the control screen (`c`). Check `~/.harness/logs/control-<project>.log`. |
| **CONTROL `<PROJECT>` WAITING FOR ITS DATA** (red line) | Control can't read a data file: the drive is gone, or a file is half-written. It notifies after 60 s. | Ticks are skipped. Control exits after `data-unreadable-exit-seconds` (300). | Make sure the data drive is mounted and the file is readable. |

These aren't warnings: "Subscription rate limited — agents are on the API key" (information only), the Operator Needed tile and red ● (see Operator Needed tickets), the footer's usage, spend and API-budget figures (its third line), and the green RUNNING banner. The footer's second line (machine health, ASS-566) turns red for the same troubles as several chips (setup failed, sign in needed, a Substrate cluster), and for a machine over its limits or unreachable.

## Credentials

Tokens live in the macOS keychain wherever possible. `~/.harness/vm-credentials.json` (0600, no secrets) declares, per project, which keychain items agents' machines get, by kind: `claude`, `anthropic`, `gitlab`, `github`, `git` (the commit identity), and `atlassian` (the host's Jira API token, never given to a VM). Never print a token's value. Talk about the keychain service name or the file field instead.

**The one check:** `./agent.sh project:credentials-status <project>` reads the latest `project:check-credentials` result (control runs it every ~3 min). It lists each problem with its exact fix. It only checks that keychain items **exist** and that logins answer. An expired VM token shows up only when a step fails with it, and then a Blocked run rechecks the credentials.

| Credential | Used for | Stored | Created / refreshed | When it breaks |
|---|---|---|---|---|
| **Claude login, host** | Agents on the Mac, and control's usage reading | The project's `CLAUDE_CONFIG_DIR` (`data/projects/<p>/.claude`, or `~/.claude`). Keychain item `Claude Code-credentials[-<sha8>]`. | `[CLAUDE_CONFIG_DIR=<dir>] claude`, then `/login`. Claude Code renews its token itself when it runs; control has it do so (ASS-571: one minimal `claude -p` with that config dir) when the token expires within 10 minutes or has expired, so a project whose agents all run remotely or in sandboxes stays fresh. Logged once as `usage <p>: refreshed its Claude login token (expired <when>)`. | The **SIGN IN** banner when the login isn't `project.json`'s `expected-account`. A usage reading that fails (the renewal failed: refresh token revoked, login ended) is recorded as `claude-usage.json`'s `failure` (the last figures kept), shown red on the footer's third line (`usage unreadable (token expired)`), and listed by `project:credentials-status` under `warnings`, **not** a hold. Fix: `CLAUDE_CONFIG_DIR=<dir> claude`, then `/login` if it asks. A failed renewal is retried every 30 minutes. |
| **Claude token / Anthropic API key, VMs** | Agents in VMs, workstations and cloud VMs | The keychain item that `vm-credentials.json` declares (`claude`: a `claude setup-token` token; `anthropic`: a Console API key) | `security add-generic-password -U -s "<service>" -a "$USER" -T /usr/bin/security -w "$(pbpaste)"`. Re-saving it is enough: control notices the keychain change (every ~5 min) and re-injects it into idle VMs. | A missing item gives a credentials hold. An expired one makes the steps that use it fail (Blocked). |
| **GitLab PAT, VMs** (`gitlab`) | git push/pull, `glab`, and npm registries inside VMs | Keychain (declared, with `host` and `npm-registries`) | As above (scopes `api`, `read_registry`). Picked up automatically. | Missing: a hold. Rejected: the footer's red `GitLab account: token rejected (401)` on its first line (hourly push-account check, **not** a hold). |
| **GitHub PAT, VMs** (`github`) | git and `gh` inside VMs | Keychain | As above. | The same as GitLab. |
| **glab login, host** | Downloader (MRs), host merge-request commands, golden builds | glab's own config | `glab auth login`. Its OAuth token is short-lived and refreshes on use. | **run 'glab auth login' asap** (checked every 2 min when `check-for-expired-glab-auth`), and a hold. |
| **gh login, host** | Downloader (PRs), golden builds | gh's own config | `gh auth login` | A hold (`gh is not authenticated on <host>`). |
| **gcloud login, host** (default config) | Image registry upstream, the gcloud check, arm64 builds | gcloud config | `gcloud auth login`. The Workspace session lapses after ~16 h. | **run 'gcloud auth login' asap**, and a hold. |
| **gcloud logins, per machine** (`gcloud-config` in `dev-environments`) | Workstations and cloud VMs | That `CLOUDSDK_CONFIG` folder | `CLOUDSDK_CONFIG=<cfg> gcloud auth login` | The chip names that exact command. The footer's second line counts the machine unhealthy (`<id> sign in needed`, red), the machine's card on the `n` screen says `● sign-in needed` in red, and its seat is lost. It retries every 2 min. |
| **Registry (zot) upstream token** | Pulling images through zot | `<registry storage>/credentials.json`, from a gcloud access token | **Automatic** every 30 min (`registry:refresh-credentials`). | Fails only if gcloud is logged out (logged). zot then serves its cache only. |
| **Atlassian API token** (`atlassian`) | Downloader's analytics (the `p` screen) | Keychain item named by the project's `atlassian` entry in `vm-credentials.json` (`{ keychain-service, site, email }`; never injected into VMs). With no entry, the old plain-text `work-sources[].api-email` / `api-token` in `project.json` (kept out of bundles). | Make a token at id.atlassian.com (Security, API tokens), copy it, then `./agent.sh project:set-atlassian-token <project>` (clipboard, or `--stdin`): it saves the item, clears the clipboard and logs acli in too. No entry: it says what to add. | Missing: the **Atlassian sign-in** chip. Rejected: the **Jira API token rejected** chip. Neither is a hold. |
| **acli login** | Downloader's ticket sync, `ticket:set-ticket-system-status`, `ticket:raise-bug`, your Jira commands | acli's own config | `./agent.sh project:set-atlassian-token <project>` (logs in with the API token), or `acli jira auth login`. | `project:check-credentials` checks `acli jira auth status`: logged out or on another site gives the **Atlassian sign-in** chip. Not a hold. |
| **Hindsight LLM key** | Each project's Hindsight | The keychain item named by `project.json` `hindsight.llm-api-key-keychain-service` | Re-save the item. The next `memory:up` sees the change and restarts Hindsight. | `memory:up` fails with "keychain item … can't be read". A bad key isn't detected. |
| **Anthropic Admin key** | Month-to-date API spend (`api-cost.json`) | Keychain `harness-anthropic-admin-key` (or `project.json` `api-cost-admin-keychain-service`) | By hand | Logged only. The API spend figure stops updating. |
| **npm registry token, host** | pnpm on the Mac for GitLab npm registries | pnpm user config | `./harness.sh npm-registry-login <project>` (keeps a working token, else asks for a new one) | Failing installs only. |
| **SSH** | Lima VMs (Lima's own key), workstations and cloud VMs (`~/.ssh/google_compute_engine`, through IAP / OS Login) | `~/.ssh`, `<Lima folder>/_config` (each folder its own: the harness-wide one and each project's `lima-home`) | Made on first use by `gcloud` / Lima | Connect errors in control's log, and the footer's second line (`<id> unreachable`, red). Not a hold. |
| **Forge credential, the Mac's relay** (ASS-583) | Moving a ticket's branches onto and off a Substrate sandbox (or a missing VM's from the forge) through the Mac: the relay's and `code:hand-over`'s `ls-remote`, `fetch`, `push` and `clone` | The same `gitlab` / `github` keychain item as VMs (its `host`, else gitlab.com / github.com). The Mac's own git logins aren't used for those hosts, and nothing is stored: a credential helper on that one git call's command line reads the keychain when git asks (`src/agent-cli/forge-git.bash`); never in a git config, URL, file, argv or log. No item declared: git as before (local paths, public repos), never prompting. | As the VM items. | The hand-over fails, and control's error line says why (ASS-583: a failing command's last stderr lines): `code:hand-over: <repo> (<url>): authentication failed (…)` (missing, expired or wrong token) or `forge unreachable (…)`. Re-save the item. |
| **Sandbox credentials** (ASS-538) | Agents and git in Substrate sandboxes | Kubernetes Secrets `harness-credential-<kind>` in the project's namespace of each cluster, from the same keychain items as VMs. The sandbox holds placeholders only. | **Automatic**: `./agent.sh substrate:credentials <project> [<machine>]`, which control runs again when an item is re-saved (within ~5 min), the allowlist changes, or a Secret is missing. | `project:credentials-status`'s `substrate` field (the provider pod, its namespace policy, each Secret, a failed sync). Not a hold. |
| **Substrate clusters** | The harness's own access to each cluster (`kind`, `kubectl`, `kubectl-ate`) | A kubeconfig per project and machine, `~/.harness/substrate/<project>/<machine>.kubeconfig` on the cluster's machine. Never `~/.kube/config`. A remote cluster is reached over the machine's SSH connection (its gcloud login, above). | **Automatic** by `substrate:up` (the kit and kubeconfig sent over SSH). No token of its own. | Health problems (`api`, `cluster`): the **Substrate `<machine>` broken** chip; control runs `substrate:up` again. |
| **Sandbox image build** | `substrate:build-image` fetching the project's repositories | The VM `gitlab` / `github` keychain items, given to the build as a BuildKit secret (never in the image). The image goes to the project's zot only. | As the VM items. | **Sandbox image `<arch>` build failed** (read its log for 401/403). |
| **Forwarder tokens** | An agent in a VM or a Substrate sandbox calling `agent.sh` on the Mac | `~/.harness/vm-tokens.json` (hashes only) | **Automatic**, new on every `vm:start` and `substrate:sandbox-up`; a sandbox's revoked when it is deleted | 403 `unknown token`. Nothing to do. |

**When to tell the operator:** any credentials hold, SIGN IN, gcloud/glab or Atlassian sign-in chip, and a `warnings` entry in `project:credentials-status` (an unreadable Claude usage token). Also: a red `<provider> account:` error on the footer's first line, `jira-token-rejected.json`, `atlassian-needs.json` (in `project:credentials-status` as `atlassian`), and downloader log lines about the signed-in Jira account. Also: tickets Blocked on auth errors (401/403, "authentication", "token") in their `ai-feedback` or test output. Give the exact fix command, and say which project and which keychain service or login it is.

## Projects and their workflows

- Projects: `ls data/projects/`. Each has a `project.json` with its `name`, `work-sources` (`jira` or `off-board`), `repositories`, limits, Hindsight port, and `execution-state-engine`.
- A project's workflow is that engine: `engines/<engine>/workflow.yaml`, or a project's own one under `data/projects/<project>/engines/<engine>/`. jq can't read YAML, so read an engine as JSON with `./agent.sh engine:show <project> <engine>` (it finds the project's own first; `-` for `engines/` alone), and check one with `./agent.sh engine:validate <project> [<engine>]`. Its steps say what each one runs (a prompt, a script, or a human gate), its model (`action.model`), and where each exit goes. The dashboard's `S`, `B` and `f` screens draw the sprint, backlog and sub-flows.
- No workflow runs a project's CI checks locally (ASS-552): the project's own CI pipeline runs them on the merge request, and the merge steps (`merge-request:check`, Await, Merge in Turn) wait for it. `./agent.sh ci-checks:verify <project> <KEY> <var>` stays for running a project's declared checks (`golden-image/ci-checks.json`) by hand.
- Tickets in a project merge side by side (ASS-560). There is no project-wide merge queue or lock: ASS-197's `merge.lock` is gone. Only a ticket variation's own merge requests merge in their planned depends-on order, and a ticket that depends on another still waits for it.
  - When another ticket lands first, the ticket rebases and waits for its pipeline again. On a forge that goes through Address Merge Request Feedback, bounded by its `max-visits`.
  - For the harness's own tickets, the merge gate (`merge-request:merge-in-turn`) rebases onto the latest main and runs the full suite before each merge, per ticket and concurrently, under the variation's own `work/<KEY>/merge-gate-<var>.lock`. A gate whose main moved during its run says `base-moved` and runs again. Merge Pull Request's `max-visits` (5) bounds those reruns, then the ticket goes to Blocked with the reason in its ai-feedback.
  - The trade-off: two changes that are each green but conflict together can both merge. The project's CI on main after the merge (ASS-552) is what catches that.
- Sprint state: `data/projects/<project>/sprints/`. Backlog: `backlog.json`.

## Where ticket information lives

A ticket's work folder is `data/projects/<project>/work/<KEY>/`, with one file per variation (`-A`, `-B`…):
- `ticket.json`, `ticket-A.json`: the ticket and its variation's state and history.
- `change-log-A.md`: the change history. `root-cause-analysis-A.md` and `root-cause-analysis-review-A.md`: RCA.
- `execution-plan-A.md`, `plan-review-A.md`, `code-review-A.md`, `security-review-A.md`, `risk-assessment-A.md`, `test-plan-A.md`, `test-results-A.md`, `steps-to-test-A.md`, `explanation-A.md`.
- `questions-and-answers.json`: the ticket's questions. Project-wide ones are in `data/projects/<project>/global-questions-and-answers.json`.
- `commits-A.json`: every commit of the variation across the project's repositories (ASS-558), each with its repository, SHA, date, author, subject, branch or merge request, and state (`local` only, `pushed`, `open-mr`, `merged`), and `refreshed-at`. The ticket screen's Commits tab shows it. It comes from the forge (glab/gh, read only) and the Mac's clones, never the ticket's machine. Control refreshes it after each step that commits and every `commits-refresh-minutes` (`data/harness.json`, 15 by default) until the ticket is done. Refresh one now with `./agent.sh ticket:refresh-commits <project> <KEY> <var>`. Its `sources` say which forge or clone couldn't be read.
- Status history: `./off-board.sh ticket:history <project> [<key>]` (off-board), or `analytics/tickets.json` (Jira).

## Acceptance criteria: passed or failed

Each ticket variation has its own copy of the acceptance criteria, in its sprint file, as `acceptance-criteria: [{ criteria-number, description, dev-status, testing-status }]`. Each status is `Passed`, `Failed` or `Incomplete`, and agents record them:

- **`dev-status`**: Generate Solution marks each criterion its change meets `Passed`, else `Failed`. Code Review marks a criterion `Failed` when it rejects the change for it.
- **`testing-status`**: the Test step marks each criterion `Passed` or `Failed` from `test-results-<var>.md`, which gives the evidence for each one.

Both use `./agent.sh ticket:set-ac-status <project> <KEY> <var> <dev|testing> <n> <Passed|Failed|Incomplete>`. The ticket screen's **Acceptance criteria** tab (ASS-559, the last tab) lists each criterion with its dev and testing status (green passed, red failed, gray incomplete), the automated tests' tally, and links to the evidence files; the sprint screen no longer shows them. To see why one failed, read the variation's `test-results-<var>.md`, `code-review-<var>.md` and `change-log-<var>.md`.

Changing the criteria themselves is a requirements change:
- `ticket:set-acceptance-criteria` (`agent.sh`, for a sprint ticket's variation).
- `ticket:add-` / `update-` / `replace-acceptance-criteria` (`off-board.sh`, for an off-board ticket).
- For a Jira ticket, the criteria are changed upstream in Jira.

## Hindsight memory

Each project has its own Hindsight server on `127.0.0.1:<project.json hindsight.port>`, with one bank named after the project. Agents use it through MCP. From here, use its HTTP API:

```sh
# recall
curl -s -X POST localhost:<port>/v1/default/banks/<project>/memories/recall \
  -H 'content-type: application/json' -d '{"query":"…"}'
# retain: one short, self-contained fact per item, with a document_id of its own (<topic>-<slug>)
curl -s -X POST localhost:<port>/v1/default/banks/<project>/memories \
  -H 'content-type: application/json' \
  -d '{"items":[{"content":"…","document_id":"…","metadata":{"ticket":"KEY"}}]}'
```

Recall before digging into a project's code or history. Retain root causes and settled decisions a later agent would otherwise rediscover. Correct a stale memory by retaining under the same `document_id`. Never retain secrets or personal information. Related commands: `./agent.sh memory:list <project> <KEY>`, `memory:up`, `memory:backup`, `memory:restore`.

## Where agents run (sandboxes)

Each machine-using step (an AI step, or a script step that works on the ticket's code) runs on a **run target** (ASS-540, `src/control/run-targets.js`):
- **`local-vm`**: a Lima VM per ticket variation, cloned copy-on-write from the project's golden image. See `./agent.sh vm:inventory <project>`. Both live in the project's Lima folder (ASS-578): its `project.json` `lima-home` (an absolute path, say a disk of its own), else the harness-wide one (`data/harness.local.json`'s `lima-home`, else `~/.lima`). The golden image and its VMs are always in one folder (clones can't cross volumes). Every Lima call for the project's VMs runs with that folder as `LIMA_HOME`, per call (`src/agent-cli/lima-home.bash`, `src/control/machine-lima.js`); the disk check, `vm:reclaim-all`, the memory and CPU readings, `vm:ports` and the dashboard's shutdown cover every folder in use. A `lima-home` that isn't absolute or isn't writable (an unmounted disk) is named in control's log (`lima-home …`) and the project's VM commands refuse to run. Read one: `jq '."lima-home"' data/projects/<p>/project.json`. Move a project's VMs with `vm:move-lima-home` ("Adding machines to a project").
- **`workstation`**: existing GCP Cloud Workstations, reached over SSH (several tickets per machine, each in its own folder, ASS-529).
- **`cloud-vm`**: plain GCP Compute Engine VMs, used like workstations, reached through IAP.
- **`workstation-worktree`**, **`cloud-vm-worktree`** (ASS-553): the ticket variation's own worktree on one of the project's workstations or cloud VMs: its own folder there (`~/harness/worktrees/<KEY>[.<variation>]`) and checkout, the machine's toolchain, no VM; its agents in Claude Code's sandbox, or unsandboxed where it can't run (below). It takes that machine's seat and counts against its measured limits, beside its Substrate sandboxes. Kept between steps; removed once the ticket is done (`workstation:remove-worktree`, while the machine is connected).
- **`local-worktree`**: a git worktree for the ticket variation on the Mac, made on first use from the harness's own clone (`data/projects/<project>/checkouts/<repo>`, ASS-553), never from the operator's checkout; removed once the ticket is done or deleted. A worktree made before ASS-553 in the workspace's `.worktrees/` keeps working until then. **`local-workspace`**: the project's checkout on the Mac itself, one ticket at a time per project. Neither takes a seat, but their load counts against the Mac's budget.
- **`local-substrate`**, **`workstation-substrate`**, **`cloud-vm-substrate`**: the ticket variation's own Substrate sandbox on the Mac's cluster, a workstation's or a cloud VM's (ASS-535, "Substrate sandboxes" below). A project can list one only once `dev-environments.substrate.clusters` declares a cluster on that kind of host.

**The setup now (ASS-543): every project on sandboxes.** Every project's machine-using steps run in Substrate sandboxes, its text-only steps (`worktree: true`, below) in worktrees; gates, waits and the harness's bookkeeping steps stay with control on the Mac. Read a project's list with `jq '."dev-environments"."run-targets"' data/projects/<p>/project.json`:
- A project on the Mac alone: `[local-substrate, local-worktree]`, its cluster `{ "machine": "mac" }`.
- A project on its own workstations and cloud VMs (one whose images are amd64-only, so not the arm64 Mac): `[cloud-vm-substrate, workstation-substrate, workstation-worktree, cloud-vm-worktree]`, a cluster on each machine. Its app stack and declared suites run in each ticket's own sandbox (`sandbox/services.yaml`, ASS-542); a suite that can't run there (it builds its own Docker images, or doesn't hold under gVisor) is left out of the declaration, never routed to a full machine, and listed in the ticket that left it out.
- The shipped engines have no Docker step left (ASS-552 removed CI Checks), so these lists need no plain target; `engine:validate <project>` fails if an engine of the project's own still has one.
- **The alternatives stay supported**, each a `project:set-run-targets` away: `local-vm` (Lima VMs from the golden image, still built and kept current), `workstation` and `cloud-vm` (slots on the machine), `local-workspace`, and any mix (a substrate target first, a plain one after it for Docker steps). The golden image, the `workstations` and `cloud-vms` entries and the old `mode` derivation work as before.

**Isolation per target:**

| Target | What isolates its agents |
|---|---|
| `local-vm` | the ticket's Lima VM |
| `local-substrate`, `workstation-substrate`, `cloud-vm-substrate` | the ticket's Substrate sandbox (gVisor) and its egress gateway (ASS-538) |
| `workstation`, `cloud-vm` | its own folder (slot) on the machine; nothing else |
| `local-worktree`, `local-workspace`, `workstation-worktree`, `cloud-vm-worktree` | **Claude Code's own sandbox** (ASS-555): Seatbelt on the Mac, bubblewrap on Linux. Where it can't run there, **none** (ASS-564): the agent runs unsandboxed in its worktree, its file tools still held to it, marked `unsandboxed` |
| confined host agents (grooming, health checks, Blocked's host steps) | their own Claude Code settings (`host-agent-settings.json`, ASS-108) |

**Worktree agents in Claude Code's sandbox (ASS-555, `src/agents/worktree-sandbox.js`).** Control generates each agent's settings from its worktree path and the project's allowlist (ASS-538's: its forges, `api.anthropic.com`, the declared GitLab/GitHub, `registry.npmjs.org`, `dev-environments.substrate.egress.allow`) and starts it with them inline (`--settings`); the copy is `sandbox-settings.json` in its session folder (`data/agents/…`), holding paths and host names only, never a token. Its commands write only its worktree (a remote one: the variation folder's `repos/`), temp and the npm/pnpm caches; the Write and Edit tools only its working directories; hosts off the allowlist are refused (strict, even in bypass mode); no unsandboxed retry; Claude Code won't start without the sandbox; WebFetch is off; the model credentials and the machine's login files (ssh, gh, glab, gcloud, docker, kube, aws, netrc, `~/.harness`, every `project.json`) are hidden. Only `agent.sh` (and `off-board.sh` on the Mac) by absolute path, a bare line, runs outside it, and `docker exec -w <folder> <container> …` for an agent in the dev container. A write refused shows as "Operation not permitted", a host as the proxy's 403 (`deny network-outbound <host>` in the agent's session). Can't work from a worktree: git over SSH on the Mac, non-HTTP tools (database drivers, plain ssh), Docker, and editing `.claude/` settings, skills or hooks, `.git/hooks` or `.gitconfig` (Claude Code's protected paths). On a workstation or cloud VM the sandbox needs `bubblewrap` and `socat`, and bwrap allowed user namespaces. `workstation:setup` installs them (ASS-563), only on the machine as it is (never its infrastructure code, config or machine type), again at every start: the two packages from ones it keeps under `~/harness/tools/debs/sandbox` (`sudo -n dpkg -i`), and, when `apparmor_restrict_unprivileged_userns` is 1, an AppArmor profile allowing bwrap user namespaces (Ubuntu's `bwrap-userns-restrict` if shipped, else a minimal one; `sudo -n apparmor_parser -r`, the sysctl never changed). What it couldn't do is in `setup.sandbox.why` and `setup.failed` (marked `sandbox: true`), never a setup failure. It records whether the sandbox can run as `setup.sandbox` (`jq '.[] | .setup.sandbox' data/projects/<p>/workstations.json`). **Where the sandbox can't run, worktree agents run unsandboxed (ASS-564, the operator's decision of 2026-11-23):** a workstation or cloud VM whose `setup.sandbox.ok` is false or not probed yet, or the Mac without Seatbelt (`/usr/bin/sandbox-exec`), still takes `*-worktree` steps; the agent starts in its worktree with no sandbox settings (so no `failIfUnavailable`), keeping `permissions.blockWritesOutsideWorkingDirectories`, no token in its settings, and its prompt's write rules. Where the sandbox works nothing changes, `failIfUnavailable` included. To see it: control logs `dispatch worktree <KEY> <var> on <machine>: Claude Code's sandbox unavailable (<why>) — running unsandboxed` once per machine; the agent's session folder has `sandbox.json` (`{ "sandboxed": false, "why": … }`); the ticket screen's Details mark the agent `(unsandboxed)` with a `Sandbox` line saying where and why, and its `🌿 <KEY> worktree` line on its machine's card on the `n` screen ends in `unsandboxed`. README's "Worktree agents in Claude Code's sandbox" has the table.

Both sides use the same key, `run-targets`:
- **The project:** `dev-environments.run-targets` in `project.json` lists the targets it has and allows, in its default order. It replaces `dev-environments.mode`. Unset, it is derived from the mode: `vm` (the default) = `[local-vm]`, `workstation` = `[workstation, cloud-vm]`, `vm+workstation` = `[workstation, cloud-vm, local-vm]` (planning then stays on the local VM, as before). Set it with `./agent.sh project:set-run-targets <project> <target>…`. `./agent.sh project:migrate-run-targets [--dry-run]` writes every project's list from its mode once and removes the mode.
- **The step:** `run-targets:` in a `workflow.yaml` step, one target or a list in order of preference, only on machine-using steps. Engines set it only where a step can't run somewhere (the shipped engines: the VM-only scripts); otherwise the project's list decides. Setup's Check Setup Complete, Create VM and Mark Setup Complete, and Blocked's Add the Missing Repository, take the six machine targets, substrate ones first (ASS-551): on a substrate target Create VM (`vm:create`) makes or resumes the variation's sandbox and clones into its `/repos` what its image lacks through the Mac, the setup marker is written in the sandbox, and Add the Missing Repository's new repository is cloned into it the same way. Build's CI Checks (`ci-checks:verify`, Docker) takes only `local-vm`, `workstation`, `cloud-vm`.

**Resolution:** the step's list filtered to the project's, in the step's order (no list of its own: the project's). By default it takes the first target with a free seat now, and waits only when none is free. A step whose list shares nothing with the project's is never started, and control logs `project <p>: engine … can run on none of the project's run targets`. `./agent.sh engine:validate <project>` fails on the same steps, naming the engine and the step (ASS-551): run it after changing a project's run targets. A command that needs Docker (`machine-steps.js` `DOCKER_COMMANDS`, or the project's `dev-environments.substrate.needs-docker`) never runs on a substrate target, and a machine-only one (`MACHINE_ONLY`) never on the Mac targets. When a ticket's next step runs on another target, control runs `code:hand-over` first: its branch is committed and pushed where it was, and pulled where it goes. It runs in the background (ASS-585), never holding control's tick: the step waits for it (`waiting for its hand-over`) and starts only once it has succeeded, one per variation at a time; a failed one is retried with backoff; its duration is logged as it ends (`run-targets <KEY> <var>: handed over … in <n>s`). A Lima VM it reads from (or brings into) is stopped between steps, so the hand-over starts it (`vm:start`), bundles and pushes its branches, and stops it again (ASS-577), logged once as `run-targets <KEY> <var>: started its stopped Lima VM <vm> to hand its branches over; stopped again`; while the Mac is out of memory (the memory hold) the step waits instead, no failure counted. A VM that no longer exists is said so plainly (`… its Lima VM <vm> no longer exists; its branches were taken from the forge instead. Lost: …`): its `change/<KEY>…` branches come from the forge, and the hand-over finishes rather than retrying. A step starts only where the planner places it (ASS-567, `run-target-places.js` `heldElsewhere`): a step reached after its tick's seats were placed, whose seat record still names the previous step's target or which has none yet, waits one tick for its own (nothing started), whatever the hand-over history. **A project without `local-vm` runs no Lima VM** (ASS-581): control never makes, re-creates or starts one for its variations, whatever `vm` record a variation still carries from before run targets (a Blocked run's step included); a step with no seat waits for one on the project's own targets, logged once as `vm <KEY> <var>: its old Lima VM record ignored — <project> doesn't run on local-vm`, an old VM still running is stopped once idle, and `vm:create` refuses, naming why. The hand-over above, starting an existing old VM only to move its branches out, is the one exception. A sandbox's `/mnt/ticket` is copied only into a running sandbox and checked after the copy; `harness fault: sandbox ticket folder empty` in control's log means a copy came out short (the step is held and tried again, never given to an agent).

**Worktree steps** (ASS-554): a step that only reads code and writes text (Plan's, Code Review, Security Review, Explain the Change, Risk Assessment, the token check, Document's, Write Steps to Test, Requirements Changed's) carries `worktree: true` in its `workflow.yaml` and runs only on the worktree targets (`local-worktree`, `workstation-worktree`, `cloud-vm-worktree`) its project lists, by pool choice (`remote-first`: remote machines first, the Mac last), leaving the sandboxes and VMs for building and testing. Its own `run-targets`, if any, may name only worktree targets. A project with `run-targets` must list at least one worktree target, or control logs each flagged step as never started and `./agent.sh engine:validate <project>` fails naming the engine and step; a project still on a `mode` ignores the flag. An unflagged step with no `run-targets` of its own keeps off the worktree targets while a sandbox, VM, workstation or cloud VM is left for it. The branch is handed over at every switch; Plan's worktree branch (nothing of its own) is never pushed, and the worktree moves onto Build's branch when Review comes back to it. Typical lists: `./agent.sh project:set-run-targets <project> local-substrate local-worktree` on the Mac; a project on remote machines adds `workstation-worktree cloud-vm-worktree`, and `local-worktree` only if it has one repository (the Mac's worktree carries the workspace's repository alone) and its `worktree-setup` can run on the Mac or in a dev container that mounts `data/projects/<project>/checkouts`.

**Work mode** (ASS-556, `src/control/work-mode.js`): after Review Plan approves the plans, the shipped grouped and v2 Plans run **Choose Where to Work** (an AI step, `prompts/choose-work-mode-grouped`: points, the files and lines the plan touches, risk — migrations, auth, billing, infrastructure, security-sensitive paths — whether meaningful tests run without the app stack, contracts others depend on, Hindsight's recall of similar tickets and their CI) and **Record Where to Work** (`ticket:choose-work-mode`, on the host). The variation's `work-mode` becomes `worktree` or `full`, with its reasons, shown in the ticket screen's Details. The project's forced rules override the AI: `project.json` `work-mode.force-full` (a list of `{ paths: [globs], min-points, why }`, any matching forces full) beats `work-mode.force` (`worktree` or `full` for every ticket), which beats the AI; a project that lists no worktree run target is always full; `engine:validate <project>` checks the rules. In worktree mode every machine step runs on the project's worktree targets (remote first), the build steps too, and a step flagged `stack: required` in its engine (Local Testing's Take Screenshots) is skipped, recorded as skipped (`needs the running stack; built in a worktree`), not failed; unit tests, lint and type checks still run, the merge request's CI the rest. **Escalation to full is one-way:** an agent runs `ticket:escalate-work-mode <project> <KEY> <var> tests|review|ci "<why>"` when tests can't run in the worktree, a review or security review flags risk, or the merge request's CI fails for a reason that needs the stack (their prompts' `{work-mode-rule}` says so); once, logged by control, never back by itself (a re-plan keeps it full). A `ci` escalation retains a Hindsight memory (`work-mode-ci-<key>-<var>`) for the next choice. **The operator's override:** `./agent.sh ticket:set-work-mode <project> <KEY> <var> worktree|full [<why>]`, or `w` on the ticket screen (it asks first); kept by a re-plan, and the only way back to worktree after an escalation. `merge-request:check` records each CI run it sees fail and each merge request merged in the variation's `ci-results`; the `S` screen's metrics view shows tickets, escalations, CI pass rate, rounds and time to merge by mode. Read one: `jq '.features[] | select(.key=="<KEY>") | .variations[] | {name, "work-mode", "ci-results"}' data/projects/<p>/sprints/sprint-<n>/sprint.json`.

**Pool choice** (ASS-553, `src/control/pool-choice.js`): `first` (the default), `most-room` (the most headroom now, anywhere; ties keep list order), or `remote-first` (the default when a candidate is a worktree target): the project's remote machines whenever one has room, the most headroom among them, and the Mac only when every eligible remote machine is full. A stopped remote machine counts as available: control starts it and the step waits up to `harness.json`'s `remote-boot-wait-seconds` (900), then falls back (`seats <id> did not come up within …`). Control records each wait per project in `data/projects/<p>/boot-waits.json` (`since`, `ends-at`, `over`; ASS-575), kept across a restart; the dashboard reads it, so its planner and the `n` screen treat a machine past its wait as lost, as control does (`jq . data/projects/<p>/boot-waits.json`). Headroom is in tickets, from `remote-seats.json` and `seat-budget.json`. Set it per step (`pool-choice:` in `workflow.yaml`) or per project (`./agent.sh project:set-pool-choice <project> first|most-room|remote-first`). Each placement it decides is logged once (`seats <KEY> <var>: placed on … by pool choice …`).

### Substrate clusters

A project may also have Substrate clusters (ASS-533), declared in `project.json`'s `dev-environments.substrate.clusters` (a list, beside the run targets' `needs-docker`; each cluster's machine is what lets the project list that kind of substrate run target): `{ "machine": "mac" }` (kind on the Mac, one cluster all Mac projects share, each with its own WorkerPool, namespace and atespace `harness-<project>`), `{ "machine": "<workstation or cloud VM id>" }` (kind on that machine, over its SSH connection), or a `gke` entry (accepted, but refused at setup until the operator approves GKE). The README's "Substrate clusters" section says the fields and how it works.

```sh
./agent.sh substrate:up <project> [<machine>]       # create or connect, install/upgrade the pinned release; idempotent
./agent.sh substrate:health <project> [<machine>]   # what control runs every 3 minutes
./agent.sh substrate:down <project> [<machine>] [--cluster]
./agent.sh substrate:load-image <project> <machine> <archive|->   # an image built on the Mac, into the cluster
./agent.sh substrate:kit [<platform>]               # build the kit (pinned ate-setup, kubectl-ate, kind, kubectl) ahead
./agent.sh substrate:stop <project> <machine>       # stop a remote cluster's node, state kept (control does it before a cloud VM's idle disconnect)
```

- **Sandboxes (ASS-535).** A step on a substrate run target runs in the variation's own sandbox: an actor named `<key>-<variation>` (lower case) on the cluster of its seat's machine, recorded on the variation as `sandbox` { name, project, machine, state }. Control makes it before the step (it waits, `sandbox …` in control's log), stops it (hibernated: files and processes kept) when the variation holds no substrate seat and no agent turn or in-machine script of it runs, resumes it before its next machine step (no step re-run; 3 failed resumes in a row send the ticket to Blocked, ASS-537), and deletes it once the ticket is done. A **crashed** sandbox (ASS-568: after a Docker Desktop or cluster node restart every sandbox there comes back `crashed`, Substrate's `ACTOR_STATE_CRASHED`; a hibernated one whose snapshot was lost too) is replaced, not resumed and not counted against Blocked: `substrate:sandbox-up` exits 4, control runs `substrate:sandbox-delete … --salvage` (its branches pushed through the Mac only while its command server still answers; deleted either way, its token revoked), and the step's next try makes a fresh one from the branches on the forge, its app stack included. It logs `sandbox <KEY> <var>: its sandbox on <machine> had crashed (<state>); replaced. Lost: <what>` once (what from the commits record, ASS-558), adds a "Sandbox replaced" entry to `change-log-<var>.md` and a notice to the ticket screen's Health. A new sandbox that can't be made counts as usual (3 in a row, Blocked); one that crashes again before any bring-up worked since is replaced and counted. Commands reach it only through its image's command server (`src/substrate/sandbox-exec.js`, through `kubectl ate proxy`; no Docker in it), and its branches move on and off it through the Mac (`code:hand-over`). Its agents reach the Mac's forwarder (`agent.sh`) and their project's Hindsight through its egress rule set `mac` (ASS-536): at `host.docker.internal` on the Mac's cluster, at `harness-mac.harness-<project>.svc.cluster.local` on a remote one (the machine's relay, `harness-substrate-mac-relay`, onto its SSH connection's reverse forwards); `substrate:sandbox-up` issues its forwarder token, `substrate:sandbox-delete` revokes it. Each cluster has its own image registry (`harness-substrate-registry`, 127.0.0.1:5011 on its machine), which `substrate:deliver-image` fills.

- **The app stack (ASS-542).** A project that declares its stack in `data/projects/<p>/sandbox/services.yaml` (services, jobs, hosts, CA, app, login, suites) gets it in every ticket's sandbox: control runs `substrate:stack-up` right after the sandbox is up (dependency order, jobs once, the host map, the CA, the app's URL, the seeded user signed in). A failing service or job sends the ticket to Blocked; its logs are in `work/<KEY>/sandbox-stack-<var>/logs/`, the start and resume times in `work/<KEY>/sandbox-times-<var>.json`. The project's compose-based suites run there with `substrate:suite`.

```sh
./agent.sh substrate:stack-up <project> <KEY> <var>                    # the app stack up in the variation's sandbox (control does this)
./agent.sh substrate:suite <project> <KEY> <var> <suite>               # a declared suite against the sandbox's own stack
./agent.sh substrate:sandbox-up <project> <KEY> <var> <machine>      # made or resumed (control does this)
./agent.sh substrate:sandbox-stop|sandbox-delete <project> <KEY> <var> [--keep-work|--salvage]   # --salvage: a crashed one's (ASS-568)
./agent.sh substrate:sandbox-state <project> <machine> <actor>          # exists, running or suspended, its proxy
./agent.sh substrate:credentials <project> [<machine>]                  # the keychain items into the gateway's Secrets, each sandbox's egress policy
jq '.mac | {credentials, egress}' data/projects/<p>/substrate.json      # the last sync, and the gateway's state and refusals
jq '.mac.usage."sandbox-use"' data/projects/<p>/substrate.json          # each sandbox's measured memory and CPU
```
- **Credentials and egress (ASS-538).** A sandbox holds no token: Substrate's egress gateway injects them into its requests from Kubernetes Secrets (`harness-credential-<kind>` in `harness-<project>`) that `./agent.sh substrate:credentials <project> [<machine>]` keeps in step with the same keychain items VMs get (control re-syncs within 5 minutes of a re-saved item, an allowlist change or a missing Secret). The sandbox gets placeholders only (`/etc/profile.d/harness-credentials.sh`, `/etc/harness/gitconfig`, git over HTTPS). It reaches only its allowlist: its forges, the model API, its GitLab npm registries, `registry.npmjs.org`, plus `dev-environments.substrate.egress.allow` (a hand edit, with the operator's go-ahead). The gateway's refusals are logged by control (`egress refused: …`); a host no rule lists fails DNS in the sandbox and isn't logged anywhere (Substrate's gap). README's "Credentials through the egress gateway" has the details.
- **Never touch `~/.kube/config`.** Each cluster's kubeconfig is `~/.harness/substrate/<project>/<machine>.kubeconfig` on its machine. To look at a cluster yourself, pass it: `kubectl --kubeconfig ~/.harness/substrate/<project>/mac.kubeconfig get pods -A` (the kit's own `kubectl` and `kubectl-ate` are in `~/.harness/substrate/kit/current/bin`). Never run kind or kubectl without one.
- Docker Desktop needs the memory: on the 48 GB Mac it has all but 10 GB (38 GB) and all 14 CPUs. Too little shows as **Docker Desktop memory low**.
- **Setting one up:** add the cluster to the project (below, "Adding a Substrate cluster to a project"), then `./agent.sh substrate:up <project> [<machine>]`; control checks it every 3 minutes from then on and restarts it when a restart can fix it. The project's sandbox image: `./agent.sh substrate:build-image <project>` (from `data/projects/<project>/sandbox/services.yaml`), delivered to each cluster by control (`substrate:deliver-image`). Then list the substrate run target (`project:set-run-targets`).
- **What the template needs (capabilities).** Root in a gVisor sandbox has almost no capabilities by default, so `sudo -u agent` would fail. The template (`sandbox-template` in `on-machine/substrate.sh`) adds the most Substrate allows: CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETUID, SETGID, SETFCAP, SETPCAP, SYS_CHROOT. SYS_ADMIN and NET_ADMIN are refused at admission. It also mounts the egress gateway's trust bundle, names its image by digest, and asks for 7/8 of a worker's memory (`worker-memory-gib`: a template as large as its worker never places, the **template: no golden snapshot** chip).
- **Docker steps never run in sandboxes.** Docker can't run in one (no SYS_ADMIN). A command that needs Docker (`machine-steps.js` `DOCKER_COMMANDS`, plus `dev-environments.substrate.needs-docker`) is never given a substrate target: it runs on a local VM, workstation or cloud VM, and the branch is handed over to it and back. So a project whose engines still have a Docker step keeps a non-substrate target (and its golden image) for it; the shipped engines have none since ASS-552.
- **Hibernation (ASS-537).** A sandbox whose ticket gives up its seat is hibernated (snapshot kept, no memory or CPU) once nothing of it runs, and resumed before its next machine step. Its snapshots' disk is watched (**snapshot disk high**).
- A workstation keeps only `/home`: the cluster's state is there, and `workstation:setup` re-applies what it needs outside `/home` at every start. Never change how a project's machines are stood up (their infrastructure code, workstation config, machine types) for it.

### Seats and machines

A ticket in progress holds one **seat** on its step's run target (above), but only while its current step uses its machine (an AI step, or a script step that `src/control/machine-steps.js` declares in-machine). At a gate, a human step, a wait or a host-only script it holds none and its VM is stopped; back at a machine step it waits for the next free seat in rank order (ASS-527). Planning and building take **one pool** of seats, in control's rank order (ASS-528). A project's seats are its VM seats on the Mac plus each workstation's and cloud VM's own seats (ASS-529, below). There are no seat counts: the VM seats come every tick from the Mac's **seat budget** (`src/control/seat-budget.js`):
- `data/harness.json`'s `max-memory-percent` and `max-cpu-percent` (90 and 90 by default) are how much of the Mac the harness may use. A project's `share` in its `project.json` is a percentage of that. Unset shares split what's left equally; shares over 100 in total are scaled down, logged. Set them with `./agent.sh project:set-share <project> <percent|none>` (`none` back to the split; it refuses shares adding up to over 100, naming them) and `./agent.sh harness:set-budget [--memory <percent>] [--cpu <percent>]`.
- A project spends its share only on its own Lima VMs. Share it can't use (nothing waiting, or only remote work) goes to the projects that can; when its demand returns it takes the next freed seats until it's back at its share. Nothing running is stopped.
- A new seat is given only while the Mac's measured memory and CPU (CPU averaged over 5 minutes, with hysteresis), plus one more ticket's expected use, stay under both limits. If one can't be read, the other alone applies; if neither can, no new seat is given (held ones keep running), logged once as `budget can't read the Mac's memory or CPU — no new seats until it can`.
- `max-tickets-in-progress` and `max-tickets-in-planning` are no longer read (`./agent.sh harness:migrate-seat-budget [--dry-run]` removes them). `max-tickets-ready-for-build` still caps finished plans.
- **Workstations and cloud VMs** (ASS-529, `src/control/remote-seats.js`) take as many of their project's tickets as their own memory and CPU allow: control measures a machine with a ticket on it once a minute over SSH (`./agent.sh workstation:usage <project> <id>`, recorded as `usage` in `workstations.json`), and gives it one more seat while its use plus one more ticket stays under its limits: its entry's `max-memory-percent` / `max-cpu-percent` in `dev-environments` (set them with `./agent.sh machine:set-limits <project> <id> [--memory <percent>] [--cpu <percent>] [--clear]`), else `harness.json`'s. A machine with none of the project's tickets always takes one; one not measured (stopped) keeps what it holds, at least one; one whose reading fails takes no new ticket, logged once as `remote <p> <id>: can't read its memory or CPU`. Its seats and why: `data/projects/<p>/remote-seats.json`. A machine that can't be used loses all its seats.
- **Remote disk** (ASS-557): the same `workstation:usage` call reads the disk the machine's work lives on (`~/harness`: a workstation's `/home`, a cloud VM's root or data disk), recorded as `usage.disk` and in `remote-seats.json`'s `disk` (`total-bytes`, `used-bytes`, `free-bytes`, `hold-bytes`, `release-bytes`, `held`). Below its hold (its entry's `disk-free-hold-gb`, else `harness.json`'s 15) it takes no new ticket, not even a first; held ones keep running. It stays held until free space is back above its `disk-free-warn-gb` (else 50), capped at half of what the hold leaves of the disk. Logged once each way as `hold <p> <id>: its disk …`. Set the levels with `./agent.sh machine:set-limits <project> <id> --disk-hold <gb> --disk-warn <gb>`. To free space: `./agent.sh workstation:ssh <project> <id>`, then look under `~/harness`.
- On a shared machine each ticket's step runs in its own folder (a **slot**: `~/harness`, else `~/harness/slots/<n>`, in `workstations.json` as `holder` and `holders`), with its own checkout. `dev-environments.ticket-isolation` decides how their tests keep apart: `"one-at-a-time"` (the default when unset) runs the project's test and CI steps one at a time per machine and adds nothing to its sessions (one ticket on a machine runs exactly as before); `"separate"` (opt-in, once the project's compose files and test scripts use them) gives each slot's sessions their own `COMPOSE_PROJECT_NAME` (`harness-slot<n>`) and `HARNESS_PORT_OFFSET` (100 × n) through its `slot.env`, and lets tests run side by side. Set it with `./agent.sh project:set-ticket-isolation <project> one-at-a-time|separate`.
- **Substrate sandboxes** (ASS-535) take their host's seat: a Mac seat for `local-substrate` (the budget), the machine's own for the others. A project on sandboxes counts a ticket at a sandbox's measured memory (rootfs writes included) and CPU, not a VM's; a hibernated sandbox holds no seat and counts no memory or CPU.
- **The per-ticket estimate on the Mac** (ASS-570, `src/control/ticket-estimate.js`): for a project on `local-substrate`, the seat budget sizes its allotment by one *working* ticket's use. A sandbox's reading (`substrate.json`'s `sandbox-use`, every 3 minutes) is a sample only when the sandbox is `running` and an agent turn or in-machine script of its variation ran through the whole check interval up to the reading; idle, starting (resuming), hibernated and hibernating sandboxes are never sampled, and each reading is taken once. The estimate's target is, per dimension, the larger of the 80th percentile of the last 50 working samples and the floor, the Mac cluster entry's `sandbox-memory-gib` / `sandbox-cpu-percent` (1.5 GiB / 100%); with no samples it is the floor. It moves towards the target by at most ×1.1 a tick, never below the floor, and is kept across ticks and restarts in `data/projects/<p>/ticket-estimate.json` (its samples, the last reading taken, the estimate; written by the project's own control, read by the others). Where it came from is in the `budget <p>: …` log line (`per ticket 1.5 GiB, 100% CPU (defaults)` or `… (from 12 working samples)`; a VM project's says `(a VM's)`) and in `seat-budget.json`'s `per-ticket` (`source` `working-samples`, `defaults` or `vm`, `samples`, `floor`, `target`): `jq '."per-ticket"' data/projects/<p>/seat-budget.json`. Raise the floor (a hand edit, operator's go-ahead) for a project whose working sandboxes are known to be bigger (a whole app stack in one sandbox measured about 9 GiB, ASS-542). **Remote machines use the same estimate** (ASS-574): a workstation's or cloud VM's sandboxes are sized the same way, one estimate per machine from that machine's own working samples (its cluster entry's `sandbox-*` figures the floor), kept in `data/projects/<p>/ticket-estimate-<machine>.json`; the machine's own measured use per ticket still counts when it is higher. Its `remote <p> <id>: …` log line says `one ticket <mem> GiB, <cpu>% CPU (defaults)`, `(from N working samples)`, `(…; its measured use per ticket above it)`, or `(a VM's)` on a machine without sandboxes, and `remote-seats.json`'s `per-ticket` carries the same `source`, `samples`, `floor`, `target`, plus `measured`: `jq '.[] | ."per-ticket"' data/projects/<p>/remote-seats.json`. Its project's warm workers' memory requests count in its cluster's reserve, and its snapshots' disk against the cluster's disk: no new seat for sandboxes while one more snapshot would take it below `disk-free-hold-gb` (ASS-537; `jq '.mac.usage | {"snapshot-bytes", disk, workers}' data/projects/<p>/substrate.json`).
- **Run targets** (ASS-540): each seat record in `seats.json` carries its `target`. A holder whose next step wants another kind of target moves seats between its steps, never during one. The `local-worktree` and `local-workspace` holders take no seat and are `seats.json`'s `local` list.
- **Focus on planning** (ASS-531): `./agent.sh project:set-planning-focus <project> on|off` (or `P` on the sprint screen) puts every ticket at a planning step ahead of the rest for seats and agents, rank order within each group, nothing running cut off, and lifts `max-tickets-ready-for-build` off planning. Off, ranking is as usual. Read it with `jq . data/projects/<project>/planning-focus.json`.

These are read-only looks: change seats and machines only through the CLIs.

```sh
p=<project>
# its share, and which workstations and cloud VMs exist
jq '{share, workstations: [."dev-environments".workstations[]?.id], "cloud-vms": [."dev-environments"."cloud-vms"[]?.id]}' \
  data/projects/$p/project.json
# its VM seats now and why: share, allotment, use (seats, its VMs' memory and CPU), lends/borrows, demand, the Mac's figures
jq '{seats, share, "share-source", allotment, used, lends, borrows, want, "per-ticket", mac}' data/projects/$p/seat-budget.json
# each remote machine's tickets, seats and why (ASS-529): state (measured, unmeasured, unread), its use against its limits, its disk (ASS-557)
jq -c 'def gib: if . == null then "-" else (. / 1073741824 * 10 | round / 10) end;
  to_entries[] | .value as $m | {id: .key, held: $m.held, seats: $m.seats, state: $m.state, limits: $m.limits,
  memory: "\($m["memory-used-bytes"] | gib)/\($m["memory-budget-bytes"] | gib) GiB", cpu: "\($m["cpu-percent"] // "-")/\($m["cpu-budget-percent"] // "-")%",
  disk: "\($m.disk["free-bytes"] | gib) GiB free of \($m.disk["total-bytes"] | gib)\(if $m.disk.held then " HELD" else "" end)", why: $m.why}' \
  data/projects/$p/remote-seats.json
# which seats are filled, by kind (vm, workstation, cloud-vm), with the ticket and machine in each; then the planning holders and the Mac-target ones
jq -r '(.seats | group_by(.kind)[] | "\(.[0].kind): \(length) — \(map(.key + (if .workstation then "@"+.workstation else "" end)) | join(", "))"),
       "planning: \((.planning // []) | map(.key) | join(", "))", "on the Mac: \((.local // []) | map("\(.key) \(.target)") | join(", "))"' \
  data/projects/$p/seats.json
# its run targets (unset: derived from its mode)
jq '."dev-environments" | {"run-targets", mode}' data/projects/$p/project.json
# each workstation's and cloud VM's last known status (state, connection, setup, last error)
jq -c 'to_entries[] | {id: .key, state: .value.state, connected: .value.connected, setup: .value.setup.ok, "last-error": .value["last-error"]}' \
  data/projects/$p/workstations.json
```

- For a fresh status of one machine, run `./agent.sh workstation:status <project> <id>`. It asks gcloud, then records and prints the state (running, stopped, starting…), the connection and the setup. Add `--connection` to check only the SSH connection.
- Local VMs: `./agent.sh vm:inventory <project>` (each VM's ticket, state and disk), or `limactl list`.
- `seats.json`'s `planning` list holds the planning seat holders. Control logs each seat-budget change as `budget …` in `~/.harness/logs/control-<project>.log`.
- **The dashboard's footer** (ASS-566) is three status lines for the project on screen (on the sprint screen a blank line keeps them apart from its legend, ASS-573), each within 120 columns (a value that doesn't fit is shortened with `…`, never wrapped; at 120 the provider is dropped first, since its account names it):
  1. `control: up (<uptime>, pid: <pid>)` (green, as Hindsight's; amber `draining`, `restarting`; red `waiting for its data`; red `control: DOWN (exit <code>, restart in <n>s, crash <n>)`, or `… given up after <n> crashes, press R`, when it is down), `hindsight: up (port <n>)`, `provider: GitLab|GitHub`, `<provider> account: <push account>` (red with the reason when the push-account check fails), `claude account: <email>`.
  2. Machine health, one summary per group: `local` (the Mac, always: it runs control, the forwarder and Hindsight for every project, ASS-573), then the project's `gcp workstations` and `cloud VMs`: `healthy`, or `<n> healthy, <n> unhealthy (<id> <why>; …)`, the unhealthy in red. Unhealthy is what the header chips or the `n` screen mark red or unusable: setup failed, sign in needed, unreachable or start timed out, a reading that failed, over its memory or CPU limit, its disk held, its Substrate cluster in trouble; for the Mac, over the harness budget or unreadable, the disk hold, a memory hold. Stopped and idle is healthy (`src/tui/machine-health.js`).
  3. `session: <n>%, resets <in>` and `weekly: …` (red while rate limited), or `billing: API key (<org>)` and `API $<spent> / $<budget> this month` for a project billed by API key; `disk free: <GiB>` (amber below the warning level); `repos: <n> in <group>` (or `repo: <owner>/<name>`); `day spend` and `sprint spend`. ASS-571: a window past its reset shows a gray `—`; a reading over 10 minutes old adds its age in gray (`as of 2d ago`); a failed reading a red `usage unreadable (token expired)` (`unreadable, read 2d ago` when the line is full). See the Credentials table's Claude login row.
- **Machine detail is on the `n` screen** (compute network, below): what the footer's old boxes had (ASS-566), for the project on screen only, on its machine cards (ASS-572): the Mac's memory and CPU against the harness budget (its gauges, red past a limit, `● not read`), the project's `share` (`(split)` when unset), `allotment`, `uses` (red `over` above its allotment), `lends` / `borrows` and the memory and CPU behind them on the Mac card's `Share` line, its part of each Substrate cluster on the card's `Cluster` line; each workstation's and cloud VM's tickets (Seats), memory and CPU against its own limits and its verdict (`full: …`, `not measured yet`, `no new work: its reading failed`). Each card's `On it` lists every one of the project's tickets there, one a line, cut with `…` to the card's width, never wrapped (ASS-590): `💺 <KEY> Lima VM · running` (or `creating`), `📦 <KEY> sandbox · <state>`, `🌿 <KEY> worktree · 🤖 <step>` (or `idle`; on the Mac or, ASS-553, a remote machine), `📁 <KEY> slot`, `📂 <KEY> workspace` (or `workspace free`), a variation other than A after the key, `🤖xN` / `💻` with the step while agents or a script work on it, a gold `unsandboxed` while its agent runs without Claude Code's sandbox (ASS-564). Each card's `Image` line (ASS-580) is the sandbox image its machine's cluster runs for the project: the Mac's its own architecture's (arm64), a remote machine's amd64, as `sandbox image <arch> built <day> UTC`, amber `building`, red `build failed` or gray `none`; no line on a machine without the project's cluster (the Mac's card still shows an image built for it). Under the cards the project line: `agents: <model> 🤖xN, …`, its `golden image` (built day, UTC), and only a sandbox image no card shows, so none appears twice.
- **The seat queue** is `q` on the sprint screen (ASS-566; the footer's queue box before): drawn over the screen, `q` or Esc closes it. It lists the tickets control will give a seat to next, in order, each with what it waits for (`build`, `plan`, `plan, full` or `memory`), from control's `seat-queue.json`, as many as the screen has room for; `empty` when nobody waits.
- Its sprint screen says where each ticket variation's current step runs (ASS-559), in two columns read from `seats.json` (its `target`, the machine's id, the `local` list) and the variation's `sandbox` record: **Machine** (`Mac`, `GCP workstation <id>`, `Cloud VM <id>`; the id goes under the label when the column is narrow) and **Runs in** (`Lima VM`, `slot` (a remote machine's working folder), `Substrate sandbox`, `worktree` (on the Mac or, ASS-553, a workstation or cloud VM), `workspace`), with `hibernated` beneath a hibernated sandbox. Both are blank while the ticket holds no seat (a gate, a wait, a host-only step, waiting for a seat), except that a hibernated sandbox still shows, in gray, where it is parked. These replace the old 💺 / ⛅ / 🌐 / 📦 seat marks and the "· sandbox on <machine>" after the title. The table lists only tickets and its section lines: no empty seat rows (ASS-579; seats are no fixed counts), the `n` screen and the seat queue (`q`) show room for more work.
- The dashboard's `n` screen (compute network, ASS-557; redesigned by ASS-572, `src/tui/screens/network.js`) answers, for the project on screen (the left and right arrows pick it), where its next ticket goes, which machines have room, and why one isn't taking work. **The headline**: `<project> · N machines · N can take work · N of M seats in use · next ticket → <machine> (<runs in>; <why>)`, the machine the planner itself would place it on (`plan.js` `nextPlacement`: the same pool choice, ASS-553), `· after N already waiting` when waiting tickets take the free seats first; in red, `nothing can take work: <machine> <why>, …` when none has room. **One card per machine**, two a row from 120 columns, the next ticket's machine first, then those that can take work in the order the pool choice would try them, then the rest: the Mac (always, ASS-580; `mac · shared by N projects`, its gauges the whole Mac's from `seat-budget.json` and `disk-space.json`, its seats, tickets and `Share` line the project's; a project that can't run work there — no Mac run target, no Mac Substrate cluster — gets the gauges and a gray `no work: none of its run targets is on the Mac`, no seats or `Share` line, after every other machine, counted in the headline but never its next machine), and each workstation and cloud VM (from `remote-seats.json` and `workstations.json`). Its title has a status dot: `● running` green, `● starting` amber, `○ stopped` gray (started on demand), `● unreachable` / `setup failed` / `sign-in needed` / `start timed out` red. A machine control is waiting for to boot says `starting · waited <m> of <n> min` under Seats; past `remote-boot-wait-seconds` it says `no work: didn't come up within <n> min; work goes elsewhere until it's up` in red, and the headline never names it (control's `boot-waits.json`, ASS-575). Its CPU, RAM and Disk gauges are bars of the whole machine with `│` at the harness's limit (a disk's at its hold), green, amber within 10 points, red over; CPU is a percent of the whole machine (5-minute average), never per core. A stopped or unreachable machine's last figures are gray, their age in its title. A short terminal cuts the cards from the bottom and says `+N machines below`; the headline and the legend always show. Use it first when asking "why is nothing going to that machine?".
- Other machine commands: `workstation:connect|disconnect|ssh|setup`.

### Adding machines to a project

No CLI adds or removes a machine, so that is the hand edit to `data/projects/<project>/project.json` allowed above. A share, a machine's limits, the ticket isolation, the harness budget and the project's run targets have commands (below; run targets: `project:set-run-targets`): use them, not a hand edit. Get the operator's go-ahead first. Write the file whole, `jq … > tmp && mv tmp project.json`, never half-written. Control rereads `project.json` every tick, so no restart is needed. Watch the footer and control's log after the change.

**Worktrees on remote machines** (ASS-553): `./agent.sh project:set-run-targets <project> workstation-worktree cloud-vm-worktree local-worktree` (the machines must be listed already). Steps then fill the remote machines first and the Mac last (`remote-first`).

**Running steps on the Mac** (ASS-540): `./agent.sh project:set-run-targets <project> local-worktree` (or `local-workspace`, one ticket at a time) with the project's `local-environments` `local-pc` folder set. No seat is taken, so nothing caps them but the Mac's measured load (the seat budget) and `max-agents`.

**More local VMs** (Lima): a VM is made per ticket automatically, and the seat budget decides how many run (ASS-528). To give a project more:
- Raise its `share`, a percentage (0–100) of the budget: `./agent.sh project:set-share <project> 40`. `./agent.sh project:set-share <project> none` goes back to the equal split. It refuses shares that would add up to over 100, naming each project's. Or raise the budget itself: `./agent.sh harness:set-budget --memory <percent> --cpu <percent>` (`data/harness.json`'s `max-memory-percent` and `max-cpu-percent`). `data/harness.json`'s `vm-disk-limit-gb` caps the VMs' disk. Then watch its `share` / `allotment` on the `n` screen's Mac card, its `Share` line (with that project on screen).
- A smaller golden image (its `template.yaml` `memory:`) makes each ticket cheaper, so more fit.
- Too much budget gives **Out of memory** or **Out of disk space** holds (`vm:inventory`, "Watch the machine").
- The project needs a current golden image (`./agent.sh vm:golden-status <project>`; build it with `vm:build-golden`).
- **Its own Lima folder** (ASS-578), for a project whose VMs need a disk of their own: with the operator's go-ahead and **the harness stopped**, `./agent.sh vm:move-lima-home <project> <folder> --dry-run` (what moves, the space a copy needs and the target has), then without `--dry-run`. It moves the project's golden image(s), a leftover build and its ticket VMs, and sets its `lima-home` (removes it when the folder is the harness-wide one); no hand edit. It refuses, moving nothing, while the harness runs, a golden build of it runs, one of its VMs isn't stopped, or the target holds one of their names. Across volumes each instance is copied whole, sparse-aware (`cp`): clones become full copies, so it refuses unless the target keeps `disk-free-hold-gb` free after it (delete VMs no ticket needs first: `vm:reclaim <project>`). Each copy is checked (files, sizes, `limactl list` under the new folder says `Stopped`) before `lima-home` is set and the old copies deleted. It copies the old folder's Lima key (`_config/user`) and `networks.yaml` into a new folder without them; Lima 2.x also gives a VM its folder's key at every boot. On the same volume it just renames.

**A cloud VM** (a GCP Compute Engine VM): the harness never creates, resizes or stops one. It must already exist, and then:
1. **Prerequisites on the GCP side:** the VM runs Linux with Docker. The operator's gcloud account can reach it through IAP on port 22, with OS Login, and can start it. It stops itself when idle (the harness expects an idle self-stop, about 60 minutes).
2. **The gcloud login that reaches it:** `CLOUDSDK_CONFIG=<folder> gcloud auth login` when it isn't the default config. Check the login with `gcloud compute instances describe <id> --zone <zone> --project <gcp-project>` under the same config.
3. **Add it** under `dev-environments` in `project.json`. The `id` must be unique across workstations and cloud VMs:
   ```json
   "dev-environments": {
     "mode": "vm+workstation",
     "cloud-vms": [
       { "id": "<vm-name>", "gcp-project": "<gcp-project>", "zone": "<zone>",
         "gcloud-config": "~/.config/<name>/gcloud", "ssh-user": "<os-login-user>" }
     ]
   }
   ```
   - `gcloud-config` and `ssh-user` are optional. `ssh-user` defaults to the gcloud account's OS Login name (`ada.lovelace@example.com` becomes `ada_lovelace_example_com`).
   - The project's run targets must list `cloud-vm` (`./agent.sh project:set-run-targets <project> cloud-vm local-vm`, in the order you want them tried), or, while it still has a `mode`, the mode must be `workstation` (remote seats only) or `vm+workstation` (remote first, then local VMs). A project listing `cloud-vm` with no cloud VM fails validation, naming the field. With neither, cloud VMs are ignored.
   - Each cloud VM adds seats (as many tickets as its own memory and CPU allow, ASS-529), taken after the workstations and before the VM seats. Optional `max-memory-percent` / `max-cpu-percent` (1–100) in its entry cap how much of it the harness uses; `harness.json`'s apply without them. Once it's added, set or clear them with `./agent.sh machine:set-limits <project> <id> [--memory <percent>] [--cpu <percent>] [--clear]`. The machine's card on the `n` screen shows its use against them (the gauges' │).
   - Optional `ticket-isolation` in `dev-environments` (not per machine): `"one-at-a-time"` (the default) or `"separate"` (see "Seats and machines"). Set it with `./agent.sh project:set-ticket-isolation <project> one-at-a-time|separate`.
4. **Check it:** `./agent.sh workstation:connect <project> <id>`, then `workstation:setup <project> <id>`, then `workstation:status <project> <id>`. Control does the same by itself. A bad entry is logged by control naming the field, and then neither workstations nor cloud VMs are used. Setup failures show as **Cloud VM `<id>` setup failed**.

### Adding a Substrate cluster to a project

A hand edit too (operator's go-ahead), to `dev-environments.substrate.clusters` in `project.json`, then a command:

1. **The machine:** `mac` (Docker Desktop running, with the memory above), or one of the project's own workstations or cloud VMs (already added, connected and set up; Linux with Docker, its data under `/home` on a workstation). `gke` is accepted but refused until the operator approves GKE.
2. **Add it**, written whole as above:
   ```json
   "dev-environments": {
     "substrate": {
       "clusters": [ { "machine": "mac" }, { "machine": "<workstation or cloud VM id>" } ]
     }
   }
   ```
   Optional per entry: `memory-gib` (2.5) and `cpu-percent` (30), the cluster's fixed cost; `sandbox-memory-gib` (1.5) and `sandbox-cpu-percent` (100), one sandbox's before it is measured, and the floor of that machine's per-ticket estimate (ASS-570 on the Mac, ASS-574 on a remote machine); `warm-workers` (1); `worker-memory-gib` (4) and `worker-cpus` (4), one worker's limits. Hosts sandboxes may reach besides the defaults: `dev-environments.substrate.egress.allow`. A wrong entry is logged by control naming the field, and nothing of the list is set up until it is fixed.
3. **Set it up:** `./agent.sh substrate:up <project> <machine>`, then `./agent.sh substrate:health <project> <machine>` (should say `healthy`), and `./agent.sh substrate:credentials <project> <machine>` (control does it too).
4. **Its image:** `./agent.sh substrate:build-image <project>` (amd64 for remote machines, the Mac's own arch for `mac`); `substrate:image-status` to check.
5. **Use it:** list the substrate target before the plain one, e.g. `./agent.sh project:set-run-targets <project> local-substrate local-vm`. Keep a non-substrate target only if an engine of the project's still has a Docker step (`engine:validate` says).
6. **Watch** the `n` screen's machine cards (each one's `Cluster` line and its sandboxes), the footer's machine health line and the header's Substrate chips.

Remove a cluster with `./agent.sh substrate:down <project> <machine> [--cluster]`, then take its entry out (only once no ticket's step runs on that substrate target).

**A GCP Cloud Workstation:** the same steps (its run target is `workstation`), under `dev-environments.workstations`, each `{ id, gcp-project, region, cluster, config, gcloud-config?, max-memory-percent?, max-cpu-percent? }`. The workstation must already exist. The harness connects with `gcloud workstations ssh`.

Remove a machine by deleting its entry, but only while no ticket holds its seat (check `seats.json`).

## Tickets

Every change gets a ticket, and the harness works every ticket. That is the happy path. Work a ticket by hand (`./agent.sh ticket:set-manual <project> <KEY> on`) only when the operator insists on making the change directly. A hand-made change merges into `main` only while the harness is stopped.

Before creating a ticket:
1. Check it doesn't exist already: `./off-board.sh ticket:list <project>` and the backlog (or the Jira project), searching for the functionality, not just the title.
2. Follow the shape of the project's recent tickets (sections, tone, acceptance criteria). Read a few with `ticket:get` first.

Create: `./off-board.sh ticket:create <project> <type> <title> <body-file>`. Then `./agent.sh ticket:join-sprint <project> <KEY> <state>` to make it sprint work.

### Working a ticket by hand (manual)

A ticket marked manual is one control leaves alone: no seats, VMs, sandboxes or agents for it. The operator (or a Claude session beside them) builds it instead. Do this only when the operator asks for it ("build it with sub-agents here"); otherwise let the harness build it.

```sh
./agent.sh ticket:set-manual <project> <KEY> on ["<note>"]   # e.g. "Built by a subagent in a worktree at the operator's request"
./agent.sh ticket:set-manual <project> <KEY> off             # hand it back to control
```

- It records `worked-manually` (`{ by, since, note }`) on the ticket in the sprint file (and works on a backlog ticket too). The ticket screen shows it. Reaching the engine's done step removes it by itself.
- **Mark it in the same command as joining the sprint.** Control acts on a joined ticket within seconds (VMs, enrich-AC and RCA agents), and `ticket:join-sprint` does not carry a backlog ticket's `worked-manually` over: `./agent.sh ticket:join-sprint <project> <KEY> committed && ./agent.sh ticket:set-manual <project> <KEY> on "<note>"`. Then check control's log for dispatches, and compare the sprint's acceptance criteria with `./off-board.sh ticket:get`. A brand-new off-board ticket can't be marked until the downloader has synced it (a few minutes after `ticket:create`; until then it says `no <KEY> in the active sprint`).
- **Build it in its own worktree**, off `main`: `git worktree add -b change/<KEY> .worktrees/<KEY> main`, with a subagent working there rather than in the foreground. Never `git stash`. Commit messages start `<KEY>:`.
- **Merge** only once its tests pass (`npm test` in the worktree), and only while the harness is stopped, as a merge rewriting `engines/` under a running control can crash it. Then mark it Done: `./agent.sh ticket:change-state <project> <KEY> A <current-state> done`, and restart the harness if it needs loading.
- **Find manual tickets left unfinished:** `jq -r '[.features[]?, .bugs[]?, .spikes[]?][] | select(."worked-manually") | "\(.key)\t\(.title)\t\(."worked-manually".since)"' data/projects/<project>/sprints/sprint-<n>/sprint.json`. The flag goes when a ticket is done, so any ticket listed is still open.

### The ticket system is upstream

For a Jira (or other ticket-system) project, the harness only mirrors the ticket system. The downloader pulls, every few minutes, the tickets **assigned to the operator** (`assignee = currentUser()`, sub-tasks excluded): those in an open sprint become sprint work, and those in a future sprint or none become backlog. So to bring a ticket in, or to change its assignee, sprint, priority, links or status, change it **upstream**, e.g. `acli jira workitem assign --key <KEY> --assignee "@me"`, then move it into the sprint in Jira. Off-board projects have no upstream: the `off-board.sh` commands are the ticket system.

The harness can work **stories, bugs and spikes**. It can't work tasks, epics or sub-tasks, so never assign the operator to those for the harness to build.

### Dependencies, and who is working them

- In the harness, a sprint ticket's `dependencies` (Jira's "is blocked by" links, pulled by the downloader) are in its sprint file. An off-board ticket's are its `depends-on` (`./off-board.sh ticket:get`; set with `ticket:set-dependencies`).
- Every Jira ticket's assignee, status and type are in `analytics/tickets.json`, or ask Jira: `acli jira workitem view <KEY> --fields assignee,status,priority --json`.

```sh
# each sprint ticket's dependencies, with who has each one and its status
p=<project>; s=$(ls -d data/projects/$p/sprints/sprint-* | sort -V | tail -1)
jq -r --slurpfile a data/projects/$p/analytics/tickets.json '
  ($a[0].tickets | map({(.key): .}) | add) as $t
  | [.features[]?, .bugs[]?, .spikes[]?] | map(select((.dependencies // []) | length > 0))[]
  | "\(.key) (\(."ticket-system-assignment" // "unassigned")) depends on: "
    + ([.dependencies[] | "\(.) [\($t[.].assignee.name // "unassigned"), \($t[.].status // "?")]"] | join(", "))' \
  $s/sprint.json
```

The operator prefers to take on the tickets that their own tickets depend on, so the dependency gets built first. When a dependency of theirs is unassigned and not Done, offer to assign it to them. **Never assign the operator to a ticket someone else already has.** Name its assignee instead.

### Finding new tickets for the operator

When the operator asks for new tickets to take on, look only at unassigned, not-Done stories, bugs and spikes. Rank them:
1. **The current sprint first.** Look at other sprints or the backlog only after it.
2. **Higher ticket-system priority first** (Jira's priority, or an off-board ticket's `priority`).
3. **The operator's strengths.** They may prefer kinds of work they're best qualified for. Ask if you don't know, and keep their answer in memory, not in this file.
4. Unblocking the operator's own tickets counts in a ticket's favour (see above).

```sh
acli jira workitem search --jql 'project = <KEY> AND sprint in openSprints() AND assignee is EMPTY
  AND statusCategory != Done AND issuetype in (Story, Bug, Spike) ORDER BY priority DESC, rank ASC' \
  --fields 'key,summary,priority,issuetype,status' --json
```

Show a short ranked list with each ticket's priority, type, and why it fits. Assign only the ones the operator picks, upstream.

## Looking things up in Jira

There are two ways in. Pick by what you need.

**The Atlassian CLI (`acli`)** is signed in on this machine as the operator (`acli jira auth status`). It's good for quick reads and for changes:

```sh
acli jira workitem view <KEY> --fields 'summary,status,assignee,priority,issuetype' --json
acli jira workitem search --jql '<jql>' --fields 'key,summary,status,assignee,priority,issuetype' --json [--limit N | --paginate]
acli jira workitem assign --key <KEY> --assignee "@me"
```

Its quirks:
- `search` returns only a fixed set of fields: **no sprint, no issue links, no custom fields**. `--fields key` alone gives nulls, so add another field.
- `view --fields '*all'` works, but search doesn't.

**The Jira REST API** is what the harness's own analytics use (`src/downloader/jira-rest.js`). It uses basic auth with the project's Atlassian API token: the keychain item its `atlassian` entry in `~/.harness/vm-credentials.json` names, with that entry's `email`, else the Jira work source's `api-email` and `api-token` from `data/projects/<project>/project.json`. The site and board id come from that work source's `url` (`https://<site>/jira/software/c/projects/<KEY>/boards/<id>`). **The API is the only way to see which sprint a ticket is in.** That's the work source's `sprint-field` (`customfield_10020` by default), with every sprint the ticket has been in and each one's `state` (`active`, `closed`, `future`). It also gives full changelogs, other people's tickets, and links.

```sh
p=<project>
ws=$(jq -c '[."work-sources"[] | select(.type=="jira")][0]' data/projects/$p/project.json)
site=$(jq -r '.url | capture("^(?<s>https://[^/]+)").s' <<<"$ws")
sf=$(jq -r '."sprint-field" // "customfield_10020"' <<<"$ws")
a=$(jq -c --arg p "$p" '.[$p].atlassian // empty' ~/.harness/vm-credentials.json)
if [ -n "$a" ]; then auth="$(jq -r .email <<<"$a"):$(security find-generic-password -s "$(jq -r '."keychain-service"' <<<"$a")" -w)"
else auth=$(jq -r '"\(."api-email"):\(."api-token")"' <<<"$ws"); fi    # never echo this
# a ticket's sprints, status and assignee (any JQL works)
curl -s -u "$auth" -G "$site/rest/api/3/search/jql" --data-urlencode "jql=key = <KEY>" \
  --data-urlencode "fields=summary,status,assignee,priority,issuetype,issuelinks,$sf" \
  | jq -c --arg sf "$sf" '.issues[] | {key, status: .fields.status.name, assignee: .fields.assignee.displayName,
      sprints: [.fields[$sf][]? | {name, state}]}'
unset auth
```

Other calls the harness uses:
- `GET /rest/api/3/search/jql?jql=…&fields=…&expand=changelog&maxResults=100`: pages with `nextPageToken` until `isLast`. Add `expand=changelog` for status and assignee history.
- `GET /rest/api/3/issue/<KEY>/changelog?startAt=&maxResults=100`: the rest of a long changelog.
- `GET /rest/agile/1.0/board/<board-id>/sprint?state=active,closed,future`: the board's sprints (`id`, `name`, `state`, dates).
- `GET /rest/api/3/myself`: checks the token works.

Notes:
- Search answers **200 with no issues** when it rejects the token, so an empty result can mean bad credentials. Check `/myself` first: it gives 401 or 403 for a rejected token (that's the **Jira API token rejected** warning).
- Never print or log the token. Keep it in a variable, as above.
- For past data without calling Jira, `data/projects/<project>/analytics/tickets.json` holds every ticket's status and assignee history, refreshed by the downloader.

## Building a ticket several ways (variations)

When the operator wants a ticket built more than one way (say, following another answer to one of its questions), add a variation. Each variation gets its own seat, VM, branches (`change/<KEY>.<var>-<id>`) and `-<var>` work files. The ticket's other variations carry on unchanged.

1. Write a brief: a short file saying what this variation does differently. It's the operator's file, and agents can't edit it. Where it conflicts with the ticket's description or answered questions, the brief wins for this variation only.
2. Add the variation. It's named B, then C, and so on, and starts at `committed` unless you pass `--at`:
   ```sh
   ./agent.sh ticket:add-variation <project> <KEY> --brief <file> [--at <state>]
   ```
   The brief is kept as `work/<KEY>/variation-brief-<var>.md`. The ticket must be in the active sprint and not Done.
3. At **Variation Selection** (an Operator Needed gate), present each variation's result (`explanation-<var>.md`, `test-results-<var>.md`, its merge requests) with a recommendation. Then record the operator's pick, which soft-deletes the others (see the table below).

## Human gates

Some steps in a workflow are **human gates**: steps with `action.type: "human"`, where the ticket waits until the operator decides. Examples are Human Review, the Payment Gate, Variation Selection, Blocked for Human, Awaiting the Plan Answer, and a backlog's Awaiting Approval. Each gate's choices are its `exit-events`' `human-review` decisions. Gates differ by project and engine, so **read the active engines** (`engine:show`) to know where the operator will have to act. List a project's gates through its execution engine and every sub-engine it reaches:

```sh
P=<project> bash <<'EOF'
p=$P; todo=$(jq -r '."execution-state-engine"' data/projects/$p/project.json); seen=" "
while [ -n "${todo// /}" ]; do
  set -- $todo; n=$1; shift; todo="$*"
  [[ "$seen" == *" $n "* ]] && continue; seen="$seen$n "
  e=$(./agent.sh engine:show $p $n 2>/dev/null) || continue
  jq -r --arg n "$n" '.steps[] | select(.action.type=="human") | "\($n)/\(.id)\t\(.name)\t\([."exit-events"[]? | .condition | (.["human-review"] // (if .["variation-selected"] then "pick a variation" else empty end))] | join(" | "))"' <<<"$e"
  todo="$todo $(jq -r '[.steps[] | select(.action.type=="state-engine") | .action.engine] | unique | join(" ")' <<<"$e")"
done
EOF
```

(It runs under `bash`, because zsh doesn't split `$todo` into words.) For the backlog's gates, start from the project's backlog refinement engine instead.

There are two more kinds of gate:
- **Gates added to one variation:** `ticket:set-gate-when-leaving-state <project> <KEY> <var> <engine>/<state>…` makes that variation wait for approval when it leaves those states. They are in the variation's `gate-when-leaving-state`.
- **Steps switched off** in the engine are skipped, gates included.

When a ticket reaches a gate, it becomes **Operator Needed** (below). Tell the operator before the gate when you can see a ticket heading for one: "<KEY> will stop at the Payment Gate after Review". Record the operator's decision with the listing's `choices` argv, `ticket:human-review`, or `ticket:approve-gate` for an added gate.

### When requirements change after a ticket has started

The downloader's `ticket:sync` notices when a sprint ticket's description changes in its ticket system. It doesn't overwrite the description. It **holds** the change as the ticket's `pending-requirements-change`, pauses the variations being worked, and the ticket becomes **Operator Needed** at that decision. The operator decides:

- **Take new: build against the latest requirements.** `./agent.sh ticket:take-new <project> <KEY>`. The new description becomes the ticket's and the variations are un-paused. A variation at Plan or later (steps flagged `recheck-on-requirements-change`) then takes the **Requirements Changed** detour (`grouped-requirements-changed`):
  1. It revises the acceptance criteria.
  2. It judges the built work, or the plan, against them.
  3. If everything still passes, it returns to its group. Otherwise it goes back into Plan at Root Cause Analysis to adjust the build plan.
  
  A variation earlier than Plan just takes the new description.
- **Keep current: defer the late requirements** to a separate ticket delivered after this one. `./agent.sh ticket:keep-current <project> <KEY>`. The current description stays and the variations are un-paused. The ticket doesn't hold this change again unless the description changes once more. **Keep current doesn't create the follow-up ticket.** Create it yourself, with the operator's go-ahead:
  - **Jira:** upstream, holding the late requirements, linked as depending on this ticket. Put the original requirements back on this ticket in Jira if the operator wants the two to match.
  - **Off-board:** `off-board.sh ticket:create`, then `ticket:set-dependencies` on it, naming this ticket.

To present the decision, compare the held text (`pending-requirements-change.description` in the sprint file) with the current description and `requirements-history.jsonl`. Then say what changed, how far the ticket has got, and what Take new would cost (re-planning, re-build). Recommend one.

Two related cases:
- **A ticket already Done:** a description change isn't held. It is noted (`requirements-change-notified`) with a comment on the ticket. Late requirements there always need a new ticket.
- **A non-blocking question answered differently from its assumption** is a requirements change too, and starts the same Requirements Changed detour.

## Operator Needed tickets

A ticket is **Operator Needed** when it can't move without the operator: it's Blocked for Human, waiting at a human step or gate, has an open blocking question, or has a pending requirements change. List them, with why each one waits and its ready-to-run choices:

```sh
./agent.sh ticket:operator-needed [<project>]
```

It prints `{ <project>: [{ key, title, variation, step, reason, choices }] }`, the same set the dashboard shows:
- `reason` says why the ticket waits: `blocked` with the AI's `short`/`long` feedback, `gate` and `instructions`, `questions` (each with the `where` and `index` that `question:answer` takes), or a requirements `change`.
- `choices` holds each option at a gate as a ready-to-run `argv`. Run it as `./agent.sh <argv…>`. A choice marked `needs-reason` takes the reason last.

When the operator is available, go through them **one at a time**, in this form:

```
<KEY>: <ticket title>
<short summary of the ticket>

Context:
<short context on why the question is being asked>

Question:
<the agent's question>

Recommendation:
<your recommendation>
```

Read the ticket's work folder (and recall from Hindsight) before recommending. Then act on the operator's direction. Prefer the listing's `choices` argv, because it is exactly what the dashboard would run. Otherwise:

| Situation | Command (`./agent.sh …`) |
|---|---|
| Answer a question | `question:answer <project> <KEY\|global> <index> "<answer>" ["<why>"]` (index from 0 in the questions file) |
| Accept / reject an answer the AI judged | `question:accept …`, `question:reject <project> <KEY> <index> "<why>"` |
| Blocked for Human, resolved | `ticket:human-review <project> <KEY> <var> blocked-for-human Resolved ""` |
| Blocked for Human, AI tries again | `ticket:human-review <project> <KEY> <var> blocked-for-human "Have AI Try Again to Unblock this Ticket" ""` |
| Re-run the failed check first | `ticket:recheck-block <project> <KEY> <var>` |
| Approve a gate | `ticket:approve-gate <project> <KEY> <var>` |
| Choose at a human step | `ticket:human-review <project> <KEY> <var> <state> "<decision>" <to-state\|"">` |
| Pick a variation | `ticket:select-variation <project> <KEY> <asking-var> <state> <selected-var> ""` |
| Requirements change | `ticket:take-new <project> <KEY>` or `ticket:keep-current …` |
| Move to a state | `ticket:change-state <project> <KEY> <var> <from> <to>` |
| Pause / unpause | `ticket:set-paused <project> <KEY> <var> true\|false` (all of a project's: `assignments:pause`) |
| Remove / restore | `ticket:delete`, `ticket:restore` |

The variation (`<var>`) is usually `A`. A `""` to-state records the choice and lets control take the step's exit (for Blocked for Human, back to the step the ticket was blocked in). Decision names come from the step's `exit-events` in the engine.

## Blocked tickets waiting on a fix

This section is about **Blocked**, the AI's own troubleshooting state, not Blocked for Human. When a ticket is Blocked, its Blocked run (`engines/grouped-blocked`) troubleshoots and classifies the problem. A harness or project problem gets a fix: a fix ticket (in the harness project, or the ticket's own project's ticket system), or a fix merge request. The blocked ticket then **waits on it**:
- **Wait on the Fix** (`ticket:wait-on`) records the variation's `waits-on`.
- **Await the Fix** (or **Await the Fix Merge Request**) runs `ticket:fix-landed` every 5 minutes.

The fix has **landed** when its ticket is Done and either went through a merge step, or has a commit starting `<FIX-KEY>:` on its project's default branch. A merge request fix has landed when the merge request has merged. A **harness** fix also needs the running controls restarted on code that contains it. Until then the ticket's Health says "Fix `<KEY>` landed; waiting for a harness restart to load it", and the header shows **Restart to load N landed fixes**.

Once it has landed, **Find Where to Resume** (`ticket:fix-resume-step`) picks the step to go back to: the fix ticket's declared `resume-at`, else the earliest step the fix's commits or changed work files touch, else the step it blocked at. The ticket then **resumes automatically**, with no operator needed. It moves to that step at once, even with no free seat, and waits there for one (ASS-522). A fix ticket that closed without landing sends the ticket round Blocked again.

### When a ticket doesn't resume although its fix is deployed

Find the cause first:

```sh
./agent.sh ticket:fix-landed <project> <KEY> <var>   # safe to run: { waits-on, status, landed, awaiting-restart? } (it only refreshes the restart flag and Health)
```

- **Exit 1 with `awaiting-restart`:** the fix is merged but not loaded. Restart: `./agent.sh harness:request-restart`. Don't move the ticket by hand.
- **Exit 1 otherwise:** the fix isn't seen as landed. The fix ticket isn't Done yet, or it is Done with no merge step and no `<FIX-KEY>:` commit on the default branch (for example a squash or merge commit named otherwise). Or `waits-on` names the wrong ticket.
- **Exit 3:** the fix ticket closed without landing. **Exit 4:** the ticket waits on nothing.

If the fix really is deployed and the ticket still sits in Blocked, **resume it yourself**. Tell the operator which ticket and why.

```sh
./agent.sh ticket:fix-resume-step <project> <KEY> <var>        # prints { resume-at, resume-source, resume-why } — read-only
./agent.sh ticket:change-state <project> <KEY> <var> blocked <resume-at>
./agent.sh ticket:wait-on <project> <KEY> <var> -              # then clear the finished wait
```

- **Resume at the right step:** use `resume-at` from `fix-resume-step`, or the step the ticket was blocked at when it prints none. You can read that step from the variation's last `state-changes` into `blocked`.
- **Visit counts restart:** the move records cause `fix-landed`, so steps visited before the block don't count toward max-visits.
- **Move it first, then clear the wait.** Clearing `waits-on` while the ticket is still in Await the Fix sends it to Blocked for Human (`fix-landed` exits 4).
- **Control ends the Blocked run itself** once the ticket has left Blocked.
- **All of this is for Blocked only.** Blocked for Human is a different workflow, the operator's step: don't use `change-state` there. Follow "Operator Needed tickets" (Resolved, or Have AI Try Again).

## Priorities

Control ranks the sprint by itself (ticket-system priority, bugs first, dependencies, closeness to done, points). The operator can override it:

```sh
./agent.sh ticket:set-manual-priority <project> <KEY> <n>          # 1 = top; "" clears
./agent.sh ticket:set-manual-backlog-priority <project> <KEY> <n>  # the same for the backlog
```

## Data and analytics

- **Team performance**: `data/projects/<project>/analytics/` (`tickets.json` with every status and assignee change, `merge-requests.json`, `sprints.json`) and `team.json` (people and roles). The dashboard's `p` screen shows each developer's tickets, sub-tasks, points and MRs per day, first-pass rate, and dev and test time (`src/analytics/performance.js`).
- **Control runtimes**: `./agent.sh harness:tick-stats [<project>]` gives tick durations, overall and per phase.
- **Models**: each AI step's model is `action.model` in its engine's `workflow.yaml`. List them with `./agent.sh engine:show <project> <engine> | jq -r '.steps[] | select(.action.model) | "\(.id)\t\(.action.model)"'`. The models available per CLI are in `data/harness.json`. Spend: `claude-usage.json`, `chat-spend.json`, `memory-spend.json`, `data/api-cost.json`.
- **State analytics**: the `S`, `B` and `f` flow screens show, for each state, its visits, time, agent time, dispatches, cost and tokens (`src/tui/metrics.js`, from the variations' state changes).

## Watch the machine

The harness is heavy on CPU, memory and disk (VMs, agents, Hindsight). Check before starting heavy work, and say so when something is low:

- Disk: `./agent.sh harness:check-disk-space`, `vm:inventory <project>`, `vm:reclaim-all --dry-run`. Below `disk-free-warn-gb` control deletes stopped VMs. Below `disk-free-hold-gb` it starts no new work. Every Lima folder's volume counts, a project's own `lima-home` too (ASS-578: `jq .volumes data/disk-space.json`); `vm:reclaim-all` frees each short volume from the VMs of the projects whose folder it holds.
- Memory and CPU: `memory_pressure`, `top -l 1 -o cpu | head -20`. Control holds new VMs when memory is short.

## Hard rules

- Never `git stash`: the stash is shared across worktrees.
- Never put secrets, tokens or a project's private details in the repo. It is published.
- Never push `main` raw. Pushing goes through the operator's scrub-and-squash flow.
