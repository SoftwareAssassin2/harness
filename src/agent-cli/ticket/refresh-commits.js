// ASS-558: ticket:refresh-commits's work (see refresh-commits.sh) —
// node refresh-commits.js <projects> <project> <ticket-key> <variation>.
// refreshCommits is exported for the tests, which pass a fake `run`.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMITS_FILE, forgeReader, gatherCommits, gitReader, sinceOf } from '../../control/ticket-commits.js';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const isDir = dir => { try { return statSync(dir).isDirectory(); } catch { return false; } };

// The commands gathering may run (AC3: never one that starts or reaches a machine — no limactl, ssh, gcloud, kubectl).
export const READERS = new Set(['glab', 'gh', 'git']);

// run(cmd, args) — the command's stdout; rejects with its stderr. Read only, a minute at most.
export const run = (cmd, args) => new Promise((resolve, reject) => {
  if (!READERS.has(cmd)) { reject(new Error(`${cmd}: not a command commits are gathered with`)); return; }
  execFile(cmd, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${cmd} ${args.join(' ')}: ${(stderr || error.message).trim()}`));
    else resolve(stdout);
  });
});

// The active sprint's ticket `key` (any case), or null.
function sprintTicket(dir, key) {
  const sprints = join(dir, 'sprints.json');
  const active = existsSync(sprints) ? readJson(sprints).list?.find(s => s['is-active']) : null;
  const file = active && join(dir, 'sprints', `sprint-${active.number}`, 'sprint.json');
  if (!file || !existsSync(file)) return null;
  const sprint = readJson(file);
  return ['features', 'bugs', 'spikes'].flatMap(list => sprint[list] ?? []).find(t => String(t.key).toUpperCase() === key.toUpperCase() && t['is-deleted'] !== true) ?? null;
}

// clonesOf(dir, project) — the git checkouts on the Mac commits are read from: the project's local-pc folder and each
// of the harness's own clones under its checkouts/ (ASS-553), those that exist.
export function clonesOf(dir, project) {
  const own = join(dir, 'checkouts');
  return [
    ...(project['local-environments'] ?? []).filter(e => e?.type === 'local-pc' && e.folder).map(e => e.folder),
    ...(isDir(own) ? readdirSync(own).toSorted().map(name => join(own, name)).filter(d => existsSync(join(d, '.git'))) : []),
  ].filter(isDir);
}

// refreshCommits({ projects, project, key, variation, run, now }) — the variation's commits gathered and written to
// work/<KEY>/commits-<variation>.json; returns what was written. Throws when the ticket or variation is not in the
// active sprint.
export async function refreshCommits({ projects, project, key, variation, run: runner = run, now = new Date() }) {
  const dir = join(projects, project), json = readJson(join(dir, 'project.json'));
  const ticket = sprintTicket(dir, key);
  if (!ticket) throw new Error(`${key} is not in ${project}'s active sprint`);
  const live = (ticket.variations ?? []).filter(v => v['is-deleted'] !== true);
  const v = live.find(x => x.name === variation);
  if (!v) throw new Error(`${ticket.key} has no variation ${variation}`);
  const merged = m => m.status === 'Merged' || m['build-status'] === 'Merged';
  const since = sinceOf(v, ticket.created, now);
  const { commits, sources } = await gatherCommits({
    key: ticket.key, variation, variations: live.map(x => x.name), mrs: v['merge-request'] ?? [], branch: v.build?.branch ?? null,
    mergedVariations: live.filter(x => (x['merge-request'] ?? []).some(merged)).map(x => x.name),
    repositories: json.repositories ?? [], clones: clonesOf(dir, json), since,
  }, { forge: forgeReader(runner), git: gitReader(runner) });
  const out = { key: ticket.key, variation, 'refreshed-at': now.toISOString().replace(/\.\d{3}Z$/, 'Z'), since, sources, commits };
  const work = join(dir, 'work', ticket.key);
  mkdirSync(work, { recursive: true });
  const file = join(work, COMMITS_FILE(variation)), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, file);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [projects, project, key, variation] = process.argv.slice(2);
  try {
    const out = await refreshCommits({ projects, project, key, variation });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (error) {
    console.error(`ticket:refresh-commits: ${error.message}`);
    process.exitCode = 1;
  }
}
