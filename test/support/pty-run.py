# Runs a command in a pseudo-terminal of a given size, for tests of the
# dashboard, which needs one (ASS-338): see pty.js. The spec, JSON in argv[1]:
# argv, env, cols, rows, steps, timeout. Each step is {wait: ms}, {send: text},
# {resize: [cols, rows]}, {mark: name} (the output so far, kept under that
# name), {children: name} (the command's child pids, kept under that name)
# or {file: name, path} (the file's text then, or null, kept under that name).
# Prints {pid, marks, children, files, output, status}: status is the exit code, or null
# if it was still running `timeout` ms after the last step (then killed).
import json, os, pty, select, signal, struct, subprocess, sys, time, fcntl, termios

spec = json.loads(sys.argv[1])
winsize = lambda cols, rows: struct.pack('HHHH', rows, cols, 0, 0)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, winsize(spec['cols'], spec['rows']))
    os.execvpe(spec['argv'][0], spec['argv'], spec['env'])

out = bytearray()
status = None

def pump(ms):
    global status
    end = time.time() + ms / 1000
    while True:
        left = end - time.time()
        if left <= 0: return
        ready, _, _ = select.select([fd], [], [], min(left, 0.05))
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if data: out.extend(data)
        if status is None:
            done, code = os.waitpid(pid, os.WNOHANG)
            if done: status = os.waitstatus_to_exitcode(code)
        if status is not None and not ready: return

marks, children, files = {}, {}, {}
for step in spec['steps']:
    if 'wait' in step: pump(step['wait'])
    elif 'send' in step:
        try: os.write(fd, step['send'].encode())
        except OSError: pass   # it has ended
        pump(50)
    elif 'resize' in step:
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize(*step['resize']))
            os.kill(pid, signal.SIGWINCH)
        except (OSError, ProcessLookupError): pass
    elif 'mark' in step: marks[step['mark']] = out.decode('utf8', 'replace')
    elif 'children' in step:
        found = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True).stdout.split()
        children[step['children']] = [int(p) for p in found]
    elif 'file' in step:
        try:
            with open(step['path']) as f: files[step['file']] = f.read()
        except OSError: files[step['file']] = None
pump(spec.get('timeout', 3000)) if status is None else None
if status is None:
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)
print(json.dumps({'pid': pid, 'marks': marks, 'children': children, 'files': files, 'output': out.decode('utf8', 'replace'), 'status': status}))
