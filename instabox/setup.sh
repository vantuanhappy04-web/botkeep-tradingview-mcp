#!/usr/bin/env bash
# =============================================================================
# 1-Command Installer for TradingView Desktop + MT5 + Unified MCP on InstaBox
# Usage: bash /data/trading/app/instabox/setup.sh
# =============================================================================
set -euxo pipefail

TRADING_ROOT="/data/trading"
APP_DIR="$TRADING_ROOT/app"
WINE_DIR="$TRADING_ROOT/wine-mt5"

sudo mkdir -p "$TRADING_ROOT"/{bin,logs,tv-profile,wine-mt5}
sudo chown -R user:user "$TRADING_ROOT"

export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://tvd-packages.tradingview.com/keyring.gpg | sudo tee /usr/share/keyrings/tradingview-desktop-archive-keyring.gpg >/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/tradingview-desktop-archive-keyring.gpg] https://tvd-packages.tradingview.com/ubuntu/stable jammy multiverse" | sudo tee /etc/apt/sources.list.d/tradingview-desktop.list >/dev/null

sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl wget unzip zstd cabextract procps psmisc net-tools \
  wine wine64 winbind novnc python3-websockify x11vnc \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libsecret-1-0 libxss1 libxtst6

if ! command -v tradingview >/dev/null 2>&1; then
  if ! sudo apt-get install -y tradingview; then
    cd /tmp && apt-get download tradingview && sudo dpkg --force-depends -i tradingview_*.deb && rm -f tradingview_*.deb
  fi
fi

# Install Windows Python 3.11.9 x64 into Wine64 prefix
if [ ! -f "$WINE_DIR/drive_c/Python311/python.exe" ]; then
  curl -fsSL "https://www.nuget.org/api/v2/package/python/3.11.9" -o /tmp/py311.nupkg
  mkdir -p /tmp/py311_extract "$WINE_DIR/drive_c/Python311"
  unzip -q -o /tmp/py311.nupkg -d /tmp/py311_extract
  cp -a /tmp/py311_extract/tools/* "$WINE_DIR/drive_c/Python311/"
  rm -rf /tmp/py311.nupkg /tmp/py311_extract
  sudo chown -R user:user "$WINE_DIR"
fi

su - user -c '
  set -euxo pipefail
  printf "start\n1440x900\n\n" | /usr/local/bin/instabox-desktop || true
  export DISPLAY=:1 WINEPREFIX=/data/trading/wine-mt5 WINEARCH=win64 WINEDEBUG=-all
  wineboot --init || true
  wine "C:\\Python311\\python.exe" -m ensurepip --upgrade
  wine "C:\\Python311\\python.exe" -m pip install --no-warn-script-location \
    MetaTrader5 python-dotenv numpy pandas tabulate pydantic "mcp>=1.6.0,<2.0.0" click pytz uvicorn
  if [ ! -f "$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe" ]; then
    curl -fsSL "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" -o /tmp/mt5setup.exe
    timeout 75 wine /tmp/mt5setup.exe /auto || true
  fi
'

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
cp -f "$APP_DIR/instabox/boot.sh" "$TRADING_ROOT/bin/boot.sh"
chmod +x "$TRADING_ROOT/bin/boot.sh"
bash "$TRADING_ROOT/bin/boot.sh"
