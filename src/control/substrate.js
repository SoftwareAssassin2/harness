// ASS-533 AC4: control checks each project's Substrate clusters (project.json's dev-environments.substrate.clusters,
// substrate-config.js) every few minutes, restarts a broken one, and the dashboard's header names a broken one by its
// machine (src/tui/screens/frame.js substrateWarnings, from the live data this check records).
//
// - The check: substrate:health <project> <machine> (agent-cli/substrate/health.sh; on-machine/substrate.sh says what
//   it checks: Docker and its memory, the node, the API server, every system pod and the project's, rustfs, postgres,
//   the pinned release, the project's WorkerPool and atespace, its templates' golden snapshots, and the cluster's use)
//   every CHECK_EVERY (harness.json's substrate-check-seconds), in a job beside the tick (one per project at a time, as
//   the workstation job: a check over SSH takes seconds), never awaited by it. It records its result as the machine's
//   entry in data/projects/<p>/substrate.json, which the dashboard reads and seat-budget.js / remote-seats.js count
//   (AC5).
// - A remote machine's cluster (a workstation's or a cloud VM's) is checked only while the machine is connected and
//   set up: a check never starts a machine, nor keeps one from its idle stop. Its cluster's state lives under /home
//   there, so a restart keeps it, and workstation:setup (at every connect) starts its node again (AC3, AC7).
// - The Mac's cluster is shared by the Mac projects: each project's control checks it for its own part (its
//   WorkerPool, atespace and templates) and the whole; substrate:up's lock keeps two restarts apart.
// - A restart: a cluster whose check is `missing` (no cluster: one the operator declared and never brought up, or one
//   deleted) or whose node is down is restarted at once; one `broken` with a problem substrate:up can fix (its
//   `repair`) on REPAIR_AFTER checks in a row (a pod restarting once is not worth it), by substrate:up <project>
//   <machine> with HARNESS_SUBSTRATE_REPAIR=1 (which also deletes pods stuck not ready). One that fails is tried again
//   after a failing step's backoff (backoff.js: 30 seconds doubling to 30 minutes). `starting` (the node restarted
//   within its grace) waits. Problems a restart cannot fix — Docker down or short of memory, a template with no golden
//   snapshot (the template's error is its own: ASS-534/535's), the host short of memory — are reported only: the
//   header shows them, the operator or the template's owner fixes them. No restart while the disk hold is on, nor
//   while the project is held by its credentials (no new work, as for VMs).
// - GKE entries are accepted but refused at setup (substrate-config.js GKE_REFUSED): logged once, never checked.
// - A wrong substrate list is logged once, naming each bad field (AC1), and nothing of it is checked until it is
//   fixed. Background work off (project.json background-work false) checks nothing, as for every health check.
// Each change of a cluster's state, and each restart, is logged once under "substrate".
// - ASS-538: on every pass, each reachable cluster's egress credentials synced when the keychain, the allowlist or
//   its health says so, and the gateway's refusals logged (substrate-credentials.js).
import { backoffDelay, held } from './backoff.js';
import { entriesOf, substrateErrors, MAC, GKE_REFUSED } from './substrate-config.js';
import { diskHeld } from './disk.js';
import { credentialsHeld } from './credentials.js';
import { keepCredentials } from './substrate-credentials.js';

const PHASE = 'substrate';
export const CHECK_EVERY = 3 * 60e3;
export const REPAIR_AFTER = 2;

// superviseSubstrate(ctx, state) — the tick's phase: each project's check job started when due (see the module comment).
export function superviseSubstrate(ctx, state) {
  const jobs = (ctx.memory.substrate ??= new Map());
  for (const project of state.projects) {
    const r = jobs.get(project.id) ?? { job: null, m: new Map(), errors: '', gke: false };
    jobs.set(project.id, r);
    const errors = substrateErrors(project.json);
    const said = errors.join('; ');
    if (said !== r.errors) {
      if (said) ctx.log('error', `${PHASE} ${project.id}: its dev-environments.substrate.clusters is wrong, so none of its clusters is checked or set up until it is fixed: ${said}`);
      else if (r.errors) ctx.log(PHASE, `${project.id}: its dev-environments.substrate.clusters reads again`);
      r.errors = said;
    }
    if (said) continue;
    const entries = entriesOf(project);
    if (!entries.length || project.json?.['background-work'] === false) continue;
    r.job ??= keep(ctx, state, project, entries, r).catch(error => ctx.log('error', `${PHASE} ${project.id}: ${error.message}`)).finally(() => { r.job = null; });
  }
}

// usable(project, machine) — a remote machine connected and set up (its live data), so its cluster can be checked.
const usable = (project, id) => project.workstations?.[id]?.connected === true && project.workstations?.[id]?.setup?.ok === true;
const short = h => (h.problems ?? []).map(p => `${p.what}: ${p.why}`).join('; ');

// keep(ctx, state, project, entries, r) — one project's pass over its clusters.
async function keep(ctx, state, project, entries, r) {
  const every = (state.harness?.['substrate-check-seconds'] ?? CHECK_EVERY / 1000) * 1000;
  for (const e of entries) {
    const what = `${project.id} ${e.machine}`;
    const s = r.m.get(e.machine) ?? { checkedAt: 0, broken: 0, failures: 0, until: 0, state: null, waitSaid: '' };
    r.m.set(e.machine, s);
    if (e.kind === 'gke') {
      if (!r.gke) ctx.log(PHASE, `${what}: refused: ${GKE_REFUSED}`);
      r.gke = true;
      continue;
    }
    const now = ctx.now().getTime();
    // ASS-538: its egress credentials kept in step with the keychain and the allowlist, on every pass.
    if (e.host === MAC || usable(project, e.machine)) await keepCredentials(ctx, state, project, e);
    if (now - s.checkedAt < every) continue;
    if (e.host !== MAC && !usable(project, e.machine)) { s.broken = 0; continue; }
    s.checkedAt = now;
    let h;
    try { h = JSON.parse(await ctx.cli(['substrate:health', project.id, e.machine])); } catch (error) {
      if (error.code !== 3) ctx.log('error', `${PHASE} ${what}: substrate:health failed: ${error.message}`);
      continue;
    }
    if (h.state !== s.state) {
      if (h.state === 'healthy') ctx.log(PHASE, `${what}: healthy${s.state ? ` (was ${s.state})` : ''}`);
      else ctx.log(PHASE, `${what}: ${h.state}${short(h) ? `: ${short(h)}` : ''}`);
      s.state = h.state;
    }
    if (!['broken', 'missing'].includes(h.state)) { s.broken = 0; continue; }
    if (!(h.problems ?? []).some(p => p.repair)) { s.broken = 0; continue; }   // reported only: the header shows it
    s.broken++;
    const down = h.state === 'missing' || (h.problems ?? []).some(p => p.what === 'node' || p.what === 'cluster');
    if (!down && s.broken < REPAIR_AFTER) continue;
    if (now < s.until) continue;
    const wait = diskHeld(state) ? 'the disk hold is on' : credentialsHeld(project) ? 'the project is held by its credentials' : '';
    if (wait) {
      if (s.waitSaid !== wait) ctx.log(PHASE, `${what}: not restarted while ${wait}`);
      s.waitSaid = wait;
      continue;
    }
    s.waitSaid = '';
    ctx.log(PHASE, `${what}: restarting the cluster (substrate:up): ${short(h)}`);
    try {
      const out = JSON.parse(String(await ctx.cli(['substrate:up', project.id, e.machine], { HARNESS_SUBSTRATE_REPAIR: '1' })).trim().split('\n').pop());
      ctx.log(PHASE, `${what}: restarted${out.did?.length ? `: ${out.did.join('; ')}` : ' (nothing needed doing: it should come back by itself)'}`);
      Object.assign(s, { failures: 0, until: 0, broken: 0, checkedAt: 0 });
    } catch (error) {
      const delay = backoffDelay(++s.failures);
      s.until = now + delay;
      ctx.log('error', `${PHASE} ${what}: substrate:up failed (${s.failures} in a row; next try in ${held(delay)}): ${error.message}`);
    }
  }
}
