#!/bin/bash
# Stage 3 of docs/LINUX-SETUP.md: configure a freshly pacstrapped Arch Linux install as a
# headless compute box. Run as root in the Arch ISO live environment, with the new system
# mounted at /mnt. GRUB with btrfs snapshots in the menu, key-only SSH, zswap over a swapfile,
# lid ignored, no sleep, and a user whose home path can match your main machine.
#
# Settings (environment):
#   SETUP_USER        required: the login name, ideally the same as on your main machine
#   SETUP_HOME        default /home/$SETUP_USER; use /Users/<name> to match a Mac's paths
#   SETUP_HOSTNAME    default devbox
#   SETUP_TIMEZONE    default UTC, for example Europe/Berlin
#   SETUP_SHELL       default /bin/zsh
#   SETUP_PWHASH_FILE default /root/pwhash: a crypt hash for the console password
#                     (openssl passwd -6 > /root/pwhash). SSH never accepts passwords.
# Expects: /root/.ssh/authorized_keys holding your main machine's public key, and the Wi-Fi
# profile the live session joined in /var/lib/iwd, so the passphrase is never typed again.
set -euo pipefail
U=${SETUP_USER:?set SETUP_USER to the login name}
H=${SETUP_HOME:-/home/$U}
HOST=${SETUP_HOSTNAME:-devbox}
TZONE=${SETUP_TIMEZONE:-UTC}
SH=${SETUP_SHELL:-/bin/zsh}
PWHASH=$(cat "${SETUP_PWHASH_FILE:-/root/pwhash}")
[ -f "/mnt/usr/share/zoneinfo/$TZONE" ] || { echo "configure: no timezone $TZONE" >&2; exit 1; }
[ -s /root/.ssh/authorized_keys ] || { echo "configure: put your public key in /root/.ssh/authorized_keys first" >&2; exit 1; }

grep -q '/swap/swapfile' /mnt/etc/fstab 2>/dev/null || { genfstab -U /mnt >> /mnt/etc/fstab; echo '/swap/swapfile none swap defaults 0 0' >> /mnt/etc/fstab; }

# Wi-Fi: reuse the profile the live session already joined.
if ls /var/lib/iwd/*.psk >/dev/null 2>&1; then
  install -d -m 700 /mnt/var/lib/iwd
  cp -p /var/lib/iwd/*.psk /mnt/var/lib/iwd/
  chmod 600 /mnt/var/lib/iwd/*.psk
fi

# Your main machine's key: the only way in over the network.
install -d -m 700 "/mnt$H/.ssh"
cp /root/.ssh/authorized_keys "/mnt$H/.ssh/authorized_keys"

arch-chroot /mnt /bin/bash -s "$U" "$PWHASH" "$H" "$HOST" "$TZONE" "$SH" <<'CHROOT'
set -euo pipefail
U=$1; PWHASH=$2; H=$3; HOST=$4; TZONE=$5; SH=$6

ln -sf "/usr/share/zoneinfo/$TZONE" /etc/localtime
hwclock --systohc
sed -i 's/^#en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
locale-gen >/dev/null
echo LANG=en_US.UTF-8 > /etc/locale.conf
echo KEYMAP=us > /etc/vconsole.conf
echo "$HOST" > /etc/hostname
printf '127.0.0.1 localhost\n::1 localhost\n127.0.1.1 %s.localdomain %s\n' "$HOST" "$HOST" > /etc/hosts

# Network: iwd does Wi-Fi and its own DHCP; networkd takes a wired port if a cable is plugged in.
mkdir -p /etc/iwd /etc/systemd/network /etc/systemd/resolved.conf.d
printf '[General]\nEnableNetworkConfiguration=true\n\n[Network]\nNameResolvingService=systemd\n' > /etc/iwd/main.conf
printf '[Match]\nName=en*\n\n[Network]\nDHCP=yes\n\n[DHCPv4]\nRouteMetric=100\n' > /etc/systemd/network/20-wired.network
# avahi answers <host>.local; resolved stays out of mDNS so the two don't fight over port 5353.
printf '[Resolve]\nMulticastDNS=no\n' > /etc/systemd/resolved.conf.d/10-no-mdns.conf
sed -i 's/^hosts:.*/hosts: mymachines mdns_minimal [NOTFOUND=return] resolve [!UNAVAIL=return] files myhostname dns/' /etc/nsswitch.conf

# The user. A home path that matches your main machine makes every absolute path, and Claude
# Code's per-project folders (named after the path), the same on both.
mkdir -p "$(dirname "$H")"
id "$U" >/dev/null 2>&1 || useradd -d "$H" -s "$SH" -G wheel "$U"
echo "$U:$PWHASH" | chpasswd -e
cp -rn /etc/skel/. "$H/" 2>/dev/null || true
touch "$H/.zshrc"
chown -R "$U:$U" "$H"
chmod 700 "$H/.ssh"; chmod 600 "$H/.ssh/authorized_keys"
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$U" > "/etc/sudoers.d/90-$U"
chmod 440 "/etc/sudoers.d/90-$U"
visudo -c >/dev/null
passwd -l root >/dev/null

# SSH: key only, no root, no passwords.
grep -q '^Include /etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
mkdir -p /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAuthenticationMethods publickey\n' > /etc/ssh/sshd_config.d/10-keyonly.conf
ssh-keygen -A >/dev/null
sshd -t

# Lid closed and on the charger: keep running. Nothing may suspend it.
mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\nKillUserProcesses=no\n' > /etc/systemd/logind.conf.d/10-compute-box.conf
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target >/dev/null 2>&1
systemctl set-default multi-user.target >/dev/null 2>&1

# Memory: zswap (kernel command line below) over the swapfile; swap is cheap when compressed in RAM.
printf 'vm.swappiness = 150\n' > /etc/sysctl.d/90-swap.conf

# pacman: parallel downloads, colour.
sed -i 's/^#\?ParallelDownloads.*/ParallelDownloads = 10/; s/^#Color/Color/' /etc/pacman.conf

systemctl enable iwd systemd-networkd systemd-resolved systemd-timesyncd sshd avahi-daemon fstrim.timer systemd-oomd >/dev/null 2>&1

# Boot: GRUB, with btrfs snapshots listed in the menu by grub-btrfs.
pacman -S --noconfirm --needed grub efibootmgr grub-btrfs inotify-tools >/dev/null
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=3/' /etc/default/grub
sed -i 's|^GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT="loglevel=3 zswap.enabled=1 zswap.compressor=zstd zswap.max_pool_percent=35 zswap.shrinker_enabled=1"|' /etc/default/grub
grub-install --target=x86_64-efi --efi-directory=/boot --bootloader-id=GRUB >/dev/null 2>&1
# A second copy at the firmware fallback path: some laptop firmware drops custom boot entries.
grub-install --target=x86_64-efi --efi-directory=/boot --removable >/dev/null 2>&1
mkinitcpio -P >/dev/null 2>&1
grub-mkconfig -o /boot/grub/grub.cfg 2>&1 | grep -E 'Found linux image|Found initrd' || true
systemctl enable grub-btrfsd >/dev/null 2>&1
echo CHROOT-DONE
CHROOT
# arch-chroot bind-mounts the live resolv.conf, so the link is made from outside.
ln -sf ../run/systemd/resolve/stub-resolv.conf /mnt/etc/resolv.conf
ls -l /mnt/etc/resolv.conf
echo "configure: done. Reboot into the new system, then run post-install.sh there."
