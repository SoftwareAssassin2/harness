// inPty({ argv, env, cols, rows, steps, timeout }) — runs argv in a
// pseudo-terminal cols × rows (python3's pty, through pty-run.py), taking the
// steps in turn, and resolves to { pid, marks, children, files, output, status }: see
// pty-run.py. For the dashboard, which refuses a stdin that isn't a terminal.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const PY = join(import.meta.dirname, 'pty-run.py');
export const inPty = ({ argv, env = process.env, cols = 100, rows = 30, steps = [], timeout = 3000 }) => new Promise((resolve, reject) => {
  execFile('python3', ['-I', PY, JSON.stringify({ argv, env, cols, rows, steps, timeout })], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`pty-run.py: ${stderr.trim() || error.message}`));
    else resolve(JSON.parse(stdout));
  });
});
