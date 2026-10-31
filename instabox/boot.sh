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
MT5_NATIVE_MCP_PORT=22346
NOVNC_PORT=6080
MT5_PORTABLE=1
MT5_LAZY_INIT=1
MT5_TIMEOUT_MS=5000
EOF
  chmod 600 "$ENV_FILE"
  as_root chown user:user "$ENV_FILE"
fi

grep -q '^MT5_LAZY_INIT=' "$ENV_FILE" 2>/dev/null || echo 'MT5_LAZY_INIT=1' >> "$ENV_FILE"
grep -q '^MT5_TIMEOUT_MS=' "$ENV_FILE" 2>/dev/null || echo 'MT5_TIMEOUT_MS=5000' >> "$ENV_FILE"

# Ensure Config -> config symlink on case-sensitive Linux ext4 so terminal.lic is visible in /portable mode
MT5_DIR="$WINE_DIR/drive_c/Program Files/MetaTrader 5"
MT5_EXEC_ARGS="/portable"
if [ -d "$MT5_DIR" ]; then
  mkdir -p "$MT5_DIR/config"
  if [ -d "$MT5_DIR/Config" ] && [ ! -L "$MT5_DIR/Config" ]; then
    cp -af "$MT5_DIR/Config/." "$MT5_DIR/config/"
    rm -rf "$MT5_DIR/Config"
    ln -s config "$MT5_DIR/Config"
  fi
  if [ -f "$TRADING_ROOT/servers.dat" ]; then
    CUR_SZ=$(stat -c%s "$MT5_DIR/config/servers.dat" 2>/dev/null || echo 0)
    BAK_SZ=$(stat -c%s "$TRADING_ROOT/servers.dat" 2>/dev/null || echo 0)
    if [ "$BAK_SZ" -gt "$CUR_SZ" ]; then
      cp -f "$TRADING_ROOT/servers.dat" "$MT5_DIR/config/servers.dat"
    fi
  fi
  python3 - "$ENV_FILE" "$MT5_DIR/config/startup.ini" <<'PYEOF'
import os, sys
env_path, startup_path = sys.argv[1], sys.argv[2]
env = {}
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
if env.get("MT5_LOGIN") and env.get("MT5_PASSWORD") and env.get("MT5_SERVER"):
    ini = (
        "[Common]\r\n"
        f"Login={env['MT5_LOGIN']}\r\n"
        f"Password={env['MT5_PASSWORD']}\r\n"
        f"Server={env['MT5_SERVER']}\r\n"
        "KeepPrivate=1\r\n"
        "CertInstall=0\r\n"
        "NewsEnable=0\r\n"
        "[Experts]\r\n"
        "AllowDllImport=0\r\n"
        "Enabled=1\r\n"
        "Account=1\r\n"
        "Profile=1\r\n"
        "Chart=0\r\n"
        "Api=0\r\n"
    )
    with open(startup_path, "wb") as f:
        f.write(b"\xff\xfe" + ini.encode("utf-16-le"))
    os.chmod(startup_path, 0o600)
PYEOF
  if [ -f "$MT5_DIR/config/startup.ini" ]; then
    MT5_EXEC_ARGS="/portable /config:config\\\\startup.ini"
  fi
  as_root chown -R user:user "$MT5_DIR"
fi

# Ensure metatrader_mcp & metatrader_client are installed in Wine Python site-packages
if [ -d "$WINE_DIR/drive_c/Python311/Lib/site-packages" ] && [ -d "$APP_DIR/mt5-mcp/src" ]; then
  cp -rf "$APP_DIR/mt5-mcp/src/metatrader_mcp" "$WINE_DIR/drive_c/Python311/Lib/site-packages/"
  cp -rf "$APP_DIR/mt5-mcp/src/metatrader_client" "$WINE_DIR/drive_c/Python311/Lib/site-packages/"
  as_root chown -R user:user "$WINE_DIR/drive_c/Python311/Lib/site-packages"
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
Environment=HOME=/data/home
Environment=DISPLAY=:1
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
Environment=GDK_BACKEND=x11
Environment=XDG_SESSION_TYPE=x11
UnsetEnvironment=NODE_OPTIONS
ExecStart=/usr/bin/env -u NODE_OPTIONS /opt/TradingView/tradingview --password-store=basic --remote-debugging-port=9222 --remote-allow-origins=* --no-sandbox --disable-gpu --disable-dev-shm-usage https://www.tradingview.com/chart/
TimeoutStopSec=5
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

as_root tee /etc/systemd/system/mt5-terminal.service >/dev/null <<EOF
[Unit]
Description=MetaTrader 5 Terminal (Wine64 Portable on DISPLAY=:1)
After=network.target trading-novnc.service

[Service]
Type=simple
User=user
Environment=HOME=/data/home
Environment=DISPLAY=:1
Environment=WINEPREFIX=/data/trading/wine-mt5
Environment=WINEDEBUG=-all
Environment=WINEDLLOVERRIDES=mscoree,mshtml=
WorkingDirectory=/data/trading/wine-mt5/drive_c/Program Files/MetaTrader 5
ExecStart=/usr/bin/wine "C:\\\\Program Files\\\\MetaTrader 5\\\\terminal64.exe" $MT5_EXEC_ARGS
TimeoutStopSec=5
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
Environment=HOME=/data/home
Environment=DISPLAY=:1
Environment=WINEPREFIX=/data/trading/wine-mt5
Environment=WINEDEBUG=-all
Environment=WINEDLLOVERRIDES=mscoree,mshtml=
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

if [ ! -s "$TRADING_ROOT/.mt5_native_mcp_key" ] && [ -f "$APP_DIR/instabox/extract_mt5_mcp_key.sh" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    su - user -c "nohup bash '$APP_DIR/instabox/extract_mt5_mcp_key.sh' >/dev/null 2>&1 &" || true
  else
    nohup bash "$APP_DIR/instabox/extract_mt5_mcp_key.sh" >/dev/null 2>&1 &
  fi
fi

echo "All 5 Trading services are enabled and started."
