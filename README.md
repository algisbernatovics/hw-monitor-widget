# HW Monitor Widget

A GNOME Wayland panel for CPU, RAM, NVIDIA GPUs, disks, and network throughput. A user service samples the hardware. The Shell extension only draws the result.

GNOME 49–50. Wayland. NVIDIA and `lm-sensors` are optional.

## Why I built it

I run local AI models on a desktop with two NVIDIA GPUs. During a run I need CPU load, RAM, per-GPU utilization, VRAM, temperature, and power on screen, without opening another tool.

Three existing options failed that job:

- **Conky** is an X11 desktop window. It does not belong on this GNOME Wayland session.
- **Calling `nvidia-smi` inside the Shell** stalled the session. The GPU query does not belong on the compositor thread.
- **Top-bar monitors** only leave room for a thin summary. They cannot show two GPUs, VRAM, disk fill, and a network graph together.

The split is the fix. A systemd user service samples `/proc`, `lm-sensors`, and `nvidia-smi` every two seconds and writes one JSON file. The extension reads that file and paints the panel. Sampling never runs inside `gnome-shell`.

The panel sits in a corner of the desktop. A top-bar icon shows or hides it, and that choice survives logout. It can also hide while a normal window is focused, so it stays out of the way during a run and comes back on an empty desktop.

## What the panel shows

- CPU load, temperature, RAM, and current frequency
- One block per GPU listed in `gpu_titles`: load, VRAM, temperature, fan, and power
- Disk fill for each configured mount, plus an optional NVMe temperature
- Download and upload rates, each with a short sparkline

Bars fill from the left. Usage is red. Temperature is cyan. The panel background is opaque, so the window underneath does not show through the numbers.

## How it fits together

```text
collect_daemon.py          user service, every 2s
        │
        ▼
~/.cache/hw-monitor-widget/stats.json
        │
        ▼
GNOME extension            reads JSON, draws the corner panel
hw-monitor-widget@userpowers.local
```

`nvidia-query.sh` is a small wrapper around `nvidia-smi`. If the driver is missing it returns zeros and `N/A` instead of failing the collector.

## Requirements

- Ubuntu or another distro with GNOME Shell 49 or 50 on Wayland
- `python3`, `zip`, and `systemd --user`
- Optional: NVIDIA driver and `nvidia-smi`, for the GPU blocks
- Optional: `lm-sensors` (`sudo apt install lm-sensors`), for CPU and NVMe temperatures
- Optional: JetBrains Mono, which the panel CSS names as its font

The extension declares `shell-version` 49 and 50. Older Shell releases will refuse to load it.

## Install

```bash
git clone https://github.com/algisbernatovics/hw-monitor-widget.git
cd hw-monitor-widget
bash scripts/install-hw-monitor-widget.sh
```

The installer:

1. Copies the extension into `~/.local/share/gnome-shell/extensions/hw-monitor-widget@userpowers.local`
2. Copies the collector and `nvidia-query.sh` to `~/.local/lib/hw-monitor-widget/`
3. Enables the user service `hw-monitor-collect.service`
4. Adds a login autostart that enables the extension
5. Writes `~/.config/hw-monitor-widget/settings.json` only when that file does not already exist

Log out and back in once after the first install so GNOME Shell discovers the extension. Later updates are a re-run of the installer, then disable and enable the extension.

## Configuration

Edit `~/.config/hw-monitor-widget/settings.json`. The example in `config/settings.json.example` is a single disk and one GPU. An empty `net_interface` selects the first non-loopback interface that is up.

| Field | Meaning |
| --- | --- |
| `net_interface` | NIC for the throughput graphs. `""` or `"auto"` detects one. |
| `refresh_seconds` | Collector interval. Minimum 1. |
| `cpu_title` | Heading of the CPU section. |
| `gpu_titles` | One heading per GPU, in `nvidia-smi` index order. The length of this list is how many GPUs are queried. |
| `mounts` | Objects `{ "path", "label" }` for each disk row. The path must already be mounted. |
| `show_nvme_temp` | Show the NVMe composite temperature from `sensors` on the first disk row. |
| `panel_corner` | `"top-right"` (default) or `"top-left"`. |
| `gap_x`, `gap_y` | Inset from that corner, in pixels. |
| `bar_width`, `bar_height` | Meter size. Width is also the panel content width. |
| `auto_hide_when_focused` | Hide the panel while a normal window is focused. |
| `user_hidden` | Last top-bar toggle. Written by the extension. |

A second GPU is another string in `gpu_titles`:

```json
"gpu_titles": ["GPU 0", "GPU 1"]
```

After a config change, restart the collector. Layout fields are read by the extension the next time it reloads:

```bash
systemctl --user restart hw-monitor-collect.service
gnome-extensions disable hw-monitor-widget@userpowers.local
gnome-extensions enable hw-monitor-widget@userpowers.local
```

The top-bar icon toggles the panel. On GNOME 50 the extension replaces the default panel-button click, which would otherwise open an empty menu. While hidden, the panel is removed from Shell chrome, so Overview cannot force it back on.

## Check that it is running

```bash
systemctl --user status hw-monitor-collect.service
head -c 400 ~/.cache/hw-monitor-widget/stats.json
gnome-extensions info hw-monitor-widget@userpowers.local
```

`stats.json` should contain `cpu_pct`, `gpus`, and `mounts`. The extension state should be enabled, with no error.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No panel after install | Log out and back in. Confirm the UUID is enabled. |
| Panel is up but values stay empty | `systemctl --user restart hw-monitor-collect.service` and read `stats.json`. |
| GPU rows say N/A | Run `nvidia-smi`. Then `~/.local/lib/hw-monitor-widget/nvidia-query.sh 0 status`. |
| Disk row is 0% or N/A | The mount path in `settings.json` is wrong, or the disk was not mounted when the collector started. |
| Extension reports an error | `journalctl --user -b \| rg hw-monitor`. Confirm the Shell major version is 49 or 50. |
| Code change did not appear | Disable and enable the extension. `extension.js` reloads `widget.js` from the file mtime. |

## Layout of this repo

| Path | Role |
| --- | --- |
| `extension/` | GNOME Shell extension |
| `scripts/collect_daemon.py` | Stats writer |
| `scripts/nvidia-query.sh` | Safe `nvidia-smi` wrapper |
| `scripts/install-hw-monitor-widget.sh` | Installer |
| `scripts/enable-hw-monitor-widget.sh` | Login enable |
| `systemd/hw-monitor-collect.service` | User service template |
| `config/settings.json.example` | Default config |

## License

[MIT](LICENSE).
