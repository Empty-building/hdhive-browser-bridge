#!/usr/bin/env bash
set -euo pipefail
cd /root/hdhive-browser-bridge

fuser -k 10000/tcp >/dev/null 2>&1 || true
pkill -9 -f '/root/hdhive-browser-bridge/server.mjs' >/dev/null 2>&1 || true
pkill -9 -f 'ms-playwright/chromium_headless_shell' >/dev/null 2>&1 || true
sleep 1

export PORT=10000
export BRIDGE_TOKEN=hdhive-local-token
export HDHIVE_COOKIE="$(tr -d '\r\n' </tmp/hdhive-cookies.txt)"
export HDHIVE_BIND_SECRET="$(tr -d '\r\n' </tmp/hdhive-bind-secret.txt)"
export HDHIVE_USERNAME=mapiwbh@gmail.com
export HDHIVE_PASSWORD='raqtaz-hIjfek-7pashu'
export HDHIVE_PROXY=socks5://127.0.0.1:1081
export BROWSER_PROXY=socks5://127.0.0.1:1081
export BROWSER_HEADLESS=true
export AUTO_WARMUP=true
export AUTO_LOGIN=false
export ACTION_TIMEOUT_MS=240000
export BROWSER_IDLE_MS=0
# hybrid: auto=pure优先回落浏览器, pure=仅pure, browser=仅浏览器
export HYBRID_MODE=${HYBRID_MODE:-auto}
export AUTO_WARMUP_BROWSER=${AUTO_WARMUP_BROWSER:-false}
export CAPTCHA_AI_BASE_URL=http://127.0.0.1:50002/v1
export CAPTCHA_AI_API_KEY=sk-Z1aCj7YyVeqVTo4kx
export CAPTCHA_AI_MODEL=mimo-v2.5
export CAPTCHA_SOLVER=auto

if [ -z "${HDHIVE_COOKIE}" ]; then
  echo "missing cookie" >&2
  exit 1
fi

: > /tmp/hdhive-server.log
setsid node /root/hdhive-browser-bridge/server.mjs >> /tmp/hdhive-server.log 2>&1 < /dev/null &
echo $! > /tmp/hdhive-server.pid
echo "started pid=$(cat /tmp/hdhive-server.pid) cookie_len=${#HDHIVE_COOKIE}"
