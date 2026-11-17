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
| Build | `grouped-build` | Refresh the Reference Repositories, Generate Automated Tests, Generate Solution, Address Merge Request Feedback (only from Await Sequential Merge), Merge the Awaited (`grouped-merge`; only from Await Sequential Merge, only with `merges-awaited`), Await Sequential Merge, Refresh the Reference Repositories Before Testing, Automated Testing, CI Checks, Code Review, Security Review |
| Test | `grouped-test` | Local Testing (`grouped-local-testing`), Steps to Test (`grouped-steps-to-test`) |
| Document | `grouped-document` | Update Documentation, Update Merge Request Details, Check Merge Request Details, Add Screenshots to Merge Request |
| Review | `grouped-review` | Explain the Change, Risk Assessment, AI Token Expense Check, Payment Gate, Variation Selection |
| Release (harness) | `grouped-release-harness` | Merge Pull Request, Update the Harness, Request a Restart, Await the Restart |
| Release (a project's own) | its own release engine | e.g. Take out of Draft Mode, Team Code Review, Address Merge Request Feedback, Ensure Auto-Merge |
| QA (a project's own) | `grouped-qa` | QA Testing |
| Done | (plain step) | |

`grouped-qa`'s QA Testing step, and a project's own top-level QA step, set
`"is-qa": true` (ASS-401; any step may, true or false). The sprint grid draws
a solid purple line, "in progress ↓ · ↑ in QA", under the last row whose
variation's status chain is, at any level, at such a step, when other rows
follow; the green Done line over QA rows reads "in QA ↓ · ↑ done". Nothing
finds QA by a step's id or name.

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

Await Sequential Merge (ASS-335; named Await Dependencies in Other
Repositories until ASS-363, its id still `await-dependencies`; grouped Build
only — v2-build
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

It sets `"shows-merge-train": true` (ASS-363). Any step of any engine may
declare that flag, true or false (the engine validator rejects any other
type). While a variation's status chain, at any level, is at a step with it,
the sprint grid gives the ticket an extra Ticket-cell line, after any
`↳ WAITING ON …` line (ASS-360) and indented as it is:
`↳ AWAITING MERGE <repo> <key> → <repo> <key> → …`. Each train starts with an
awaited merge request: one that a merge request of the variation depends on,
in another repository, that is neither Merged nor Closed (the same test as
`merge-request:await-dependencies`). It goes on in depends-on order through
every merge request of the variation that depends on it, directly or not.
`<repo>` is the repository url's last path segment and `<key>` the merge
request key, each linked to its url; a planned one with no key shows as
`MR <id>`. Several trains are joined by "; ", and an awaited one already in
another train gets none of its own. For example, `api !12 → web !7` (for
acme/api and acme/web): web !7 waits on api !12 merging. The line comes from
the variation's recorded `merge-request` list, with no forge call. The TUI
reads the flag, never the step's id or name, so another engine's merge wait
can opt in. The key under the grid explains AWAITING MERGE.

It says why a dependency is not merging (ASS-359). Each `waiting` entry it
prints has `needs`, read from the dependency's forge, in this order:
`not-created` (planned, never opened), `draft`, `build-failed` (its head
pipeline failed or was canceled; on GitHub a failed check), `open-threads`
(unresolved blocking threads; on GitHub changes requested), `review-comments`
(ASS-361, below), `needs-rebase` (conflicts, or behind its target), `needs-approval` (GitLab's
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
record. Any other failure of the command exits 1, never 2, 3 or 4, so it
matches no exit and is tried again where it is.

A reviewer may leave a blocking request as a plain comment, not a thread
(ASS-361): "renumber the migration, then rebase". `review-comments` counts
those, after `open-threads`: on GitLab a merge request note that is neither a
system note, a bot's nor resolvable (a thread's notes are resolvable, and
`open-threads` counts those), on GitHub an issue comment or the body of a
review that commented or requested changes — by anyone but the harness,
posted after the merge request's latest commit and after the harness's last
comment there. The harness is the project's push account
(`data/projects/<p>/push-account.json`, control's check of the VMs' token,
which pushes the commits) and the host's own glab or gh login (which
`merge-request:reply` posts as), so a new commit or a reply answers it.
`merge-request:view` lists them as `comments: [{ id, author, body, created }]`
beside `threads`, and `merge-request:reply` takes a comment's id in place of a
thread's: the comment is answered with a new one naming its author and
linking it (neither forge replies to one in place without making it a
thread). The feedback says it in plain words: "it has a review comment from
sam".

Advisory review bots that post as ordinary accounts are left out too
(ASS-389), so answering them never livelocks the merge loop: GitLab Duo Code
Review's account (`GitLabDuo`, `ADVISORY_BOTS_DEFAULT` in
src/agent-cli/merge-requests.bash) always, plus project.json's
`"advisory-review-bots": ["review-helper", "notes-bot-*"]`, usernames or
simple patterns (`*` any run of characters, `?` one) matched whole in any
case. A value that is not a list of non-empty strings fails
`merge-request:view` and the checks that read review comments, naming it.

Every dependency waited on is the variation's own merge request, and before
ASS-361 nothing in Build acted on its review: Release's Address Merge Request
Feedback comes after the very tests that wait. So while a dependency needs
`open-threads`, `review-comments`, `build-failed` or `needs-rebase` (and none
is `not-created`, which exits 3 first) the step exits 4, and grouped-build
sends it to its own Address Merge Request Feedback:
`check-on-merge-request-build-grouped`, in the VM — Release's
`check-on-merge-request-grouped` (unchanged) plus plain review comments and
the operator's Human Review notes, as every grouped Build prompt reads
them — which reads each merge
request with `merge-request:view`, acts on its threads, review comments,
failed jobs and rebase, pushes, and replies to each (resolving the threads).
On GitLab its `failed-jobs` (and the job names in the feedback) also hold
the pipeline's failed bridges — trigger jobs, which `…/jobs` leaves out —
and their downstream pipeline's failed jobs (ASS-482), all from the pipeline
the `build-failed` was judged on. A `build-failed` with no failed job or
bridge to show (a canceled pipeline, say) is no agent's to act on either: it
keeps polling, exit 2, the feedback naming the pipeline's URL.
Once its turn is complete it goes back to Await Sequential Merge, which reads the
forge again. It has its own max-visits (3), then Blocked. A control line in
`execution-plan-<variation>.md` names the merge request and what it needs,
and the feedback adds "sent to Address Merge Request Feedback". A dependency
that is only a draft or only needs approval is no agent's to act on: it keeps
polling, exit 2, as before.

### Build merges the awaited merge request (ASS-365)

Await Sequential Merge only waits: a dependency that is a draft, needs an
approval or is not set to auto-merge polls until a person does Release's job
on it. A project's workflow can have Build do that job itself: its own main
engine sets `"merges-awaited": true` on the parent step that runs
grouped-build — its Build step. No engine in this repository sets it, so
every project but one that opts in (the harness's own included) behaves as
after ASS-361.

- **The flag.** Any step of any engine may declare it, true or false (the
  validator rejects any other type). Control reads it, never a step's id,
  name or project: while any level of the variation's status chain is at a
  step with it (`src/control/engine.js` `mergesAwaited`, as the TUI reads
  `shows-merge-train` anywhere in the chain), every script step control runs
  for that variation, on the host, gets `MERGES_AWAITED=1` in its environment
  (`src/control/steps.js` `scriptEnv`); the variation's command lines are
  unchanged. Only `merge-request:await-dependencies` reads it. On a
  state-engine step whose sub-engine can end at `blocked-for-human`
  (grouped-build), the validator also wants an exit reading that end, before
  the bare `is-done` one: without it the run's Blocked for Human would match
  `is-done` and move the ticket on, unmerged, as if Build had passed.
- **Exit 5.** With the flag, Await Sequential Merge's command, after exit 3
  (never created) and exit 4 (feedback of its own to act on) come first,
  exits 5 while it waits on any dependency (a draft, an approval, or nothing
  but the merge), printing the dependencies' planned ids as
  `"merge-request-ids"` and noting them in `execution-plan-<variation>.md`.
  grouped-build sends exit 5 to Merge the Awaited (`merge-awaited`, max-visits
  5, then Blocked), a state-engine step running `grouped-merge`. It sets
  `shows-merge-train`, so the `↳ AWAITING MERGE` line (ASS-363) still shows
  while the loop runs, and `"pass-output": ["merge-request-ids"]`: a
  state-engine step's `pass-output` names fields of its own run's
  structured-output that the run it starts begins with (`steps.js`
  `passedOutput`), here the ids Await Sequential Merge recorded
  (`record-script-output`). Its ends: `done` (the set merged) back to Await
  Sequential Merge, which reads the forge again and goes on to the tests or
  merges the next awaited one in a chain; `rebuild` (a review rejected the
  work) to Generate Solution; `blocked` to grouped-build's Blocked;
  `blocked-for-human` to grouped-build's own `blocked-for-human` done step,
  reached from nowhere else, which the parent step sends to Blocked for Human.
- **One variation only.** A variation set aside at Variation Selection is
  soft-deleted (`is-deleted`, `ticket:select-variation`). With more than one
  variation not set aside, nothing is merged early, since the work merged
  might be the losing variation's: the command exits 2 or 4 as without the
  flag, and the feedback says why ("Build does not merge it early: the
  ticket has 2 variations in play, until Variation Selection sets all but
  one aside"), even for a dependency that only waits to merge.
- **Nesting.** The loop runs three levels down: the project's Build step,
  grouped-build's Merge the Awaited, grouped-merge's step. Control already
  runs a sub-engine inside a run (`runTransient`'s state-engine case: Test's
  Local Testing runs grouped-local-testing the same way), dispatches agents
  for a run's prompt steps at any depth, and records the variation's status
  at every level, so no control change was needed for the depth: the loop is
  a sub-engine of grouped-build rather than steps added to it, so a
  project's Release can run the same loop.
- **The ordering decision.** grouped-build's order is unchanged, and so is
  every project's without the flag. With it, the awaited merge request
  merges in Build, before the ticket's Test, Document, Review and Human
  Review (and before grouped-build's own Code Review and Security Review
  after the tests): its dependents cannot be tested until it has merged, so
  it cannot wait for them. It merges only after the harness's own Code Review
  and Security Review have passed with it at its current head commit (the
  loop runs them first, below), and only through its forge's approvals and
  pipeline (auto-merge; nothing is approved automatically). The dependent
  merge requests still wait, and go through Release as before.

`grouped-merge` (`engines/grouped-merge`) is the shared merge loop: Release's
loop over a set of a variation's merge requests, its commands generic and
each given the set as `--only {merge-request-ids}` (control's placeholder for
a run: the run's `merge-request-ids` comma-separated, `-` for every one when
it names none, so a project's Release could run it over the whole variation).

| Step | Command or prompt | Exits |
|---|---|---|
| Check Reviewed at Head (`check-review`, max 10) | `merge-request:reviewed-at-head … --only` | 0 out of draft; 2 to Code Review; else tried again |
| Code Review, Security Review (max 3 each, in the VM) | `code-review-grouped`, `security-review-grouped` | approved on; rejected to `rebuild` |
| Mark Reviewed (max 5) | `merge-request:reviewed-at-head … --only … --mark` | 0 back to the gate |
| Take out of Draft Mode (max 5) | `code:take-out-of-draft-mode … --only` | 0 to the check; else tried again |
| Check the Merge Requests (`check`, timer 5 min, max 10, record-script-output) | `merge-request:check … --only` | needs-attention to Address Merge Request Feedback; merged to `done`; approval-wait-expired to `blocked-for-human`; auto-merge false to Ensure Auto-Merge; only waiting polls, no visit spent |
| Address Merge Request Feedback (max 3, in the VM) | `check-on-merge-request-build-grouped` | to Check the Feedback Round |
| Check the Feedback Round (`check-feedback-round`, max 5; ASS-388) | `merge-request:feedback-round … --only` | changed false back to the check, cause `no-op-round`, no visit counted; else back to the gate |
| Ensure Auto-Merge (max 3) | `merge-request:ensure-auto-merge … --only` | 0 to the check; else `blocked` |

Each looping step's max-visits ends the run at `blocked`. Its prompt steps
say `"vm": "running"`, as a project Release's Address Merge Request Feedback
does, so they have the VM under a Release too; its host scripts say
`"vm": "stopped"` (ASS-418), so the loop's forge polls hold no VM under
Build either. The ticket system's exits of
Release's Team Code Review (In Testing, In Progress) are not the loop's: they
are Release's own, and in Build the ticket is In Progress.

- **Reviewed at the head commit.** `merge-request:reviewed-at-head` reads each
  Open one of the set's head commit from its forge (GitLab's `sha`, GitHub's
  `headRefOid`). One whose `reviewed-head` (on its merge request row) is that
  commit passes; any other gets it as its `review-head` and the gate exits 2,
  telling the operator "Reviewing acme/api !12 at 1a2b3c4d before it leaves
  draft or is set to auto-merge". Code Review and Security Review then review
  the variation's merge requests as grouped-build's do; once both pass,
  `--mark` makes each `review-head` its `reviewed-head`, with no forge call,
  and the gate is asked again: a commit pushed during the review is not the
  one reviewed, so it is reviewed again. The only way out of draft is the
  gate's exit 0, the only way to Ensure Auto-Merge the check after it, and
  Address Merge Request Feedback, whose agent pushes, goes back to the gate
  (through Check the Feedback Round, ASS-388: a round that changed nothing
  goes back to the check instead, its head reviewed already), so its new commit is reviewed before anything is set to auto-merge.
  Merged or Closed ones need no review. A project whose Release runs the
  loop and wants no second review switches off the loop's Code Review and
  Security Review (`switched-off-steps`), and the heads are marked as they
  are.
- **The set (`--only`).** `code:take-out-of-draft-mode`, `merge-request:check`
  and `merge-request:ensure-auto-merge` take an optional `--only <ids>`
  (planned ids, comma-separated, or `-` for every one). Without it each is
  exactly as before. With it each acts on the set alone: every merge request
  is still read and recorded, and one outside the set still counts as a
  dependency (Ensure Auto-Merge sets one only once all it depends on have
  merged, in whatever set), but needs-attention, reasons, auto-merge, merged,
  the held-back pipelines and the approval wait are the set's, and no
  pipeline outside it is re-run. `merged` is true once every one of the set
  is Merged or Closed. The check also counts a reviewer's plain comment not
  yet answered (ASS-361) as `review-comments`, which stops the approval wait
  and goes to Address Merge Request Feedback. An id the variation never
  planned fails the command before the forge is asked.
- **Feedback.** With `--only`, each command tells the operator what the loop
  is doing, as the variation's ai-feedback (the TUI's Health), written only
  when it changes and kept as `merge-loop-feedback`: "Taking acme/api !12 out
  of draft", "Auto-merge set on acme/api !12; waiting for it to merge",
  "acme/api !12 waits for 1 approval since <time>" (the approvals left from
  the forge, the time its approval wait began), "acme/api !12: it has
  unresolved review threads; sent to Address Merge Request Feedback",
  "acme/api !12 waits for acme/lib !4 to merge first". Once the set has
  merged it is cleared, when it is still the loop's own. Await Sequential
  Merge's own feedback on exit 5 ends "Build merges it". An approval wait
  past harness.json's `approval-wait-days` ends the loop at
  `blocked-for-human` with the check's own feedback, as Release's does.

Write Execution Plan (grouped/v2 Plan, `write-execution-plan-grouped`) never
pins a consumer to a digest or tag a producer repository publishes only after
its merge request merges, when that digest can't be read in the VM (ASS-339):
it plans the producer's merge request alone and leaves the consumer's pin to
Renovate or a follow-up ticket. A hand-pinned placeholder digest
(`sha256:0000…0000`) reads merge-ready but is un-pullable, so Ensure Auto-Merge
never arms it and the release bounces until the ticket blocks. The flat
`write-execution-plan` prompt is unchanged.

A plan Review Plan keeps rejecting gets one stronger re-plan, then a question
to the operator, not Blocked (ASS-399; `grouped-plan` only — `v2-plan` and the
flat engines are unchanged). Each rejection first goes to Record the Plan
Objections (`plan:record-objections`, on the host), which adds that review to
`plan-objections-<variation>.md` in the ticket's folder ("## Review <n>,
rejected <time>", the review beneath; the harness's own file, which
`work:write` refuses) and sends the plan on to the step the review named
(`revise-from`). Its max-visits (2) make the third rejection — the one that
would have ended Plan at its max visits — go to Record the Objections for a
Stronger Plan instead, which records it the same way and goes to Write
Execution Plan on a Stronger Model: the same `write-execution-plan-grouped`
prompt, its action `"model": "stronger"`, so control dispatches it with
`assignments:create --model <model>` — harness.json's `stronger-model`, else
the first (strongest) model in its Claude models list (`dispatch.js`
`modelFor`; every other step runs on the model its action names, below). The prompt reads
`plan-objections-<variation>.md` whenever it exists, the earlier re-plans too:
every objection so far, summed up once each under the plan's "## Objections"
with how the draft resolves it. Write Test Plan, Enrich Automated Test Data
and Review Plan allow 4 visits (the flat engines 3), so that pass runs through
them. Approved, Plan ends at done as usual. Rejected (both record steps now at
their max), it goes to Ask the Operator About the Plan
(`plan:ask-about-objections`): the review is recorded, then a blocking
`question:ask` on the ticket lists the open objections (that last review) and
asks how to proceed. The ticket gets no agent while it is open; Awaiting the
Plan Answer, a human step with `restarts-visit-count`, rests until no blocking
question is open, then sends the plan back to Write Execution Plan with every
step's visits counted afresh — the answer in `questions-and-answers.json`.

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

A passing hiccup at either Refresh step is no block (ASS-396). A VM the
command cannot reach (`limactl shell` failing: ssh's 255, the in-VM
`agent.sh`'s 125 "host forwarder unreachable", any other) and a fetch that
fails as a network does (a timeout, a connection reset or refused, a host not
resolved, an early EOF, a 5xx from the forge) get 3 attempts, 5s then 15s
apart, each for the repositories still to do. Still failing, the step — a
timer step (5 min, `waiting-exit-code` 2, as Check Numbered Files) — waits:
exit 2, polled again with no visit or failure counted, the variation's
feedback saying "Refresh Repositories: can't reach <the VM/the forge>,
retrying (attempt n, since <time>)" (kept as `refresh-wait`, written when it
changes, cleared once a run gets through). 30 minutes after the ticket entered
the step (its sub-state-change into it in the variation's `state-changes`) it
gives up: exit 3 to Blocked, its output (`record-script-output`) the
`ai-feedback-short`/`-long` naming each failing call and its last error. Any
other fetch failure (no such repository) is left as is, as before, and no
running VM (exit 1) blocks at once. Run elsewhere (by hand) it exits
3 at once. Any other exit (4, an unexpected failure) matches none: tried again.

Generate Automated Tests (grouped/v2 Build, `generate-automated-tests-grouped`)
records an entry only once its `run` command, not just its `list`, runs in
the VM (ASS-337). A CI-only test — one whose `run` cannot execute in the VM:
a missing toolchain, an outside credential, an image not on the mirror — is
written on the branch for CI but left out of `automated-tests-<variation>.json`,
so Automated Testing does not block on it. The flat `generate-automated-tests`
prompt is unchanged.

Both it and the flat `generate-automated-tests` never end their turn while a
command they started is still running (ASS-461, test-grouped's ASS-304 rule
verbatim, ahead of `automated-tests:record`): a long test run goes in the
foreground with a long enough timeout, or in the background polled until it
exits, then recorded. A backgrounded run left behind at turn end died with the
headless session, and nothing got recorded.

A recorded test stays current with the code it tests (ASS-353). A `run`
command bringing a docker compose stack up starts it from a fresh database:
`docker compose down -v` first, or a per-run-unique `COMPOSE_PROJECT_NAME`;
`automated-tests:record` refuses one under a fixed project name with no reset
(`compose-reset.js`), whose volume would carry migrations a later step
renumbered into the next run. Generate Solution records the list again when
it renames or moves a test file an entry names. Automated Testing
(`automated-tests:verify-success`) sends either kind recorded before back to
Generate Automated Tests, exit 4 as for a missing list, marked ↻ in
`automated-test-results-<variation>.md`: a reusing stack before anything runs,
and a red run whose `list` command fails too (it ran, so the file it names is
gone), compared with no master. The flat engines send exit 4 to Generate
Solution, as any exit but 0 and 3.

Two merge requests in one repository (ASS-498): each entry for a test there
also gets `"merge-request": <id>`, the one whose branch holds the test, and
each test is committed on that branch (`automated-tests:record` refuses an id
that is not a positive integer).
`automated-tests:verify-exist-and-runnable` checks that branch out in the
repository holding it to run the entry's `list`, then puts the repository back
where it was (on failure too); it fails, switching nothing, on an id not in
the merge-request plan, a branch no repository has, or changes not committed.
Entries without it run as before. `automated-tests:verify-success` does not
read the field yet: its `run` commands still all run in one checkout.

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
compare with; in a repository whose planned merge requests are all Merged it is
skipped (ASS-474: no merge request range is left to scan), said so in the
results, so a finished ticket is not sent round Build; `needs` (optional, ASS-471) lists commands the check's scripts
are known to run that its command line does not show, which a workstation's
setup checks with each command's first word (see "A GCP workstation's setup"). A check that fails is run on `origin/<base>` too, as Automated
Testing's tests are (ASS-99), and failing as it does on master passes. Exit 0
(every run check passed, or failed only as on master) goes to Code Review, 3
(a check could not run, no VM, or the file malformed) to Blocked, any other (a
new failure) back to Generate Solution. `ci-checks-results-<variation>.md` in
the ticket's folder holds each check's job, command, exit code and output, for
Generate Solution and Security Review. A project without the file, or a ticket
whose repositories declare none, passes with nothing run.

`ci-checks.json` is not an input of the golden image (it is of a workstation's setup, ASS-471): changing it rebuilds
nothing.

Check Numbered Files (ASS-385; grouped Build only — v2-build and the flat
engines have none — `merge-request:check-numbered-files`, on the host, max-visits
3) runs between Refresh the Reference Repositories Before Testing and Automated
Testing, so after every Generate Solution and Address Merge Request Feedback
push. An agent numbers a new migration or numbered test once and kept that
number across rebases while master and other open merge requests took it:
Flyway (`outOfOrder=false`) rejects a version at or below the target's highest,
and a project's CI rejects one another open merge request claims. Each kind of
numbered file is declared in project.json:

```json
"numbered-files": [
  { "kind": "migration", "glob": "apps/*-db/src/V*__*.sql", "command": "scripts/next-free-number.sh migration" },
  { "kind": "db-test", "glob": "apps/*-db-e2e/src/*.sql" } ]
```

`glob` picks its files from the repository's root (`**`, `*`, `?` and `{a,b}`
as in `ci-checks.json`); a file's number is the first run of digits in its
name, and each folder is a sequence of its own. `command` (optional) prints the
next free number (its output's last number); it runs in the repository's
checkout in the VM, with the VM's own forge credentials (`/run/harness/env`:
`GITLAB_TOKEN`, `GH_TOKEN`) loaded, so a rule script that asks the forge can —
pass the token on in the command if the script reads another name, e.g.
`GITLAB_READ_TOKEN="$GITLAB_TOKEN" bash scripts/next-free-number.sh migration`.
Without one, or when it fails, the free number is the fallback: one above the
highest on the target branch and in the other open merge requests. Unset,
`numbered-files` is Flyway's versioned migrations (`**/V*__*.sql`) by the
fallback; `[]` checks nothing. For each merge request neither Merged nor
Closed, the check reads in the VM, origin fetched, the numbered files its
branch adds since its merge base with `origin/<base>` and the target's
highest in each sequence; and on the host, through the harness's glab/gh, the
repository's other open merge requests and the files each adds. A file
collides when its number is at or below the target's highest, or an open merge
request opened before this one (a lower iid; every one, while this one is not
yet opened) adds the same number — the older keeps it, so two tickets never
both renumber. That file and the branch's later ones in its sequence are
renumbered in order from the free number, skipping any number another open
merge request holds, each new name keeping its digits' width. Exit 0 goes on
to Automated Testing; 1 (a collision) back to Generate Solution, with each
file and the name to give it on stderr and in `numbered-files-check-<variation>.md`
in the ticket's folder; 3 (no VM, the declaration malformed) to Blocked.
A forge or VM hiccup is no block (ASS-386): each forge read (`glab auth
status`, the open merge requests, the files each adds) and each git call in
the VM (fetch, the default branch, the files added, the target's tree) gets 3
attempts, 5s then 15s apart. Still failing, the step — a timer step (5 min,
`waiting-exit-code` 2, as Await Sequential Merge) — waits: exit 2, polled
again with no visit or failure counted, the variation's feedback saying
"Check Numbered Files: can't reach <the forge/the VM>, retrying (attempt n,
since <time>)" (kept as `numbered-files-wait`, written when it changes,
cleared once the check runs). 30 minutes after the ticket entered the step
(its sub-state-change into it in the variation's `state-changes`; every run
since failed to check, as any other exit moves it on) it gives up: exit 3 to
Blocked, its output (`record-script-output`) the `ai-feedback-short`/`-long`
naming which forge call or VM command kept failing and its last error, set
as the ticket's health after the move. Run anywhere else (an agent before a
push) it exits 3 at once, as before. Any other failure exits 4, matching no
exit: tried again. A collision (1) and a pass (0) are as before, with no
delay. `generate-solution-grouped`,
`check-on-merge-request-build-grouped` and Release's
`check-on-merge-request-grouped` give the rule (`{numbered-files}`) and have
the agent run the same command after every rebase and before every push,
renumbering (`git mv`, every reference, the recorded automated tests through
`automated-tests:record`) and saying so in the change log. grouped-merge,
whose Address Merge Request Feedback pushes straight back to the review gate,
has no step of its own: its agent runs the command before pushing, and the
merge request's own CI rule gates the merge.

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
file; a wait recorded with no `wait-began` finds no such edit (ASS-342). A
harness fix (its home harness.json's `harness-project`) is fast-tracked
unless harness.json's `fast-track-harness-fixes` is false, and one landed by
a merge or a commit is landed only once the running control has loaded it:
control records the commit it started from in `data/control-commit-<project>`
and each of the fix's commits on the default branch (`<KEY>:` subjects, the
merge of its `change/<KEY>` branch) must be its ancestor; until then the
ticket waits, its Health "Fix <KEY> landed; waiting for a harness restart to
load it", counted in the dashboard's one "Restart to load <n> landed fixes"
notice, never as Operator Needed (ASS-393). An
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
With nothing named there is nothing to check (ASS-492): the not-proven
feedback never prints blank placeholders ("job - on -'s master"); it says
Troubleshoot named no failing check and gives the Blocked run's summary,
root cause, Classify's reasoning and any missing change (check-on-master's
optional fourth argument, `{run}`, the run whose structured-output it reads).

A failure in the ticket's own branch goes back to Generate Solution, not to
the operator (ASS-384). When master passed the job (exit 3) or could not show
it (exit 4), Check for an Own-Branch Fix (`own-branch-or-obstacle` after a
pass, `own-branch-or-human` after no evidence; both `ticket:own-branch-fix`
on the host, reading the VM's checkout) decides whether the defect is the
branch's own: Classify said `own-branch: true`, Troubleshoot named the
failing repository, the failing file (`failing-file`, a path in it, `:line`
allowed) and the job or assertion that fails on it, and that file is one the
variation's branch adds or changes — in `/repos/<repository>`, changed since
the merge base with `origin/<base>` (the merge request's base, else origin's
default branch), committed, not committed or untracked. Then the finding —
summary, root cause, failing check, file:line, evidence, the master evidence —
is appended to `execution-plan-<variation>.md` as an `## Own-branch fix`
section, which Generate Solution reads first, and the run ends at `done` with
`own-branch-fix: true` and a `resume-at` (Generate Solution's top-level group,
lifted and checked by fix-resume-step.js as a declared step: Build, or the
blocked step when Build comes after it). Control takes that `resume-at` as it
does a landed fix's (engine.js `ownBranchFix`, `resumeAt`), and the clearing
move's `own-branch-fix` cause restarts the visit counts; its log says `the
failure is in its own branch (own-branch fix); resumes at <step>`. The run's
`ai-feedback-short`/`-long` are cleared, so check-on-master's "not proven"
note does not mark the ticket as the operator's. Each such return is a fix
attempt: ticket:fix-attempts adds the own-branch fixes in a row in the
variation's `blocks` (back from the latest, retries passed over, until a block
that ended any other way — a landed fix, a repair, Blocked for Human) to the
stay's fix tickets, so the third sends the ticket to Blocked for Human, its
feedback saying how often the own-branch fix was tried. Anything not shown —
Classify not saying so, nothing named, no VM, a file the branch does not
change — goes on as before: the obstacle fix after a pass, Blocked for Human
with check-on-master's feedback after no evidence. A failure on the latest
master still raises the project bug, and an environment or harness issue
never reaches the check.

A merged merge request is still the ticket's own code (ASS-423). Once the
ticket's merge requests merge — QA puts a released ticket On Hold, say — the
VM's checkout shows nothing of them, so when the failing file is not the
branch's, `ticket:own-branch-fix` reads each of the ticket's Merged merge
requests for the failing repository on its forge (merge-requests.bash
`mr_files`: GitLab's `…/merge_requests/<iid>/diffs`, else `…/changes`;
GitHub's `…/pulls/<n>/files`); a file one of them added or changed (a
rename's old name too) is the ticket's own, `own-branch-source: merged`.
Then, when none of the ticket's merge requests for that repository is still
open or to be created (every one Merged or Closed), it plans a new one
(merge-requests.bash `plan_new_merge_request`, through
`ticket:set-merge-request-plan`): the next unused id, branch
`change/<KEY>-<id>`, based on the merged one's base, its contents saying
what to fix and why; the output's `merge-request-planned` names it. The `##
Own-branch fix` section says the fix goes in that new merge request, names
it, and says not to reopen or push to the merged branches; Generate Solution
builds and opens it as any planned one, skipping the merged ones as ever. One
still open keeps the fix, nothing planned. Troubleshoot and Classify are told
that a defect in a file the ticket's merge requests added or changed is
`own-branch: true`, merged or not. A block from QA resumes at Build (Generate
Solution's group), its Jira status that step's pairing, and goes through
Build, Release and QA again; the return is a fix attempt as above. A file in
no merge request of the ticket, or a merged one the forge will not show, is
not shown: the paths above, unchanged.

Own work that is merely incomplete goes back to Generate Solution with a
merge request planned for it (ASS-492). Seen on a client ticket: both merge
requests merged, but the app pinned the library to the version before the
one the first published, so QA put it On Hold; nothing failed, the ticket
lacked a third merge request bumping it. Troubleshoot names such a change
(`missing-change`: what the merge request must hold; `missing-change-repository`:
the project's repository it goes in) with no `failing-*`, and Classify says
`issue: project`, `own-branch: true` with the same two fields. Check on the
Latest Master has nothing to check (exit 4), so Check for an Own-Branch Fix
Before the Operator runs `ticket:own-branch-fix`: with no failing file named
and a missing change in one of the project's repositories (the ticket's
merge requests', else project.json's), the change goes on the ticket's merge
request there still Open or Not Created (nothing planned;
`merge-request-existing` names it), else on a new one planned by
`plan_new_merge_request` under ticket:add-merge-request's rules (next unused
id, `change/<KEY>-<id>`, the merged one's base, Not Created, `planned-by`
step `Blocked`, its why Classify's reasoning). The `## Own-branch fix`
section gives the summary, cause, the missing change with Classify's
reasoning, the evidence, and which merge request takes it; the run ends at
`done`, `own-branch-fix: true`, `own-branch-source: missing-change`, its
`resume-at` Generate Solution's group, the not-proven feedback cleared — no
operator gate. No VM is read. A repository the project does not list, or no
repository named, is not shown (exit 3): Blocked for Human as before, its
feedback the run's own finding.

Blocked checks first (ASS-390 AC4). After counting its attempts and before
any agent is dispatched, Check First (`check-first`, `ticket:recheck-block`,
on the host, the VM kept running) re-runs the check the ticket failed: the
step it was at when it entered Blocked, read from its state changes as
`cameFrom` reads them (through Blocked for Human and back too; beneath a
group, the step that left for the group's done step), when that step is a
script step — Automated Testing's being the recorded automated tests — whose
command needs no value of a run and changes nothing outside the ticket (never
a merge, a restart, a VM made, a merge request opened or marked). In
vm+workstation mode, a variation on a Lima VM is moved onto the ticket's
branches first (`vm:step-start`, as before any VM step; ASS-487: `vm:step-end`
left it on master); a step-start that fails is a failed re-check. Passing now,
the run ends at done with `needs-fix: false`, `recheck-passed: true` and "Passed
on re-check; nothing to fix" in the change log, and the ticket resumes as it
does when Troubleshoot finds nothing wrong; still failing, or nothing to
re-run, Troubleshoot goes on as before. Passes on re-check that block again
are counted by ticket:fix-attempts (`passed-on-recheck`), so a check that
only passes when re-checked reaches the operator after three.

A loop is no block of the step it left (ASS-474). When that step moved on
into a step of the group already visited its `max-visits` times in the
group's run, so control sent the ticket to that step's `on-max-visits` (the
done step it was blocked at) instead, the step it left passed and re-running
it proves nothing. Check First then names the loop (`loop`: the step that ran
out, the steps repeated, and the step that kept sending the ticket back, with
how often and where), re-runs that failing step for its output when it is a
check as above, and goes on to Troubleshoot whatever it exits — never
resuming the ticket into the same loop. The loop is kept with the run in
`blocks` (so Blocked for Human's record names it), and a loop run that ended
with nothing to fix counts as a fix attempt (`loops`). Verify the Repaired
Image re-checks the failing step too, its pass the repair's proof.

Repair Environment fixes whatever blocks the ticket within its scope (ASS-390
AC1): in the ticket's VM (or, before it is set up, its own host worktree) —
dependencies, containers, checkouts, caches, generated files, recorded test
commands (recorded again through automated-tests:record), stale branches
(reset to the base they should be on, never discarding the ticket's own
commits). The old list (reinstall dependencies, remove a stale compose stack,
re-run a setup step, save an edit aside) stays in its prompts as known-fix
examples, not as all it may do. Its limits stay: no credential, token or
secret changed; uncommitted work saved aside before anything is discarded;
nothing on the Mac or in the project's shared checkout; no product code (that
is Repair Project's); repaired only when the failing thing re-runs and passes.

Repair Project fixes product code in a fix merge request of its own (ASS-390
AC2, AC6). A project issue that is not on the latest master and not the
ticket's own branch (ASS-384) no longer goes to Repair Environment: after Plan
the Obstacle Fix records it in the plan (its `obstacle-repair` says which
repair follows; a missing repository named is still added first), Repair
Project (`repair-project` in the VM, `repair-project-on-host` in a fresh clone
in a temporary folder before the VM is set up) fixes the product code in the
ticket's way in a separate small merge request, on its own branch
`change/<KEY>-fix-<n>` from the repository's default branch, shows it works
by re-running the failing check, pushes it and opens it through
`merge-request:create-fix` (allowed through the forwarder), which titles it in
the project's format with "(fix <n>, unblocks <KEY>)", describes what blocked
the ticket and why, takes it out of draft and records it in the variation's
`fix-merge-requests`. It never pushes the ticket's own branches, changes a
credential, or touches the Mac or the shared checkout; a fix it cannot show
to work opens nothing and goes to Blocked for Human with what it tried. The
ticket then waits on it as on a fix ticket: Wait on the Fix Merge Request
(`ticket:wait-on --merge-request {fix-merge-request}`) records it as the
variation's `waits-on`, and Await the Fix Merge Request
(`ticket:fix-landed`, on a 5-minute timer, exit 1 its waiting exit: no
failure counted) reads it from its forge — open, the ticket's Health names it
and says it needs approval (and what else: out of draft, a failed pipeline,
open threads, a rebase); merged, the run is done with `landed: true`, the
ticket resumes and its visit counts restart (`fix-landed`); closed unmerged,
Blocked for Human asks the operator. Each such wait is a fix attempt for
ticket:fix-attempts.

Blocked sends a ticket that only waits for its own dependency merge request
back to Build (ASS-390 AC5). Classify's `dependency` outcome says the block
is no fault: one of the ticket's merge requests depends on one in another
repository that has not merged, and needs what it publishes only after the
merge (a pin to an image, say). Wait for the Dependency Merge Request
(`dependency-wait`, `ticket:dependency-wait`, on the host) shows it from the
variation's merge requests (read from their forges, as recorded when they
cannot be) — Classify's `dependency-merge-request`, when named, among them —
and ends the run at done with `awaits-dependency: true`, `resume-at` Build
(lifted and checked by fix-resume-step.js as a declared step) and
`resume-sub-at: await-dependencies`. Control takes that `resume-at` as it does
a landed fix's (engine.js `awaitsDependency`), enters Build at Await
Sequential Merge (`resumeSubAt`, steps.js: only a step of that group's
sub-engine, else its first step), and restarts the visit counts (cause
`dependency-wait`); its log says `it only waits for its dependency merge
request; resumes at build at await-dependencies`. Not shown is Blocked for
Human. Such returns in a row count as fix attempts (`dependency-waits`).

Classify's outcomes are easy to extend (ASS-390). Each is a value of
classify-issue-grouped's `issue` enum, said in its prompt, with one exit of
its own on `structured-output: { issue }` in grouped-blocked's Classify;
the last exit, `turn-complete` alone, sends an outcome with no exit of its
own to Blocked for Human rather than leaving the run stuck. A new outcome is
an enum value, its line in the prompt, its exit, and the steps it routes to.

Blocked repairs a broken image on the Mac, one golden rebuild at a time
(ASS-392). Classify's `image` outcome says the cause is in the project's
golden image (its definition in the project's golden-image folder, or its
build), the ticket's VM cloned from it, or the project's local registry the
image pulls through — an amd64-only image on arm64, `claude` missing from the
image, zot not answering, `golden-build.lock` held. The Blocked agents in the
VM cannot rebuild images, so the path runs on the host:
- Await the Golden Build (`await-golden-build`, `vm:golden-wait`, on a
  5-minute timer, exit 1 its waiting exit: no failure counted) waits while
  the project's golden image is being built — `golden-build.lock` held, or the
  build `golden-build-run.json` records still going: golden.bash's
  `golden_status`, the reading `vm:build-golden-start` refuses a second start
  on, whoever started the build (control's golden rebuild ticket, ASS-151;
  the operator; another ticket's Repair Image). No new lock: the harness's
  own, so no two builds overlap. Its `max-visits` (4) bounds the builds one
  stay waits for; then Blocked for Human.
- Repair the Image (`repair-image`, prompt `repair-image-on-host-grouped`,
  a host step confined as Troubleshoot on the Host is: it writes only temp,
  the harness's data only through agent.sh) re-checks first whether the
  problem is still there — a build finished while the ticket waited may have
  fixed it; then it rebuilds nothing (`problem-gone`). Found building, or
  having started a build, it ends with `golden-building: true` and goes back
  to wait, then runs again to re-check. It may only: start the registry
  (`registry:up`); edit the image definition through `vm:golden-write
  <project> <file>` (stdin; only a file of the golden-image folder — no
  absolute path, `..`, dot-file or symlink — and never while a build runs);
  rebuild (`vm:build-golden-start`, which builds only a definition that
  changed); and recreate the ticket's VM from the current image
  (`vm:recreate`: refused while a build runs or while the VM holds work no
  remote has; it puts each repository back on its branch and marks Setup
  complete again). Nothing else on the Mac — no other project, the shared
  checkout or the operator's settings — and never a credential (a missing
  token is the operator's, as Setup's credential check reports it). None of
  these commands is allowed through the forwarder.
- Verify the Repaired Image (`verify-image`, `vm:image-recheck`, the VM
  running) is done only when the failing check passes on a VM from the
  repaired image: the golden image current (built from its definition as it
  is now), the ticket's VM, when it has one, of the same generation, and the
  blocked step's check passing there (`ticket:recheck-block`, as Check First
  runs it; `image-verified: true`). With no check of the harness's own to
  re-run (an agent's step, or one that makes a VM: exit 2) Repair Image's own
  run stands. Anything else, or Repair Image not fixing it, is Blocked for
  Human with what was tried. Each command logs to the change log.

Blocked logs everything and cites only what it read (ASS-390 AC3, AC7).
Every prompt grouped-blocked runs (Troubleshoot, Classify, both Repairs, on
the VM and the host) has its agent append to `change-log-<variation>.md`
through `work:append` what it found, what it changed (files, commands, merge
requests) and why, and says to quote or cite only files and output it has
actually read in that run, never attributing a rule to a file it has not
opened. Its own script steps log too (`work.bash` `blocked_log`): Check
First, Plan the Obstacle Fix, the fix merge request opened, each wait
recorded and how it ended, and the dependency route.

A ticket blocked by a Claude rate limit uses the API key fallback at once or
waits for the reset (ASS-391). Classify's `rate-limit` outcome says the block
was Claude's usage or rate limits (HTTP 429, "usage limit reached", an agent
that died at 0 tokens on a limit), not the ticket. Await Rate Limit
(`await-rate-limit`, `ticket:await-rate-limit`, on the host, a 5-minute
timer whose waiting exit is 2: no failure counted) reads the limits control
recorded (`rate-limit.json`, `project:set-rate-limit`, a kind holding while
its `resets-at` is ahead). The subscription (`claude`) limited and the API
key fallback available — the project's `.claude-api`, no API cap holding it
(`api-cap-hold`), the API key (`anthropic`) not limited too, as dispatch.js
`paymentFor` decides — the run is done at once with `api-fallback: true`: the
ticket resumes where it was blocked and control's next dispatch pays by the
key. Otherwise (no `.claude-api`, a cap holding it, the key limited too, or
the limited runs on the API key already) it waits until the reset, then is
done with `rate-limit-reset: true` and the ticket resumes. While it waits its
Health reads "Waiting for the rate limit to reset at <time> (no API
fallback)", the long feedback saying why there is none — written, logged and
said once, then only when it changes (the wait kept as the variation's
`rate-limit-wait`). The ticket sits at Blocked, which is no blocked state: it
is not Operator Needed and notifies nothing (ASS-383). Nothing recorded as
holding, the run is done at once with `rate-limit-held: false`; such resumes
in a row are fix attempts for ticket:fix-attempts (`rate-limit-unheld`), so a
misread rate limit reaches the operator after three. A fallback or a reset
is no attempt.

A block caused by a missing or failing credential waits on the project's
credentials hold (ASS-395 AC5). Classify's `credentials` outcome (a keychain
item, a token, a login) goes to Check the Credentials (`check-credentials`,
`project:check-credentials`: a fresh check, recording the hold), then Read
the Credentials Hold (`credentials-status`, `project:credentials-status
--fail-when-held`). Held (exit 3): the run is done and the ticket returns to
its step — the hold stops the project's new dispatch, and the project already
shows once in Operator Needed ("Project blocked by credentials"). Not held,
the check cannot see this credential: Explain the Unseen Credential
(`credentials-unseen`, `ticket:credentials-unseen`) writes Classify's
reasoning and its `human-action` as the ai-feedback, logs it, and the ticket
goes to Blocked for Human.

A VM problem is fixed in the ticket's VM at once and in its source in the
background (ASS-427). The pattern, the operator's (2026-11-14): fix the
ticket's VM directly to unblock the ticket, then make the same change to the
VM's source — the golden image definition, or the harness's VM setup — so no
later VM has the problem. A golden rebuild never disturbs a ticket using its
VM (vm:build-golden builds `golden-<p>-build` beside the image and takes the
VM lock only for the swap), so the source fix never holds the ticket.
- Classify's `vm` outcome is a problem in the ticket's VM that can be fixed
  in place there and that every VM made the same way would have: a tool or
  package the golden image lacks (ABC-1770: `bats`, which the static-policy
  gate execs), a cache or container image it should carry, a file the
  harness writes into each VM as it starts (`vm:credentials`:
  `/run/harness/npmrc`, gitconfig, env) missing an entry because its
  declaration lacks it — the credential itself valid (ABC-897: a project
  declared no gitlab `npm-registries`, so pnpm reached `@example`
  anonymously, 401). That is no `credentials` issue any more: the credentials
  hold is for a secret missing or failing. `image` is now only what cannot
  be fixed in place. Repair Environment, finding a fix every VM from the
  image would need, fixes nothing and says `vm-source: true`, which sends it
  to the same repair.
- Repair the VM and Its Source (`repair-vm`, prompt
  `repair-vm-on-host-grouped`, a host step confined as Repair Image is, its
  VM kept running) makes the smallest fix in the ticket's VM through `vm:run
  <p> <ticket> <variation> <script file>` (the agent's script run in that VM
  alone, as its user, through `limactl shell -- bash -s`; it waits for the VM
  to come up, exits with the script's exit, 3 with no VM; script and exit
  logged) and re-runs the failing check there. Then the same change in the
  source: the definition through `vm:golden-write` (the file path its last
  argument), and, for a missing tool, `vm:golden-add-tool <p> <tool>` — the
  tool added to project.json's `golden-image.tools`, so a build without it
  fails its tools check; or a non-secret VM-setup declaration through
  `vm:credentials-declare <p> <ticket> <variation> npm-registry <@scope>
  <gitlab-project-id>`, which adds the scope to the project's gitlab
  `npm-registries` in `~/.harness/vm-credentials.json` (under its lock, its
  mode kept; added only — a scope declared with another id, or a project
  declaring no gitlab credential, is refused, exit 3) and writes the ticket's
  VM's `/run/harness` files again at once (`vm:credentials`): the VM fix and
  the source fix in one, no rebuild needed. A secret — a token, a keychain
  item, its service name — stays the operator's. Fixed: Rebuild the Source
  in the Background, then Verify. Not fixable in place (`in-place: false`:
  the Lima template — cpus, memory, disk —, kernel settings, the image's
  build, no VM yet): today's path, Await the Golden Build, Repair Image,
  Verify, the ticket waiting. Not fixed: Blocked for Human with what it
  tried.
- Rebuild the Source in the Background (`rebuild-source`, `vm:golden-followup
  <p> <ticket> <variation>`, run once, whatever it exits on to Verify)
  records the ticket as waiting on a rebuild (`golden-followup.json`) and,
  when no build runs and the image is not current with its definition,
  starts it (`vm:build-golden-start`, detached, never waited on); the image
  current (a VM-setup fix), there is nothing to build, and the ticket's
  change log says so. One build per project at a time (AC3): while a build
  runs, `vm:golden-write` no longer refuses — it queues the file in
  `data/projects/<p>/golden-queue/` (`queued: true`; an agent reads a queued
  copy first, and a write while no build runs drops it), and control's
  golden follow-up (golden-followup.js, phase 2, once a minute while a file
  is queued or a ticket followed) runs `vm:golden-followup <p>`: once the
  build has ended it writes the queue into the definition, starts the
  rebuild, and logs each ended build's result on the tickets it fixed —
  rebuilt, its checks (the tools check among them) passed, or failed, its
  exit and logs. A start the disk hold refuses waits for the next minute.
- Verify the Repaired Image (`vm:image-recheck`) now verifies the ticket on
  its fixed VM (AC6): the blocked step's check passing there. The ticket's
  VM need not be a clone of the newest image, nor the image current; the
  image's state (current, being rebuilt, not built from its definition) and
  the VM's generation are logged with the outcome. This holds on the
  rebuild path too, where Repair Image recreates the VM before it.
- The run's history says "its VM fixed in place (…), its source (…) fixed for
  later VMs, verified on its VM" (facts.js blockHistory), and no fix ticket
  is raised for a `vm` issue. None of the new commands is allowed through the
  forwarder.
- When the repair could not apply a fix, the operator (or Claude acting for
  them) can: `vm:hold <p> <ticket> <variation> on [<note>]` keeps the VM
  running at Blocked for Human, paused or worked by hand (see VMs by state).

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

The ticket health check (`check-ticket-health-grouped`, ASS-124, and the
flat engines' `check-ticket-health`, run on a sample of state changes) is
removed (ASS-450): it found nothing Blocked, the merge request checks and
the step scripts had not, and when it fell behind it started dozens of
agents at once. Blocked and Blocked for Human, and the project health check
(`check-health`, `check-health-v2`), are as they were. An engine that still
declares `check-ticket-health-sample-every` or `check-ticket-health-steps`
runs as before, the keys ignored (control logs them once as obsolete), and
a run of the check an earlier harness left is ended as control starts.

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
  Request Feedback, grouped-merge's Code Review, Security Review and Address Merge Request Feedback (ASS-365),
  and Blocked's troubleshooting and repair. A `state-engine` step always
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
  - `blocked-for-human`: Setup's Create VM found no room, or (ASS-365)
    grouped-build's merge loop waited past `approval-wait-days`; read only by
    a Build step that sets `merges-awaited`.
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

## Each AI step's model (ASS-452)

A prompt step's `action.model` names the model its agents run on: one of
harness.json's claude models (`agentic-command-line-interfaces`, `claude`),
or `"stronger"` (ASS-399, above). Control dispatches every agent of the step
on exactly that model (`dispatch.js` `modelFor`, `assignments:create --model
<model>`), the round robin and `last-model-used` left as they were; a step
that names none still takes the round robin's next model (restricted by its
prompt's `supported-models`, as before). `validate.js` rejects any other
value, naming the step and the allowed models, and a model the step's
prompt's prompt.json `supported-models` leaves out (when it lists any). The
dashboard's agents keep showing each agent's actual model, its record's —
the step's configured one when it names one.

The rule every prompt step in `engines/` follows: `"model":
"claude-opus-5-5"` (Opus 5.5), except the review steps — those whose prompt
is `code-review`, `code-review-grouped`, `security-review`,
`security-review-grouped`, `review-plan`, `review-plan-grouped`,
`review-root-cause-analysis`, `review-root-cause-analysis-grouped` or
`review-work` — which name `"model": "claude-sonnet-5"` (Sonnet 5); and
`grouped-plan`'s Write Execution Plan on a Stronger Model keeps
`"model": "stronger"`. A project's own engines under
`data/projects/<project>/engines/` are the operator's: they follow the rule
by hand, or rotate while they name none.

## Host agents give agent.sh its content by file (ASS-428)

The rule: a host agent passes content to agent.sh by file, never by
redirect, pipe or heredoc. It writes the content first to a temp file of its
own, unique to its run, in a call of its own (its Write tool, or a Bash call
that does nothing else), then runs the agent.sh command as a bare command
line with that file's absolute path as the command's file argument.

Why: a confined host agent (`src/agents/confinement.js`, every host step not
on a ticket's code: Blocked's Troubleshoot on the Host, Classify and Repair
the Image, grooming, health checks) runs under
`data/projects/<project>/host-agent-settings.json`, whose
`sandbox.filesystem.denyWrite` holds the harness's `data/` folder. agent.sh
writes there only because `<harness>/agent.sh *` is one of the sandbox's
`excludedCommands`, and that exclusion matches only a bare call: agent.sh and
its arguments, nothing else on the line. A call with `< file`, `<<'EOF'`, a
pipe, `&&`, `;` or `$(…)` runs sandboxed, and every write it makes under
`data/` fails with "Operation not permitted" (ABC-1770's `vm:golden-write …
< provision.sh` failed at mktemp; its `work:append` failed on the change
log's lock). The agents' `{where}` (`dispatch.js confinedWhereText`) and each
host prompt's call say so.

Every command a host agent is told to give content takes it from a file path
as well as stdin, stdin unchanged when the path is left off: a trailing
optional `<file>` for `work:write`, `work:append`, `ticket:set-requirements`,
`automated-tests:record`, `ticket:set-demo-plan`, `vm:golden-write` and
`merge-request:create-fix`; a path in place of `-` for
`ticket:set-acceptance-criteria` (its 3-argument form),
`ticket:set-merge-request-plan`, `ticket:add-merge-request`,
`ticket:propose-split` and `ticket:post-comment`. A VM agent keeps giving
stdin through the forwarder: `forwarder-allowlist.json` caps each
trailing-file command's arguments (`max-args`) and requires `-` where a path
could stand in its place, so no path reaches the Mac from a VM.

A write refused all the same is named, not left vague: a confined agent's
output schema gains `sandbox-refused` (`dispatch.js withSandboxRefused`), the
commands refused, and control makes it the variation's health,
`ai-feedback-short` "sandbox refused <command>" (`facts.js
sandboxRefusedFeedback`, set by `finish.js` when the agent finishes and by
`steps.js` when its Blocked run ends). `test/agents/host-agent-sandbox.test.js`
runs each command both ways under the generated settings.

### Every agent.sh call its own Bash call, and the guard (ASS-463)

After ASS-428 went live, host agents' writes were still refused, and the
tickets went to the operator ("sandbox refused assignments:status-update",
"sandbox refused work:append"). What they typed: the status update chained to
the next step (`agent.sh assignments:status-update <agent> "…"; python3 …`),
the approval chained to `; echo exit=$?`, and the change-log entry's heredoc
and its `work:append … "$f"` in one Bash call. None is a bare line. Three
causes: Classify's and Troubleshoot on Host's prompts have no `{where}`, so
those agents never saw control's rule (agent:dispatch now puts `where=` first
in a prompt without `{where}`); the `{code-scope}` preamble said "the content
on stdin"; and the status/approve wording in the wrappers, the check-in
(`ask-for-status-update`, supervise.js's nag) and the message and shut-down
prompts never said to run the command alone. They all say so now:
`test/workflow/confinement.test.js` fills each of them as the engines name
them and checks every agent.sh call in them against the sandbox rule.

How Claude Code matches `excludedCommands` (2.1.325, read from its bundled
matcher, `test/support/claude-rules.js runsUnsandboxed`): it splits the line
at `;` `&&` `||` `|` `&` and newlines and runs it outside the sandbox only
when every command on it is covered by a pattern; a `cd`, a shell, `env`,
`xargs`, `nohup` and the like are never covered, and a heredoc, `$(…)`,
backquote or a variable set in one command and used in another keeps the
whole line sandboxed. So no exclusion can make `cd <dir> && agent.sh …`
work, and a relative `./agent.sh *` pattern would follow the agent's `cd` to a
folder it can write. Instead the host-agent settings run a PreToolUse hook on
Bash, `src/agents/agent-sh-guard.js`: a line that calls the harness's
agent.sh or off-board.sh but is not that call alone, by its absolute path, is
refused before it runs, and the reason names the bare call to run as its own
Bash call (and, for content, to write a temp file first). It only refuses;
lines that do not call agent.sh pass.

`assignments:status-update` and `agent-interaction:send-message` take their
text as the argument or `--from <file>`, for text with quotes, `$` or
backquotes; a VM gives the argument (the forwarder's `max-args`).

## VMs by state, and the disk limit (ASS-75)

- **Running and stopping.** A step's `vm` says whether the variation's VM runs
  there (`running`) or is kept, stopped (`stopped`); the deepest level of the
  variation's status that sets it decides. Running: Setup through Review, and
  beneath, Blocked's steps that need it (below) and a project
  Release's Address Merge Request Feedback (they run in it). Stopped and kept:
  Blocked (once it waits on its fix), Blocked for Human, and, beneath a
  running group, each step that needs no VM (ASS-418, below). Anywhere else
  (Backlog, Committed, Release, QA, Done) it is not needed: stopped. A paused
  variation or ticket (`is-paused`) and a set-aside one (lost Variation
  Selection) have theirs stopped too. A VM to be stopped, for any of these
  reasons (or waiting for a slot, a finished plan waiting for a build seat
  (ASS-362), or for a ticket it depends on (ASS-355),
  or gone from the sprint), while an
  assignment is on its variation is left running until that ends — logged
  once, `waits until its agent finishes` — so its agent is never killed
  mid-step (ASS-349). Control matches the VMs to this once per
  loop (`src/control/vm-lifecycle.js`), so a move by hand in the TUI is
  followed; `move_to` and the TUI do nothing of their own.
- **Only while a step works in it (ASS-418).** A client project's VM holds its full
  configured memory (about 10 GB) while it runs, so a ticket only waiting
  holds none: every step whose work does not run in the VM says
  `"vm": "stopped"`, overriding its group's `running` (the deepest setting
  decides). Stopped: forge reads and polls (Await Sequential Merge;
  grouped-merge's Check Reviewed at Head, Mark Reviewed, Take out of Draft
  Mode, Check the Merge Requests, Check the Feedback Round and Ensure
  Auto-Merge; Document's Check Merge Request Details), host steps and host
  agents (Blocked's Classify and Check on the Latest Master; Requirements
  Changed's Verdict; Plan's Ask the Operator About the Plan; every step of
  Self Healing's `self-healing-fix`), and people (Plan's Awaiting the Plan
  Answer, Review's Payment Gate and Variation Selection). Blocked's waits
  (Await the Fix, Await Rate Limit, the fix merge request's waits) and a
  project Release's (Team Code Review) already ran stopped, under Blocked's
  and Release's own setting. A step keeps the VM running when:
  - it runs in it (`run-location: vm`): every agent of Plan, Build, Test,
    Document and Review, Address Merge Request Feedback, the repairs and
    Troubleshoot, Automated Testing and CI Checks;
  - its command reaches it (`limactl`, `in_project`, a `vm:` command): Setup's
    Create VM and Mark Setup Complete, Build's Refresh the Reference
    Repositories (both), Check Numbered Files, Blocked's own-branch checks,
    Add the Missing Repository and Verify the Repaired Image, and Check First
    (it re-runs the blocked check, which may be a VM one);
  - an exit condition probes it (`vm:setup-complete`): Check Setup Complete,
    Find Where to Troubleshoot, Find Where to Repair the Project;
  - it finishes at once and every way on is a step that needs it, so
    stopping would only start it again seconds later: Blocked's Count the Fix
    Attempts and Plan the Obstacle Fix, Plan's two Record the Objections.

  `test/workflow/vm-use.test.js` lists every step of every grouped engine
  (each engine harness-development-grouped, harness-development-v2 or the
  example project's two grouped top-level engines runs, shared ones
  included) with whether it needs the VM by these rules and the setting it
  runs under, and fails on a step that leaves the VM running without needing
  it — a step added later under a running group without a setting included.
  The v2 copies say the same (v2-document's Check Merge Request Details,
  v2-review's Human Review, Payment Gate and Variation Selection), and
  v2-local-testing's Await the Golden Build, a wait on the host, stops it too.
  Leaving a step for one that needs the VM, the lifecycle starts it again and
  the step waits for it (`awaitsVm`, ASS-387), no step re-run and no visit
  spent; a VM with an agent at work is still left till it ends (ASS-349).
- **Rate limited, no API fallback (ASS-400).** While a project's Claude kind
  is rate limited (its `rate-limit.json` entry's `resets-at` still ahead) and
  dispatch has no API fallback for a variation's next agent (no `.claude-api`
  for a host step, a VM not holding both credentials, an API cap hold, or the
  API key limited too: `state.js` `payWith`, the rule `dispatch.js`
  `paymentFor` uses), the VM of each variation whose deepest step is a prompt
  step is stopped, logged `stopped (…; rate-limited until <time>, no API
  fallback)` — one with an assignment on it left until that ends (ASS-349).
  A script step (in the VM or not) and a human step follow their `vm` setting.
  The variation waits as for a slot: its steps are not judged, and the VM-up
  ceiling never sends it to Blocked. Its VM counts towards no memory hold
  (ASS-398), and its Health reads `Waiting for the rate limit to reset at
  <time> (no API fallback)` — it is at no blocked step, so never Operator
  Needed — cleared once the wait ends. When the limit resets, or a fallback
  becomes available, the VM is started again as its step says; no step is
  re-run and no visit spent.
- **Out of memory (ASS-398, ASS-404).** Before control starts or creates a
  VM (the lifecycle's `vm:start` / `vm:create`, or Setup's Create VM step) it
  reads macOS's own memory signal (`src/control/host-memory.js`, at most every
  10 seconds): the free percentage (`sysctl kern.memorystatus_level`) and the
  pressure level (`kern.memorystatus_vm_pressure_level`: normal, warn,
  critical). A new VM's need is what the project's running VMs really use —
  the largest resident size of their Virtualization framework VM processes,
  matched to their Lima instances — plus harness.json's
  `memory-free-margin-gib` (2), at least `memory-need-floor-gib` (4) and at
  most the VM's configured `memory:`; with none running, the floor.
  (`memory-free-hold-gib`, when set, is the need instead.) Which rule
  decides depends on the pressure (ASS-422, `memoryVerdict`): under
  **normal** pressure the VM is held while macOS's free memory is below the
  need, and with room nothing is held; under **critical** pressure it is
  always held; under **warn** pressure — which reflects how full macOS's
  compressor is rather than exhaustion, and is near-constant with several
  VMs running — it starts when the memory macOS can reclaim without swapping
  covers the need and macOS has not swapped since the previous reading, and
  is held otherwise. The reclaimable memory is `vm_stat`'s free + inactive +
  speculative + purgeable pages times its page size (read from its header,
  not assumed); swapping is `vm_stat`'s `Swapouts` grown since the previous
  reading. With no previous reading to compare (control just started) it is
  held, unless `sysctl vm.swapusage` shows no swap in use, and the next
  reading 10 seconds later decides. Under warn, the VMs the hold let start
  under the same reading are counted against the reclaimable memory. The
  log, the Health and the records say which rule decided, e.g. `pressure
  warn, 14.2 GiB reclaimable ≥ 6.6 GiB needed, no swap-outs since the last
  reading: started` or `pressure warn, swapping (120 swap-outs since the
  last reading): held`. A held VM's
  variation waits as for a slot — its steps not judged, no failure counted —
  and holds no planning or in-progress seat meanwhile (`plan.js`
  `memoryHeld`). The hold is logged under `hold` with macOS's
  figures, the need and how it was estimated, and the VM held, and recorded
  in the project's `memory-hold.json` (the header's "Out of memory" flag;
  with `reclaimable-bytes`, `swapouts`, `swapping` and the `rule`, ASS-422).
  It lifts by itself once there is room; the held variations take a seat
  again in rank order, no step re-run and no visit spent.
- **A seat only when its VM fits (ASS-420).** Before control gives a
  variation a planning or in-progress seat — a move into one (`moves.js`
  `mayMove`: Committed into Setup, a finished plan on to Build) or a seat
  coming round to one already at a seat-taking step — whose next steps need
  a VM that is not running (its step's `vm` is `running`), it checks the VM
  fits (`src/control/seat-memory.js`, a phase each tick before the VM
  lifecycle) by the memory hold's own verdict over the same reading
  (ASS-422: `host-memory.js` `memoryVerdict`, so a seat is never given to a
  VM the hold would then refuse, nor refused one it would start) — free
  memory under normal pressure, reclaimable memory and no swapping under
  warn, never under critical — at least the need (`host-memory.js`
  `vmNeed`) on top of the VMs already starting for seats so given. One that
  does not fit takes no seat: it waits as for a slot —
  its VM not started, no move, no ticket-system status change, no visit
  spent — listed in the project's `memory-wait.json` (`plan.js`
  `memoryWaiting`: no 💺 on the dashboard; with the free and reclaimable
  figures and the rule that refused it, ASS-422), its Health `Waiting for
  memory for its VM (need X GB, Y GB free)` — under warn `(need X GB, Y GB
  reclaimable, pressure warn)`, or `macOS swapping` — cleared once it gets
  its seat. Seats
  go in rank order, and one that does not fit does not block a lower-ranked
  one that does (its VM already up, say); a variation whose VM is running,
  or whose next steps need none, takes its seat as before. It is weighed
  again every tick, so the seat is given once memory frees up. This
  replaces ASS-404's rule that, while the hold was on, a freed seat went
  only to a variation whose VM was up; the memory hold stays the safety net
  on VM starts.
- **What a running VM costs (ASS-421, findings in
  `docs/ASS-421-vm-memory.md`).** A vz VM can't give memory back to the Mac:
  Lima (2.2 and 2.3) attaches Apple's balloon device but never sets its
  target, has no template key or command for it, and the device offers no
  free page reporting. Dropping the guest's page cache alone frees nothing on
  the Mac. So every golden image's kernel boots with `init_on_free=1` (the
  shared `memory.sh` step, an input of every image): freed guest pages are
  zero, and macOS compresses a zero page to almost nothing. The saving shows
  in macOS's free memory and pressure, not in a VM's footprint (which counts
  a compressed page whole), so the need above is unchanged and more VMs fit
  under it. The cost is that each VM start touches its whole `memory:` once,
  as zero pages. No cache drop between steps: a VM between steps that need
  none is stopped (`"vm": "stopped"`, ASS-418), which frees it all. A
  client project's build and test run peaks at about 8 GiB (ASS-141), so its 10 GiB
  stays; the other projects keep 4 GiB.
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
- **Waiting for a VM (ASS-133, ASS-159, ASS-348, ASS-387, ASS-464).** A step
  that runs in the VM is not judged while control has not yet seen the VM up
  (Running and reached by a probe). While control is starting it — the start
  queued behind the project's other VM jobs, under way, or failed and to be
  tried again after its backoff — that wait lasts until the VM is up, logged
  "waits for its VM <vm>'s start, queued/under way N s"; only a VM nobody is
  starting (the disk hold on) is waited for at most 2 minutes, then the step
  is judged as it stands, logged "not running after 2m and not starting
  (<why>): judged as it stands". So a ticket Resolved from Blocked for Human
  onto Build, its VM stopped there, has Build wait for the VM's start however
  long it takes. An agent is never dispatched into it until it is up, however long that
  takes: one sent in before `vm:start` has written its credentials fails "Not
  logged in" and spends a try. Its wait is logged once. A VM still not up
  after `vm-up-ceiling-seconds` in harness.json (default 1800: 30 minutes)
  sends its variation to Blocked, or to Blocked for Human from Blocked. The
  variation's ai-feedback names the VM, says it never came up, and gives its
  last failed start, if any.
- **On a workstation instead (ASS-435).** A variation placed on a GCP
  workstation (below, "A ticket variation on a GCP workstation") has no VM:
  none of this section's starts, stops, deletes or memory holds apply to it;
  control keeps its workstation connected and its folder readied instead.
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
- **Held for the operator (ASS-427 AC7).** Control stops a VM wherever its
  step does not say `vm: running` — Blocked for Human, a paused ticket, one
  worked by hand — so a VM the operator started there to fix something by
  hand was stopped again within seconds. `vm:hold <p> <ticket> <variation>
  on [<note>]` writes the variation's `vm-hold` ({ by, since, note }) and the
  lifecycle keeps its VM running whatever else says not, as it does one an
  assignment is on, and starts (or recreates) it when it is not running, by
  the disk and memory rules of any start; `vm:hold … off` removes it, and its
  step's rules apply again (stopped, where they say so). Each is logged in
  the variation's change log, and control logs the hold once as it begins
  ("held running for the operator (…)") and once as it is released. The TUI
  shows "VM held" on the ticket (its details and its panel) and offers
  "Release its VM" there.

## A GCP workstation's connection (ASS-433)

A project whose `dev-environments` lists workstations (ASS-431) reaches each
one over a single long-lived SSH connection: every new connection through
Google's workstation tunnel needs a live Google token, an open one does not,
and the operator's gcloud login lapses after about 16 hours. The commands
(`src/agent-cli/workstation/*.sh`, `src/agent-cli/workstation.bash`):

- **`workstation:connect <project> <id>`** — under the workstation's lock
  (two connects never race: the second finds the first's connection), starts
  it when it is stopped (`gcloud workstations start`, about 80 seconds; one
  stopping or starting is waited for) under its `gcloud-config`'s
  `CLOUDSDK_CONFIG`, then opens one OpenSSH master: `gcloud workstations ssh
  <id> … --ssh-flag=-M --ssh-flag="-S <socket>" --ssh-flag=-N` with
  `ExitOnForwardFailure=yes` and a `-R 127.0.0.1:<port>:127.0.0.1:<port>` for
  harness.json's `forwarder-port`, project.json's `hindsight.port` and
  `registry.port`: the forwarder, Hindsight and zot appear at the same ports
  on the workstation's loopback alone, and nothing new listens on the Mac.
  The socket is `~/.harness/workstations/<project>-<id>.sock` (0700 folder);
  the master runs in a session of its own, so it outlives the command and
  control. `gcloud workstations ssh` rather than `start-tcp-tunnel` as a
  ProxyCommand: start-tcp-tunnel has no stdin mode, only a local port, so it
  would be a second process; gcloud's ssh is tunnel and master in one.
  Prints the live data entry with `started`.
- **`workstation:status <project> <id> [--connection]`** — whether the
  connection answers (its master, and a `true` run over it within 20
  seconds) and, without `--connection`, the workstation's state from
  `gcloud workstations describe`.
- **`workstation:ssh <project> <id> [--] <argv…>`** — argv run on the
  workstation over the connection (stdin, output and exit code passed
  through; 255 when none is open: it never opens one of its own). Bash code
  calls `workstation_ssh <project> <id> <argv…>` (or `workstation_rsh` for
  `rsync -e`); control's `src/control/workstation-connection.js sshArgv(env,
  project, id, argv)` gives the same `ssh -S <socket> -o ControlMaster=no -o
  BatchMode=yes -o ProxyCommand=false workstation-<id> -- <quoted argv>`,
  which the workstation machine backend (ASS-435) spawns.
- **`workstation:disconnect <project> <id>`** — the master ended; the
  workstation is left to stop itself (30 minutes with no SSH session).

Live data, never project.json: `data/projects/<project>/workstations.json`,
`{ "<id>": { state, state-at, connected, connected-at, checked-at,
disconnected-at, started-at, forwards, last-error: { at, kind, message } |
null, control-pid } }`, kind `expired`, `offline` or `unknown` as
`src/control/login.js` reads gcloud's output (ASS-429), the message with any
token redacted.

Who owns a connection (ASS-470): `control-pid`, the pid of the control it
belongs to, or null for one opened by hand. Control runs every `agent.sh`
with `HARNESS_CONTROL_PID` set to its pid, and every command those run
inherits it, so a connection opened by control's own phase and one opened by
a command it ran (`vm:create`, a step's `workstation:claim`) are both its
own. `workstation:connect` records that pid before it starts or opens
anything (a control exiting meanwhile still finds it its own), takes an open
connection as its control's unless another running control owns it, refuses
to connect for a control that has exited and closes a master it opened after
its control exited; run from the operator's shell it records null for a new
master and for an open one no running control owns. `workstation:disconnect`
clears it. Whenever control exits — the dashboard's stop, a restart (exit
75), SIGTERM, SIGINT, SIGHUP, an uncaught exception (70), unreadable data
(69) — it closes every connection it owns, each `workstation:disconnect` run
detached so the supervisor's SIGKILL after 20 seconds cannot cut it short
(process `exit` starts any still owned, whatever the way out; a stop waits
at most 8 seconds for a tick under way). A connection another running control
owns, and one opened by hand, are left alone. A control killed outright
(SIGKILL, a crash of the Mac) closes nothing; the next control, at its
start and before its first tick, closes each connection of its projects whose
`control-pid` names no running control, logging it. A hand-opened connection
nothing needs is still closed by a running control's idle disconnect.

Control (`src/control/workstations.js`, beside the VMs in phase 3) keeps a
workstation connected while something needs it: a step of a ticket
variation running on it or waiting for it, a holder whose step is to be
ended, a `vm:hold` on it, or (ASS-469) its seat — held by a ticket in
progress, between its steps too, or free while a ticket waits for a seat or
sits in a VM seat to move into it, or lost while tickets in progress would
take it (so its connect is retried). It checks the connection every minute
(`workstation:status --connection`; gcloud's ssh sends no keepalives) and
reconnects one that dropped, or whose workstation stopped (starting it),
logging each. Once nothing has needed it for harness.json's
`workstation-idle-disconnect-seconds` (300) it disconnects, and it closes
the connections it owns as it exits (ASS-470, above). A failed connect is retried after
the usual backoff. One that failed because the workstation's gcloud login
needs reauthentication sets the project's `gcloud-requires-reauthentication`
(a network failure never does), logs and shows in the TUI the login to run —
`CLOUDSDK_CONFIG=~/.config/example/gcloud gcloud auth login` — is retried
every 2 minutes at most, and clears the flag once a connect works; nothing
is dispatched to the workstation meanwhile (`workstationUsable`).

## A GCP workstation's setup (ASS-434)

Workstations are reused, never built, so a setup script stands in for the
golden image: **`workstation:setup <project> <id>`**
(`src/agent-cli/workstation/setup.sh`) runs
`src/agent-cli/workstation/on-workstation/setup.sh` on the workstation over
its open connection, as its user. Only `/home` survives a Cloud Workstation's
restart, so everything goes under `~/harness`, and only what is missing is
installed (a rerun with nothing missing writes nothing):

- `~/harness/bin` — first on PATH in the harness's sessions: `agent.sh` (a
  wrapper running `~/harness/lib/agent.sh`, the VM's `in-vm/agent.sh`, with
  `AGENT_FORWARDER_URL` from the runtime folder's `agent-url` and
  `AGENT_TOKEN_FILE` its `agent-token`), and `jq` (its static release) and
  `claude` (claude.ai's installer run with `HOME=~/harness/tools/claude`)
  when the workstation had none.
- `~/harness/env` — what the harness's sessions source (ASS-435): PATH with
  `~/harness/bin` first, `HARNESS_RUNTIME`, `DISABLE_AUTOUPDATER=1`, and the
  runtime folder's `env` (the credentials) when there is one, and (ASS-477)
  `DOCKER_CONFIG=~/harness/docker` once that holds a config. The owner's
  shell files, git identity, SSH keys, `~/.docker` and `~/workspaces` are
  never touched.
- `~/harness/bin/docker-credential-harness` and `~/harness/docker` (ASS-477)
  — the agents' own Artifact Registry pulls as the workstation's service
  account (below, "The agents' own pulls").
- `~/harness/setup.json` — `{ version, boot-id, runtime }` of the last setup
  that completed.
- `~/harness/golden-image` — the project's `workstation-tools.sh` and the
  golden-image files shipped beside it (ASS-462), written afresh each time it
  runs.
- The runtime folder, `/dev/shm/harness-<uid>` (`/tmp/…` without a writable
  `/dev/shm`), 0700, the workstation's `/run/harness`: `agent-url`
  (`http://127.0.0.1:<forwarder-port>/run`, the connection's reverse
  forward), and ASS-435's `agent-token` and credentials. Emptied whenever the
  workstation has started since the last setup (its boot id changed), never
  otherwise.

git, curl and base64 are checked (the workstation config's image must have
them), Docker is checked (`docker info`; it is the config's to give), and each
of project.json's `golden-image.tools` must be on PATH: the missing ones are
handed to the project's optional `golden-image/workstation-tools.sh` (run in
`~/harness/tools` with `HARNESS_BIN` and `HARNESS_TOOLS` set and the tools as
arguments, to install them under `$HOME`; not an input of the golden image),
then checked again. Anything missing or unusable fails setup, each named.

ASS-471: so is every command the project's CI checks need, so a missing one
shows at setup rather than as a ticket's CI Checks step exiting 127 (Blocked):
the first word of each simple command in each check's `command` in the
golden-image `ci-checks.json` (`src/agent-cli/ci-check-commands.js`: past
`NAME=value` assignments, keywords such as `if`/`do`/`!`/`exec` and
redirections; not bash builtins such as `export`, nor a path such as
`scripts/ci/x.sh`, nor a word holding `$`, a backquote or a glob), and each
name a check declares in its optional `"needs": ["sqlfluff", …]` — commands
its scripts are known to run that its command line does not show. The missing
ones go to `workstation-tools.sh` with the missing tools; one still missing
fails setup naming it and the checks that run it, e.g. `example-static-policy-gate:
not on the workstation, and the project has no golden-image/workstation-tools.sh
to install it under $HOME; ci-checks.json's static-policy-gate (example-project,
example-corpus and 24 more) needs it`. A `ci-checks.json` that is not JSON
fails setup (and `--version`), naming it.

So `workstation-tools.sh` can source a file it shares with `provision.sh`
(ASS-462) — `. "$(dirname "$0")/<file>"`, no copy — the golden-image folder's
other top-level regular files are shipped beside it to
`~/harness/golden-image`: not dotfiles, subfolders, nor the Lima- or test-only
`provision.sh`, `template.yaml`, `warm.sh`, `images.txt`, `tests.json`,
`run-test.sh`, `ci-checks.json`. A name that is not a plain file name fails
setup before anything is sent. Without a `workstation-tools.sh` nothing is shipped.

The setup's version is the sha256 of the two scripts, `agent.sh`,
`workstation-tools.sh`, the forwarder URL, the tools list, (ASS-471) each
command the CI checks need with the checks needing it, and each shipped
file's name and sha256
(`workstation:setup <project> <id> --version` prints it without a
connection). It is recorded on the workstation (`setup.json`) and in the live
data, `workstations.json`'s `setup`: `{ ok, version, checked-at, set-up-at,
home, runtime, did, failed: [{ what, why }], error }`.

Control (`src/control/workstations.js`) runs it after every connect and
whenever the version it asks at each minute's check differs from the live
data's. `workstationUsable` — what ASS-435's placement asks — wants the setup
ok and checked since the connection opened, so nothing is dispatched to a
workstation before it is set up. A failed setup is logged naming what
failed, retried after the usual backoff (at once when the version changes),
and shown in the TUI as a `Workstation <id> setup failed` chip; in
`vm+workstation` mode steps run on their variations' VMs meanwhile (ASS-468).

### What a grouped client project's provision.sh installs, and how each reaches a workstation (ASS-471)

The client project's VMs (`vm+workstation` mode) get their tools from
`data/projects/<project>/golden-image/provision.sh`
(arm64); its workstation (its config's image: Ubuntu 24.04, x86_64) gets each
from the workstation config's image, from setup itself, or from the project's
`golden-image/workstation-tools.sh` (under `~/harness/tools`, linked into
`~/harness/bin`). Change one side, check the other: a tool added to
`provision.sh` that a check or an agent needs on the workstation needs a line
here and, when the image lacks it, an install in `workstation-tools.sh`.
Found on its workstation on 2026-11-16.

| provision.sh installs | On the workstation | Checked by setup |
|---|---|---|
| ca-certificates, gnupg, openssh-client | image | — |
| curl | image | always (ASS-434) |
| git (>= 2.48, the shared git.sh) | image | always (ASS-434) |
| jq | image (setup installs its release when missing) | always (ASS-434) |
| Docker Engine, buildx, compose | image (the config's; never installed) | always (`docker info`) |
| Node 24, npm, corepack | image | — |
| pnpm (corepack) | image | golden-image.tools |
| kustomize, kubectl, kubeconform, conftest, yq | image | golden-image.tools |
| gitleaks | image | golden-image.tools |
| promtool, go (gofmt) | image | golden-image.tools |
| shellcheck, bats | image | golden-image.tools |
| glab | image | — |
| Claude Code CLI | image (setup installs it under `~/harness` when missing) | always (ASS-434) |
| example-static-policy-gate | `workstation-tools.sh` (a copy of provision.sh's, its CI repository found at `$HARNESS_VM_ROOT/repos/<its CI repository>`) | ci-checks.json (its static-policy-gate checks) |
| uv | `workstation-tools.sh` (astral.sh's installer, `UV_INSTALL_DIR=~/harness/tools/uv/bin`) | — (every run of `workstation-tools.sh` makes sure of it) |
| sqlfluff 4.2.2 | `workstation-tools.sh` (`uv tool install sqlfluff==4.2.2`, its Python uv's own, all under `~/harness/tools/uv`) | — (likewise; a check's `"needs": ["sqlfluff"]` would check it) |
| postgresql-client (psql) | not on the workstation: no CI check runs it; tests run it in the dev container | — |
| @devcontainers/cli (devcontainer) | not on the workstation: no CI check runs it | — |
| `sh`, `bash` | image | ci-checks.json (secret-scan-mr, validate-mr, flux-bundle-validate) |

`workstation-tools.sh` lives in `data/` (live data, not in git), as
`provision.sh` does; it installs each command setup hands it that it knows,
says any it does not (exit 1, so setup names it), and at every run makes sure
of uv and sqlfluff (only when missing; sqlfluff also when not 4.2.2).

## A ticket variation on a GCP workstation (ASS-435)

In `workstation` and `vm+workstation` modes (ASS-431) a ticket variation's
steps run on one of its project's workstations instead of a VM of its own,
everything else as in a VM. ASS-468 (below) changed how long a variation
holds one: a step at a time, not from Create VM until Done.

- **Create VM.** Setup's Create VM (`vm:create`) records the pool on the
  variation, claiming nothing: the first workstation in list order whose
  gcloud login is live (connected and set up first when no setup has
  recorded its home yet), by `ticket:set-vm … --kind workstation --folder
  <home>/harness`: `vm { name: <id>, kind: workstation, project, folder,
  created-at }`. With none usable, `vm+workstation` falls back to a VM;
  `workstation` mode fails, naming why. Check Setup Complete and Mark Setup
  Complete read and write the variation's `vm.setup-complete-at` (the
  workstation's repositories are every variation's), Mark Setup Complete
  only once the workstation's setup is ok. `vm:create … --vm` makes or
  reuses the variation's VM whatever the mode (ASS-468's fallback).
- **The shared root.** `<home>/harness` on the workstation, never the
  owner's `~/workspaces`, stands in for a VM's root: `repos/` (the shared
  repositories), `ticket/` (the holder's ticket folder's read-only copy;
  `mnt/ticket` links to it) and `run/harness` (a link to the setup's runtime
  folder). The machine layer (`machine-workstation.bash`,
  `machine-workstation.js`) names it `workstation:<project>:<id>:<home>/harness`
  and runs each command there over the workstation's connection with
  `HARNESS_VM_ROOT` the root, its workdir mapped (`/` the root, `/repos…`,
  `/run/harness…` and `/mnt/ticket…` under it) and `~/harness/env` sourced;
  a marker works as in a VM, so `stop()` ends an agent there. While a step
  holds the workstation the variation records it as its `workstation` `{
  name, project, folder, since }`, which is its machine then (`machine.js
  machineOf`, `machine.bash $machine_of`), whatever its `vm` says.
- **Readied as a VM is**, at each step's claim (`wsv_start`):
  `vm:credentials` sends the same contents over the connection into the
  runtime folder (`env`, its paths the runtime folder's —
  `GIT_CONFIG_GLOBAL=<runtime>/gitconfig` and so on — `gitconfig`, `npmrc`;
  no git identity declared, the gitconfig includes the owner's
  `~/.gitconfig`), a fresh forwarder token goes to `agent-token` and its hash
  and binding to `vm-tokens.json` under the machine's name, the ticket's copy
  is brought up to date, and, once per boot of the workstation
  (`images-boot-id`), the project's images are pulled there, Artifact
  Registry first, zot the fallback (ASS-472, below). Its credential kind is
  recorded on the holder, its stamps by `vm:credentials`.
- **Agents.** Dispatched over the connection (`ssh -S <socket> …
  workstation-<id>`) in the root's `repos/`, under a marker; told where they
  are (`on the GCP workstation <id>, in its shared repositories under <root>,
  checked out on this ticket variation's branches for this step`),
  `{ticket-folder}` the copy, their memory at `127.0.0.1:<hindsight.port>`
  (the forward; a VM's is `host.lima.internal`). The ticket copy is pushed as
  each agent starts, and the forwarder pushes it again after every call it
  runs for a workstation binding, before the call returns, so an agent reads
  its own writes; its calls are authorized against their binding exactly as
  a VM's. A workstation's agents take none of the Mac's memory: no memory
  hold or seat check for them.
- **Isolation.** None of a VM's: no macOS sandbox or pf rules, and agents act
  as the workstation's user — on the test workstation with the operator's
  own git identity and GitLab key where the project declares none (accepted,
  2026-11-14).

For ASS-436's footer: a workstation's agents are the assignments on its
holder's variation (`workstations.json`'s `holder` ticket and variation),
and its state `workstation-machines.js workstationState(entry)`: `running`,
`stopped`, `connecting`, `sign in needed` or `setup failed`.

## A workstation's images (ASS-472)

A workstation pulls its project's images straight from Artifact Registry in
its own region: a project's first pull through zot on the Mac (the SSH
reverse forward, ~8 MB/s, 41 images, ~15 GB) took over an hour and loaded
the Mac's USB drive and tunnel. Once per boot of the workstation
(`images-boot-id`; Docker's data, `/home/.docker_data`, persists across
restarts), at a step's claim, `wsv_pull_images`
(`workstation-variation.bash`) sends
`src/agent-cli/workstation/on-workstation/pull-images.sh` over the
connection with every image of the golden image's `images.txt` under the
project's `registry.upstream` host — digest-pinned ones too, where before
only those by tag were pulled (comments, blank lines and other registries'
images passed over) — and it pulls each in turn:

1. **A local rebuild in zot**, when the image is by tag alone and zot holds
   `0local/<path>:<tag>` (`registry:push`'s): from `127.0.0.1:<registry.port>`
   (the forward) and tagged as named, winning over Artifact Registry's as a
   VM's `hosts.toml` makes it win there — so a rebuild, under a tag Artifact
   Registry lacks or its own, reaches the workstation (AC2).
2. **Else straight from Artifact Registry** under its own name, as the
   workstation's **service account**: its token from the metadata server
   (`computeMetadata/v1/instance/service-accounts/default/token`), asked
   before every pull and written to a Docker config of the run's own
   (`DOCKER_CONFIG`, a 0700 temp folder removed at the end). Never a token
   from the Mac, and never the owner's `~/.docker/config.json`. Found on
   the test workstation, 2026-11-16 (read-only): its service account (scope
   `cloud-platform`) gets a token and pulls from the project's Artifact
   Registry in `us-central1-docker.pkg.dev`; the operator's
   own gcloud there (the owner's Docker config's `gcloud` credential helper)
   needed reauthentication — it lapses with Workspace session control — so
   it is not used.
3. **Only when that fails, through zot** as before ASS-472
   (`127.0.0.1:<port>/<path>:<tag>`, or `@<digest>` for a pinned image: zot
   syncs it from Artifact Registry with the Mac's login), tagged as named
   when it has a tag, Artifact Registry's error logged as the why. An image
   that fails both ways leaves the workstation the one it has.

`docker pull`'s own check keeps an image already there at the same digest
from being downloaded again. Each pull is logged (`vm:start: workstation
<id>: pulled <image> from Artifact Registry in 4s (downloaded)`, `… through
zot in 12s (up to date): <why>`, `could not pull <image> (…): <why>`), then
the run's counts; the workstation's live data (`workstations.json`) records
the last run as `last-image-pull` `{ at, boot-id, seconds, from-registry,
from-zot, failed, up-to-date, missing, zot: [{ image, why }], failures: [{
image, why, present }] }` (with `error` when the session itself failed; the
images are then tried again at the next claim).

**Retries, and a missing image (ASS-473).** 2026-11-15, a ticket's
placement logged "httpReadSeeker: failed open: failed to do request" and
went on without its images. Now each source's pull is tried 3 times,
waiting 5s and then 10s between tries (`HARNESS_WS_PULL_RETRY_SECONDS`, for
the tests), each retried failure logged — except when the source says it
has no such image (`manifest unknown`, `not found`), which another try
would only repeat. An image that still fails every way is then looked for
in the workstation's Docker (`docker image inspect`: by name, at its pinned
digest, or under zot's name for a tag-less pinned one):

- **There, at an older version: a warning**, as on a VM (`… the workstation
  keeps the image it has`); the claim goes on and the boot counts as pulled.
- **Not there: the step's claim fails** — `workstation:claim` exits 5, its
  last line naming each missing image with its error; the workstation is
  given back (its holder cleared, the variation's `workstation` removed),
  `images-boot-id` is not recorded, so the next claim pulls again. Control
  (`workstation-steps.js`) tries the claim again after the usual backoff
  (30s, doubling), the variation's Health meanwhile `Waiting for its
  workstation: <id> lacks images its step needs, which could not be pulled:
  <image> (<error>) …`, cleared once a claim succeeds. The workstation stays
  usable, so its seat stays the ticket's (ASS-469: a seat is lost only for
  a login to renew, a failed setup, or a workstation that cannot be
  reached). No agent of the step starts meanwhile.

VMs are unchanged: `vm:start` in a VM still warns on a failed pull (a VM's
golden image already holds every image, ASS-70).

**The agents' own pulls (ASS-477).** Pulling `images.txt` at a claim is
not all: a step's agents pull too (`docker pull`, `docker compose up`,
devcontainer builds), and with the owner's `~/.docker/config.json` the
Artifact Registry host went to the owner's `gcloud` credential helper, whose
login on the workstation lapses every few hours — those pulls failed. So the
harness's sessions use a Docker config of their own:

- `~/harness/bin/docker-credential-harness`
  (`src/agent-cli/workstation/on-workstation/docker-credential-harness`,
  shipped and installed by `workstation:setup`, part of its version) — a
  Docker credential helper whose `get` answers
  `{"Username":"oauth2accesstoken","Secret":<token>}` with the workstation's
  service account's token, asked of the metadata server at every call (no
  token is kept, written or printed; `store`, `erase` and `list` keep
  nothing).
- `~/harness/docker` (0700), written by the helper's `configure <host>` for
  the project's `registry.upstream` host: the owner's `config.json` as it is
  (other registries' `auths`, `credsStore`, the owner's `credHelpers` for
  other hosts, `currentContext`, …) with `credHelpers[<host>]` set to
  `harness` and any `auths` entry of that host dropped, and a link to each
  other entry of `~/.docker` (`contexts`, `cli-plugins`, `buildx`…) so a
  context or a per-user compose plugin is found; a link to an entry the
  owner removed is removed. Made at each setup and again at each step's
  claim (`wsv_start`; a failure there is a warning, the last config kept), so
  the owner's changes reach the next step. The owner's `~/.docker` is only
  read. `~/harness/env` exports `DOCKER_CONFIG=~/harness/docker` once it
  holds a `config.json`, so the owner's own sessions never see it; a project
  with no upstream gets none (a setup removes one left over).

Setup checks the helper gets a token for the host, and fails naming it
when it does not (`docker-credential-harness: gets no token for <host>: …`).
`pull-images.sh` keeps its own temp config for its Artifact Registry pulls.

## A workstation held one step at a time (ASS-468)

Operator decision, 2026-11-15: a GCP workstation is held only while one of
a ticket variation's steps runs on it, so a ticket waiting — Blocked, waiting
for a slot, waiting on a fix — never keeps it from the others (under ASS-435
one ticket held a project's only workstation for a day, mostly Blocked,
while every other ticket of the project went to a VM). Every step leaves the repositories clean on
master with the latest pulled, so the workstation keeps one shared set,
`~/harness/repos`, every variation uses in turn: cloned once (as `vm:create`
clones) and kept across steps and restarts (`/home` persists), never a
folder per variation.

- **Which steps.** A step whose work runs on the variation's machine,
  top-level or a sub-engine's (`workstation-steps.js machineWork`): a
  `run-location: vm` prompt or script (Generate Solution's agents, CI
  Checks' `ci-checks:verify`), or a host script that works in the machine
  (`vm:refresh-repositories`). No other step needs or waits for a workstation.
- **The claim (AC1, AC2).** Before such a step's agent is dispatched or its
  script started (`stepWaits`, asked in `dispatch.js` once every other gate
  has passed, and in `steps.js` before the script runs), control's
  workstation job (`tendSteps`, beside the tick) claims a workstation for
  that step — its visit, so a step left and come back to is another —
  through `workstation:claim <project> <ticket> <variation>`: under the pool
  lock the first workstation that is free (no holder) and usable now
  (connected, its login live, set up since) becomes the variation's (the
  holder `{ ticket, variation, folder: <home>/harness, since, … }`, the
  variation's `workstation`); it is readied (above), and the shared
  repositories are fetched and checked out on the variation's branches
  (`step-trees.sh start`): each repository with an entry of the merge-request
  plan not Merged or Closed on its branch (`change/<KEY>-<id>`: the local one
  fast-forwarded to GitLab's, else GitLab's, else made from the entry's
  planned `base` — origin's default branch without one — when GitLab has
  none yet); every other on master at the latest; and each repository's git
  hooks refuse a commit on master (AC10, below). One holder
  per workstation; two variations never hold one at once. A step's parallel
  agents share its claim.
- **Every step commits its own work (AC9).** Each prompt of a step that
  changes code commits and pushes it on the ticket's branch before it
  finishes: Generate Automated Tests and Enrich Automated Test Data commit
  their tests and test data on the merge request's branch themselves (made
  from origin/<base> when it is not on origin yet), Generate Solution and
  Address Merge Request Feedback commit everything and push before they
  finish (Update Documentation did already). Nothing is carried between
  steps: uncommitted work is only ever the leftover of a step that did not
  complete.
- **Never a commit on master (AC10).** `git-hooks.sh` makes each repository's
  hooks folder `<git-dir>/harness-hooks` (`core.hooksPath`): a wrapper for
  every hook git runs, each running the repository's own hook from the
  folder it named before (kept as `harness.chained-hooks-path`) or its
  `.git/hooks`, so its own hooks keep working; `pre-commit` and
  `pre-merge-commit` first refuse a commit while HEAD is the default branch
  (`harness.default-branch`), naming the ticket's branch to use
  (`harness.ticket-branch`: the planned one, else `change/<KEY>-<id>`). Set
  at every claim on the workstation, at `vm:create` and `vm:step-start` in a
  VM; idempotent.
- **The end (AC3, AC9, AC10).** Once nothing of the step uses the machine —
  no assignment of a machine step on the variation, no live agent of it,
  none being dispatched, no script of the step running — whatever the
  outcome (success, failure, stop, the agent killed), control runs
  `workstation:release <project> <id> --force [--completed <step>]`
  (`step-trees.sh end`, then the cleanup). The step completed when its
  agent's turn ended without error (`finish.js` → `stepCompleted`) or its
  script exited 0 (`usingMachine`); anything else — a failed or killed agent,
  a stop, a script failing — did not. In every repository what is not
  committed (changes and untracked files, never the ignored dependency and
  build caches) is, for a completed step on a branch other than master,
  committed there with a message naming the ticket and the step and pushed,
  logged as a warning (`warning: <KEY> <v>: its step completed but left …
  uncommitted on …; committed and pushed by the harness (<files>)`); else
  discarded (`reset --hard`, `clean -fd`), each file logged per repository.
  Then each of the variation's own local branches' commits GitLab lacks are
  pushed to that branch (never forced; ASS-480: never another ticket's, set
  aside instead — below); master is never pushed — a local master ahead of GitLab's
  is reset to it, the discarded commits (hash and subject) logged and shown
  on the variation's Health (`Commits on master were discarded: …`) — and
  checked out at GitLab's latest. Only once every tree is clean are the
  step's Docker containers (working in the shared repositories or the ticket
  copy, or mounting them), their anonymous volumes and their compose
  projects' volumes and networks removed, the ticket copy emptied, the
  credentials and token removed from the runtime folder, the binding
  dropped, and the variation's `workstation` and the holder cleared. A tree
  that cannot be cleaned keeps the workstation held, retried after the usual
  backoff. A push that failed (rejected, no access) is logged and shown on
  the variation's Health (`Could not push its committed work: …`), its
  commits kept on the local branch and pushed again at the end of its next
  step.
- **Busy (AC4; since ASS-469, by seat).** Where a step runs follows its
  variation's seat (see "VM seats and workstation seats" below): a
  workstation-seat holder's step claims that workstation
  (`workstation:claim … --workstation <id>`), and waits, its Health saying
  why (held by another, starting — about 80 seconds — being set up, its setup
  failed, its login to renew; AC5), while control connects and sets it up. A
  VM-seat holder's step runs on the variation's VM — ASS-468's "the
  workstation first, else the VM" is gone. A step with no seat kind
  (planning) runs on the VM in `vm+workstation` mode, and in `workstation`
  mode claims any free workstation no seat-holder's step waits for. The VM
  is made by the existing VM path when it has none
  (`vm:create … --vm`, recorded as its `vm` and kept for its later steps),
  and before the step its
  repositories are moved to the variation's branches, their hooks set
  (`vm:step-start`, `step-trees.sh start` there); at the step's end
  `vm:step-end [--completed <step>]` commits, pushes and cleans them the same
  way, so a variation
  moves between its VM and the workstation from step to step without losing
  work.
- **Connections (AC5).** Control's phase keeps a workstation connected
  while a step runs on it, wants it, or a holder is to be ended — and, since
  ASS-469, while its seat is used (below); with no seat-holder and nobody
  waiting, the connection's idle disconnect (ASS-433) and the workstation's
  own idle stop work as before.
- **Leftovers and migration (AC6, AC7).** `workstation:setup` removes the
  per-variation folders ASS-435 made (`~/harness/<KEY>-<variation>`), all
  but the one a holder still records. A holder no step of the running
  control holds — one from before control restarted, or ASS-435's, which
  records its own folder — is released once no machine step's assignment is
  on its variation: its committed work pushed, what it left uncommitted
  discarded (its step did not complete), and, for ASS-435's, its folder
  removed with its containers.

## VM seats and workstation seats (ASS-469)

In a project on workstations every ticket variation in progress (each step
`slotKind` counts as `progress`) sits in exactly one seat: a VM seat or a
workstation seat (operator decisions, 2026-11-15/16). `project.json`'s
`max-tickets-in-progress` is the project's VM seats; each workstation in
`dev-environments.workstations` is exactly one workstation seat (AC9: no
setting). The planner's in-progress limit for the project is its VM seats
plus its usable workstations (`src/control/seat-kinds.js` `seatLimits`;
`vm` mode: VM seats only, as before; `workstation` mode: workstation seats
only), under `harness.json`'s cap as before. Planning seats have no kinds.

- **Recorded.** Control's tick phase (`src/control/seats.js`, before the
  memory check and the VMs) records who holds which seat in
  `data/projects/<p>/seats.json` — `{ seats: [{ key, variation, kind: "vm" }
  | { key, variation, kind: "workstation", workstation: <id> }, each with
  since] }` — written atomically when it changes. The planner keeps those
  recorded seated ahead of the rest, so a ticket in progress never loses its
  seat to a higher-ranked one.
- **Taken.** A variation entering progress takes a free workstation seat,
  else a free VM seat, else waits as before. Logged: `seats <KEY> <v>: takes
  a workstation seat on <id>` / `takes a VM seat`.
- **Preferred, moved between steps.** Whenever a workstation seat is free (its
  ticket done, at a detour, set aside, or the workstation usable again), the
  highest-ranked variation in a VM seat whose step is not running on its
  machine moves into it at that tick, logged (`moves from a VM seat to a
  workstation seat on <id>, between its steps; its VM seat is free for the
  next ticket`); the freed VM seat goes to the next ticket. One whose step
  runs on its VM is passed over and moves at a later tick, once that step has
  ended, if a workstation seat is still free (a newcomer may take the free
  one meanwhile: the workstation is used first). A VM-seat holder's next
  step, while a workstation seat is free, waits for that tick rather than
  start on the VM.
- **Machines follow seats.** A workstation-seat holder's machine steps run on
  its workstation (ASS-468's per-step claim, checkout, commit, push and
  release unchanged), its VM, if it has one, stopped meanwhile and taking
  none of the Mac's memory; a VM-seat holder's run on its VM.
- **No bound seats.** While a workstation can't be used — its gcloud login
  lapsed, its setup failed, its last connect failed (unreachable, or it
  would not start) — its seat is lost (a workstation merely stopped by its
  idle stop keeps it). Its holder is taken out of it, logged and shown on its
  Health (`Lost its workstation seat: …`, cleared once seated again), and
  takes the next free seat of either kind, ahead of tickets not yet in
  progress; a step of it mid-run there finishes or fails as any step does,
  with ASS-468's release. The seat coming back is filled as any freed one.
- **Kept awake (AC6).** Control keeps the workstation started, connected
  and set up while its seat is held, while it is free and a ticket waits for
  an in-progress seat or sits in a VM seat to move, and while it is lost and
  tickets in progress would take it (its connect retried after the backoff);
  with no seat-holder and nobody waiting it lets it disconnect and stop
  itself. A stopped workstation with work for its seat is started at once.
- **TUI.** The sprint screen's seat column shows 💺 for a VM (or planning)
  seat and ⛅ for a workstation seat (the key lists ⛅ for a project on
  workstations); the gcp workstations box shows `seat lost` on a
  workstation that can't be used (ASS-485 dropped the `<used>/1 seats`
  count); the models box, in
  `vm+workstation` mode, `vm seats: <used>/<VM seats>` (∞ with no limit).

## A step's end runs on the machine it ran on (ASS-480)

Seen live on 2026-11-16, the first evening of ASS-468 and ASS-469: a VM was
stopped and later deleted at QA before its last step's `vm:step-end` ran,
and control retried that end against the missing VM every 30 minutes for
ever; and every release of a workstation tried to push another ticket's
local branch left in the shared repositories, the rejection shown on the
releasing ticket's Health.

- **Pending ends (AC1).** Once a step goes on in a variation's VM
  (`vm:step-start`), its end is pending on that VM until `vm:step-end` has
  succeeded: recorded in control's live data,
  `data/projects/<p>/step-ends.json` (`{ ends: { "<KEY> <v>": { key,
  variation, vm, step, completed, since } }, recovered }`,
  `src/control/step-ends.js`), so a restart of control takes it up again as
  a lease in its VM, and the next step of the variation waits for it. The VM
  lifecycle (`vm-lifecycle.js`) keeps such a VM running whatever its step, a
  pause, a wait or a rate limit says — starting it when stopped, never
  stopping it, never deleting it at a `vm: released` step — logged once
  (`vm <p> <vm>: kept and started for <KEY> <v>'s step end ("<step>"),
  pending on it: …`); `vm.bash reconcile_vms` never counts it deletable, so
  `make_room` and `vm:reclaim-all` leave it. The end waits, no failure
  counted, while the VM is not up. Once it has run, the step's own rules
  apply again (a released VM is deleted then).
- **A VM already gone (AC2).** When limactl has no such instance (deleted,
  not merely stopped) the end can never run, and a fresh clone would only
  let it "succeed" on nothing, so the VM is not recreated for it: control
  logs once, as an error, which step's end could not run and that any
  commits that step had not pushed were lost with the VM, naming the
  repositories and branches the variation's plan had; shows it on the
  variation's Health (`A step's end could not run, its VM gone: …`, cleared
  by a later step's end that pushes cleanly); and drops the pending end —
  never retried.
- **Another ticket's unpushable branch is set aside (AC3).** A step's end
  pushes only the variation's own planned branch (ASS-478, which also never
  pushes back a branch GitLab deleted after its merge, and prunes merged
  ones at the claim). Another ticket's local branch it can still push
  itself — ahead of GitLab's, or not on GitLab yet — is left where it is
  for that ticket's next step (ASS-478). But one that has parted from
  GitLab's branch, which moved on since (an earlier step's push rejected),
  could never be pushed as it is (it is never force-pushed): once GitLab's
  branches are fetched its tip is kept under
  `refs/harness/stray/<branch>/<UTC time>` in that repository (out of the
  way of every checkout, never pushed), its local branch deleted so it is
  checked out fresh from GitLab later, and it is listed in the summary's
  `set-aside`. Control logs it as an error and shows it on the Health of
  the ticket the branch names (`Commits of a stray local branch were set
  aside: …`), never the releasing one's.
- **The same at a step's start (AC4).** Before any checkout
  (`step-trees.sh start`: `workstation:claim`, `vm:step-start`) a stray
  local branch of another ticket is set aside the same way; and a local
  branch of the variation's own that has parted from GitLab's with commits
  GitLab never had (ASS-468 kept it as it was) is set aside too and GitLab's
  taken, so a step never starts on stale local commits. One merely ahead of
  GitLab's (a push that failed) is kept, and its end pushes it.
- **Waiting for its VM (AC5).** A step waiting for its VM to be made or to
  start — a VM-seat holder's, or a planning step's, which never uses a
  workstation — says `Waiting for its VM: …` on its Health, never
  `Waiting for its workstation`.
- **The migration.** Before ASS-480 a pending end lived only in the memory
  of the control that ran its step. At the first start with this change,
  each project's control log (`~/.harness/logs/control-<p>.log`) is read
  once for VM step ends that failed and never succeeded afterwards; each is
  recorded as pending and so ended (its VM started when only stopped) or
  dropped as above (its VM gone). A stray branch already in a workstation's
  shared repositories is set aside at its next claim or release.

## Cloud VMs: plain GCP Compute Engine VMs like workstations (ASS-481)

A project's tickets can run on plain GCP Compute Engine VMs ("cloud VMs")
exactly as on its GCP workstations (operator decision, 2026-11-17: a plain
e2-standard-4 costs about a fifth of a workstation). The harness never
creates, resizes or stops one: that is the infrastructure repository's
(the infrastructure repository). Only the machine operations differ; everything else is
the workstation path above.

- **Settings (AC1).** `dev-environments.cloud-vms`, beside `workstations`:
  each `{ id, gcp-project, zone }`, an optional `gcloud-config` (as a
  workstation's, `~` expanded) and an optional `ssh-user`, the Linux (OS
  Login) user — without it, the OS Login user of the gcloud login's account
  (`gcloud config get-value account`, lower case, each character other than
  a-z and 0-9 made `_`: `ada.lovelace@example.com` is
  `ada_lovelace_example_com`). Refused, naming the field, as a workstation is:
  a missing or empty field, an id that is no single name segment or that a
  workstation or an earlier cloud VM has (their live data shares
  `workstations.json`), a bad `gcloud-config`, an `ssh-user` that is no user
  name. `vm+workstation` and `workstation` modes want the remote pool —
  workstations plus cloud VMs — non-empty; `vm` mode uses neither.
  `src/control/dev-environments.js` reads the pool as its `workstations`:
  the workstations first, then the cloud VMs (each marked `kind: cloud-vm`),
  each in list order — so every `workstation:*` command, the claims and the
  seats take a cloud VM's id as a workstation's. A project without
  `cloud-vms` reads exactly as before.
- **The machine layer (AC2).** A third backend, `cloud-vm`
  (`src/agent-cli/machine-cloud-vm.bash`, `src/control/machine-cloud-vm.js`):
  a cloud VM's step runs in its shared root, `<home>/harness`, as a
  workstation's (its machine `cloud-vm:<project>:<id>:<folder>`, from the
  claim's `workstation { …, kind: cloud-vm }` or Create VM's `vm { kind:
  cloud-vm, … }`). Run (workdir, stdin, marker), copy in and out (rsync),
  status and stop go over its one connection exactly as a workstation's;
  stop does nothing. Start is `workstation:connect`, which for a cloud VM
  (`src/agent-cli/cloud-vm.bash`): reads its status (`gcloud compute
  instances describe`), starts a TERMINATED one and resumes a SUSPENDED one
  (`--async`, once), waits out STOPPING, SUSPENDING and a VM booting, the
  live data's state `starting` meanwhile, polling every
  `WORKSTATION_POLL_SECONDS` (5) until RUNNING within
  `WORKSTATION_START_TIMEOUT` (300 seconds); then, unless it was running
  already, waits for the guest's SSH banner through IAP (`gcloud compute
  start-iap-tunnel <id> 22 --listen-on-stdin`, one probe at a time) within
  `CLOUD_VM_SSH_TIMEOUT` (180 seconds). Either wait running out fails the
  connect with the live data's `last-error` of kind `timeout` — the
  footer's `start timed out` and a lost seat until a connect works (control
  tries again after its backoff). The pattern is the operator's
  `~/.local/bin/harness-vm-proxy`'s.
- **The connection.** OpenSSH itself is the master: `ssh -M -S <socket> -N
  -T -o ExitOnForwardFailure=yes -o BatchMode=yes -o ServerAliveInterval=30
  -o ProxyCommand="gcloud … compute start-iap-tunnel <id> 22
  --listen-on-stdin --zone … --project …" -i ~/.ssh/google_compute_engine
  -l <user> -R 127.0.0.1:<port>:127.0.0.1:<port> … cloud-vm-<id>`, under
  the VM's `CLOUDSDK_CONFIG`: OS Login authorises the key, IAP authenticates
  the VM's end, so its host key is not pinned (as the operator's own
  `~/.ssh/config.d/harness-vm`). The forwarder, Hindsight and zot are
  reverse-forwarded to its loopback as on a workstation. Every session,
  copy and signal is a channel over that master, as on a workstation. Once
  it is up, `workstation:connect` records the VM's boot id (`boot-id`).
- **The same lifecycle (AC3).** Each cloud VM is exactly one remote seat,
  recorded in `seats.json` as `{ kind: cloud-vm, workstation: <id> }`: a
  workstation seat in every rule of "VM seats and workstation seats" —
  preferred over VM seats, lost while it can't be used (its login lapsed,
  its setup failed, its connect failed or timed out), filled again once it
  can. Free remote seats are filled in `dev-environments` order: the
  workstations first, then the cloud VMs, each in list order. Steps claim,
  check out, commit, push and release on it as in "A workstation held one
  step at a time" (its claim recording `kind: cloud-vm`), images are pulled
  there once per boot, Artifact Registry first as the VM's service account
  (it runs as the dev workstation service account), with the retries of
  ASS-473. Setup is `workstation:setup`'s; but its whole disk persists across
  a stop and its runtime folder (`/dev/shm`) across all but a restart, so a
  setup done under the boot it runs now still holds after a reconnect
  (`workstation-connection.js setUp`: the setup's `boot-id` is the live
  data's): setup runs again only for a new boot or a new version. Planning
  and grooming steps still run on Lima VMs only. A cloud VM needs Docker
  for setup, as a workstation does: one without it fails setup ("Docker not
  usable"), its seat lost until it has.
- **Idle stop and keep-awake (AC4).** The VM stops itself after 60 idle
  minutes (no interactive pts login, no claude or codex process,
  a low 5-minute load), which replaces the workstation's 30-minute stop.
  Control's keep-awake rule is the workstations': while its seat is held or a
  ticket waits for a seat it could take, control connects it — so starts a
  stopped one — and sets it up before anything is dispatched there.
  Control never stops, suspends, resets or deletes a cloud VM; its idle
  disconnect only closes the master, which (`-N -T`, and sessions without
  a terminal) never held a pts session open.
- **The footer and the sprint screen (AC5, AC6).** The `cloud virtual
  machines` box (ASS-485 retitled it from `virtual machines`) comes
  directly after `gcp workstations` (after `models` without it), in
  `vm+workstation` and `workstation` mode for a project listing a cloud
  VM: one line per cloud VM, `<id> <activity> <state>` built as the
  workstations box builds its own (ASS-485: `🤖x<n>` only with agents on
  the holder, `💻` while the holder runs a script step by the sprint
  screen's rule, nothing when idle; no seat count), the state one of running (green),
  stopped, starting, connecting, sign in needed, setup failed or start timed
  out (the last three red), `seat lost` in red while it can't be used, an id
  cut to 20 with an ellipsis. When one row of boxes would be wider than the
  screen it goes on a row of its own under the others, so the footer fits
  the TUI's 120 columns. The `gcp workstations` box lists workstations
  alone. On the sprint screen a variation in a cloud VM seat is marked 🌐
  (💺 a VM seat, ⛅ a workstation seat), and the key lists it for a project
  with cloud VMs.
- **Tests.** `test/agent-cli/cloud-vm.test.js` and
  `test/control/cloud-vms.test.js` against a fake cloud VM
  (`test/support/fake-gcloud-compute.js`, `fake-ssh-master.js`);
  `test/tui/virtual-machines-box.test.js`; and
  `test/agent-cli/cloud-vm-real.test.js`, run only with
  `HARNESS_CLOUD_VM_TESTS=1`, against ada-vm (or the VM
  `CLOUD_VM_TEST_ID`, `_PROJECT`, `_ZONE`, `_GCLOUD_CONFIG`, `_SSH_USER`
  name): its status, started if it stopped itself, a command run, a file
  copied in and out and one small Artifact Registry image pulled, all under
  a scratch folder removed after.

## The local virtual machines box (ASS-486, ASS-489, ASS-491)

The TUI footer's rightmost box, `local virtual machines`, shows every seat
that uses one of the Mac's Lima VMs, one line each, in `vm` and
`vm+workstation` mode (never in `workstation` mode, where tickets have no
VMs). ASS-489 replaced ASS-486's "busy VMs" rule; ASS-491 added the planning
seats. The in-progress VM seats come first. Their holders: control's
`seats.json` rows of kind `vm`, in their order (oldest first). Each shows the
Lima VM whose `vms.json` row has the seat's ticket (case-insensitive) and
variation, as ASS-485's `<id> <activity> <state>` (`machineLine`): the
activity the variation's agents and 💻 for a running script step
(`variationActivity`), the state the VM's own word lowercased, `running` in
green — e.g. `vm-1 🤖x2 running`, `vm-2 💻 running` — a name cut to 20 with
an ellipsis. A holder whose VM has no `vms.json` row yet shows its expected
name (lowercased key-variation, e.g. `vm-3-a`) with a gray `creating`. Then
one gray `free build seat` line per VM seat left, so these lines number the
VM seat count (`seatCapacity`, the models box's `vm seats: <used>/<n>`). Then
the planning seats, every one a local VM's since planning always runs on Lima
VMs (ASS-469), taken from `seatPlan` so they agree with the sprint screen's
💺: its planning holders in its order, each in the same line as above, then
one gray `free planning seat` line per free planning seat (`max-tickets-in-planning`
within `harness.json`'s limit). With no limit (∞) of either kind only its
holders are listed; with no lines at all, one gray `none`. A VM whose ticket
holds no seat — waiting at a gate, blocked, or in a workstation or cloud-vm
seat — is not listed. When a row of boxes would be wider than the screen it
wraps as the cloud box does, staying rightmost on its row, so the footer fits
the TUI's 120 columns. Tests: `test/tui/local-virtual-machines-box.test.js`.

## A finished plan holds no seat (ASS-362)

A variation at Plan whose `grouped-plan` run has reached its `done` step has
finished planning: it only waits for an in-progress slot to move on to Build
(control logs `waits for an in-progress slot to move to build`). While it
waits it holds no planning slot and no in-progress slot, so the next ticket at
Committed may start planning under `max-tickets-in-planning`. The rule is
generic (`src/control/engine.js` `finishedPlanning`, `src/control/plan.js`
`slotKind`): a top-level planning step (`is-planning-stage`) whose sub-engine
is at an `is-done` step, with an exit out of planning to a step that holds a
slot (Plan's to Build). Setup's `done` goes on to Plan, more planning, so it
keeps its planning slot. The flat engines have no sub-engines, so their seats
are unchanged.

- **Still seated:** anything that is not a finished plan keeps its slot as
  before. That covers every other Plan step, a plan Review Plan sends back
  for revision, a planning step at a human step or at a gate (a
  `gate-when-leaving-state` on Plan, its work done, waits on a person), and
  Requirements Changed.
- **The queue:** the finished plans form a queue for Build, in rank order.
  Control moves a sprint's variations highest-ranked first, so a freed
  in-progress slot goes to the highest-ranked finished plan. A lower-ranked
  one, or a ticket still planning, never takes it ahead of a ready one of
  higher rank. `planDispatch` lists the queue as `ready`.
- **Its VM:** stopped while it waits, like a variation waiting for a slot
  (ASS-233), so the queue costs no RAM. The log says `planned, waits for a
  build seat`. It needs no VM to move on, so its step is judged with the VM
  stopped, and once a slot frees it moves to Build, which starts the VM.
- **The cap:** `max-tickets-ready-for-build` is optional, in harness.json
  (every project's together) and in project.json (the project's own), like
  the other ticket limits. Unset means no limit, and 0 means none. It caps the
  finished plans together with those still planning, which will join them.
  While that count reaches the cap, no ticket enters planning (`free.planning`
  is false). Tickets at Committed stay there, logged once per visit: `waits
  to enter planning: max-tickets-ready-for-build reached (…)`. A ticket
  already planning keeps its slot and its agents.
- **Shown:** the sprint row has no 💺 (ASS-357), and its Status cell has
  `Planned, waiting for a build seat` under the step chain. The ticket screen's
  Status says the same. The progress update lists it under `In Progress:
  planned, waiting for a build seat`, not `In Progress: planning`. It is not
  counted as actively being built or planned; the net line counts it on its
  own.

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
waiting on a depends-on neither Merged nor Closed. A planned one never
created (`Not Created`, no key; one Generate Solution left out, a duplicate of
one merged already, say) has no forge row to set or merge, so it counts for
neither `auto-merge` nor `merged`, nor as a dependency to wait on (ASS-354):
counted, it held both false for good, Team Code Review and Ensure Auto-Merge
passing the group back and forth until Blocked. So a group whose later
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

An agent at Address Merge Request Feedback retries a failed pipeline that
failed on infra before any test ran (a runner, Docker daemon or scheduling
failure) with `merge-request:retry <project> <ticket-key> <variation> <id>`
(ASS-483), as the grouped feedback prompts say, rather than changing code. It
starts the pipeline again with the same `mr_rerun` as above, once per head
commit: the head is recorded on the row as `retried-head` (the check does not
clear it) with `feedback-acted`, and a second call at the same head is refused
(exit 1, naming the prior retry), so a real failure cannot loop; a push gives
a new head and one more retry. A retry that cannot start records nothing.

A superseded canceled pipeline is no `build-failed` (ASS-388). A force-push,
a rebase or a new commit cancels the pipeline running for the old head, so a
merge request whose head is fine could read `build-failed` from it and be
sent to Address Merge Request Feedback with nothing to do. On GitLab a
canceled head pipeline is `build-failed` only while it is the current head's
(its `sha` is the merge request's `sha`; either missing, it counts as the
head's) and no newer pipeline (a higher id) for that head is among the merge
request's pipelines (`GET …/merge_requests/<iid>/pipelines`, asked only for a
canceled one; a list the forge refuses changes nothing). On GitHub a
`CANCELLED` check is not a failure when the same check (name or context)
started later on the head commit and was not cancelled. A `failed` pipeline,
and a canceled one for the current head with nothing newer, are
`build-failed` as before. `mr_view` now also gives `head` (the head
commit's sha) and the pipeline's `status` and `sha`.

A feedback round that changed nothing spends no visit (ASS-388). The check
records on each Open merge request's row the head commit it saw
(`checked-head`) and clears `feedback-acted`, which `merge-request:reply`,
`merge-request:resolve` and `merge-request:retry` set. After Address Merge Request Feedback, Check the
Feedback Round runs `merge-request:feedback-round` (`--only` as the loop's
other commands): each Open one's head is read from its forge, and it prints
`{ "changed": <bool>, "merge-requests": [{ id, key, head, "checked-head",
acted }] }`, changed false only when there is an Open one and every head is
its `checked-head` with nothing replied to, resolved or retried. Its exit on changed
false goes back to the check with `"cause": "no-op-round"` in the engine JSON;
control records an exit's cause on a script step's move, and on a run's own
`state-changes` too (`transient-state-engine:change-state` takes
`MOVE_CAUSE`), and counts visits over the history with each no-op round taken
out (`engine.js` `withoutNoOpRounds`: the no-op move and every change back to
and including the last move out of the step it returns to), the no-op move
itself never redirected by max-visits. So the round's visits to Address Merge
Request Feedback, Check the Feedback Round and the check all go uncounted, and
the group goes on polling. Any other exit (something changed, or the command
failed) goes on as before and counts. A real failed pipeline, open thread or
review comment still sends the merge request to Address Merge Request
Feedback; a round there that again changes nothing is again uncounted, so the
check sends it once per poll at most. A project's own Release adds the same
step after its Address Merge Request Feedback (without `--only`, both exits
back to Team Code Review, the first with the cause), as
`test/fixtures/engines/grouped-release-example` does.

The current engines' commands are the same ones: a merge request recorded
from a worktree (no `repository`) is on the workspace's origin, read with
`glab mr` as before.

Not yet proven against the live forges: every forge call is tested against a
fake glab and gh. Automated Testing and Local Testing run in each repository's
checkout as Generate Solution left it, the last branch it built there: two
merge requests in one repository with no depends-on between them are not
both tested.

### A merge request planned after Write Execution Plan (ASS-424)

The rule, shared with ASS-423's Blocked path: a merged merge request does not
end the ticket's work in its repository. When the ticket needs another change
there, the harness plans and opens a new merge request; it never reopens,
pushes to or retargets a merged branch, and it does not ask the operator.

Who may plan one after Write Execution Plan: Generate Solution, Build's and
Release's Address Merge Request Feedback, and Generate Automated Tests
(`-grouped` prompts), each only for a repository where the ticket has no
merge request Open or Not Created. They call `ticket:add-merge-request
{project} {ticket} {variation} -` (forwarder-allowed), stdin `{ repository,
contents, step, why, "needed-by": [ids] }`. It plans through
`plan_new_merge_request` (`merge-requests.bash`, the helper ASS-423 shares):
the next id never used, `change/<KEY>-<id>`, depends-on none, base the
repository's last merged one's, written by `ticket:set-merge-request-plan`.
The row gets `planned-by: { step, why, at }` (kept by later replans); each
`needed-by` one not Merged or Closed gets the new id in its depends-on; and
an `## Merge request <id> added` section in `execution-plan-<V>.md` says
which step added it and why. A repository with one Open or Not Created
already is refused (exit 3, naming it): the change goes on that one, so no
step plans a second for the same repository. Write Execution Plan plans as
before; the Blocked repair steps open their fix merge requests through
`merge-request:create-fix`. A question to the operator is only for a change
outside the ticket's scope.

Control takes one so planned like any other. Generate Solution builds it
from the latest `origin/<base>` and records it with `merge-request:create`
(Generate Automated Tests only plans it). While it is Not Created, Await
Sequential Merge sends the ticket back to Generate Solution (exit 3), with or
without a dependent, asking no forge — unlike an ASS-354 leftover without
`planned-by`, which is still no wait. Created, it has Code Review and Security
Review with the rest, and, when `needed-by` made another depend on it, it is
what Await Sequential Merge waits for — the merge loop where merges-awaited
is set — so the ticket does not leave Build until it merges. In Release,
`merge-request:check` counts it, Not Created, as the reason `not-created`
(`"not-created": [ids]`, `"needs-build": true`) and `merged` false, so
Release cannot finish without it.

Release's own Address Merge Request Feedback only plans it: created there it
would skip Build's Code Review and Security Review. A project Release engine
with Team Code Review takes it back to Build with an exit on that step,
before its needs-attention exit: `{ "all": [{ "exit-code": 0 }, {
"script-output": { "needs-build": true } }] }` → `rebuild`, which ends
Release at `rebuild`, into Build at Generate Solution. A client project's
`grouped-release-example` (under `data/`) has it; the harness's, family's and
software-assassin's Release engines merge at once with no Team Code Review,
so they need none. A Release engine with Team Code Review but without the
exit keeps sending the group to Address Merge Request Feedback, which leaves
it and says so — a round that changes nothing on Open ones goes uncounted
(ASS-388), else its max-visits ends at Blocked; moving the ticket back to In
Progress on the ticket system takes it to Build there too.

Blocked's own-branch fix (ASS-423) marks the merge request it plans the same
way — `planned-by: { step: "Blocked", why, at }` — so control holds it to the
same rules: Build sends the ticket back to Generate Solution until it is
built, and Release cannot finish without it.

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

## Building a ticket two ways (ASS-499)

A sprint ticket is built a second way by adding a variation to it:

```sh
./agent.sh ticket:add-variation <project> <ticket-key> [--brief <file>] [--at <state>]
# {"key":"ABC-123","variation":"B","state":"committed"}
```

It adds the next letter no variation of the ticket has had (B, then C; a
deleted one's name is never reused), fresh as ticket:sync makes A (no build,
merge requests, acceptance criteria or state changes, not paused), at the
execution engine's `committed` step, or at `--at <state>`, a top-level step id
of it. It refuses, writing nothing, a ticket not in the active sprint (a
backlog ticket joins with ticket:join-sprint first), a deleted or done ticket,
and an unknown state. Control then takes the new variation like any other: its
own seat and VM (`<key>-<variation>`), its branches (`change/<KEY>.<variation>-<id>`,
A's being `change/<KEY>-<id>`), its own `<report>-<variation>.md` files; A is
left as it is. The ticket has one ticket system status, which follows whichever
variation moved last; a variation whose step pairs with another status is in
no gap while another live variation's step pairs with the ticket's
(`pairedByAnother`, `src/control/engine.js`).

`--brief <file>` is what the variation does differently — another answer to
one of the ticket's questions, say. It is written as
`variation-brief-<variation>.md` in the ticket's folder, the operator's alone
(work:write refuses it). Every grouped prompt that reads the ticket's
questions and answers — Enrich AC, Root Cause Analysis and its review, Write
Execution Plan, Write Test Plan, Review Plan, Generate Solution, Generate
Automated Tests, Code Review, Security Review, Test, and Requirements Changed's
Revise Acceptance Criteria and Judge — reads its variation's brief first and
is told that where it conflicts with the answered questions or the
description, the brief wins, for that variation only. Questions and answers
stay the ticket's; a variation with no brief goes by them as before.

`ticket.json` in the ticket's folder is the ticket as dispatched, with the
variation last dispatched on; each variation's dispatch also writes
`ticket-<variation>.json`, which the prompts reading a variation's own
criteria, status or rejection reason read instead. When the variations reach
Variation Selection (grouped-review; `has-variations` is true with two live
ones) the operator compares them and picks one on the ticket screen
(ticket:select-variation); the others are set aside. ticket:sync keeps the
added variation, and files a merge request found on `change/<KEY>.<variation>`
or `change/<KEY>.<variation>-<id>` on that variation.

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
- **A merge-gate red on master's flake (ASS-394).** A red test run in the
  merge gate (`merge-request:merge-in-turn`) is not at once the ticket's. The
  failing tests run again, once, in the same rebased worktree: node --test's
  failed files alone when its output names them (`merge-gate-tests.js`,
  reading it with automated-tests' `test-results.js`), else the whole
  command. Passing, it was a flake: the gate pushes and merges. Failing
  again, the same run is made on a checkout of the latest main and the two
  compared test by test. Every test that failed again fails on main too (or,
  no test named, the command is red there too): main's flake or bug, not the
  ticket's. The gate ends with no exit at all — `{ waiting, master-red,
  tests, tickets }`, the board's feedback "waiting for master: …" — so no
  visit is charged and nothing goes back to Build; the ticket waits
  (`work/<KEY>/merge-gate-wait-<variation>.json`) until origin's main moves
  past the commit they failed on, then its gate runs again. Each such test is
  raised once in its project (`master-test-failures.bash`), as a project
  issue is (ASS-163: only a failure on the latest master, which the gate has
  just run), through create-ticket-grouped's own commands: the harness
  project's into its backlog and any off-board project's by `off-board.sh
  ticket:create`, a Jira project's by `ticket:raise-bug`, one with neither
  only recorded. `data/projects/<p>/master-test-failures.json` names every
  test raised and its ticket; a test in it is never raised again, by any
  ticket's gate. A test that passes on main, or a failed test file main has
  not got, counts against the ticket as before: red, exit 2, back to Build.

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
