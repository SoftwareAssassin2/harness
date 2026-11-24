// The harness's command server (ASS-534), the CMD of every Substrate sandbox
// image: Substrate has no exec API (ASS-532 spike, section 1), so the only way
// to run a command in a sandbox is the sandbox's own port, reached through
// `kubectl ate proxy actor` or the atenet router. Built from this source in
// the image build's golang stage (src/substrate/dockerfile.js), statically,
// for the image's architecture; no dependency beyond Go's standard library.
//
// The router answers within 5 minutes or not at all, so a long step runs
// detached and is polled; a short command may run in one request:
//
//	GET  /healthz                      200 "ok"
//	POST /process                      { command: [argv], envvars: {k: v}, cwd, timeout: "280s" }
//	                                   → { stdout, stderr, exitCode, error } once it ends (the
//	                                   Substrate sandbox demo's API, which the spike's sx.sh calls);
//	                                   exitCode -1 when it could not start
//	POST /jobs                         { command, envvars, cwd, stdin } → 201 { id }: started detached, in a
//	                                   process group of its own, its output kept in files; its stdin
//	                                   /dev/null, or with stdin: true a pipe POST /jobs/{id}/stdin feeds
//	GET  /jobs/{id}                    { id, command, running, exitCode (null while running), startedAt, endedAt }
//	GET  /jobs/{id}/output?stream=stdout|stderr&offset=N[&wait=S]
//	                                   the stream's bytes from offset N on (X-Next-Offset: where the
//	                                   next poll starts; X-Running: true while it runs); with wait (ASS-535,
//	                                   at most 60 s) the answer waits until there are bytes past N or the
//	                                   job has ended, so a poll streams the output as it comes
//	POST /jobs/{id}/stdin[?close=1]    ASS-535: the body written to the job's stdin (a job started with
//	                                   stdin: true), in order; close=1 closes it after → 204; 409 without one
//	DELETE /jobs/{id}                  SIGTERM to its process group → 202
//
// ASS-535: the harness's machine layer for sandboxes (src/control/machine-substrate.js, through
// src/substrate/sandbox-exec.js) runs every command as a job: its stdin streamed in (an agent's stream-json
// prompts), its output polled out with wait, its exit code the process's own (128 + the signal for one a signal
// ended, as a shell says it; -1 when it could not start).
//
// Jobs' output lives under $JOBS_DIR (/var/lib/sandbox/jobs by default), so a
// hibernated and resumed sandbox still has it. PORT is the port (80).
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type processRequest struct {
	Command []string          `json:"command"`
	EnvVars map[string]string `json:"envvars,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Timeout string            `json:"timeout,omitempty"`
	Stdin   bool              `json:"stdin,omitempty"`
}

type processResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type job struct {
	ID        string     `json:"id"`
	Command   []string   `json:"command"`
	Running   bool       `json:"running"`
	ExitCode  *int       `json:"exitCode"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt"`
	pid       int
	stdin     io.WriteCloser
	stdinMu   *sync.Mutex
}

var (
	jobsDir = envOr("JOBS_DIR", "/var/lib/sandbox/jobs")
	mu      sync.Mutex
	jobs    = map[string]*job{}
)

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	if err := os.MkdirAll(jobsDir, 0o755); err != nil {
		log.Fatalf("jobs folder %s: %v", jobsDir, err)
	}
	http.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	http.HandleFunc("POST /process", handleProcess)
	http.HandleFunc("POST /jobs", handleStart)
	http.HandleFunc("GET /jobs/{id}", handleJob)
	http.HandleFunc("GET /jobs/{id}/output", handleOutput)
	http.HandleFunc("POST /jobs/{id}/stdin", handleStdin)
	http.HandleFunc("DELETE /jobs/{id}", handleStop)
	port := envOr("PORT", "80")
	log.Printf("harness command server on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func command(ctx context.Context, req processRequest) (*exec.Cmd, error) {
	if len(req.Command) == 0 {
		return nil, errors.New("command required")
	}
	cmd := exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)
	cmd.Dir = req.Cwd
	cmd.Env = os.Environ()
	for k, v := range req.EnvVars {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	return cmd, nil
}

func decode(w http.ResponseWriter, r *http.Request) (processRequest, bool) {
	var req processRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return req, false
	}
	if len(req.Command) == 0 {
		http.Error(w, "command required", http.StatusBadRequest)
		return req, false
	}
	return req, true
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func handleProcess(w http.ResponseWriter, r *http.Request) {
	req, ok := decode(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	if req.Timeout != "" {
		d, err := time.ParseDuration(req.Timeout)
		if err != nil {
			http.Error(w, "invalid timeout: "+err.Error(), http.StatusBadRequest)
			return
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d)
		defer cancel()
	}
	cmd, _ := command(ctx, req)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	resp := processResponse{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		resp.Error = err.Error()
		resp.ExitCode = exitCode(err)
	}
	reply(w, http.StatusOK, resp)
}

// exitCode — a finished command's exit code: its own; 128 + the signal when a signal ended it (as a shell says it);
// -1 when it never ran.
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return exitErr.ExitCode()
	}
	return -1
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func handleStart(w http.ResponseWriter, r *http.Request) {
	req, ok := decode(w, r)
	if !ok {
		return
	}
	id := newID()
	dir := filepath.Join(jobsDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cmd, _ := command(context.Background(), req)
	stdout, err1 := os.Create(filepath.Join(dir, "stdout"))
	stderr, err2 := os.Create(filepath.Join(dir, "stderr"))
	if err := errors.Join(err1, err2); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var in io.WriteCloser
	if req.Stdin {
		var err error
		if in, err = cmd.StdinPipe(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if err := cmd.Start(); err != nil {
		stdout.Close()
		stderr.Close()
		reply(w, http.StatusUnprocessableEntity, processResponse{ExitCode: -1, Error: err.Error()})
		return
	}
	j := &job{ID: id, Command: req.Command, Running: true, StartedAt: time.Now().UTC(), pid: cmd.Process.Pid, stdin: in, stdinMu: &sync.Mutex{}}
	mu.Lock()
	jobs[id] = j
	mu.Unlock()
	go func() {
		err := cmd.Wait()
		stdout.Close()
		stderr.Close()
		code := exitCode(err)
		now := time.Now().UTC()
		mu.Lock()
		j.Running, j.ExitCode, j.EndedAt = false, &code, &now
		mu.Unlock()
		os.WriteFile(filepath.Join(dir, "exit"), []byte(strconv.Itoa(code)+"\n"), 0o644)
	}()
	reply(w, http.StatusCreated, map[string]string{"id": id})
}

func find(w http.ResponseWriter, r *http.Request) (*job, bool) {
	mu.Lock()
	defer mu.Unlock()
	j, ok := jobs[r.PathValue("id")]
	if !ok {
		http.Error(w, "no such job", http.StatusNotFound)
	}
	return j, ok
}

func handleJob(w http.ResponseWriter, r *http.Request) {
	if j, ok := find(w, r); ok {
		mu.Lock()
		view := job{ID: j.ID, Command: j.Command, Running: j.Running, ExitCode: j.ExitCode, StartedAt: j.StartedAt, EndedAt: j.EndedAt}
		mu.Unlock()
		reply(w, http.StatusOK, view)
	}
}

func handleOutput(w http.ResponseWriter, r *http.Request) {
	j, ok := find(w, r)
	if !ok {
		return
	}
	stream := r.URL.Query().Get("stream")
	if stream == "" {
		stream = "stdout"
	}
	if stream != "stdout" && stream != "stderr" {
		http.Error(w, "stream is stdout or stderr", http.StatusBadRequest)
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	file := filepath.Join(jobsDir, j.ID, stream)
	// ASS-535: wait=S — until there are bytes past offset, or the job has ended, at most S (60) seconds.
	if wait, _ := strconv.ParseFloat(r.URL.Query().Get("wait"), 64); wait > 0 {
		deadline := time.Now().Add(time.Duration(min(wait, 60) * float64(time.Second)))
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			mu.Lock()
			running := j.Running
			mu.Unlock()
			if st, err := os.Stat(file); !running || (err == nil && st.Size() > offset) {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	mu.Lock()
	running := j.Running
	mu.Unlock()
	f, err := os.Open(file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.NewSectionReader(f, offset, 1<<62))
	if err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Next-Offset", fmt.Sprint(offset+int64(len(data))))
	w.Header().Set("X-Running", strconv.FormatBool(running))
	w.Write(data)
}

// handleStdin — ASS-535: the request's body written to the job's stdin, in order (one writer at a time); close=1
// closes it once written.
func handleStdin(w http.ResponseWriter, r *http.Request) {
	j, ok := find(w, r)
	if !ok {
		return
	}
	if j.stdin == nil {
		http.Error(w, "the job has no stdin (start it with stdin: true)", http.StatusConflict)
		return
	}
	j.stdinMu.Lock()
	defer j.stdinMu.Unlock()
	if _, err := io.Copy(j.stdin, r.Body); err != nil {
		http.Error(w, "stdin: "+err.Error(), http.StatusGone)
		return
	}
	if r.URL.Query().Get("close") == "1" {
		j.stdin.Close()
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	j, ok := find(w, r)
	if !ok {
		return
	}
	mu.Lock()
	running, pid := j.Running, j.pid
	mu.Unlock()
	if running {
		syscall.Kill(-pid, syscall.SIGTERM)
	}
	w.WriteHeader(http.StatusAccepted)
}
