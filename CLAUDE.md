# CLAUDE.md

This repo is a customizable AI agent harness. It orchestrates agentic work, from backlog to merged change, across one or more projects, with a human operator approving at the gates. The README covers the architecture and setup. This file is for a Claude session working **beside the operator**: running the harness, filing tickets, and clearing what waits on them.

## Map

- `src/control/`: control, the long-lived process that ticks, dispatches agents and runs script steps.
- `src/tui/`: the dashboard (`./harness.sh tui`), which also starts control and the downloader.
- `src/downloader/`: pulls tickets and merge requests from Jira, GitLab and GitHub.
- `src/agent-cli/`, `src/off-board-cli/`, `src/harness-cli/`: the commands behind the three CLIs.
- `engines/`: shared workflows (state engines, as JSON). See `engines/grouped-engines.md`.
- `prompts/`, `personas/`: what agents are told, and who they are.
- `data/`: live state, gitignored apart from `harness.json` and `agent-names.json`.
  - `data/harness.json`: harness-wide settings. `data/harness.local.json` holds this machine's.
  - `data/projects/<project>/`: one folder per project (see below).
- `src/off-board/<project>/`: off-board ticket bodies (gitignored).
- `~/.harness/`: run pids, logs, backups, `restart-requested.json`.
- `test/`: `npm test` (node:test). Run one file with `node --test test/<file>.test.js`.

## The CLIs: use them, don't hand-edit JSON

Change the harness's state only through its CLIs, never by editing a JSON file in `data/`. The CLIs take the file locks, keep histories, and sync the ticket system. A hand edit races control and can corrupt state. Run `--help` to list each CLI's commands with their usage:

- `./harness.sh --help`: run the dashboard, install or export a project bundle, the downloader.
- `./agent.sh --help`: everything control and agents do (tickets, questions, VMs, memory, restarts…).
- `./off-board.sh --help`: off-board tickets (create, list, get, edit).

The only exceptions are the settings no CLI covers, such as `dev-environments` / `cloud-vms` in a `project.json`. Edit those only with the operator's go-ahead, and only by hand.

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
| Last download | `data/projects/<project>/last-data-download` (a timestamp, normally within `download-updates-interval-in-minutes`) |
| Hindsight | `curl -s localhost:<hindsight.port>/health` should say `"status":"healthy"`. Control restarts it, or run `./agent.sh memory:up <project>`. |
| Image registry (zot) | `curl -s -o /dev/null -w '%{http_code}' localhost:<registry.port>/v2/` should give 200. Restart with `./agent.sh registry:up <project>`. |
| Credentials and logins | `./agent.sh project:credentials-status <project>`, where `held: true` means new work is held. Also `data/projects/<project>/gcloud-requires-reauthentication` (`true` means run the `gcloud auth login` the dashboard names). |
| Pauses, self-healing | `jq '.status, .pauses, ."self-healing"' data/assignments.json` |
| Pending restart | `~/.harness/restart-requested.json`, and `./agent.sh harness:restarted` |
| Golden VM image | `./agent.sh vm:golden-status <project>` (`current`, building, failed…) |
| Disk, memory | `data/disk-space.json` (`level`), `harness:check-disk-space`, and see "Watch the machine" |
| Workstations, cloud VMs | See "Seats and machines" |

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
| **Background work off** (no notification) | `project.json` has `background-work: false`, which the operator set. | No health checks, memory checks, appeals or self-healing. | `./agent.sh project:set-background-work <project> on` |
| **Out of memory** (harness-wide) | Before starting a VM, control found too little memory free on the Mac (macOS memory pressure against the VMs' footprint plus margin). Its file is `memory-hold.json`. | No VM starts or is created. Tickets wait without a seat, and no failure is counted. | Free memory on the Mac. Control rechecks every tick. |
| **Out of disk space** (harness-wide), with the amber line "Disk nearly full — work held" | The Lima or data volume is below `disk-free-hold-gb` (15). It stays on until free space is back above `disk-free-warn-gb` (50). | Nothing new starts: no agents, VMs, clones or golden builds. | Free disk (`vm:reclaim-all --dry-run`, `vm:inventory`). It releases by itself. |
| **Disk low** (amber line, harness-wide) | Free space is below `disk-free-warn-gb` (50). | Control deletes stopped VMs no ticket needs. | Usually nothing. Free space if it keeps falling. |
| **Restart to load N landed fix(es)** (harness-wide) | A harness fix merged, but the running controls predate it. Tickets wait at fix-landed. | Those tickets wait. | Restart: `./agent.sh harness:request-restart` |
| **No work in progress** | An active sprint, but no agent working any sprint ticket. It notifies only after 5 minutes. | Nothing is being built. | Check the sprint for what holds the tickets: paused, blocked, Operator Needed, seats full, a hold above. |
| **Jira API token rejected** | The downloader's analytics sign-in was refused. Its file is `jira-token-rejected.json`. | Analytics (the `p` screen) stop updating. Work goes on. | A new Atlassian API token (see Credentials). It clears on the next good sign-in. |
| **SIGN IN** (banner) | The project's Claude login isn't its `expected-account` (`account-hold`). | None of the project's agents start, and it is also a credentials hold. | The banner's command: `[CLAUDE_CONFIG_DIR=<dir>] claude`, then `/login` as the expected account. It clears within ~1 min. |
| **RATE LIMITED** (banner) | Claude's 5-hour or 7-day limit was hit (and the API key's cap too, when there is one). Its file is `rate-limit.json`. | Agents of that kind get nothing until the reset time shown. | Nothing. It lifts by itself at the reset. |
| **SELF HEALING** (banner) | Control is fixing a harness or project problem itself. | Only the tickets listed under "Paused" are paused. | Nothing. It clears when the fix ends (`self-healing:stop`). |
| **PAUSED BY HUMAN** (banner, no notification) | The operator paused the project, or all projects. | Agents commit and stop. | `space` on the dashboard for the project, or `!` for all. |
| **PAUSED BY AI** (banner, no notification) | An agent paused work (`assignments:pause … ai`), with a reason and ETA. | Agents commit and stop. | Control releases it after the ETA. Only the AI releases it earlier. |
| **CONTROL DOWN — `<project>` — …** (red line) | That project's control exited. The line says when it restarts, or that it gave up after 5 crashes in 10 minutes. | No ticks for that project. | Wait for the restart, or press `R` on the control screen (`c`). Check `~/.harness/logs/control-<project>.log`. |
| **CONTROL `<PROJECT>` WAITING FOR ITS DATA** (red line) | Control can't read a data file: the drive is gone, or a file is half-written. It notifies after 60 s. | Ticks are skipped. Control exits after `data-unreadable-exit-seconds` (300). | Make sure the data drive is mounted and the file is readable. |

These aren't warnings: "Subscription rate limited — agents are on the API key" (information only), the Operator Needed tile and red ● (see Operator Needed tickets), the spend, usage and API-budget boxes, and the green RUNNING banner.

## Credentials

Tokens live in the macOS keychain wherever possible. `~/.harness/vm-credentials.json` (0600, no secrets) declares, per project, which keychain items agents' machines get, by kind: `claude`, `anthropic`, `gitlab`, `github`, `git` (the commit identity). Never print a token's value. Talk about the keychain service name or the file field instead.

**The one check:** `./agent.sh project:credentials-status <project>` reads the latest `project:check-credentials` result (control runs it every ~3 min). It lists each problem with its exact fix. It only checks that keychain items **exist** and that logins answer. An expired VM token shows up only when a step fails with it, and then a Blocked run rechecks the credentials.

| Credential | Used for | Stored | Created / refreshed | When it breaks |
|---|---|---|---|---|
| **Claude login, host** | Agents on the Mac | The project's `CLAUDE_CONFIG_DIR` (`data/projects/<p>/.claude`, or `~/.claude`). Keychain item `Claude Code-credentials[-<sha8>]`. | `[CLAUDE_CONFIG_DIR=<dir>] claude`, then `/login`. Claude Code refreshes it itself. | The **SIGN IN** banner when the login isn't `project.json`'s `expected-account`. Usage-read failures are only logged. |
| **Claude token / Anthropic API key, VMs** | Agents in VMs, workstations and cloud VMs | The keychain item that `vm-credentials.json` declares (`claude`: a `claude setup-token` token; `anthropic`: a Console API key) | `security add-generic-password -U -s "<service>" -a "$USER" -T /usr/bin/security -w "$(pbpaste)"`. Re-saving it is enough: control notices the keychain change (every ~5 min) and re-injects it into idle VMs. | A missing item gives a credentials hold. An expired one makes the steps that use it fail (Blocked). |
| **GitLab PAT, VMs** (`gitlab`) | git push/pull, `glab`, and npm registries inside VMs | Keychain (declared, with `host` and `npm-registries`) | As above (scopes `api`, `read_registry`). Picked up automatically. | Missing: a hold. Rejected: the footer's red `account: token rejected (401)` (hourly push-account check, **not** a hold). |
| **GitHub PAT, VMs** (`github`) | git and `gh` inside VMs | Keychain | As above. | The same as GitLab. |
| **glab login, host** | Downloader (MRs), host merge-request commands, golden builds | glab's own config | `glab auth login`. Its OAuth token is short-lived and refreshes on use. | **run 'glab auth login' asap** (checked every 2 min when `check-for-expired-glab-auth`), and a hold. |
| **gh login, host** | Downloader (PRs), golden builds | gh's own config | `gh auth login` | A hold (`gh is not authenticated on <host>`). |
| **gcloud login, host** (default config) | Image registry upstream, the gcloud check, arm64 builds | gcloud config | `gcloud auth login`. The Workspace session lapses after ~16 h. | **run 'gcloud auth login' asap**, and a hold. |
| **gcloud logins, per machine** (`gcloud-config` in `dev-environments`) | Workstations and cloud VMs | That `CLOUDSDK_CONFIG` folder | `CLOUDSDK_CONFIG=<cfg> gcloud auth login` | The chip names that exact command. The machine's footer says `sign in needed` and its seat is lost. It retries every 2 min. |
| **Registry (zot) upstream token** | Pulling images through zot | `<registry storage>/credentials.json`, from a gcloud access token | **Automatic** every 30 min (`registry:refresh-credentials`). | Fails only if gcloud is logged out (logged). zot then serves its cache only. |
| **Jira analytics token** | Downloader's analytics (the `p` screen) | **Plain text** in `project.json`: `work-sources[].api-email` / `api-token` (kept out of bundles) | Make a new token at id.atlassian.com (Security, API tokens), then the operator edits it into `project.json` themselves. No rotation. | **Jira API token rejected** chip. Not a hold. Work goes on. |
| **acli login** | Downloader's ticket sync, `ticket:set-ticket-system-status`, `ticket:raise-bug`, your Jira commands | acli's own config | `acli jira auth login`. The harness never checks it. | Only downloader log errors (`~/.harness/logs/downloader.log`) and failing ticket commands. **No chip.** |
| **Hindsight LLM key** | Each project's Hindsight | The keychain item named by `project.json` `hindsight.llm-api-key-keychain-service` | Re-save the item. The next `memory:up` sees the change and restarts Hindsight. | `memory:up` fails with "keychain item … can't be read". A bad key isn't detected. |
| **Anthropic Admin key** | Month-to-date API spend (`api-cost.json`) | Keychain `harness-anthropic-admin-key` (or `project.json` `api-cost-admin-keychain-service`) | By hand | Logged only. The API spend figure stops updating. |
| **npm registry token, host** | pnpm on the Mac for GitLab npm registries | pnpm user config | `./harness.sh npm-registry-login <project>` (keeps a working token, else asks for a new one) | Failing installs only. |
| **SSH** | Lima VMs (Lima's own key), workstations and cloud VMs (`~/.ssh/google_compute_engine`, through IAP / OS Login) | `~/.ssh`, `$LIMA_HOME/_config` | Made on first use by `gcloud` / Lima | Connect errors in control's log and the footer. Not a hold. |
| **Forwarder tokens** | An agent in a VM calling `agent.sh` on the Mac | `~/.harness/vm-tokens.json` (hashes only) | **Automatic**, new on every `vm:start` | 403 `unknown token`. Nothing to do. |

**When to tell the operator:** any credentials hold, SIGN IN, or gcloud/glab chip. Also: a red `account:` error in the footer, `jira-token-rejected.json`, and downloader log lines about the signed-in Jira account. Also: tickets Blocked on auth errors (401/403, "authentication", "token") in their `ai-feedback` or test output. Give the exact fix command, and say which project and which keychain service or login it is.

## Projects and their workflows

- Projects: `ls data/projects/`. Each has a `project.json` with its `name`, `work-sources` (`jira` or `off-board`), `repositories`, limits, Hindsight port, and `execution-state-engine`.
- A project's workflow is that engine: `engines/<engine>/state-engine.json`, or a project's own one under `data/projects/<project>/engines/<engine>/`. Its steps say what each one runs (a prompt, a script, or a human gate), its model (`action.model`), and where each exit goes. The dashboard's `S`, `B` and `f` screens draw the sprint, backlog and sub-flows.
- Sprint state: `data/projects/<project>/sprints/`. Backlog: `backlog.json`.

## Where ticket information lives

A ticket's work folder is `data/projects/<project>/work/<KEY>/`, with one file per variation (`-A`, `-B`…):
- `ticket.json`, `ticket-A.json`: the ticket and its variation's state and history.
- `change-log-A.md`: the change history. `root-cause-analysis-A.md` and `root-cause-analysis-review-A.md`: RCA.
- `execution-plan-A.md`, `plan-review-A.md`, `code-review-A.md`, `security-review-A.md`, `risk-assessment-A.md`, `test-plan-A.md`, `test-results-A.md`, `steps-to-test-A.md`, `explanation-A.md`.
- `questions-and-answers.json`: the ticket's questions. Project-wide ones are in `data/projects/<project>/global-questions-and-answers.json`.
- Status history: `./off-board.sh ticket:history <project> [<key>]` (off-board), or `analytics/tickets.json` (Jira).

## Acceptance criteria: passed or failed

Each ticket variation has its own copy of the acceptance criteria, in its sprint file, as `acceptance-criteria: [{ criteria-number, description, dev-status, testing-status }]`. Each status is `Passed`, `Failed` or `Incomplete`, and agents record them:

- **`dev-status`**: Generate Solution marks each criterion its change meets `Passed`, else `Failed`. Code Review marks a criterion `Failed` when it rejects the change for it.
- **`testing-status`**: the Test step marks each criterion `Passed` or `Failed` from `test-results-<var>.md`, which gives the evidence for each one.

Both use `./agent.sh ticket:set-ac-status <project> <KEY> <var> <dev|testing> <n> <Passed|Failed|Incomplete>`. The sprint screen shows them as dots (green passed, red failed, gray incomplete), and the ticket screen lists them per criterion. To see why one failed, read the variation's `test-results-<var>.md`, `code-review-<var>.md` and `change-log-<var>.md`.

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

A project's `dev-environments.mode` in `project.json` decides:
- **Local VMs** (`vm`, the default): a Lima VM per ticket variation, cloned copy-on-write from the project's golden image. Planning always runs here. See `./agent.sh vm:inventory <project>`.
- **GCP Cloud Workstations**: existing workstations, reached over SSH, held one step at a time.
- **GCP cloud VMs** (`cloud-vms`): plain Compute Engine VMs, used like workstations, reached through IAP.

`vm+workstation` uses a workstation or cloud VM seat first, then a VM seat.

### Seats and machines

A ticket in progress holds one **seat**. A project has `max-tickets-in-progress` VM seats, one seat per workstation and per cloud VM, and `max-tickets-in-planning` planning seats (local VMs). `data/harness.json`'s `max-tickets-in-progress` caps all projects together. These are read-only looks: change seats and machines only through the CLIs.

```sh
p=<project>
# how many seats, and which workstations and cloud VMs exist
jq '{"vm-seats": ."max-tickets-in-progress", "planning-seats": ."max-tickets-in-planning",
     workstations: [."dev-environments".workstations[]?.id], "cloud-vms": [."dev-environments"."cloud-vms"[]?.id]}' \
  data/projects/$p/project.json
# which seats are filled, by kind (vm, workstation, cloud-vm), with the ticket and machine in each
jq -r '.seats | group_by(.kind)[] | "\(.[0].kind): \(length) — \(map(.key + (if .workstation then "@"+.workstation else "" end)) | join(", "))"' \
  data/projects/$p/seats.json
# each workstation's and cloud VM's last known status (state, connection, setup, last error)
jq -c 'to_entries[] | {id: .key, state: .value.state, connected: .value.connected, setup: .value.setup.ok, "last-error": .value["last-error"]}' \
  data/projects/$p/workstations.json
```

- For a fresh status of one machine, run `./agent.sh workstation:status <project> <id>`. It asks gcloud, then records and prints the state (running, stopped, starting…), the connection and the setup. Add `--connection` to check only the SSH connection.
- Local VMs: `./agent.sh vm:inventory <project>` (each VM's ticket, state and disk), or `limactl list`.
- Planning seats aren't in `seats.json`. The dashboard's footer shows every seat and machine: `local virtual machines` (free build and planning seats included), `gcp workstations` and `cloud virtual machines`. Its sprint screen marks each ticket's seat: 💺 VM, ⛅ workstation, 🌐 cloud VM.
- Other machine commands: `workstation:connect|disconnect|ssh|setup`.

## Tickets

Every change gets a ticket, and the harness works every ticket. That is the happy path. Work a ticket by hand (`./agent.sh ticket:set-manual <project> <KEY> on`) only when the operator insists on making the change directly. A hand-made change merges into `main` only while the harness is stopped.

Before creating a ticket:
1. Check it doesn't exist already: `./off-board.sh ticket:list <project>` and the backlog (or the Jira project), searching for the functionality, not just the title.
2. Follow the shape of the project's recent tickets (sections, tone, acceptance criteria). Read a few with `ticket:get` first.

Create: `./off-board.sh ticket:create <project> <type> <title> <body-file>`. Then `./agent.sh ticket:join-sprint <project> <KEY> <state>` to make it sprint work.

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

## Building a ticket several ways (variations)

When the operator wants a ticket built more than one way (say, following another answer to one of its questions), add a variation. Each variation gets its own seat, VM, branches (`change/<KEY>.<var>-<id>`) and `-<var>` work files. The ticket's other variations carry on unchanged.

1. Write a brief: a short file saying what this variation does differently. It's the operator's file, and agents can't edit it. Where it conflicts with the ticket's description or answered questions, the brief wins for this variation only.
2. Add the variation. It's named B, then C, and so on, and starts at `committed` unless you pass `--at`:
   ```sh
   ./agent.sh ticket:add-variation <project> <KEY> --brief <file> [--at <state>]
   ```
   The brief is kept as `work/<KEY>/variation-brief-<var>.md`. The ticket must be in the active sprint and not Done.
3. At **Variation Selection** (an Operator Needed gate), present each variation's result (`explanation-<var>.md`, `test-results-<var>.md`, its merge requests) with a recommendation. Then record the operator's pick, which soft-deletes the others (see the table below).

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

## Priorities

Control ranks the sprint by itself (ticket-system priority, bugs first, dependencies, closeness to done, points). The operator can override it:

```sh
./agent.sh ticket:set-manual-priority <project> <KEY> <n>          # 1 = top; "" clears
./agent.sh ticket:set-manual-backlog-priority <project> <KEY> <n>  # the same for the backlog
```

## Data and analytics

- **Team performance**: `data/projects/<project>/analytics/` (`tickets.json` with every status and assignee change, `merge-requests.json`, `sprints.json`) and `team.json` (people and roles). The dashboard's `p` screen shows each developer's tickets, sub-tasks, points and MRs per day, first-pass rate, and dev and test time (`src/analytics/performance.js`).
- **Control runtimes**: `./agent.sh harness:tick-stats [<project>]` gives tick durations, overall and per phase.
- **Models**: each AI step's model is `action.model` in its engine's `state-engine.json`. The models available per CLI are in `data/harness.json`. Spend: `claude-usage.json`, `chat-spend.json`, `memory-spend.json`, `data/api-cost.json`.
- **State analytics**: the `S`, `B` and `f` flow screens show, for each state, its visits, time, agent time, dispatches, cost and tokens (`src/tui/metrics.js`, from the variations' state changes).

## Watch the machine

The harness is heavy on CPU, memory and disk (VMs, agents, Hindsight). Check before starting heavy work, and say so when something is low:

- Disk: `./agent.sh harness:check-disk-space`, `vm:inventory <project>`, `vm:reclaim-all --dry-run`. Below `disk-free-warn-gb` control deletes stopped VMs. Below `disk-free-hold-gb` it starts no new work.
- Memory and CPU: `memory_pressure`, `top -l 1 -o cpu | head -20`. Control holds new VMs when memory is short.

## Hard rules

- Never `git stash`: the stash is shared across worktrees.
- Never put secrets, tokens or a project's private details in the repo. It is published.
- Never push `main` raw. Pushing goes through the operator's scrub-and-squash flow.
