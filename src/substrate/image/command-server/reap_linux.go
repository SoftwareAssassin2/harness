//go:build linux

package main

import (
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// startReaper — ASS-587: the server is PID 1 in a sandbox, so a job's orphans (a child a job backgrounded, its shell
// ended by DELETE's TERM to the group) become its children; unreaped, they stay zombies, and sandbox-services took a
// zombie's pid for a running service. As a child subreaper (a no-op as PID 1; elsewhere, a test's server, the same
// adoption), on each SIGCHLD and every 5 s it waits on each zombie child it did not start itself — by pid, never
// wait4(-1), so a job's own exit status stays its cmd.Wait's (tracked, under startMu).
func startReaper() {
	syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_CHILD_SUBREAPER, 1, 0)
	chld := make(chan os.Signal, 1)
	signal.Notify(chld, syscall.SIGCHLD)
	go func() {
		tick := time.NewTicker(5 * time.Second)
		for {
			select {
			case <-chld:
			case <-tick.C:
			}
			reapOrphans()
		}
	}()
}

// reapOrphans — each zombie child of this process, not one it started, waited on (WNOHANG).
func reapOrphans() {
	self := os.Getpid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	startMu.Lock()
	defer startMu.Unlock()
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || tracked[pid] {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// After the last ')' (a process's name may hold one): " <state> <ppid> …".
		s := string(b)
		f := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
		if len(f) < 2 || f[0] != "Z" || f[1] != strconv.Itoa(self) {
			continue
		}
		var ws syscall.WaitStatus
		syscall.Wait4(pid, &ws, syscall.WNOHANG, nil)
	}
}
