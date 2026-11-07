// The downloader: the long-lived process that keeps the projects' JSON in
// step with Jira and GitLab. Every download-updates-interval-in-minutes
// (harness.json, read again every nap of the wait, so an edit applies within
// five seconds) it runs one cycle (cycle.js) for each project under data/projects/ whose
// project.json has a jira work source with a url; a project whose cycle fails
// is logged to stderr and the others still run. The first round, then every
// COMMENTS_EVERY-th, is a comment cycle: each Jira ticket's comments too
// (ASS-37) — one acli call a ticket, so not every round — and a lookup cycle:
// the merge-request scan's direct fetches and targeted lookups (ASS-98/122). It writes no JSON itself:
// every mutation is an agent.sh call.
//
//   node src/downloader/main.js [--once] [--dry-run]
//   --once      one round, then exit
//   --dry-run   fetch, but only print the agent.sh calls and their files
//
// Between cycles it waits in naps of at most NAP_MS, logging nothing. Like
// control, it exits when its stdin closes (the supervisor's pipe: a supervisor
// that died cannot leave it running) or on SIGTERM, finishing the cycle in
// hand first; the stop lands within one nap. One line per action on stdout: "<ISO time> <project>
// <what>". PROJECTS_DIR and HARNESS_JSON override the projects folder and
// harness.json, used by tests.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as jira from './jira.js';
import * as gitlab from './gitlab.js';
import * as github from './github.js';
import * as offBoard from './off-board.js';
import { runCycle } from './cycle.js';
import { dataDir } from '../data-folder.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PROJECTS = process.env.PROJECTS_DIR ?? join(dataDir(ROOT), 'projects');
const HARNESS_JSON = process.env.HARNESS_JSON ?? join(dataDir(ROOT), 'harness.json');
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');

// exec(file, args) → stdout; a failure rejects with the exit status as `code` and stderr in the message.
const exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(new Error(`${file} ${args.join(' ')}: ${stderr.trim() || err.message}`), { code: err.code }));
    else resolve(stdout);
  });
});
const say = (project, text) => console.log(`${new Date().toISOString()} ${project} ${text}`);

// The projects to download: those with a jira work source with a url — one
// per board: a later project (by name) on a board an earlier one has is
// skipped, and said so, since syncing it would write the same tickets twice —
// and those with an off-board work source (the harness's own).
function downloadProjects() {
  const boards = new Map();
  for (const name of readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const file = join(PROJECTS, name, 'project.json');
    if (!existsSync(file)) continue;
    let url, offBoard;
    try {
      const sources = JSON.parse(readFileSync(file, 'utf8'))['work-sources'] ?? [];
      url = sources.find(s => s.type === 'jira' && s.url)?.url;
      offBoard = sources.some(s => s.type === 'off-board');
    } catch { continue; }
    if (!url) { if (offBoard) boards.set(`off-board:${name}`, name); continue; }
    if (boards.has(url)) say(name, `skipped: the same Jira board as ${boards.get(url)}`);
    else boards.set(url, name);
  }
  return [...boards.values()];
}
const NAP_MS = 5000;             // no wait in the harness is longer than this
const COMMENTS_EVERY = 15;       // about an hour at 4 minutes; the lookups too
// The keys whose comments last failed to download, across rounds: a failure is logged once.
const failing = new Set();
const intervalMinutes = () => Number(JSON.parse(readFileSync(HARNESS_JSON, 'utf8'))['download-updates-interval-in-minutes']) || 4;

// Stopping: stdin's end or SIGTERM ends the wait between rounds and the loop.
let stopping = false, wake = () => {};
const stop = () => { stopping = true; wake(); };
process.stdin.on('end', stop).on('error', stop).resume();
process.on('SIGTERM', stop);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

for (let round = 0; ; round++) {
  const slow = round % COMMENTS_EVERY === 0, comments = slow ? failing : undefined;
  for (const project of downloadProjects()) {
    try {
      await runCycle({ root: ROOT, project, now: new Date(), adapters: { jira, gitlab, github, offBoard }, exec, comments, lookups: slow, dryRun, log: text => say(project, text) });
    } catch (err) {
      console.error(`${new Date().toISOString()} ${project} cycle failed: ${err.message}`);
    }
  }
  if (once || stopping) break;
  // Until the next cycle is due, in naps of at most NAP_MS, the interval read again each nap.
  const end = Date.now(), due = () => end + intervalMinutes() * 60_000;
  while (!stopping && Date.now() < due()) await sleep(Math.min(NAP_MS, due() - Date.now()));
  if (stopping) break;
}
process.exit(0);
