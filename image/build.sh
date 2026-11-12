#!/bin/sh
# Build the RAM-boot runner image for the AVR Test HAT's Raspberry Pi 4.
#
#   image/build.sh <out-dir>
#
# Writes <out-dir>/hil-runner-<date>.img: a bare FAT filesystem holding the Pi firmware,
# the kernel, a small initramfs and rootfs.sqfs (the whole OS). BootBob serves it as a Pi
# image (boot files over TFTP) and as a disk (rootfs.sqfs over HTTP). See README.md.
#
# Runs on any arm64 host with Docker (GitHub's ubuntu-24.04-arm runners, for one). On other
# hosts Docker has to run arm64 binaries through binfmt_misc and qemu, which this script
# checks for and won't set up.

set -eu
OUT=${1:?usage: image/build.sh <out-dir>}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
SRC=$(cd "$(dirname "$0")" && pwd)

docker run --rm --platform linux/arm64 debian:trixie true 2>/dev/null || {
  echo "this Docker can't run arm64 binaries: build on an arm64 host, or register qemu-aarch64 with binfmt_misc" >&2
  exit 1
}

# mmdebstrap mounts /proc in the new root and runs package scripts in a chroot, hence
# --privileged. The container is thrown away afterwards.
docker run --rm --privileged --platform linux/arm64 \
  -v "$SRC:/src:ro" -v "$OUT:/out" \
  -e BUILD_DATE="${BUILD_DATE:-$(date -u +%Y%m%d)}" \
  -e BUILD_REV="${BUILD_REV:-$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)}" \
  debian:trixie sh /src/build-inside.sh
