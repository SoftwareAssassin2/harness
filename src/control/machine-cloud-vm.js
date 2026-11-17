// The machine layer's cloud-VM backend (ASS-481 AC2; machine.js): a folder
// on one of a project's cloud VMs (plain GCP Compute Engine VMs) — its shared
// root, <home>/harness, which every ticket variation's steps use in turn, as
// on a workstation (ASS-468). agent-cli/machine-cloud-vm.bash is the same
// backend for the bash commands, and agent-cli/cloud-vm.bash says how the VM
// is reached: one OpenSSH master through the IAP tunnel, with OS Login,
// opened by workstation:connect (which starts or resumes the VM first and
// waits for its SSH). Its machine is cloud-vm:<project>:<id>:<folder>, here
// the name <project>:<id>:<folder>. Once the connection is open, a session,
// a copy and a signal go over it exactly as over a workstation's
// (workstation-connection.js sshArgv, keyed by the project and the id), so
// they are the workstation backend's; status too. Stop does nothing: the
// harness never stops a cloud VM — it stops itself after 60 idle minutes
//.
import { workstation } from './machine-workstation.js';

export const cloudVm = {
  command: workstation.command,
  stopMarked: workstation.stopMarked,
  copyIn: workstation.copyIn,
  copyOut: workstation.copyOut,
  // statuses() — none listed: a cloud VM's state is its connection's live data (workstations.json), as a workstation's.
  statuses: async () => new Map(),
  status: workstation.status,
  // stop() — nothing: the harness never stops a cloud VM.
  stop: workstation.stop,
};
