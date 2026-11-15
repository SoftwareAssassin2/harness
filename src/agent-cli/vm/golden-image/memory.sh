#!/bin/bash
# Golden image step (vm:build-golden), shared by every project (ASS-421): boots
# the guest kernel with init_on_free=1, so every page the guest frees is zeroed
# as it is freed. Lima's vz VMs cannot give memory back to the Mac: Lima 2.2
# attaches Apple's balloon device but never sets its target, and the device
# offers no free page reporting. A page the guest has touched stays the VM's,
# and macOS compresses it when memory runs short. A zeroed page compresses to
# nothing (XNU stores a page of one repeated value with no data), so a guest's
# free memory, zeroed, costs the Mac next to nothing once compressed, where a
# freed page keeping its old contents costs as much as any other.
# Debian's kernel already zeroes every page as it is allocated (init_on_alloc,
# its default); with init_on_free on, it skips that (mm/page_alloc.c
# post_alloc_hook), so the work moves rather than doubles. The kernel also clears
# all memory once at boot, so a VM's Mac footprint starts at its full memory: size
# until macOS compresses those zero pages.
# Takes effect at the restart that follows. An image without update-grub is left
# alone, saying so. GRUB_D and GRUB_CFG override the paths, for tests.
set -euo pipefail
grub_d="${GRUB_D:-/etc/default/grub.d}" grub_cfg="${GRUB_CFG:-/boot/grub/grub.cfg}"
command -v update-grub >/dev/null || [[ -x /usr/sbin/update-grub ]] || { echo "memory: no update-grub in this image; init_on_free not set"; exit 0; }
sudo install -d -m 0755 "$grub_d"
printf '# ASS-421: zero freed pages, so a VM'"'"'s free memory costs the Mac next to nothing once compressed.\nGRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX init_on_free=1"\n' \
  | sudo tee "$grub_d/90-harness-memory.cfg" >/dev/null
sudo update-grub 2>&1 | tail -n 3
sudo grep -q 'init_on_free=1' "$grub_cfg" || { echo "memory: $grub_cfg has no init_on_free=1 after update-grub" >&2; exit 1; }
echo "memory: the kernel boots with init_on_free=1 from the next start"
