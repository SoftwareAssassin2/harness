// ASS-538 AC2, AC3: control keeps each project's Substrate cluster's egress credentials in step with the Mac's
// keychain and its allowlist, and logs what the gateway refused. Asked by src/control/substrate.js's job (beside the
// tick, one per project) for each kind cluster it can reach — the Mac's, or a remote machine connected and set up —
// on every pass, not only when its health check is due, so a rotated key goes out as soon as it is seen.
//
// - A sync (substrate:credentials <project> <machine>: the declared claude, anthropic, gitlab and github keychain
//   items as Kubernetes Secrets, the credential provider's namespace policy, each sandbox's egress policy; see
//   agent-cli/substrate/credentials.sh) runs when the cluster's last check found it healthy and
//     - it was never synced there (substrate.json's <machine>.credentials missing), or the last sync failed (tried
//       again after a failing step's backoff: backoff.js);
//     - the policy the project's allowlist and declaration make now (src/substrate/egress.js egressPolicy) is not
//       the one last synced (its policy-hash): an allowlist edited, a credential declared or dropped;
//     - a declared item was saved again in the keychain since the last sync (its modification time later than the
//       stamp recorded: vm-lifecycle.js's stampsOf and changedKeys, read at most once per
//       credential-stamp-interval-seconds, 300 by default, and shared with the VMs' own check — so a re-saved item
//       reaches the gateway within the same 5 minutes a VM gets it, ASS-350; the provider then serves it within
//       10 s, no sandbox restarted);
//     - its last health check found a declared kind's Secret missing, or the namespace policy not granting it.
//   Each sync logged with why; one that fails logged, and backed off.
// - The gateway's refusals of the project's sandboxes (its ext-proc's "egress denied" lines, which substrate:health
//   records as egress.denied) are logged once each, "substrate <p> <m>: egress refused: …". A name with no rule is
//   refused at the sandbox's DNS relay, which logs nothing (Substrate's gap, documented in README).
import { backoffDelay, held } from './backoff.js';
import { declaredCredentials } from './vm-credentials.js';
import { changedKeys, stampsOf, CREDENTIAL_STAMP_INTERVAL } from './vm-lifecycle.js';
import { namespaceOf } from './substrate-config.js';
import { egressPolicy, policyHash, INJECTED, SECRETS } from '../substrate/egress.js';

const PHASE = 'substrate';
const memoryOf = ctx => (ctx.memory.substrateCredentials ??= new Map());

// syncReason(ctx, state, project, record, decl) — why the cluster's credentials need a sync now, or ''.
async function syncReason(ctx, state, project, record, decl) {
  const c = record?.credentials;
  if (!c) return 'never synced on this cluster';
  if (c.ok === false) return `the last sync failed (${c.why ?? 'unknown'})`;
  let hash;
  try { hash = policyHash(egressPolicy(project.json, decl, namespaceOf(project.id))); } catch { return ''; }   // a clash between rule sets: substrate:credentials says so
  if (c['policy-hash'] !== hash) return 'its allowlist or declared credentials changed';
  const kinds = INJECTED.filter(k => decl?.[k]?.['keychain-service']);
  const e = record.egress;
  if (e && kinds.length) {
    const missing = kinds.filter(k => !(e.secrets ?? []).includes(SECRETS[k].name));
    if (missing.length) return `its ${missing.join(', ')} Secret${missing.length > 1 ? 's are' : ' is'} missing`;
    if (e.policy && e.policy.granted === false) return 'the credential provider\'s namespace policy does not grant it';
  }
  if (kinds.length) {
    const every = (state.harness?.['credential-stamp-interval-seconds'] ?? CREDENTIAL_STAMP_INTERVAL) * 1000;
    const changed = changedKeys(c.stamps, await stampsOf(ctx, project.id, every)).filter(k => kinds.includes(k));
    if (changed.length) return `${changed.join(', ')} key${changed.length > 1 ? 's' : ''} changed in the keychain`;
  }
  return '';
}

// keepCredentials(ctx, state, project, entry) — one cluster's sync when due, and its new refusals logged (see the
// module comment). Never throws.
export async function keepCredentials(ctx, state, project, entry) {
  const what = `${project.id} ${entry.machine}`, k = `${project.id}/${entry.machine}`, m = memoryOf(ctx);
  const r = m.get(k) ?? { failures: 0, until: 0, denied: new Set() };
  m.set(k, r);
  const record = project.substrate?.[entry.machine];
  for (const d of record?.egress?.denied ?? []) {
    const id = `${d.at} ${d.line}`;
    if (r.denied.has(id)) continue;
    r.denied.add(id);
    ctx.log(PHASE, `${what}: egress refused: ${d.line}`);
  }
  if (r.denied.size > 500) r.denied = new Set([...r.denied].slice(-200));
  if (record?.state !== 'healthy') return;
  const now = ctx.now().getTime();
  if (now < r.until) return;
  const decl = declaredCredentials(ctx.env, project.id);
  let why;
  try { why = await syncReason(ctx, state, project, record, decl); } catch { why = ''; }
  if (!why) return;
  try {
    const out = JSON.parse(String(await ctx.cli(['substrate:credentials', project.id, entry.machine])).trim().split('\n').pop());
    r.failures = 0; r.until = 0;
    ctx.log(PHASE, `${what}: credentials synced into the egress gateway (${why}): ${out.secrets?.length ? out.secrets.join(', ') : 'no credential declared'}${out.sandboxes?.length ? `; egress policy of ${out.sandboxes.join(', ')}` : ''}`);
  } catch (error) {
    const delay = backoffDelay(++r.failures);
    r.until = now + delay;
    ctx.log('error', `${PHASE} ${what}: substrate:credentials failed (${why}; ${r.failures} in a row; next try in ${held(delay)}): ${error.message}`);
  }
}
