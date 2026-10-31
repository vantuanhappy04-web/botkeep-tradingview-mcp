#!/usr/bin/env bash
# =============================================================================
# InstaBox Boot & Systemd Supervisor Script (/data/trading/bin/boot.sh)
# Restores & starts Xfce/VNC (:1), noVNC (6080), TradingView Desktop (CDP 9222),
# MetaTrader 5 (Wine64), MT5 MCP (8080), and Unified MCP Gateway (8000).
# Safe to call repeatedly (idempotent) and wired to Botkeep Keeper boot_cmd.
# =============================================================================
set -euo pipefail

TRADING_ROOT="/data/trading"
APP_DIR="$TRADING_ROOT/app"
WINE_DIR="$TRADING_ROOT/wine-mt5"
ENV_FILE="$TRADING_ROOT/.env"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi
}

as_root mkdir -p "$TRADING_ROOT"/{bin,logs,tv-profile,wine-mt5}
as_root chown -R user:user "$TRADING_ROOT"

if [ ! -f "$ENV_FILE" ]; then
  cat <<'EOF' > "$ENV_FILE"
PORT=8000
TV_CDP_HOST=127.0.0.1
TV_CDP_PORT=9222
TV_AUTO_LAUNCH=false
TV_AUTO_UPDATE=false
MT5_MCP_HOST=127.0.0.1
MT5_MCP_PORT=8080
NOVNC_PORT=6080
MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
MT5_PORTABLE=1
EOF
  chmod 600 "$ENV_FILE"
  as_root chown user:user "$ENV_FILE"
fi

# 1. Start InstaBox official Xfce + Xvnc desktop on DISPLAY=:1 (127.0.0.1:5901)
if [ "$(id -u)" -eq 0 ]; then
  su - user -c 'printf "start\n1440x900\n\n" | /usr/local/bin/instabox-desktop >/dev/null 2>&1 || true'
else
  printf "start\n1440x900\n\n" | /usr/local/bin/instabox-desktop >/dev/null 2>&1 || true
fi

# 2. Write systemd units
as_root tee /etc/systemd/system/trading-novnc.service >/dev/null <<'EOF'
[Unit]
Description=noVNC Web Bridge for InstaBox Display :1 (127.0.0.1:6080 -> 5901)
After=network.target

[Service]
Type=simple
User=user
ExecStartPre=/bin/bash -c 'printf "start\n1440x900\n\n" | /usr/local/bin/instabox-desktop >/dev/null 2>&1 || true'
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

as_root tee /etc/systemd/system/tradingview-desktop.service >/dev/null <<'EOF'
[Unit]
Description=TradingView Desktop (Linux Native with CDP 9222 on DISPLAY=:1)
After=network.target trading-novnc.service

[Service]
Type=simple
User=user
Environment=DISPLAY=:1
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=GDK_BACKEND=x11
Environment=XDG_SESSION_TYPE=x11
ExecStart=/usr/bin/tradingview --user-data-dir=/data/trading/tv-profile --remote-debugging-port=9222 --remote-allow-origins=* --no-sandbox --disable-dev-shm-usage
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

as_root tee /etc/systemd/system/mt5-terminal.service >/dev/null <<'EOF'
[Unit]
Description=MetaTrader 5 Terminal (Wine64 Portable on DISPLAY=:1)
After=network.target trading-novnc.service

[Service]
Type=simple
User=user
Environment=DISPLAY=:1
Environment=WINEPREFIX=/data/trading/wine-mt5
Environment=WINEARCH=win64
Environment=WINEDEBUG=-all
WorkingDirectory=/data/trading/wine-mt5/drive_c/Program Files/MetaTrader 5
ExecStart=/usr/bin/wine "C:\\Program Files\\MetaTrader 5\\terminal64.exe" /portable
Restart=always
RestartSec=6

[Install]
WantedBy=multi-user.target
EOF

as_root tee /etc/systemd/system/mt5-mcp.service >/dev/null <<'EOF'
[Unit]
Description=MetaTrader 5 MCP Server (Windows Python 3.11 in Wine64 on 127.0.0.1:8080)
After=network.target mt5-terminal.service

[Service]
Type=simple
User=user
Environment=DISPLAY=:1
Environment=WINEPREFIX=/data/trading/wine-mt5
Environment=WINEARCH=win64
Environment=WINEDEBUG=-all
Environment=PYTHONPATH=Z:\data\trading\app\mt5-mcp\src
EnvironmentFile=-/data/trading/.env
WorkingDirectory=/data/trading/app/mt5-mcp
ExecStart=/usr/bin/wine "C:\\Python311\\python.exe" -m metatrader_mcp.cli --transport streamable-http --host 127.0.0.1 --port 8080
Restart=always
RestartSec=4

[Install]
WantedBy=multi-user.target
EOF

as_root tee /etc/systemd/system/trading-gateway.service >/dev/null <<'EOF'
[Unit]
Description=Unified TradingView (84 tools) + MT5 (26 tools) MCP Gateway on Port 8000
After=network.target tradingview-desktop.service mt5-mcp.service

[Service]
Type=simple
User=user
EnvironmentFile=-/data/trading/.env
WorkingDirectory=/data/trading/app
ExecStart=/usr/local/bin/node /data/trading/app/src/http-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

as_root systemctl daemon-reload
as_root systemctl enable trading-novnc tradingview-desktop mt5-terminal mt5-mcp trading-gateway >/dev/null 2>&1 || true
as_root systemctl start trading-novnc tradingview-desktop mt5-terminal mt5-mcp trading-gateway

echo "All 5 Trading services are enabled and started."
