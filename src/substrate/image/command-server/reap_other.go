//go:build !linux

package main

// startReaper — ASS-587: orphans are reaped on Linux only (reap_linux.go); a Mac's test build has nothing to do.
func startReaper() {}
