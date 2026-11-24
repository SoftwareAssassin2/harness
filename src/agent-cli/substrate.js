// substrate.bash's reading of a project's Substrate clusters (ASS-533), in
// node to share control's src/control/substrate-config.js rather than restate
// it in jq:
//
//   node substrate.js <projects folder> <project>             every entry, one JSON line each
//   node substrate.js <projects folder> <project> <machine>   that machine's entry, one JSON line
//
// Each entry as projectSubstrate gives it: { machine, kind, host, cluster,
// namespace, the costs and worker shape, a GKE entry's gcp-project, location
// and cluster }. Exits 1, the reason on stderr, without the project, when its
// substrate list is wrong (each bad field named), or when it has no entry for
// <machine>. A GKE entry has `refused`: why substrate:up refuses it until the
// operator approves GKE.
import { projectSubstrate, GKE_REFUSED } from '../control/substrate-config.js';

try {
  const [dir, project, machine] = process.argv.slice(2);
  // A GKE entry carries why setup refuses it (AC1), for the commands to say.
  const entries = projectSubstrate(dir, project).map(e => (e.kind === 'gke' ? { ...e, refused: GKE_REFUSED } : e));
  if (machine === undefined) for (const e of entries) process.stdout.write(`${JSON.stringify(e)}\n`);
  else {
    const e = entries.find(x => x.machine === machine);
    if (!e) throw new Error(`no substrate entry for machine '${machine}' in its dev-environments.substrate.clusters (it has ${entries.map(x => x.machine).join(', ') || 'none'})`);
    process.stdout.write(`${JSON.stringify(e)}\n`);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
