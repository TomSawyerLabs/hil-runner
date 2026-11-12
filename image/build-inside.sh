#!/bin/sh
# The build itself, run by build.sh in a privileged debian:trixie arm64 container with
# this directory at /src (read-only) and the output directory at /out.
set -eu
. /src/versions.env
: "${BUILD_DATE:?}" "${BUILD_REV:?}"
NAME=hil-runner-$BUILD_DATE

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  mmdebstrap dosfstools mtools curl gnupg squashfs-tools device-tree-compiler zstd >/dev/null

W=/work
ROOT=$W/root
mkdir -p $W

# --- The Raspberry Pi archive key (same check as BootBob's make-pi-golden.sh) ------------
# Taken from its keyring package and checked against the well-known fingerprint, not the
# copy on the website (SHA-1 binding signature, which apt on trixie refuses).
PIREPO=http://archive.raspberrypi.com/debian
PIKEY=/usr/share/keyrings/raspberrypi-archive-keyring.pgp
curl -fsS "$PIREPO/dists/trixie/main/binary-arm64/Packages.gz" | gunzip > $W/Packages
DEB=$(sed -n "/^Package: raspberrypi-archive-keyring\$/,/^\$/s/^Filename: //p" $W/Packages)
curl -fsS -o $W/keyring.deb "$PIREPO/$DEB"
dpkg-deb -x $W/keyring.deb $W/keyring
mkdir -p "$(dirname "$PIKEY")"
cp "$W/keyring$PIKEY" "$PIKEY"
gpg --show-keys --with-colons "$PIKEY" | grep -q "^fpr:*CF8A1AF502A2AA2D763BAE7E82B129927FA3303E:" || {
  echo "the Raspberry Pi archive key has an unexpected fingerprint" >&2
  exit 1
}

# --- The root filesystem -------------------------------------------------------------------
# Deliberately absent: rpi-eeprom (nothing on this machine may update the boot EEPROM),
# cron, Wi-Fi and Bluetooth firmware, NBD.
PKGS="linux-image-rpi-v8,raspi-firmware,raspberrypi-archive-keyring,initramfs-tools,busybox,zstd"
PKGS="$PKGS,systemd-sysv,systemd-resolved,systemd-timesyncd,udev,dbus,iproute2,ca-certificates,curl"
PKGS="$PKGS,openssh-server,sudo,less,git,build-essential,autoconf,automake,libtool,pkg-config"
PKGS="$PKGS,libusb-1.0-0-dev,usbutils,avrdude,gpiod,python3,python3-venv"
# What the Actions runner needs (its installdependencies.sh, for trixie).
PKGS="$PKGS,libicu76,libkrb5-3,zlib1g,liblttng-ust1t64,libssl3t64"

mmdebstrap --architectures=arm64 --variant=important \
  --setup-hook="mkdir -p \"\$1\$(dirname $PIKEY)\" && cp $PIKEY \"\$1$PIKEY\"" \
  --include="$PKGS" \
  trixie "$ROOT" \
  "deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware" \
  "deb http://deb.debian.org/debian-security trixie-security main contrib non-free non-free-firmware" \
  "deb [signed-by=$PIKEY] $PIREPO trixie main"

in_root() { chroot "$ROOT" "$@"; }
mount -t proc proc "$ROOT/proc"
# systemd-resolved made it a link into /run, which is empty here. Restored below.
rm -f "$ROOT/etc/resolv.conf"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"

# cron is Priority: important. Only cron itself may go.
DEBIAN_FRONTEND=noninteractive in_root apt-get purge -y -qq --autoremove cron cron-daemon-common >/dev/null
for p in rpi-eeprom cron; do
  if in_root dpkg -s "$p" >/dev/null 2>&1; then echo "$p is installed, and must not be" >&2; exit 1; fi
done

# --- Users -----------------------------------------------------------------------------------
# runner: runs the Actions runner and every job. No password, no sudo, no SSH.
# hil: maintenance over SSH (keys only), with sudo. Jobs can't become it.
in_root groupadd -r spi
in_root groupadd -r hilgpio
in_root useradd -m -u 1001 -s /bin/bash -G plugdev,dialout,spi,hilgpio runner
in_root passwd -l runner >/dev/null
in_root useradd -m -s /bin/bash -G sudo hil
in_root passwd -l hil >/dev/null
printf "hil ALL=(ALL) NOPASSWD: ALL\n" > "$ROOT/etc/sudoers.d/010_hil"
chmod 0440 "$ROOT/etc/sudoers.d/010_hil"
in_root visudo -cq
install -d -m 0700 "$ROOT/home/hil/.ssh"
curl -fsS "$ADMIN_KEYS_URL" > "$ROOT/home/hil/.ssh/authorized_keys"
[ -s "$ROOT/home/hil/.ssh/authorized_keys" ] || { echo "no admin keys from $ADMIN_KEYS_URL" >&2; exit 1; }
chmod 0600 "$ROOT/home/hil/.ssh/authorized_keys"
in_root chown -R hil:hil /home/hil/.ssh

# --- Actions runner --------------------------------------------------------------------------
curl -fsSL -o $W/runner.tgz \
  "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz"
echo "$RUNNER_SHA256  $W/runner.tgz" | sha256sum -c --quiet
mkdir -p "$ROOT/opt/actions-runner"
tar -xzf $W/runner.tgz -C "$ROOT/opt/actions-runner"
# The runner reads .env for the environment of every job.
cat > "$ROOT/opt/actions-runner/.env" <<EOF
LANG=C.UTF-8
AVRDUDE=/usr/local/bin/hil-avrdude
TARGET=atmega8u2
ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/hil/job-started
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/libexec/hil/job-completed
EOF
in_root chown -R runner:runner /opt/actions-runner

# --- cpp-coveralls ---------------------------------------------------------------------------
in_root python3 -m venv /opt/cpp-coveralls
in_root /opt/cpp-coveralls/bin/pip install --quiet --no-cache-dir "cpp-coveralls==$CPP_COVERALLS_VERSION"
ln -s /opt/cpp-coveralls/bin/coveralls "$ROOT/usr/local/bin/coveralls"

# --- Our files -------------------------------------------------------------------------------
cp -R /src/rootfs/. "$ROOT/"
chmod 0755 "$ROOT"/usr/local/libexec/hil/* "$ROOT/usr/local/bin/hil-avrdude"
in_root systemctl enable systemd-networkd systemd-resolved systemd-time-wait-sync \
  hil-hat-safe hil-ssh-keygen hil-runner ssh >/dev/null
echo "$NAME ($BUILD_REV)" > "$ROOT/etc/hil/release"

# Nothing machine-specific in a public image: each boot makes its own SSH host keys and
# machine-id, and DHCP names it.
rm -f "$ROOT"/etc/ssh/ssh_host_* "$ROOT/etc/hostname" "$ROOT/var/lib/dbus/machine-id"
: > "$ROOT/etc/machine-id"
: > "$ROOT/etc/fstab"
ln -sf ../run/systemd/resolve/stub-resolv.conf "$ROOT/etc/resolv.conf"
# ip=dhcp makes systemd-network-generator write 71-default.network for every link. Wired only.
ln -sf /dev/null "$ROOT/etc/systemd/network/71-default.network"
printf "LANG=C.UTF-8\n" > "$ROOT/etc/default/locale"

in_root apt-get clean
rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/var/cache/apt/*.bin "$ROOT"/var/log/*.log
umount "$ROOT/proc"

# --- rootfs.sqfs -----------------------------------------------------------------------------
# The firmware partition's contents don't belong in the root: they live on the FAT image.
mksquashfs "$ROOT" $W/rootfs.sqfs -noappend -quiet -comp zstd -Xcompression-level 19 \
  -wildcards -e 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'boot/firmware/*'
SQFS_SHA=$(sha256sum $W/rootfs.sqfs | cut -d' ' -f1)

# --- The initramfs, which carries rootfs.sqfs's hash -----------------------------------------
echo "$SQFS_SHA" > "$ROOT/etc/hil-root.sha256"
install -m 0644 /src/initramfs/hilram "$ROOT/etc/initramfs-tools/scripts/hilram"
install -m 0755 /src/initramfs/hil-root.hook "$ROOT/etc/initramfs-tools/hooks/hil-root"
sed -i 's/^BUSYBOX=.*/BUSYBOX=y/' "$ROOT/etc/initramfs-tools/initramfs.conf"
mount -t proc proc "$ROOT/proc"
in_root update-initramfs -u -k all >/dev/null
umount "$ROOT/proc"

# --- The boot filesystem ---------------------------------------------------------------------
FW="$ROOT/boot/firmware"
for f in start4.elf fixup4.dat kernel8.img initramfs8 bcm2711-rpi-4-b.dtb; do
  [ -f "$FW/$f" ] || { echo "the boot partition has no $f:" >&2; ls "$FW" >&2; exit 1; }
done
mkdir -p "$FW/overlays"
dtc -q -@ -I dts -O dtb -o "$FW/overlays/hil-lockdown.dtbo" /src/overlays/hil-lockdown.dts
cp /src/boot/config.txt "$FW/config.txt"
# Only used when the BootBob image gives no command line of its own, which it must:
# this one can't name the server.
echo "console=tty1 boot=hilram ip=dhcp panic=30 rootwait" > "$FW/cmdline.txt"
cp $W/rootfs.sqfs "$FW/rootfs.sqfs"
printf "%s\nrevision %s\nrootfs.sqfs sha256 %s\n" "$NAME" "$BUILD_REV" "$SQFS_SHA" > "$FW/hil-release.txt"

MB=$(( $(du -sm "$FW" | cut -f1) + 64 ))
rm -f "/out/$NAME.img"
mkfs.vfat -F 32 -n HILBOOT -C "/out/$NAME.img" $((MB * 1024)) >/dev/null
mcopy -s -i "/out/$NAME.img" "$FW"/* ::
cp "$FW/hil-release.txt" "/out/$NAME.txt"
(cd /out && sha256sum "$NAME.img" > "$NAME.img.sha256")
echo "built /out/$NAME.img: ${MB} MiB, rootfs.sqfs $(du -h $W/rootfs.sqfs | cut -f1), kernel $(ls "$ROOT/lib/modules" | tr '\n' ' ')"
