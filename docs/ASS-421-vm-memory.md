# ASS-421: making running VMs cost less memory

Spike findings, 2026-11-12. Lima 2.2.1 (Homebrew), macOS 26 on Apple Silicon,
`vz` VMs. The guest checks ran read-only on a client project's running VM
(10 GiB, 8 CPUs, Debian 13, kernel 6.12.116, up 2h58m on a ticket's work).
Nothing in that VM was changed.

Re-checked 2026-11-13 against Lima 2.3.0, which Homebrew had installed by
then: nothing below changed (see the 2.3.0 notes in section 1).

## 1. Can Lima's vz driver enable a memory balloon or free page reporting?

**No, not in any way a template or `limactl` can reach.**

- Lima 2.2.1's vz driver always attaches Apple's
  `VZVirtioTraditionalMemoryBalloonDevice`
  (`pkg/driver/vz/vm_darwin.go`, `attachOtherDevices`, at tag v2.2.1:
  `vz.NewVirtioTraditionalMemoryBalloonDeviceConfiguration()` then
  `SetMemoryBalloonDevicesVirtualMachineConfiguration`). Nothing in Lima ever
  calls `SetTargetVirtualMachineMemorySize`, so the balloon stays at zero.
  The installed binary has the Code-Hex/vz setter compiled in, but the only
  Lima reference is the method promoted onto `virtualMachineWrapper`.
- No template key: `limatype.VZOpts` in v2.2.1 has only `rosetta` and
  `diskImageFormat`. `default.yaml` under
  `/opt/homebrew/share/lima/templates` documents only `memory:`, and no
  template or example mentions a balloon.
- No command: `limactl memory` gives `unknown command "memory"`. The
  experimental `limactl memory get|set` PR (lima-vm/lima#4226) was closed
  without being merged. The adaptive-ballooning PR (#4828, adding
  `vmOpts.vz.memoryBalloon: {enabled, min, idleTarget, cooldown}`) has been
  open since 2026-04-10. Issue #2789 ("Memory is not being freed on VZ") is
  still open.
- **Lima 2.3.0 (re-checked 2026-11-13) is the same.** `vm_darwin.go` at
  v2.3.0 still attaches the balloon (`NewVirtioTraditionalMemoryBalloonDeviceConfiguration`,
  line 916) and never sets a target: a code search of lima-vm/lima for
  `SetTargetVirtualMachineMemorySize` finds nothing. `VZOpts` at v2.3.0 still
  has only `rosetta` and `diskImageFormat`. The installed 2.3.0 binary's only
  Lima balloon symbol is `virtualMachineWrapper.MemoryBalloonDevices` (the
  promoted method), it has no `idleTarget` string, the 2.3.0
  `default.yaml`'s `vz:` block has no balloon key, and `limactl memory` is
  still an unknown command. #4828 is still open, unmerged; #2789 is still
  open; #4226 is closed unmerged.
- Only the process that owns the `VZVirtualMachine` (Lima's host agent) can
  set the target, so the harness can't drive the balloon from outside.
- **Free page reporting isn't offered by Apple's device.** In the guest,
  `virtio_balloon` is loaded (`lsmod`: `virtio_balloon 28672 0`) and bound
  to `virtio9` (device id 5). Its negotiated feature bits
  (`/sys/bus/virtio/devices/virtio9/features`, bit 0 first) are
  `1010000…`: bit 0 `MUST_TELL_HOST` and bit 2 `DEFLATE_ON_OOM` only. Bit 1
  `STATS_VQ`, bit 3 `FREE_PAGE_HINT` and bit 5 `REPORTING` are all 0. The
  guest kernel could report free pages (`CONFIG_PAGE_REPORTING=y`), but the
  device doesn't ask for it.
- Another route would be a different VM driver. Lima 2.2.1 ships
  `lima-driver-krunkit` (libkrun has a balloon with free page reporting), but
  krunkit isn't installed. Moving to it means a new `vmType` for every image
  and is out of this ticket's scope.

## 2. Does dropping the guest's page cache shrink the host footprint?

**No, by mechanism. The host was not measured: see "Experiment not run"
below.**

- With no balloon target and no free page reporting, the Mac never learns
  that a guest page is free. `echo 3 > /proc/sys/vm/drop_caches` only moves
  pages from the guest's Cached to its MemFree. They stay resident in the VM
  process with their old contents.
- Host evidence on the running VM's Virtualization process
  (`footprint -p <pid>`): `Footprint: 10 GB`, `phys_footprint_peak: 10 GB`,
  almost all of it "app-specific tag 1" (the guest RAM). Its `ps` RSS was
  849 MiB, and `top` showed `MEM 10G, CMPRS 18G`. So the whole 10 GiB guest
  had been touched, and most of it now sits in the compressor or swap. The
  guest itself had only 1.8 GiB used, 3.4 GiB cache and 4.9 GiB free
  (`free -m`).
- The guest's own reclaim shows memory filled up with cache that wasn't
  needed again. `/proc/vmstat` had `pgsteal_file 2548277` (about 9.7 GiB of
  page cache reclaimed over 3 hours) against `workingset_refault_file 121855`
  (about 476 MiB, 4.8% read back). `pgsteal_anon 0`, `oom_kill 0`, PSI
  `memory full total=6084652` µs (about 6 s of full stalls in 3 h). Dropping
  that cache earlier would only have handed the Mac pages it couldn't take
  back.
- **What does help is zeroed free pages.** macOS's compressor stores a page
  of one repeated value with no data: on this Mac
  `vm.compressor.svp.zval_compressions: 178443332`. A guest page that is
  free *and zero* costs next to nothing once compressed. A free page that
  keeps its old contents costs as much as a used one. The guest kernel today
  has `mem auto-init: stack:all(zero), heap alloc:on, heap free:off`, so it
  zeroes pages when they are allocated, not when they are freed, and its
  4.9 GiB of free memory still holds old data.

## 3. Peak memory of a client project's build and test run

- **The measured figure is ASS-141's** (in the project's golden-image
  template.yaml): `vm:test-repos <project>` in a fresh clone at 16 GiB, with
  the guest's `/proc/meminfo` sampled every 5 s. Peak MemTotal minus
  MemAvailable was **7.99 GiB** (anon 7.43 GiB), plus 6.47 GiB of
  reclaimable page cache, with no swap. That is why it is sized at 10 GiB.
- **Today's VM (read-only, cgroup v2 high-water marks since boot,
  `memory.peak`):** `system.slice` 6774 MiB (Docker and containerd: image
  pulls, the test Postgres containers, 7 exited test-run containers),
  `user.slice` 5786 MiB (the agent session: an nx daemon at 541 MiB RSS and
  a second at 283 MiB, builds and tests). These peaks include page cache
  charged to each slice and happened at different times, so they can't be
  added. Current anon is 1.1 GiB. There was no OOM, and the 4.8% refault
  rate says the 10 GiB was enough.
- **Estimate: a client project's build and test run needs about 8 GiB (anon about
  7.5 GiB). Anything beyond that is page cache, which fills whatever is
  given.** Confidence: medium-high for the 8 GiB, which is ASS-141's
  measurement and agrees with today's figures. Today's VM can't give its own
  anon peak (cgroup peaks count page cache), so it only confirms the figure,
  it doesn't measure it again.

## Experiment not run

The plan was to measure the host footprint of a scratch VM before and after
dropping caches and zeroing free memory. The scratch VM had to be in a
temporary LIMA_HOME under the ticket's worktree, and Lima refused to create
it: `instance name 't' too long: …/.l/t/ssh.sock.1234567890123456 must be
less than UNIX_PATH_MAX=104 characters, but is 114`. The worktree path alone
is 84 characters, and Lima resolves symlinks. To run it later, from a short
LIMA_HOME (e.g. `/tmp/l`), use a 3 GiB VM from the cached Debian 13 image.
Fill the page cache (`dd` 2 GiB from `/dev/urandom` to disk, then read it
back), note the VM process's RSS and `top -stats mem,cmprs` over a few
minutes of host pressure, then `drop_caches`. Then repeat with the
`init_on_free=1` kernel the change below adds.

## Recommendation and what was built (AC2)

1. **Built:** a shared golden-image step, `src/agent-cli/vm/golden-image/memory.sh`,
   run after `desktop.sh` and before the build's restart. It adds
   `init_on_free=1` to the guest kernel's command line
   (`/etc/default/grub.d/90-harness-memory.cfg`, then `update-grub`, then it
   checks `grub.cfg`). Every page the guest frees is then zero, so the Mac's
   compressor holds the guest's free memory (4.9 GiB in today's VM) for
   almost nothing. The kernel skips its allocation-time zeroing when
   free-time zeroing is on (`post_alloc_hook`:
   `init = !want_init_on_free() && want_init_on_alloc(…)`, v6.12), so the
   zeroing moves rather than doubles.
   - **Cost:** with `init_on_free` on, the kernel clears all memory once at
     boot ("mem auto-init: clearing system memory may take some time…"). A
     freshly started VM therefore touches its whole `memory:` at once, as
     zero pages, until macOS compresses them. Expect a burst at each VM start
     instead of the slow climb to full footprint VMs make today. While
     uncompressed, they lower macOS's free memory
     (`kern.memorystatus_level`), which the memory hold and the seat check
     (ASS-404, ASS-420) read, until the compressor takes them.
   - **What the saving shows in, and what it doesn't.** The memory hold's
     per-VM need (ASS-419, `host-memory.js`) is the VM process's
     `phys_footprint`, compressed pages included. XNU counts a compressed
     page there as a whole page however small it compressed, so a VM's
     footprint will still read its full `memory:` (it already does: 10 GB
     today), and the need, capped at the configured size, is unchanged. The
     saving is in the memory the compressor itself occupies (`vm_stat`'s
     "Pages occupied by compressor" against "Pages stored in compressor"),
     and so in macOS's free memory and its pressure level, which are what
     the hold and the seat check compare the need against. So more VMs fit
     under the same need.
   - **Confidence:** each step of the mechanism has evidence, but the
     end-to-end saving on the Mac hasn't been measured (see above). Measure
     it on the first rebuilt image: `vm_stat`'s pages occupied by the
     compressor against pages stored in it, with VMs running a ticket's
     work, against the same figures with today's images (a VM's footprint
     alone won't show it, see above).
   - Because a shared step is an input of every golden image, merging this
     makes every project's image stale, and check-health raises a
     fast-tracked "Rebuild golden-<project>" ticket for each.
2. **Not built: dropping the guest's page cache when a VM goes idle.**
   Without `init_on_free` it gains nothing (section 2). And since ASS-418 a
   ticket's VM no longer sits idle between steps: every grouped step that
   needs no VM says `"vm": "stopped"`, so control stops the VM, and a
   stopped VM costs the Mac nothing. What is left is a running VM's page
   cache within a step, which the guest reclaims as it needs memory; with
   `init_on_free` each reclaimed page is zeroed as it is freed. A drop
   between steps would therefore act only on a VM about to be stopped
   anyway, so it is not worth a periodic in-VM command.
3. **Watch upstream:** lima-vm/lima#4828 (`vmOpts.vz.memoryBalloon`). Once it
   is released it can be set in each project's template: the real fix, since
   it gives memory back without relying on compression.

## Template changes for each local project

None are needed for (1): it is a shared step, not a template setting.
`memory:` per project:

| Project | `memory:` now | Recommendation |
|---|---|---|
| client project | 10GiB | Keep. The measured peak is 7.99 GiB (anon 7.43 GiB) and today's VM fit with no OOM. 9GiB would save 1 GiB per VM with about 12% headroom. Not advised while one ticket's run can reach 8 GiB. |
| harness | 4GiB | Keep. No measurement. |
| family | 4GiB | Keep. No measurement. |
| software-assassin | 4GiB | Keep. No measurement. |
