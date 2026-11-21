#!/usr/bin/env bash
# Safe nvidia-smi wrapper for hw-monitor-widget collector.
set -euo pipefail

gpu="${1:-0}"
field="${2:-utilization.gpu}"

nvidia_ok() {
  nvidia-smi >/dev/null 2>&1
}

fallback() {
  case "$field" in
    mempair) echo "N/A / N/A" ;;
    mempct|utilization.gpu|fan.speed|temperature.gpu|power.draw) echo "0" ;;
    status)
      if [[ -f /var/run/reboot-required ]]; then
        echo "reboot needed"
      else
        echo "driver error"
      fi
      ;;
    *) echo "N/A" ;;
  esac
}

if ! nvidia_ok; then
  fallback
  exit 0
fi

case "$field" in
  mempair)
    nvidia-smi -i "$gpu" --query-gpu=memory.used,memory.total --format=csv,noheader,nounits \
      | awk -F', ' '{print $1 "/" $2 " MiB"}'
    ;;
  mempct)
    nvidia-smi -i "$gpu" --query-gpu=memory.used,memory.total --format=csv,noheader,nounits \
      | awk -F',' '{printf "%.0f", ($1 / $2) * 100}'
    ;;
  status)
    echo "ok"
    ;;
  *)
    nvidia-smi -i "$gpu" --query-gpu="$field" --format=csv,noheader,nounits | head -1
    ;;
esac
