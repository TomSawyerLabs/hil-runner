# hil-runner

Self-hosted GitHub Actions runners for hardware-in-the-loop tests, on diskless Raspberry
Pis netbooted by [BootBob](https://github.com/cinderblock/BootBob). The first machine is
the Pi 4 with the v1 AVR Test HAT ([TomSawyerLabs/mcu-hil](https://github.com/TomSawyerLabs/mcu-hil),
branch `v1-archive`) that runs [dfu-programmer](https://github.com/dfu-programmer/dfu-programmer)'s
tests against a real ATmega8u2.

Every job gets a freshly booted machine:

1. The Pi boots from BootBob over the network. TFTP brings the kernel and a small
   initramfs. The initramfs downloads the whole OS (`rootfs.sqfs`) over HTTP into RAM,
   checks its hash, and runs it read-only under a RAM overlay. There is no disk.
2. `hil-runner.service` asks the broker for a one-job runner config. The broker holds the
   GitHub credentials and knows the Pi by its address, so the image holds no secrets and
   can be public.
3. The runner takes one job. Its start hook power-cycles the AVR into its DFU bootloader.
4. The job ends, and the Pi reboots. Nothing it did survives.

## Layout

| Path | What |
| --- | --- |
| `image/build.sh` | Builds `hil-runner-<date>.img` in an arm64 Docker container |
| `image/build-inside.sh` | The build: Debian trixie arm64 plus Raspberry Pi's kernel and firmware |
| `image/versions.env` | Pinned inputs: runner version and hash, cpp-coveralls, admin keys |
| `image/initramfs/` | The `boot=hilram` initramfs script: fetch, verify, mount |
| `image/rootfs/` | Files laid over the root: services, HAT control, avrdude config, udev rules |
| `image/boot/config.txt` | The Pi firmware config |
| `image/overlays/hil-lockdown.dts` | The kernel holds GPIO 0/1 so jobs can't reach the HAT ID EEPROM |
| `broker/` | The JIT config broker: Bun/TypeScript, published as `ghcr.io/tomsawyerlabs/hil-runner-broker` |

## Building

On an arm64 host with Docker: `image/build.sh out`. CI builds every push on GitHub's arm64
runners, and a `v*` tag publishes the image as a release.

The output is a bare FAT filesystem. BootBob reads boot files out of it directly.

## Serving it from BootBob

1. Upload it still compressed, as the release has it:
   `curl -T hil-runner-<date>.img.zst -H 'Content-Encoding: zstd' http://<bootbob>:8067/api/disks/hil-runner-<date>.img`.
2. Make a BootBob image with that file as **both** its Pi boot files and its disk, not
   copy-on-write. The disk is what serves `rootfs.sqfs` over HTTP.
3. Give it this command line:

   ```text
   console=tty1 boot=hilram ip=dhcp panic=30 rootwait hil.root=http://{server}:8067/boot/disk/<image>/rootfs.sqfs?mac={mac} hil.broker=http://<broker>
   ```

   There's no serial console: GPIO 14/15 belong to the AVR's UART.
4. Assign the Pi to it.

On the Pi's boot interface, BootBob should offer only `tftp` and `http`, not `nbd`. The Pi
doesn't use NBD, and an NBD export of a disk that isn't copy-on-write is writable.

## The broker

A small HTTP service that hands each configured machine a one-job runner config. Its one
endpoint is `GET /v1/jitconfig`, plus `/healthz`. It knows a machine only by the address the
request came from, so it must sit where machines reach it directly, with no proxy in between.
It ignores `X-Forwarded-For` and similar headers on purpose.

For each request, it:

1. refuses any address that isn't in its config, with `403`;
2. allows each machine one request per `minIntervalSeconds`, otherwise answering `429`;
3. deletes any runner still registered under that machine's name, since a machine asking
   again has rebooted. If that runner is busy, it answers `409` and touches nothing;
4. calls `POST /orgs/{org}/actions/runners/generate-jitconfig` and returns the encoded config.

### The GitHub App

One App serves every project. It's owned by TomSawyerLabs and installed on each org that
has a machine.

- **Permission:** one organization permission, *Self-hosted runners: Read and write*,
  and nothing else.
- **Who can install it:** any account, since it has to reach orgs TomSawyerLabs doesn't
  own. That's safe: installing it somewhere gives that org nothing. The broker only
  registers runners for the orgs its config names.
- **Machines:** each entry in `clients` names its `org`. A machine serves one org, and the
  broker gets a separate installation token for each org.
- **Key:** the App's private key goes in the file `github.privateKeyFile` names.
- **Org setting:** org runners in a group serve public repos only if that group allows
  public repositories (org Settings, Actions, Runner groups).
- **Repos under a user account** can't use org runners. They'd need repo-level runners,
  and the App would need *Administration: Read and write* on those repos. The broker
  doesn't do that; move such a project into an org instead.

### Config and tests

Config is one JSON file (`BROKER_CONFIG`, default `/config/broker.json`). See
`broker/broker.example.json`.

Run the tests with `cd broker && bun install && bun test && bun run typecheck`.

## On the machine

| Path | What |
| --- | --- |
| `hat off\|on\|reset` (`/usr/local/libexec/hil/hat`) | Drive the HAT: power, reset, HWB, ISP and serial buffers |
| `$AVRDUDE` = `/usr/local/bin/hil-avrdude` | avrdude with the `avr-test-hat` programmer (linuxspi, reset on GPIO 13) |
| `$TARGET` | `atmega8u2` |
| `coveralls` | cpp-coveralls, in its own venv |

### Users

- **`runner`** runs the runner and every job. It has no password, no sudo and no SSH. It's
  in groups `hilgpio` (`/dev/gpiochip0`), `spi` (`/dev/spidev0.0` only), `plugdev` (the
  Atmel USB device) and `dialout`.
- **`hil`** is for maintenance: SSH with keys only, from `ADMIN_KEYS_URL`, and sudo.

SSH host keys are made fresh at every boot, because the image is public.

## Protecting what survives a reboot

A job runs whatever code was pushed, so treat it as hostile. RAM boot makes the OS itself
disposable, which leaves the things that keep state on the board:

- **The Pi's boot EEPROM.**
  - `rpi-eeprom` isn't installed, and `runner` has no root.
  - `/dev/gpiochip0` still reaches the GPIO lines the EEPROM's SPI bus uses. So
    **the EEPROM's hardware write-protect must be asserted**, with
    `eeprom_write_protect=1` in `config.txt`. That's the one layer root can't undo.
- **The HAT ID EEPROM** (GPIO 0/1). The kernel holds those lines through the
  `hil-lockdown` overlay. Once it's programmed, jumper J5 write-protects it in hardware.
- **The AVR.** Every job starts by power-cycling it into its bootloader. If a job ever
  erases the bootloader, ISP can restore it from the dump on mcu-hil's `v1-archive`
  branch (`sd-card-2023/home/pi/dump-avr-boot/reader/ATmega8u2.hex`).

A hardware watchdog reboots the Pi if it hangs, and no job outlives three hours.
