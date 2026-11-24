# ASS-587 security review (variation A)

Full diff reviewed: PR #52 (`change/ASS-587-1` → `origin/main`, commits 45cec24..8a8da2e) —
`src/substrate/image/sandbox-services`, `src/substrate/image/command-server/{main.go,reap_linux.go,reap_other.go}`,
`test/agent-cli/{substrate-stack,sandbox-exec,substrate-image}.test.js`.

## Findings
None.

## Notes
- `sandbox-services`: the pid read from the pid file (`pid_of`) is validated `[[ "$pid" =~ ^[0-9]+$ ]]` before
  any use in `kill -0`/`ps -o stat=`/`ps -o lstart=`; the recorded start-time line is only string-compared
  (`== "$recorded"`), never passed to a shell or `eval`'d. No injection in `running()`, `start_one()`, `stop`, or
  `status`.
- `reap_linux.go`'s `reapOrphans()` only `wait4`s (by pid, `WNOHANG`) a child whose own `/proc/<pid>/stat` shows
  state `Z` and ppid equal to the server's own pid; it can't reach or disturb any process outside the server's
  child tree. `PR_SET_CHILD_SUBREAPER` affects only the calling process's descendants. `tracked`/`startMu` keep a
  job's own `cmd.Wait()` from racing the reaper's scan for the same pid.
- The one-line addition to `substrate-image.test.js` (commit 8a8da2e) only asserts two new filenames in a build
  context listing already asserted elsewhere in the same test — no behavior or security surface of its own.
- No new dependency: no `go.mod`/`go.sum`/`package.json` change in the diff.
- No secret, token or credential in the diff (code, tests or comments).
- Test additions use `execFileSync`/`spawn` with argument arrays and `fetch` with JSON-encoded bodies throughout
  — no shell-string interpolation of untrusted or dynamic data.
- Scope matches the ticket: `sandbox-services`, the command-server reaper, and their tests only. No unrelated
  file touched.

## Verdict
```json
{"is-approved": true}
```
