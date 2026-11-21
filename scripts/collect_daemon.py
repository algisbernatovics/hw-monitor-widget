#!/usr/bin/env python3
"""Write hardware stats JSON for hw-monitor-widget GNOME extension."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "hw-monitor-widget" / "settings.json"
CACHE_DIR = Path.home() / ".cache" / "hw-monitor-widget"
STATS_PATH = CACHE_DIR / "stats.json"
STATE_CPU = Path("/run/user") / str(os.getuid()) / "hw-monitor-widget-cpu.json"
STATE_NET = Path("/run/user") / str(os.getuid()) / "hw-monitor-widget-net.json"


def run_cmd(cmd: list[str], timeout: float = 4.0) -> str:
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=timeout, text=True).strip()
    except (subprocess.SubprocessError, OSError):
        return ""


def first_net_interface() -> str:
    """First non-loopback interface that is up, otherwise the first other interface."""
    root = Path("/sys/class/net")
    fallback = ""
    if not root.is_dir():
        return "lo"
    for iface in sorted(path.name for path in root.iterdir()):
        if iface == "lo":
            continue
        if not fallback:
            fallback = iface
        oper = root / iface / "operstate"
        try:
            if oper.read_text(encoding="utf-8").strip() == "up":
                return iface
        except OSError:
            continue
    return fallback or "lo"


def load_cfg() -> dict:
    defaults = {
        "nvidia_query": str(Path.home() / ".local" / "lib" / "hw-monitor-widget" / "nvidia-query.sh"),
        "net_interface": "",
        "mounts": [
            {"path": "/", "label": "OS"},
        ],
        "refresh_seconds": 2,
    }
    if CONFIG_PATH.exists():
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        defaults.update(data)
    iface = str(defaults.get("net_interface") or "").strip()
    if iface in ("", "auto"):
        defaults["net_interface"] = first_net_interface()
    return defaults


def cpu_percent(prev: tuple[int, int] | None) -> tuple[float, tuple[int, int]]:
    parts = [int(x) for x in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
    total = sum(parts)
    if prev is None:
        return 0.0, (idle, total)
    pi, pt = prev
    didle, dtotal = idle - pi, total - pt
    if dtotal <= 0:
        return 0.0, (idle, total)
    return max(0.0, min(100.0, (1.0 - didle / dtotal) * 100.0)), (idle, total)


def mem() -> tuple[str, float]:
    info = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, _, v = line.partition(":")
        info[k] = int(v.strip().split()[0])
    used = info["MemTotal"] - info.get("MemAvailable", info.get("MemFree", 0))
    total = info["MemTotal"]
    return f"{used / (1024**2):.1f}G / {total / (1024**2):.1f}G", used / total * 100 if total else 0


def sensors() -> dict:
    raw = run_cmd(["sensors"], timeout=4)
    pkg, fan, nvme = "N/A", "N/A", "N/A"
    for line in raw.splitlines():
        if "Package id 0" in line:
            m = re.search(r"\+(\d+\.?\d*)", line)
            pkg = f"{m.group(1)}°C" if m else "N/A"
        elif re.search(r"rpm", line, re.I) and fan == "N/A":
            for p in line.split():
                if p.isdigit():
                    fan = f"{p}RPM"
                    break
        elif "Composite" in line and nvme == "N/A":
            m = re.search(r"\+(\d+\.?\d*)", line)
            nvme = f"+{m.group(1)}°C" if m else nvme
    return {"cpu_temp": pkg, "cpu_fan": fan, "nvme_temp": nvme}


def cpu_freq() -> str:
    mhz = 0.0
    for line in Path("/proc/cpuinfo").read_text().splitlines():
        if line.lower().startswith("cpu mhz"):
            mhz = max(mhz, float(line.split(":")[1].strip()))
    return f"{mhz / 1000:.2f}GHz" if mhz else "N/A"


def nvidia(cfg: dict, gpu: str, field: str) -> str:
    return run_cmd([cfg["nvidia_query"], gpu, field]) or "N/A"


def disk(mount: str) -> tuple[str, float]:
    try:
        st = os.statvfs(mount)
    except OSError:
        return "N/A", 0.0
    total, free = st.f_frsize * st.f_blocks, st.f_frsize * st.f_bavail
    used = total - free
    if total <= 0:
        return "N/A", 0.0
    units = ["B", "K", "M", "G", "T"]

    def hum(n: float) -> str:
        i = 0
        while n >= 1024 and i < 4:
            n /= 1024
            i += 1
        return f"{n:.1f}{units[i]}"

    return f"{hum(used)} / {hum(total)}", used / total * 100


def collect_once(cfg: dict) -> dict:
    prev = None
    if STATE_CPU.exists():
        try:
            prev = tuple(json.loads(STATE_CPU.read_text())["cpu"])
        except (json.JSONDecodeError, KeyError, TypeError):
            prev = None

    cpu, cpu_state = cpu_percent(prev)
    STATE_CPU.write_text(json.dumps({"cpu": list(cpu_state), "ts": time.time()}))

    mem_txt, mem_pct = mem()
    sens = sensors()
    gpu_ok = nvidia(cfg, "0", "status") == "ok"
    gpus = []
    if gpu_ok:
        titles = cfg.get("gpu_titles") or ["GPU 0"]
        if not isinstance(titles, list) or not titles:
            titles = ["GPU 0"]
        for idx, title in enumerate(titles):
            name = title.replace("GPU ", "", 1) if str(title).startswith("GPU ") else str(title)
            g = str(idx)
            load_raw = nvidia(cfg, g, "utilization.gpu")
            try:
                load = float(load_raw or 0)
            except ValueError:
                load = 0.0
            mempct_raw = nvidia(cfg, g, "mempct")
            try:
                mempct = float(mempct_raw or 0)
            except ValueError:
                mempct = 0.0
            gpus.append(
                {
                    "name": name,
                    "load": load,
                    "vram": nvidia(cfg, g, "mempair"),
                    "vram_pct": mempct,
                    "temp": nvidia(cfg, g, "temperature.gpu"),
                    "fan": nvidia(cfg, g, "fan.speed"),
                    "power": nvidia(cfg, g, "power.draw"),
                }
            )

    mounts_out = []
    for entry in cfg["mounts"]:
        if isinstance(entry, str):
            path, label = entry, entry
        else:
            path = entry["path"]
            label = entry.get("label", path)
        txt, pct = disk(path)
        mounts_out.append({"label": label, "path": path, "text": txt, "pct": pct})

    iface = cfg["net_interface"]
    rx = tx = 0
    rxp = Path(f"/sys/class/net/{iface}/statistics/rx_bytes")
    txp = Path(f"/sys/class/net/{iface}/statistics/tx_bytes")
    if rxp.exists() and txp.exists():
        rx, tx = int(rxp.read_text()), int(txp.read_text())

    down = up = 0.0
    now = time.time()
    if STATE_NET.exists():
        try:
            ns = json.loads(STATE_NET.read_text())
            dt = max(now - ns["ts"], 0.001)
            down = max(0, (rx - ns["rx"]) / dt)
            up = max(0, (tx - ns["tx"]) / dt)
        except (json.JSONDecodeError, KeyError):
            pass
    STATE_NET.write_text(json.dumps({"rx": rx, "tx": tx, "ts": now}))

    return {
        "ts": now,
        "cpu_pct": cpu,
        "mem_text": mem_txt,
        "mem_pct": mem_pct,
        "cpu_freq": cpu_freq(),
        **sens,
        "gpu_ok": gpu_ok,
        "gpus": gpus,
        "mounts": mounts_out,
        "net_down_bps": down,
        "net_up_bps": up,
    }


def main() -> int:
    cfg = load_cfg()
    interval = max(1, int(cfg.get("refresh_seconds", 2)))
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATS_PATH.with_suffix(".json.tmp")

    while True:
        try:
            payload = collect_once(cfg)
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(STATS_PATH)
        except Exception as exc:  # noqa: BLE001 — keep daemon alive
            print(f"hw-monitor-widget collect error: {exc}", file=sys.stderr)
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
