# Setting up the Linux box

A full install of a headless compute box for [shared compute](SHARED-COMPUTE.md), from a blank disk to a machine your main computer reaches over ssh. Written for Arch Linux on an x86_64 laptop or desktop with UEFI; the settings carry over to other distributions under their own names.

The result, as it runs on the machine these notes come from: btrfs with snapshots before and after every package change, zswap over a swapfile, no desktop, no sleep, key-only ssh, and about 205 MB of memory used at idle.

Four stages: boot the installer (1), partition and install packages (2), configure (3, `tools/linux-setup/configure-arch.sh`), finish after first boot (4, `tools/linux-setup/post-install.sh`). Then install Claude Code and the shared-compute tools (5).

## 1. Boot the installer

1. Write the Arch ISO to a USB stick, turn Secure Boot off in the firmware, and boot from the stick.
2. Join Wi-Fi: `iwctl`, then `station wlan0 connect "<network>"`. Or plug in a cable.
3. Let your main machine in, so the rest can be done over ssh with copy and paste:

   ```sh
   mkdir -p ~/.ssh && curl -fsSL https://github.com/<your-github-user>.keys > ~/.ssh/authorized_keys
   passwd          # a temporary root password for this live session only
   ip -brief addr  # the address to ssh to
   ```

   Check that the key file holds only your own key before going on.

## 2. Partition and install packages

**This erases the whole disk.** Check the disk name with `lsblk` first.

```sh
DISK=/dev/nvme0n1                      # yours may differ; sda, nvme1n1...
P=${DISK}p                             # partition prefix: ${DISK} for sda-style names
sgdisk --zap-all "$DISK"
sgdisk -n1:0:+1G -t1:ef00 -c1:EFI -n2:0:0 -t2:8300 -c2:root "$DISK"
mkfs.fat -F32 "${P}1"
mkfs.btrfs -f -L root "${P}2"

mount "${P}2" /mnt
for v in @ @home @users @log @pkg @snapshots @swap; do btrfs subvolume create "/mnt/$v"; done
umount /mnt

o=noatime,compress=zstd:1,ssd,discard=async,space_cache=v2
mount -o "$o,subvol=@" "${P}2" /mnt
mkdir -p /mnt/{boot,home,Users,var/log,var/cache/pacman/pkg,.snapshots,swap}
mount -o "$o,subvol=@home" "${P}2" /mnt/home
mount -o "$o,subvol=@users" "${P}2" /mnt/Users          # only if homes will live in /Users
mount -o "$o,subvol=@log" "${P}2" /mnt/var/log
mount -o "$o,subvol=@pkg" "${P}2" /mnt/var/cache/pacman/pkg
mount -o "$o,subvol=@snapshots" "${P}2" /mnt/.snapshots
mount -o "$o,subvol=@swap" "${P}2" /mnt/swap
mount "${P}1" /mnt/boot

# Twice the RAM. btrfs makes it without copy-on-write or compression, as swap needs.
btrfs filesystem mkswapfile --size 32g /mnt/swap/swapfile
```

Why the separate subvolumes: snapshots of `/` then leave out logs, the package cache, swap and your files, so rolling back the system never rolls back your work. `@users` exists so a home under `/Users/<name>` can match a Mac's paths exactly ([why](SHARED-COMPUTE.md#3-same-paths-on-both-machines)).

Packages. The first line is what the setup needs; the second is what a development box for Claude Code wants; pick the CPU microcode and GPU drivers for your hardware.

```sh
pacstrap -K /mnt base linux linux-lts linux-firmware btrfs-progs grub efibootmgr grub-btrfs inotify-tools \
  snapper snap-pac iwd wireless-regdb iw avahi nss-mdns openssh sudo zsh tmux rsync man-db vim \
  base-devel git github-cli jq curl python python-pip python-uv nodejs npm htop lm_sensors \
  smartmontools nvme-cli fwupd reflector mosh iperf3 dosfstools dmidecode inetutils \
  amd-ucode            # or intel-ucode; add nvidia-open nvidia-open-lts nvidia-utils for an NVIDIA GPU
```

`linux-lts` is a second kernel to boot from if an update ever breaks the main one.

## 3. Configure

Still in the live environment:

```sh
openssl passwd -6 > /root/pwhash       # the console password, for the box's own keyboard only
SETUP_USER=you SETUP_HOME=/Users/you SETUP_HOSTNAME=devbox SETUP_TIMEZONE=Europe/Berlin \
  bash configure-arch.sh
```

It sets the locale, hostname and timezone; Wi-Fi through iwd (reusing the network the live session joined) and DHCP on a wired port; mDNS so the box answers as `devbox.local`; your user with passwordless sudo and your key; ssh with keys only and no root login; the lid ignored and every sleep target masked; boot to a console; zswap on the kernel line and `vm.swappiness=150`; systemd-oomd; and GRUB, copied to the firmware's fallback path too, with snapshots in its menu.

Unmount and reboot into the new system: `umount -R /mnt && reboot`, then take the USB stick out.

## 4. Finish after first boot

ssh in as your user (`ssh you@devbox.local`), copy `post-install.sh` over, and run it:

```sh
sudo SETUP_REGDOM=US ./post-install.sh     # your two-letter country
sudo ./post-install.sh --check             # all ok, nothing missing
```

Each step is skipped when already in place:

| Step | Why |
|---|---|
| zswap on the kernel line | Compressed swap in RAM in front of the disk; held 3.9 GB of chat memory in 0.77 GB in a stress test. |
| Console blanks after 60 s | Nothing needs a lit screen. |
| Wi-Fi country | Without it the card may use the world domain and stay on 2.4 GHz. |
| Main kernel first in GRUB | With two kernels installed, keeps `linux` the default and `linux-lts` the fallback. |
| Wi-Fi prefers 5 GHz | Without it the card joined 2.4 GHz at 287 Mbit/s next to a 5 GHz network. |
| Wi-Fi power saving off | Average ping fell from 36 ms to 19 ms. |
| MGLRU thrashing guard | Keeps the last second's working set; the kernel kills instead of thrashing. |
| swappiness 150 | Swap to zswap early; it is cheap while compressed in RAM. |
| Swapfile active | The disk tier behind zswap. |
| systemd-oomd running | Ends a runaway process before the whole box stalls. |
| snapper config for `/` | snap-pac then takes a snapshot before and after every pacman run, and grub-btrfs lists them in the boot menu. |

Firmware settings worth a look, since no script can reach them: a battery charge limit or an "AC use" battery mode on a laptop that stays plugged in, and the latest firmware (`fwupdmgr update` covers many machines).

## 5. Claude Code and the shared-compute tools

- Install Claude Code on the box with Anthropic's installer (see the Claude Code docs) and log in there, on the box itself.
- Install `tools/offload/tmux.conf` as `~/.tmux.conf`.
- On your main machine: an ssh alias for the box, `~/.config/offload/config` with `host=` and `projects=`, `claude-sync` on a 5-minute launchd timer, and `remote` in `~/.config/claude-switchboard/config.json` for the window.
- Then run `OFFLOAD_HOST=devbox tools/offload/test_offload.sh` from your main machine. All 38 checks should pass.

[SHARED-COMPUTE.md](SHARED-COMPUTE.md) has the details of each step.

## Recovering

- **A bad update:** pick an earlier snapshot from the GRUB menu ("Arch Linux snapshots"), check it works, then roll back with `snapper rollback`.
- **A kernel that will not boot:** choose `linux-lts` under "Advanced options" in GRUB.
- **No network after a router change:** the box answers as `<hostname>.local`; for Wi-Fi, run `iwctl` on its own keyboard with the console password.
