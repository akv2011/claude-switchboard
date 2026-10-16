#!/bin/bash
# Stage 4 of docs/LINUX-SETUP.md: the settings that finish a compute box after its first boot.
# Each step is idempotent. Run on the box:
#   sudo SETUP_REGDOM=US ./post-install.sh           apply what is missing
#   sudo ./post-install.sh --check                    report only, change nothing (root reads /boot)
#
# Settings (environment):
#   SETUP_REGDOM     two-letter Wi-Fi country (US, DE, GB...). Without it the kernel uses the
#                    world domain and a card may stay on 2.4 GHz at a fraction of the speed.
#   SETUP_SWAP_GB    swapfile size when none exists, default twice the RAM
#   SETUP_SNAPSHOTS  snapper snapshots kept, default 10
set -uo pipefail
check=0
[ "${1:-}" = "--check" ] && check=1
REGDOM=${SETUP_REGDOM:-}
ram_gb=$(awk '/MemTotal/ { printf "%d", $2 / 1048576 + 0.5 }' /proc/meminfo)
SWAP_GB=${SETUP_SWAP_GB:-$((ram_gb * 2))}
KEEP=${SETUP_SNAPSHOTS:-10}
missing=0

say() { printf '%-8s %s\n' "$1" "$2"; }
# step <label> <test command> <apply command>: run the test; if it fails, apply (unless --check).
step() {
  local label=$1 test=$2 apply=$3
  if bash -c "$test" >/dev/null 2>&1; then say ok "$label"; return; fi
  if [ "$check" = 1 ]; then say MISSING "$label"; missing=$((missing + 1)); return; fi
  if bash -c "$apply"; then say applied "$label"; else say FAILED "$label"; missing=$((missing + 1)); fi
}
[ "$check" = 1 ] || [ "$(id -u)" = 0 ] || { echo "post-install: run with sudo, or pass --check" >&2; exit 2; }
grub=/etc/default/grub

# zswap: compressed swap in RAM in front of the disk swapfile (set by configure-arch.sh).
step "zswap on the kernel line" "grep -q 'zswap.enabled=1' $grub" \
  "sed -i 's|^GRUB_CMDLINE_LINUX_DEFAULT=\"\\(.*\\)\"|GRUB_CMDLINE_LINUX_DEFAULT=\"\\1 zswap.enabled=1 zswap.compressor=zstd zswap.max_pool_percent=35 zswap.shrinker_enabled=1\"|' $grub && touch /tmp/.grub-changed"

# The console blanks after 60 s: a headless box needs no lit screen.
step "console blanks after 60 s" "grep -q 'consoleblank=60' $grub" \
  "sed -i 's|^GRUB_CMDLINE_LINUX_DEFAULT=\"\\(.*\\)\"|GRUB_CMDLINE_LINUX_DEFAULT=\"\\1 consoleblank=60\"|' $grub && touch /tmp/.grub-changed"

# Wi-Fi country: the band and power the card may use.
if [ -n "$REGDOM" ]; then
  step "Wi-Fi country $REGDOM" "grep -q 'cfg80211.ieee80211_regdom=$REGDOM' $grub" \
    "sed -i 's|^GRUB_CMDLINE_LINUX_DEFAULT=\"\\(.*\\)\"|GRUB_CMDLINE_LINUX_DEFAULT=\"\\1 cfg80211.ieee80211_regdom=$REGDOM\"|' $grub && touch /tmp/.grub-changed"
else
  step "Wi-Fi country set" "grep -q 'cfg80211.ieee80211_regdom=' $grub" "echo 'set SETUP_REGDOM to apply this' >&2; false"
fi

# With linux and linux-lts both installed, keep the main kernel first in the menu.
if [ -e /boot/vmlinuz-linux-lts ]; then
  step "main kernel first in GRUB" "grep -q '^GRUB_TOP_LEVEL=\"/boot/vmlinuz-linux\"' $grub" \
    "echo 'GRUB_TOP_LEVEL=\"/boot/vmlinuz-linux\"' >> $grub && touch /tmp/.grub-changed"
fi

# iwd prefers 5 GHz: without it a card joined 2.4 GHz at 287 Mbit/s next to a 5 GHz network.
step "Wi-Fi prefers 5 GHz" "grep -q '^BandModifier5GHz=2.0' /etc/iwd/main.conf" \
  "printf '\n[Rank]\nBandModifier5GHz=2.0\n' >> /etc/iwd/main.conf"

# Wi-Fi power saving off: it cut average ping from 36 ms to 19 ms.
step "Wi-Fi power saving off" "test -f /etc/udev/rules.d/81-wifi-powersave-off.rules" \
  "printf '%s\n' 'ACTION==\"add\", SUBSYSTEM==\"net\", KERNEL==\"wlan*\", RUN+=\"/usr/bin/iw dev \$name set power_save off\"' > /etc/udev/rules.d/81-wifi-powersave-off.rules"

# Thrashing guard: MGLRU keeps the last second's working set and kills instead of thrashing.
step "MGLRU thrashing guard (min_ttl_ms 1000)" "grep -q 'min_ttl_ms - - - - 1000' /etc/tmpfiles.d/mglru-min-ttl.conf" \
  "printf 'w- /sys/kernel/mm/lru_gen/min_ttl_ms - - - - 1000\n' > /etc/tmpfiles.d/mglru-min-ttl.conf && systemd-tmpfiles --create /etc/tmpfiles.d/mglru-min-ttl.conf"

step "swappiness 150" "grep -q 'vm.swappiness = 150' /etc/sysctl.d/90-swap.conf" \
  "printf 'vm.swappiness = 150\n' > /etc/sysctl.d/90-swap.conf && sysctl -q -p /etc/sysctl.d/90-swap.conf"

# The swapfile behind zswap. On btrfs it must be made with btrfs's own command (no CoW, no compression).
step "swapfile active" "swapon --show=NAME --noheadings | grep -q '^/swap/swapfile'" \
  "test -e /swap/swapfile || btrfs filesystem mkswapfile --size ${SWAP_GB}G /swap/swapfile; swapon /swap/swapfile"

step "systemd-oomd running" "systemctl is-active --quiet systemd-oomd" "systemctl enable --now systemd-oomd"

# Snapshots of / before and after every pacman run (snap-pac), listed in the GRUB menu (grub-btrfs).
step "snapper config for /" "sudo -n snapper list-configs 2>/dev/null | grep -q '^root '" \
  "snapper -c root create-config / && sed -i 's/^NUMBER_LIMIT=.*/NUMBER_LIMIT=\"$KEEP\"/' /etc/snapper/configs/root"

if [ -e /tmp/.grub-changed ]; then
  rm -f /tmp/.grub-changed
  grub-mkconfig -o /boot/grub/grub.cfg >/dev/null 2>&1 && say applied "GRUB menu rebuilt (takes effect at next boot)"
fi
if [ "$check" = 1 ]; then echo "$missing missing"; exit $((missing > 0)); fi
[ "$missing" = 0 ] && echo "post-install: done" || { echo "post-install: $missing step(s) failed" >&2; exit 1; }
