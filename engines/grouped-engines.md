# The grouped development engines (ASS-68)

`harness-development-grouped` is the current `harness-development` regrouped
into a few high-level states; a project's own grouped engine, kept with its own
flat engine in `data/projects/<project>/engines/` (ASS-276), regroups that flat
engine the same way. Each high-level state is a `state-engine` step whose sub-engine holds the
detailed steps, mirrored from the current engines (same names, actions,
max-visits and exit conditions). The current engines are unchanged: they are the
rollback.

| High-level state | Sub-engine | Steps |
|---|---|---|
| Backlog, Committed | (plain steps) | |
| Setup | `grouped-setup` | Check Setup Complete, Create VM, Mark Setup Complete |
| Plan | `grouped-plan` | Extract Acceptance Criteria, Root Cause Analysis, Review Root Cause Analysis, Write Execution Plan, Write Test Plan, Enrich Automated Test Data, Review Plan |
| Build | `grouped-build` | Refresh the Reference Repositories, Generate Automated Tests, Generate Solution, Await Dependencies in Other Repositories, Refresh the Reference Repositories Before Testing, Automated Testing, CI Checks, Code Review, Security Review |
| Test | `grouped-test` | Local Testing (`grouped-local-testing`), Steps to Test (`grouped-steps-to-test`) |
| Document | `grouped-document` | Update Documentation, Update Merge Request Details, Check Merge Request Details, Add Screenshots to Merge Request |
| Review | `grouped-review` | Explain the Change, Risk Assessment, AI Token Expense Check, Payment Gate, Variation Selection |
| Release (harness) | `grouped-release-harness` | Merge Pull Request, Update the Harness, Request a Restart, Await the Restart |
| Release (a project's own) | its own release engine | e.g. Take out of Draft Mode, Team Code Review, Address Merge Request Feedback, Ensure Auto-Merge |
| QA (a project's own) | `grouped-qa` | QA Testing |
| Done | (plain step) | |

Check Merge Request Details (ASS-219; grouped/v2 only, `merge-request:check-details`,
on the host, every minute) checks each Open merge request's title against the
project's format — project.json's `"merge-request-title"`: `"key-summary"`
(`KEY: summary`, the default) or `"conventional"` (`type(scope): subject (KEY)`,
what a CI mr-title job may require) — and that its description
names every commit subject on its branch — on GitHub a subject over ~70
characters is cut short in the commit's `.messageHeadline` and ended with
"…", its remainder leading `.messageBody`: the full subject is rebuilt from
both before the match, so a description naming the full subject verbatim
passes (ASS-302) — and waits for its head pipeline's `.pre` jobs (none, or
GitHub: no wait). A failure goes back to Update Merge Request Details with
`merge-request-details-check-<variation>.md`, a failed job's log in it. The
same format fills the prompt's `{merge-request-title}`, and `merge-request:create`
opens each merge request in it (ASS-335): `KEY: title`, or with `"conventional"`
`type: title (KEY)` — a Bug a `fix`, a Task or Spike a `chore`, else a `feat`;
`(MR <id>)` before the key when the variation has several — so a CI mr-title
job passes from the first pipeline and the merge request can merge.

Await Dependencies in Other Repositories (ASS-335; grouped Build only — v2-build
and the flat engines have none — `merge-request:await-dependencies`, on the
host, a timer every 5 minutes) sits between Generate Solution and the refresh
before Automated Testing. A merge request depending on one in its own
repository is stacked on that one's branch, so its tests see the change; one
depending on a merge request in another repository is not, and its tests run
against what that repository has published, which lacks the change until the
dependency merges. While any such dependency is neither Merged nor Closed
(read from the forge), the step exits 2, its waiting-exit-code: the ticket
stays there, polled, no failure counted, never sent back to Generate Solution.
None waiting (most tickets: no forge asked) exits 0, on to the refresh and the
tests. The dependency usually merges outside the ticket's own Release (a
human, or that repository's team review), since the ticket's Release comes
after its tests. It waits for the merge only, not for a later publishing
pipeline (a promotion after the merge).

It says why a dependency is not merging (ASS-359). Each `waiting` entry it
prints has `needs`, read from the dependency's forge, in this order:
`not-created` (planned, never opened), `draft`, `build-failed` (its head
pipeline failed or was canceled; on GitHub a failed check), `open-threads`
(unresolved blocking threads; on GitHub changes requested), `needs-rebase`
(conflicts, or behind its target), `needs-approval` (GitLab's
`approvals_left` above 0; GitHub's review decision `REVIEW_REQUIRED`) — or
`[]` when it only waits to be merged (set to auto-merge, say), which keeps
polling silently as before. While any dependency needs something, the step
writes the operator's feedback on the variation (`ai-feedback-short` and
`-long`, the TUI's Health on the sprint grid and the ticket screen), naming
each by repository, key and url in plain words, for example "acme/api !12
https://…/merge_requests/12: is a draft; its pipeline failed (lint); it needs
1 approval. MR 2 depends on it." The needs it last wrote are kept on the
variation (`awaited-dependency-needs`), so the feedback is written, and said
once in control's log, only when they change, not on every poll; once nothing
needs action it is cleared (only when it is still this step's own). A move
within Build's run does not clear the feedback; leaving Build does.

Every dependency it waits on is a planned merge request of the same variation,
so one `not-created` is one Generate Solution never opened (its agent killed
before it got there, say), which nothing else will ever create. That one is
not waited on: the step exits 3, and grouped-build's exit for it sends the run
back to Generate Solution — a visit there, under its max-visits (5), after
which the run ends at Blocked as any other loop does. The feedback names the
merge request never created, and a control line in
`execution-plan-<variation>.md` tells Generate Solution which to build and
record. Any other failure of the command exits 1, never 2 or 3, so it matches
no exit and is tried again where it is.

Write Execution Plan (grouped/v2 Plan, `write-execution-plan-grouped`) never
pins a consumer to a digest or tag a producer repository publishes only after
its merge request merges, when that digest can't be read in the VM (ASS-339):
it plans the producer's merge request alone and leaves the consumer's pin to
Renovate or a follow-up ticket. A hand-pinned placeholder digest
(`sha256:0000…0000`) reads merge-ready but is un-pullable, so Ensure Auto-Merge
never arms it and the release bounces until the ticket blocks. The flat
`write-execution-plan` prompt is unchanged.

The Refresh steps (ASS-218; grouped/v2 Build only, `vm:refresh-repositories`,
on the host) open Build and come before every Automated Testing. Each of
the VM's repositories that none of the variation's merge requests is in is
fetched and checked out on origin's default branch — a dirty one, one with
commits origin's lacks, or one that cannot be fetched left as it is, a line
saying so — so code compared with another repository's master (a parity
check, say) is compared with CI's. The ticket's own repositories are untouched.
A merge request with no repository — an id-less one `ticket:sync` found on the
forge, matching no planned branch — is in none, and is passed over, here and
by CI Checks below (ASS-321).
Only a VM not running fails it: Blocked. Test's Rebuild enters Build at
Generate Solution, past the first refresh; the second still runs.

Generate Automated Tests (grouped/v2 Build, `generate-automated-tests-grouped`)
records an entry only once its `run` command, not just its `list`, runs in
the VM (ASS-337). A CI-only test — one whose `run` cannot execute in the VM:
a missing toolchain, an outside credential, an image not on the mirror — is
written on the branch for CI but left out of `automated-tests-<variation>.json`,
so Automated Testing does not block on it. The flat `generate-automated-tests`
prompt is unchanged.

CI Checks (ASS-249; grouped Build only — v2-build and the flat engines have
none — `ci-checks:verify`, in the VM, max-visits 3) runs, between Automated
Testing and Code Review, the merge-request CI checks the project declares for
each repository with a merge request not Closed: the gates its CI would fail
(a leaked secret, an unpinned image, a policy violation), caught before the
merge request reaches the forge. They are declared in `ci-checks.json` in the
project's golden-image folder, beside `tests.json`:

```json
{ "repositories": {
    "example-project": [
      { "name": "secret-scan-mr", "command": "scripts/ci/secret-scan.sh", "baseline": false },
      { "name": "kubernetes-policy", "command": "clusters/lint.sh", "changes": ["clusters/**", "*.yaml"] } ] } }
```

`name` is the CI job the check mirrors; `command` runs with bash in
`/repos/<basename>`, `CI_CHECK_BASE` exported (the merge base of the checkout
and `origin/<base>`); `changes` (optional) runs it only when the merge
request's diff touches one of the globs (`**` any folders, `*` and `?` within
one, `{a,b}` either, as CI's `rules:changes`); `baseline: false` (optional)
marks a check over the merge request's own commits, which has no master run to
compare with. A check that fails is run on `origin/<base>` too, as Automated
Testing's tests are (ASS-99), and failing as it does on master passes. Exit 0
(every run check passed, or failed only as on master) goes to Code Review, 3
(a check could not run, no VM, or the file malformed) to Blocked, any other (a
new failure) back to Generate Solution. `ci-checks-results-<variation>.md` in
the ticket's folder holds each check's job, command, exit code and output, for
Generate Solution and Security Review. A project without the file, or a ticket
whose repositories declare none, passes with nothing run.

`ci-checks.json` is not an input of the golden image: changing it rebuilds
nothing.

Blocked, Blocked for Human and Self Healing stay top-level. Blocked runs
`grouped-blocked` (ASS-107, ASS-97), its own engine; the current engines'
`blocked` stays as it was, their reference. It counts the fix attempts made
in this stay (3 failed: Blocked for Human; the count starts again each time
the ticket enters Blocked anew), troubleshoots — in the variation's VM, on
the host while it has none set up yet, as when Setup is what failed —
learning from the ticket's earlier blocks (every Blocked run is kept in its
`blocks`, append-output-to, and given to the prompts as {problem}), then
classifies: a harness issue's fix ticket to the harness project's backlog, a
project issue's to the ticket's own project's ticket system, both waited on
alike; a fix that lands ends the stay, the step it returns to its proof — it
has landed once its ticket is Done with a merge step anywhere in a live
variation's state changes, top level or nested in a `sub-state-change` at any
depth, as a grouped fix ticket's own merge is, in its Release sub-engine's run
(ASS-309), or, Done with no merge step (a ticket built by hand and committed
straight to the default branch), once a commit whose subject starts with its
key and a colon (`<KEY>:`, the key exactly) is reachable from the default
branch of its project's local-pc workspace, locally or on origin as last
fetched; a workspace that cannot be read finds none (ASS-340), or, Done with
neither (a fix that re-recorded the blocked ticket's own data, a gitignored
file no commit can carry), once one of the waiting variation's own inputs in
its work folder — an allowlist, automated-tests-<variation>.json and
demo-plan-<variation>.json, written only through automated-tests:record and
ticket:set-demo-plan — holds other content than when the wait began:
ticket:wait-on records the moment and each input's SHA-256 (null while
missing) in the variation's `wait-began`. Nothing the harness writes on its
own while the ticket is blocked or waiting counts — ticket.json, locks, step
outputs, Blocked's change-log, the obstacle fix appended to the plan — nor
another variation's file, an edit made before the wait began or a removed
file; a wait recorded with no `wait-began` finds no such edit (ASS-342); an
environment issue repaired in place, else Blocked for Human. It never
resumes as if fixed when no fix can be raised or waited on: an empty fix key
carries a no-ticket-reason (analysis-did-not-hold or create-failed) and a
one-line why, kept in `blocks`; create-failed or no reason retries the write
once; still none skips fast-track-fix and Blocked for Human's ai-feedback
names the reason and why (ASS-316). A repository the
project lacks, which the ticket's work needs, is an environment issue
(ASS-121): Troubleshoot names its forge url (missing-repository), and Repair
Environment's first step, Add the Missing Repository
(project:add-repository, on the host), adds it to project.json once glab or
gh shows the harness can access it, downloads it into the VM (vm:create
clones what the golden image predates), and the ticket retries; one it cannot
access is not added: Blocked for Human, naming it and why. One another
project lists is refused by the command itself, nothing changed (ASS-160):
Blocked for Human, saying the ticket needs that project's access — it
belongs in that project or must be done on the Mac. Nothing else ever
adds a repository, and none is ever removed.

Where a landed fix resumes the ticket (ASS-343): declared, else derived, else
the step it blocked at. Once await-fix says landed, Find Where to Resume
(`resume-step`, `ticket:fix-resume-step`, on the host) records the run's
`resume-at`, `resume-source` (declared, commits, data or none), `resume-why`
and `resume-ignored`, and the run is done whatever its exit. Declared is the
fix ticket's own `resume-at:` front matter (`off-board.sh ticket:create
--resume-at <step>`, which create-ticket-grouped's writer passes when the fix
changes an earlier step than the blocked one). Derived maps what the fix
changed to the steps that use it: the files of its `<KEY>:` commits on its
project's default branch (`prompts/<name>/` to the steps running that prompt,
`src/agent-cli/<family>/<command>.sh|.js` to the steps whose command runs it,
`engines/<name>/` to the group running that engine), and the files of the
ticket's work folder written since the wait began (`wait-began.at`, else
its entry into await-fix), mapped by a step's `file-updated` exits
(`execution-plan-<V>.md` to Write Execution Plan) and by
`automated-tests-<V>.json` to Generate Automated Tests. The commits read
are the waited-on fix's and, for a ticket blocked more than once, each
earlier landed fix's in the variation's `blocks` (ASS-347: `landed: true`;
one with `landed: false` adds nothing). A step an earlier fix maps to counts
only while the ticket has not entered that step again since that block
ended (its `timestamp`). If it has, the step's output already carries the
fix, and the step goes to `resume-ignored` saying so. With earlier fixes in
play, each `resume-ignored` entry from commits or a declaration carries its
`fix` key. Each is
lifted to its top-level group; the earliest at or before the blocked step
wins, and `resume-why` names the fix and file that won. Control (engine.js `resolveTarget`) takes `resume-at` on the
fix-landed return only when `whyNotResume` allows it: a step of the engine's
`steps`, at or before the step the return-to-state walk names, doing real
work — no done step, Blocked, detour or other sequence-0 state, nor a `none`
or `human` step such as Backlog or Committed. Else it returns to the blocked
step, as before. The log says which: `the fix landed; resumes at <step>:
<why>`. A resume upstream needs nothing reset: the clearing move's
`fix-landed` cause restarts the visit counts, a script step's "already ran"
memory is per state change, and each group's run starts afresh at its
first step, so a resume at Plan writes the execution plan again (Write
Execution Plan leaves only once the file was written in its turn), and Build
generates the solution again. A resume at a planning step waits for a
planning slot as any move into one does. The current engines' `blocked`
has no resume step: it resumes where it blocked, as before.

A project issue raises a bug only for a failure on the latest master
(ASS-163, the operator's decision box). Troubleshoot names the failing check
(repository, CI job, assertion); Check on the Latest Master
(project:check-on-master, on the host, read-only glab/gh) reads that job on
the newest finished master pipeline that ran it. Failed there: the bug is
raised in the project's ticket system with that evidence and waited on, as
before. Passed: nothing raised; Plan the Obstacle Fix
(ticket:plan-obstacle-fix) appends the fix of what stands in the way to the
variation's execution-plan-<variation>.md, no scope added, and Repair Environment's steps
make it (else the operator's step, Blocked for Human); the ticket resumes.
No master evidence (no such job, forge unreachable, nothing named) is not
proven: no bug, Blocked for Human asking the operator. On the harness
project nothing is checked: its project issues are its own backlog.

Requirements Changed (ASS-79) is a top-level detour like Blocked, in these
engines and `harness-development-v2`: `requirements-changed` runs
`grouped-requirements-changed`. The operator's Take new (`ticket:take-new`,
ASS-78) sends each live variation at a step flagged
`recheck-on-requirements-change` (Plan and every group after it) there
(`ticket:requirements-changed`). Revise Acceptance Criteria (in the VM)
writes `{ticket-folder}/requirements-change-<variation>.md` (`work:write`) — what changed, from → to,
from the last description line of `requirements-history.jsonl` — and
revises the variation's criteria, keeping their numbers where they still
apply. Judge (in the VM) gives a verdict per criterion on the built work
(every merge request not Closed whose branch is pushed), else on the plan.
Verdict (`ticket:requirements-change-verdict`, on the host) decides from
them: every criterion passing, the variation goes back to the start of the
group it was in (`follow-return-to-state`); any failing or unjudged, the
failing ones are written to `{ticket-folder}/requirements-change-reason.md`
and it goes into Plan at Root Cause Analysis, which starts from that file.
Every revising `-grouped` prompt reads `requirements-change-<variation>.md` when it
exists. Blocked during the detour hands the variation back to its group,
not to the detour. It sets no ticket-system pairing: the ticket keeps the
status it had.

The ticket health check `harness-development-grouped` samples with is
`check-ticket-health-grouped` (ASS-124; the current engines keep
`check-ticket-health`). A harness or project issue it finds raises its fix
ticket; an environment issue raises none: ticket:repair-environment hands
the sampled ticket to its own Blocked at Blocked's repair step, what the
check found its run's {problem} — resumed once repaired, else Blocked for
Human. A ticket whose engine's Blocked makes no repair goes straight to
Blocked for Human, saying what was found and what to do.

## How it reads

- **Pairing.** Only the top-level steps carry `paired-ticket-system-status`
  (ASS-67). Every group pairs `In Progress`, except a project's own Release
  (`In Review`) and QA (`In Testing`). A ticket-system status that differs
  from the pairing is a gap for gap resolution, unless the group's own run
  answers it (ASS-224): its step has an exit on that status (Team Code
  Review's In Testing or In Progress), or the run is done. Then the group
  step moves by its own exits, with no agent.
- **run-location.** Missing means host. The steps that review code or need to
  know the code or product run in the VM (`run-location: vm`): all of Plan and
  Build but its Refresh steps, the steps inside Local Testing's and Steps to Test's sub-engines, all of
  Document, Explain the Change, Risk Assessment, the AI Token Expense Check, a project Release's Address Merge
  Request Feedback, and Blocked's troubleshooting and repair. A `state-engine` step always
  runs on the host.
- **run-in-repository** (ASS-119, prompt steps only). Missing means the folder
  holding every repository (`/repos/` in the VM). `"<repo>"` — a repository the
  project declares, named by its url's last segment (`validate.js` refuses any
  other) — starts the agent in `/repos/<repo>/`, told that repository alone (on
  the host: its checkout, named in `{where}`). `"each"` runs the step once per
  repository the ticket's planned merge requests touch
  (`ticket:merge-request-plan`), one after another in one agent slot: a run
  that takes the step's first exit (its pass) hands on to the next repository;
  the last run's exit, or any other run's other exit, moves the ticket. A ticket
  touching none passes the step over by its first exit. No step sets it yet.
- **Leaving a group.** A sub-engine ends at one of its done steps: `done`, or
  `blocked`, `rebuild` or `replan`. The group step's exits read which one with
  `sub-engine-ended-at`:
  - `blocked`: a step failed or looped past its max-visits. The ticket goes to
    Blocked, which returns it to the start of the group (each group's
    `return-to-state` is itself).
  - `rebuild`: Local Testing rejected, or a project Release's Team Code Review sent the
    ticket back In Progress. The ticket goes into Build at Generate Solution
    (`start-sub-engine-at`, ASS-66).
  - `replan`: the Payment Gate rejected it. The ticket goes into
    Plan at Write Execution Plan.

  Loops that stay inside a group, such as a code review sending the work back to
  Generate Solution, are the sub-engine's own. A step's visits count within its run and start again at
  zero each time the group is entered. The group step's `max-visits` caps how
  often the group is entered (Build 5, the rest 3). A block a landed fix clears
  restarts that counting: the move out of Blocked records the cause `fix-landed`,
  and every group's visits count from it (ASS-309), so a ticket that was blocked
  with its groups at their caps resumes where it returns instead of being
  redirected straight back to Blocked. The other clears — a retry, an
  environment repaired, nothing found wrong — keep the counts. A merge-gate
  red (ASS-315, the merge queue below) restarts it too, but only for the
  groups downstream of Release it sends the ticket back through (Build, Test,
  Document, Review): Release's own keeps counting across reds, so a gate that
  never goes green still blocks at Release's `max-visits`.
- **Setup.** Check Setup Complete asks `vm:setup-complete` whether the
  variation's VM holds the setup-complete marker (`/repos/.setup-complete`).
  If it does, Setup ends at once. If not, Create VM (`vm:create`, which is
  idempotent) runs, then Mark Setup Complete (`vm:mark-setup-complete`) writes
  the marker. A setup that stopped part way has no marker, so it runs again
  from the start.
- **Prompts.** Seven steps revise their existing output and say what changed
  and why (AC5): Root Cause Analysis, Write Execution Plan, Write Test Plan,
  Enrich Automated Test Data, Generate Automated Tests, Generate Solution and
  Update Documentation. Write Execution Plan also does its research before it
  writes the plan, and the plan holds no spikes (AC4). These steps use copies of
  their prompts, `prompts/<name>-grouped/`, so the current engines' prompts are
  unchanged.
- **Writes (ASS-182).** Agents change the harness's data only through
  agent.sh, which validates and locks every write. In the VM, `/mnt/ticket`
  (the ticket's folder) is mounted read-only, with no scratch mount: every
  write goes through the VM's agent.sh, the content on stdin — reports with
  `work:write` / `work:append` (`<name>-<variation>.<ext>`), the merge request
  plan with `ticket:set-merge-request-plan … -`, the criteria with
  `ticket:set-acceptance-criteria … -` (Extract Acceptance Criteria runs
  `enrich-ac-grouped`), a ticket comment with `ticket:post-comment … -`
  (Write Steps to Test runs `write-steps-to-test-grouped`), screenshots with
  `work:add-screenshot`. A confined host agent writes only temp, so to save a
  report it stages the body in a temp file and passes that path as the trailing
  `<file>` argument of `work:write` / `ticket:set-requirements` /
  `ticket:set-acceptance-criteria` (stdin would re-sandbox the call; ASS-298);
  the forwarder caps `work:write` at four arguments, so a VM can give only
  stdin, never a path. validate.js
  (`promptWriteErrors`) fails any prompt or persona telling an agent to write
  a file under `{ticket-folder}`, `{project-folder}` or `data/` without an
  `{agent-sh}` command.

## VMs by state, and the disk limit (ASS-75)

- **Running and stopping.** A step's `vm` says whether the variation's VM runs
  there (`running`) or is kept, stopped (`stopped`); the deepest level of the
  variation's status that sets it decides. Running: Setup through Review, Self
  Healing, and beneath, Blocked's Find Where, Troubleshoot, Classify and Repair and a project
  Release's Address Merge Request Feedback (they run in it). Stopped and kept:
  Blocked (once it waits on its fix) and Blocked for Human. Anywhere else
  (Backlog, Committed, Release, QA, Done) it is not needed: stopped. A paused
  variation or ticket (`is-paused`) and a set-aside one (lost Variation
  Selection) have theirs stopped too. A VM to be stopped, for any of these
  reasons (or waiting for a slot, or for a ticket it depends on (ASS-355),
  or gone from the sprint), while an
  assignment is on its variation is left running until that ends — logged
  once, `waits until its agent finishes` — so its agent is never killed
  mid-step (ASS-349). Control matches the VMs to this once per
  loop (`src/control/vm-lifecycle.js`), so a move by hand in the TUI is
  followed; `move_to` and the TUI do nothing of their own.
- **Released (ASS-325).** A step may instead say `released`: the variation's
  VM is deleted as soon as it gets there, so its disk goes back to the
  project's VM disk budget at once rather than when a new VM is short of
  room. Control stops it if it runs (`vm:stop`), then deletes it
  (`vm:delete <p> <vm>`: `limactl delete` and its `vms.json` row, as room is
  made, under the project's VM lock), logging `deleted (<KEY> <variation> at
  <step>: released)`; a failed delete is logged and retried with the usual
  backoff. A VM with an assignment on its variation is left as it is until
  that ends; a paused or held variation's, or a paused project's, is only
  stopped, as anywhere else. Back at a step that says `running` (QA failed:
  Blocked, then Build), the VM is recreated (`vm:create`), as any deleted VM
  is. None of the repo's engines sets it; a project turns it on in its own
  engine, on a step that needs no VM (QA).
- **Refreshing credentials (ASS-215, ASS-350, ASS-356).** `vm:start` (through
  `vm:credentials`) records on the VM's `vms.json` row the credential kind it
  injected (`credential-kind`) and each injected keychain item's modification
  time (`credential-stamps`, `{ "<kind>": "<mdat>" }`, read from the item's
  attributes, never its value; atlassian is never injected, so never
  stamped). A Running VM control has reached is refreshed (`vm:start` on the
  running VM, which re-runs `vm:credentials`) when its project now declares
  another kind, or when a declared item has been saved again since (a rotated
  key: the keychain's stamp later than the recorded one), logged
  `credentials refreshed (…; <kind> key changed)`. Control reads the stamps
  (`vm:credential-stamps <p>`) only when a VM is due the comparison, and at
  most once per `harness.json` `credential-stamp-interval-seconds` (default
  300) per project, caching them in control memory with the time read; a
  failed read is logged once, until a read succeeds, and tried again only
  after the interval. Stamps cached before a VM's start or refresh are older
  than those it recorded, so they never refresh it again. With an assignment
  on its variation the refresh waits until it is idle, logged once. A VM recording no stamps (not started since ASS-350), or
  an item only one side stamps, is not compared until its next start records
  them.
- **Waiting for a VM (ASS-133, ASS-159, ASS-348).** A step that runs in the
  VM is not judged while control has not yet seen the VM up (Running and
  reached by a probe), for at most 2 minutes; then it is judged as it stands.
  An agent is never dispatched into it until it is up, however long that
  takes: one sent in before `vm:start` has written its credentials fails "Not
  logged in" and spends a try. Its wait is logged once. A VM still not up
  after `vm-up-ceiling-seconds` in harness.json (default 1800: 30 minutes)
  sends its variation to Blocked, or to Blocked for Human from Blocked. The
  variation's ai-feedback names the VM and says it never came up.
- **The inventory.** `data/projects/<p>/vms.json` (untracked) holds each VM of the
  project: ticket, variation, state, disk bytes, last accessed (started or
  stopped). `vm:inventory <p>` reconciles it with `limactl list` and the sprint
  and prints it against the limit, with a leftover `golden-<p>-build` (a failed
  golden build's VM, which vm:build-golden stops as it fails) apart from the
  ticket VMs: deletable once stopped and no build is in progress, and deleted
  before any ticket VM when room is made (ASS-289).
- **The limit.** `vm-disk-limit-gb` in harness.json is every project's default
  and ceiling; a project's own in project.json may only be lower (a higher one
  is held to the ceiling, with a warning). Only each VM's own disk counts, at
  its APFS private size; a new VM is charged the golden image's allocated size.
- **Deleting.** Before cloning, Create VM deletes the least recently accessed
  stopped VMs whose variation is not in flight — gone from the sprint, set
  aside, or at a step that sets no `vm` or `released` — until the new one fits. If it cannot
  fit without deleting one that runs or is in flight, it deletes nothing and
  exits 3: Setup sends the ticket to Blocked for Human, the reason (project,
  limit, use, need) as the variation's ai-feedback. A deleted VM that is
  needed again is recreated from the golden image (`vm:create`, by Setup or by
  control), and the variation's `vm.recreated-at` says so: work that lived
  only on the old disk is lost.

## Waiting on another ticket (ASS-195, ASS-355)

In a project whose project.json says `"wait-for-dependencies": true`, a sprint
variation whose ticket depends on a ticket that is not done is held at the
step it is on, at the top level or anywhere in a run beneath it. Control
(`src/control/dependencies.js`, `dependencyHold`) dispatches no agent for it,
starts no step script, sub-engine run or move, gives it no planning or
in-progress slot and no agent seat (the next ticket takes the slot), and stops
its VM as for a variation waiting for a slot. An agent already running when
the hold begins finishes its turn; its VM is stopped only once that agent has
finished (ASS-349). When every dependency is done the variation goes on at the
same step: it never moved, so no step re-runs and no visit is spent.

- **Never held:** a done step (at any level of the status, so a run at its
  own done step lets its group step move on) and the steps where only a
  person acts: a human step at any level (Blocked for Human, Human Review,
  the Payment Gate, Variation Selection, any human-action step), a gate
  waiting on a human once its work is done, and a `none` step whose every
  exit reads the ticket-system status alone (QA Testing, top level or in
  `grouped-qa`). Everything else is held: Backlog, Committed, Setup through
  Release, Blocked, Self Healing.
- **Where a dependency is found:** the project's sprint, its backlog,
  another loaded project's sprint or backlog, then the project's
  `outside-tickets.json`. The Jira downloader writes that file each cycle
  (`ticket:sync-outside`) with `{ key, title, url, ticket-system-status,
  ticket-system-assignment }` for every key a sprint or backlog ticket depends
  on that neither holds, read by key (assigned to a teammate, say). A key
  found nowhere holds nothing.
- **When it is done:** its ticket-system status is the status paired with
  the `is-done` step of the execution engine of the project it belongs to,
  read from the engine and never assumed to be "Done". For an outside ticket
  that is the dependent's project. A sprint dependency with any variation at
  an is-done step is done too.
- **Shown:** the sprint row starts `WAITING ON <KEY>, <KEY>` in gold, in
  place of `PAUSED`. The Status cell says `waits on …`, the ticket screen
  lists each dependency with its status and assignee, and the progress update
  puts the variation under On Hold's "Waiting on another ticket" group.

## Merge requests

Create Branch, Create Worktree and Create Merge Request are gone from these
engines. Write Execution Plan plans the merge requests (ASS-80): it reads the
variation's (`ticket:merge-request-plan`) and records the whole plan
(`ticket:set-merge-request-plan`), each merge request `{ id, repository,
branch, contents, depends-on, status, key, url, build-status }`. The plan gives
the id (stable, never reused), the repository (one of the project's), the
contents and depends-on; the harness names the branch, `change/<KEY>-<id>`
(`change/<KEY>.<variation>-<id>` for a variation other than A). A replan
matched by id keeps a created one's key, url, build status and status, and
never drops one. A new one is `Not Created`; its status goes on to `Open`,
then `Merged` or `Closed`.

Generate Solution creates them (ASS-81), one at a time in depends-on order.
For each, it has control read them all (`merge-request:check`), builds the
branch in the VM on its `base`, pushes it, and calls `merge-request:create
{project} {ticket} {variation} <id>` through the forwarder. A rebase onto a
moved `base` that conflicts is resolved with the other ticket's intent in hand
(`merge-request:conflicting-tickets`). On the Mac that
opens the draft through the forge's API, with no checkout (`glab api
--hostname`, `gh --repo`), reuses one already open from the branch, and
records key, url and `Open` by id. Control decides the rest, deterministically
(`refresh_merge_requests`, `src/agent-cli/merge-requests.bash`), every time a
merge-request command runs:

- each created one's status is what the forge says: `Open`, `Merged` or
  `Closed`;
- a planned one's `base` is the branch of the last of its depends-on still
  unmerged in the same repository, else the repository's default branch. An
  open one whose target differs is retargeted, so a dependent whose
  dependency merged is based on master;
- a branch with no changes against its base is marked `Closed`, not opened;
- rows are never dropped, and each change is a line in execution-plan-<variation>.md
  (`- <time> control, variation <V>: …`) saying why.

The steps after it cover every merge request, through `-grouped` copies of
their prompts: Code Review, Security Review, Risk Assessment and the AI Token
Expense Check review every one not Closed (`git diff
origin/<base>...origin/<branch>`) in one pass, with one verdict and findings
named per merge request. Take Screenshots saves one merge request's
screenshots in `{ticket-folder}/screenshots/<id>/` and the ticket's in
`screenshots/`, each through `work:add-screenshot`, the PNG on stdin. A ticket with no
visible UI is shot from the raw output Test saved (`test-output-<n>-<V>.txt`),
rendered as it is by `work:output-page`, never re-run or composed (ASS-230). Add Screenshots gives each Open one its own, else the
ticket's, and the 'no visible UI' note only when there are none at all.
Update Merge Request Details and Address Merge Request Feedback work on each
Open one.

Release takes the whole variation. Harness's Merge Pull Request
(`merge-request:merge`) merges the Open ones in depends-on order, retargeting
each dependent to master once its dependency has merged; the first that
cannot merge stops it non-zero (Blocked), those merged stay Merged, and a
re-run resumes. A project Release's Take out of Draft Mode readies every Open one,
Team Code Review's `merge-request:check` reports over them all (merged only
when every one is), and Ensure Auto-Merge sets auto-merge in depends-on order,
a dependent only once its dependencies have merged, with the same stop and
resume. The check's `auto-merge` says Ensure Auto-Merge has nothing to set
now (ASS-351): every one not Closed is Merged, set to auto-merge, or Open and
waiting on a depends-on neither Merged nor Closed. So a group whose later
merge requests wait on earlier ones, every one it can set already set, just
waits at Team Code Review for approvals: a timer poll that matches no exit
leaves the step where it is, with no move and so no visit spent (control's
`nextState` is null, `src/control/engine.js`; `runTransient`'s settle,
`src/control/steps.js`), where before each poll went to Ensure Auto-Merge and
back and spent a visit, sending the group to Blocked after ten polls. Once a
dependency merges, a merge request it unblocks that is not set yet makes
`auto-merge` false: Ensure Auto-Merge runs once, sets it, and the wait
resumes. Each wave of dependency merges costs one visit of each, so a chain
deeper than Ensure Auto-Merge's `max-visits` allows still blocks.

The wait for approvals has its own bound (ASS-351): harness.json's
`approval-wait-days`, 3 by default. An Open merge request set to auto-merge
with nothing of its own to act on records when it was first seen so
(`approval-wait-since` on its row; cleared once it is not, so a real problem,
or GitLab cancelling auto-merge, restarts it), counted from no earlier than
the variation's last move at its own level (a Release entered afresh, or
resumed from Blocked for Human, waits afresh). Once the group is only waiting
and any one has waited past the bound, the check adds
`"approval-wait-expired": true`, `"awaiting-approval": [{ id, key, url,
since }]` naming those, and `ai-feedback-short` / `ai-feedback-long` for the
operator. A project Release routes it to Blocked for Human with three
additions, as the example project's `grouped-release-example` and
`example-development-grouped` have them: on Team Code Review,
`"record-script-output": true` and an exit `{ "all": [{ "exit-code": 0 },
{ "script-output": { "approval-wait-expired": true } }] }` → a done step
`blocked-for-human`; and on the parent's Release step, an exit for
`"sub-engine-ended-at": "blocked-for-human"` → `blocked-for-human`, before its
bare `is-done` exit (else the ended run would move the ticket on to QA). The
run's recorded output carries the feedback, which control sets on the
variation after the move (`steps.js`, as for Create VM's out-of-disk
reason). A Release without them is unchanged: the check's new fields match
none of its exits, and the group waits on.
`merge-request:check` holds back a failed pipeline that only reflects a
dependency (ASS-346), so a group across several repositories still reaches
Ensure Auto-Merge: while any of a merge request's depends-on, in its
repository or another, is neither Merged nor Closed (the same test as
`merge-request:await-dependencies`), its failed pipeline is not
`build-failed`, though its `open-threads` and `needs-rebase` still are. Once
all have merged, a failed pipeline that started before the latest of them
merged (the forge's merged-at against the pipeline's created-at; on GitHub,
the latest start of a failed check) is started again — on GitLab a new merge
request pipeline (`POST …/merge_requests/<iid>/pipelines`), or, when the
project refuses one, its failed jobs retried (`POST …/pipelines/<id>/retry`);
on GitHub each failed workflow run re-run (`gh run rerun <run> --failed`) —
and is not `build-failed` while it runs. That happens once per dependency
merge (its time recorded on the row as `pipeline-rerun`): a pipeline that
started after the merge, or one re-run for it already, that fails is
`build-failed`, as is one that cannot be started again. Each one held back is
listed in the check's output as `"build-pending": [{ id, key, why:
"dependency-unmerged" | "re-run" }]`, present only when there is one. Once
every one not Closed is Merged, Team Code Review ends Release (ASS-224) and
QA sets the ticket system to In Testing.

The current engines' commands are the same ones: a merge request recorded
from a worktree (no `repository`) is on the workspace's origin, read with
`glab mr` as before.

Not yet proven against the live forges: every forge call is tested against a
fake glab and gh. Automated Testing and Local Testing run in each repository's
checkout as Generate Solution left it, the last branch it built there: two
merge requests in one repository with no depends-on between them are not
both tested.

## Explain the Change and Human Review (ASS-118)

grouped-review has no Human Review (ASS-314): Risk Assessment goes straight on
to the AI Token Expense Check, however the risk came out, and a variation's
merge requests leave draft or merge in Release with no operator stop. The gate,
its review screen and its rejection below are v2-review's (harness,
software-assassin), which keeps them. Explain the Change and Risk Assessment
are both engines'. Explain the Change (`prompts/explain-the-change`, in the VM)
writes `explanation-<variation>.md` in the ticket's folder — what the
variation changes and why, in plain language, a line per merge request —
and puts a short `## Summary` at the top of each Open merge request's
description (merge-request:view/update on the host, ASS-238, replacing the last one), every one left a draft; it
goes on only once the file is written (`file-updated` fills `{variation}`).
Risk Assessment writes the variation's own `risk-assessment-<variation>.md`.

On the ticket screen at Human Review the details column (C2) opens with the
review (`src/tui/review.js`): the explanation, the risk profile, every
merge request created, linked, with its screenshots (`screenshots/<id>/`,
then the ticket's own `screenshots/`), each linked to its file, the tests
failing on master too (ASS-99's `automated-test-results-<variation>.md`), and
the demo — Demo in the human actions (ASS-76), or that there is none and
why. Rejected asks for the reason, then the step to go back to (ASS-228):
Write Execution Plan (the default), Write Test Plan or Generate Solution
(`ticket:human-review … <reason> <return-to>`). The reason is kept as the
variation's `rejection-reason` and appended, a dated section naming the
step, to `operator-review-<variation>.md` in the ticket's folder — the
operator's alone: work:write and work:append refuse it. Human Review's
Rejected exit moves by the choice's `return-to`
(`move-to-state-from-human-review`, `replan` the fallback) to the done step
of that name; the top-level Review step re-enters Plan or Build there. The
move is recorded with cause `operator-reject` and the reason, and logged.
Every grouped prompt from Root Cause Analysis on (a grouped copy of Review
Root Cause Analysis among them) reads the operator-review file and
addresses each note; the next pass's explanation quotes the reason and
says how that pass answers it.

## Switching a project, and rolling back

Each project switches on its own:

```bash
./agent.sh project:set-execution-engine harness harness-development-grouped     # switch
./agent.sh project:set-execution-engine harness harness-development             # roll back
./agent.sh project:set-execution-engine example-project example-development-grouped   # a project's own
./agent.sh project:set-execution-engine example-project example-development
```

The command sets `execution-state-engine` in `data/projects/<project>/project.json`.
It also points every sprint variation's `harness-status` at the new engine,
together with its `gate-when-leaving-state` entries, because the ticket-system
sync reads the variation's own engine. Editing `project.json` by hand leaves
those pointing at the old engine.

Before switching:

- Stop control, or pause the project, so that no run is under way.
- Every sprint variation must be at Backlog, Committed or Done. Those steps
  are in both engines, and neither hands the ticket back anywhere. The command
  refuses, and writes nothing, while any variation is somewhere else. That
  includes a step the new engine lacks (for example, the middle of Build) and
  Blocked or Blocked for Human, which return the ticket to a step of the old
  engine. Let those tickets finish, or move them first with
  `ticket:change-state`.

A project's own grouped engine shares every group's prompts with harness
except its Release and QA. The prompt fixes from the harness's live v2 runs
(2026-10-24/25: ASS-111–117, ASS-136, ASS-139) are in them, but they were
proven against the harness's own stack only. So before real tickets go
through after switching another project, run one small test ticket
gated on leaving each step, as ASS-125 was for harness ("A test run" below).

## The restructure: harness-development-v2 (ASS-110)

`harness-development-grouped` moved every step in at once and no ticket has
run through it. The restructure starts again from a flow that works and adds
the steps back one at a time. `harness-development-v2` is the harness's
high-level groups only, each a stub sub-engine of its own, so a project's
own grouped engine (which shares the `grouped-*` sub-engines) is untouched; the grouped engines
stay the reference to copy from.

| Group | Sub-engine |
|---|---|
| Setup, Plan, Build, Test, Document, Review, Release | `v2-setup`, `v2-plan`, `v2-build`, `v2-test`, `v2-document`, `v2-review`, `v2-release` |

- **A stub.** Its first step, Pass Through (`pass-through`), is `action: none`
  with an `always` exit to `done`: the run goes straight to done and the group
  step moves on. A run must not start on `done`, or its parent waits forever
  (`transient-state-engine/create.sh`, `steps.js`). Each stub also has the
  `blocked` done step its group step's exit reads.
- **The rest is the grouped engine's.** The exception states (Blocked running
  `grouped-blocked`, Blocked for Human, Self Healing), Backlog, Committed,
  Done and the engine-wide settings are `harness-development-grouped`'s, as
  are each group step's pairing, `vm`, `max-visits` and `return-to-state`.
  Each group step reads two ends: `blocked` (to Blocked) and `done` (to the
  next group). The exits a stub cannot reach — Setup's `blocked-for-human`,
  Test's `rebuild`, Review's `replan` — and Test's `record-output-as` come
  back with the steps that need them.
- **Adding a step.** Copy it from the `grouped-*` sub-engine into its `v2-*`
  stub, in place of Pass Through (the group's first step from then on), with
  what it needs (prompt, exits, the group step's exits), then do a test run.
  Until the group's last step is in, Pass Through stays after the added ones,
  standing in for the rest: an exit to a step not yet added goes to it.
  When the last step is in, Pass Through goes: the `v2-*` engine is then its
  `grouped-*` one exactly. Setup is filled (ASS-111): Check Setup Complete,
  Create VM, Mark Setup Complete; Create VM brought Blocked for Human
  (v2-setup's and the Setup step's exit).
  Plan is filled (ASS-112, two steps per test run): Extract Acceptance
  Criteria, Root Cause Analysis, Review Root Cause Analysis, Write Execution
  Plan, Write Test Plan, Enrich Automated Test Data, Review Plan.
  Build is filled (ASS-113, a pair per test run): Generate Automated Tests,
  Generate Solution, Automated Testing, Code Review, Security Review; ASS-218
  added the two Refresh steps to both.
  Test is filled (ASS-114, a sub-flow per test run): Local Testing, Steps
  to Test. A sub-engine step's sub-engine is copied too, as `v2-<name>`
  (`v2-local-testing`, grouped-local-testing's but for Test's prompt,
  `test-grouped`, and its first step, Await the Golden Build — ASS-157: a
  golden rebuild ticket waits there for its detached image build,
  `vm:golden-ready` polled about every 10 seconds, any other ticket going
  straight through; `v2-steps-to-test`, grouped-steps-to-test exactly), so
  v2-test is grouped-test but for those names; Local Testing brought Test's
  `rebuild` (back into Build at Generate Solution) and `record-output-as`.
  Document is filled (ASS-115, a pair per test run): Update Documentation,
  Update Merge Request Details, Add Screenshots to Merge Request (on GitHub,
  which has no image upload, the screenshots go to an orphan branch
  `screenshots/<ticket>-<variation>`, linked pinned to its commit).
  Review is filled (ASS-116, a pair per test run): Explain the Change, Risk
  Assessment, Human Review (v2-review's alone since ASS-314: grouped-review's
  Risk Assessment goes straight to the expense check, so v2-review is
  grouped-review but for it), the AI Token Expense Check, the Payment Gate
  (only when it says tokens will be spent), Variation Selection (passes on
  its own for a ticket with one variation); Rejected at the Payment Gate
  ends it at `replan`, back into Plan at Write Execution Plan, whose prompt
  answers the rejection-reason; Rejected at Human Review at the step the
  operator names (ASS-228, above).
  Release is filled (ASS-117, a pair per test run): Merge Pull Request,
  Update the Harness, Request a Restart, Await the Restart. A script step
  held at a gate on leaving it is not run again by a restarted control, so
  gating Request a Restart restarts control once, not over and over.
- **The merge queue (ASS-197), v2's own.** v2-release's Merge Pull Request
  is no longer grouped-release-harness's: it runs
  `merge-request:merge-in-turn … npm test` on a one-minute timer. One ticket
  of a project merges at a time — its gate holds a flock on
  `data/projects/<p>/merge.lock`, which the kernel drops when the gate ends
  however it ends, so a crashed holder never jams the queue;
  `merge-lock.json` beside it names the holder. A ticket behind it waits at
  the step (exit 0, `waiting`), its ai-feedback saying "waiting to merge
  behind <key>". Holding the lock, the gate runs in the background (the
  tests take minutes; control's tick is not held): the branch rebased onto
  the latest main in a scratch worktree, the full tests run there; green —
  the rebased branch pushed and merged, so what merges is what was tested;
  red (a conflict, a failing test) — nothing pushed or merged, why in
  execution-plan-<variation>.md, exit 2 to the new `rebuild` end, which Release sends
  into Build at Generate Solution, the exit itself marked `cause: merge-gate-red`
  so that move restarts Build/Test/Document/Review's visit counting (ASS-315,
  above) rather than spending it on a gate red unrelated to the change. The
  grouped engines keep the plain merge.

### Switching

```bash
./agent.sh project:set-execution-engine harness harness-development-v2   # switch
./agent.sh project:set-execution-engine harness harness-development      # back
```

As in "Switching a project, and rolling back" above: control stopped or the
project paused, and every sprint variation at Backlog, Committed or Done, or
the command refuses.

### A test run

What follows each step added, before the next one is added:

1. A real, trivial harness ticket — one whose change is small and safe to
   merge — joins the sprint at Committed on `harness-development-v2`
   (`ticket:join-sprint harness <KEY> committed`).
2. A human gate on leaving the newly added step:
   `./agent.sh ticket:set-gate-when-leaving-state harness <KEY> A v2-<group>/<step>`.
3. Control runs it. At the gate the ticket waits with the step's work done;
   the operator checks that work — its output, the files, the ticket's
   folder — and approves the move on in the TUI's ticket screen. Wrong work
   means the step is fixed and the test run done again.
4. The ticket goes on to Done, every group visited in order, as its
   variation's `state-changes` (its history) show.

A test run passes when the operator has checked the new step's work and the
ticket reached Done. Only then is the next step added.
