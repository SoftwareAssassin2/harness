# ASS-587 code review (variation A), pass 3

## Findings
None.

## What this pass covers
Reviewed the full diff on PR #52 (change/ASS-587-1 vs origin/main, through commit 8a8da2e)
in this worktree: `src/substrate/image/sandbox-services`, `command-server/{main.go,reap_linux.go,reap_other.go}`,
and the three test files. Pass 2's finding (amd64/386 build break from `syscall.PR_SET_CHILD_SUBREAPER`) was
already fixed and re-verified then; this pass focuses on pass 3's fix for the AC3 regression test-results-A.md
found (copy-out build test).

- **AC3 fix (commit 8a8da2e) is correct.** `test/agent-cli/substrate-image.test.js:251` asserts the exact file
  list a real `docker build` context would contain. `src/substrate/dockerfile.js:72` copies the whole
  `harness/command-server/` directory into the context, and the fake builder records it with
  `find . -type f | sort` (test/agent-cli/substrate-image.test.js:102) — so `reap_linux.go` and `reap_other.go`
  belong in that list once they exist, in alphabetical order after `main.go` and before `git.sh`. The one-line
  addition matches both; not a hack around the test.
- **`sandbox-services`**: `running()`/`pid_of`/`started_of` match the plan and RCA; the two-line pid file
  (`$!` + `ps -o lstart=`) is written right after backgrounding, and `started_of` degrades to empty (zombie-check-only,
  matching a legacy one-line file) when the process already exited before `ps` could read it — handled, not a gap.
  `stop`/`status` correctly moved to `pid_of` so `--argjson pid` doesn't choke on the two-line file.
- **`command-server`**: `startTracked`/`untrack` under `startMu`, the same mutex `reapOrphans` takes for its whole
  `/proc` scan, keeps a job's own exit status from ever racing the reaper (`cmd.Start()`+track is atomic with the
  scan). `reap_linux.go`'s `/proc/<pid>/stat` parse correctly looks past the last `)` (handles a `comm` with `)` in
  it) and never calls `wait4(-1, …)`, only by pid, on entries not in `tracked`. `reap_other.go` is a true no-op.
- **Tests**: AC1's five new cases in `substrate-stack.test.js` and AC2's three new cases in `sandbox-exec.test.js`
  (Linux+Go gated, skip reason given elsewhere) match the test plan, use `until()`'s event-wait hang-guard
  pattern (ASS-545) throughout, and the AC2 tests explicitly assert the job's own exit code (143) survives the
  reaper. `automated-test-results-A.md` (19:29:04Z, run in this worktree right after commit 8a8da2e) shows the
  AC1 suite and the existing AC2/AC3/AC8 skip test green.
- One merge request, no scope creep, no unrelated file touched.

## Not independently re-run here
This review's own sandbox could not execute `npm test`/`node --test` on these files: every attempt (the full
`substrate-image.test.js`, a `--test-name-pattern` filtered run, and `substrate-stack.test.js`'s ASS-587 tests)
hung past 120 s with no output, and a direct `GOOS=linux go build`/`go vet` of `command-server` failed on
`open …go-build/…: operation not permitted` — both sandbox limits of this review step, not something to work
around. Relying instead on: pass 2's own cross-compile verification (already recorded, amd64/arm64/386 + vet all
clean, native darwin build clean), and this ticket's own `test-results-A.md` / `automated-test-results-A.md`,
which ran these exact tests, post-fix, in the ticket's own (less restricted) sandbox and got them green.

## For the merge request description
Merge promptly — closes the real CLW-89 Blocked regression (stale pid file skipping a service restart) and the
amd64 image-build break found in review, with the copy-out test now matching the real build context.

## Verdict
```json
{"is-approved": true}
```
