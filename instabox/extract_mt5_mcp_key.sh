#!/usr/bin/env bash
# =============================================================================
# Auto-extract MetaTrader 5 built-in MCP Bearer key via Win32 WM_GETTEXT
# Writes /data/trading/.mt5_native_mcp_key (mode 600) so trading-gateway can
# authenticate to http://127.0.0.1:22346/mcp seamlessly.
# =============================================================================
set -euo pipefail

KEY_FILE="/data/trading/.mt5_native_mcp_key"
if [ -s "$KEY_FILE" ]; then
  exit 0
fi

export DISPLAY=:1 HOME=/data/home WINEPREFIX=/data/trading/wine-mt5 WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="

# Wait up to 45s for MT5 internal MCP port 22346 and main window
for _ in $(seq 1 15); do
  if ss -tln 2>/dev/null | grep -q ':22346 '; then
    break
  fi
  sleep 3
done

WID=$(xwininfo -root -tree 2>/dev/null | awk '/"terminal64\.exe"/{print $1; exit}' || true)
if [ -n "$WID" ] && command -v xdotool >/dev/null 2>&1; then
  xdotool windowactivate --sync "$WID" >/dev/null 2>&1 || true
  sleep 0.3
  xdotool key --window "$WID" ctrl+o >/dev/null 2>&1 || true
  sleep 0.8
  # Navigate to MCP tab (click tab header at x=635, y=395 on 1440x900 desktop)
  xdotool mousemove 635 395 click 1 >/dev/null 2>&1 || true
  sleep 0.5
fi

cat <<'PYEOF' > /tmp/extract_mt5_mcp_key.py
import ctypes
from ctypes import wintypes

u32 = ctypes.windll.user32
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_CLOSE = 0x0010
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

texts = []

def get_text(hwnd):
    n = u32.SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0)
    if n <= 0 or n > 4096:
        return ""
    buf = ctypes.create_unicode_buffer(n + 2)
    u32.SendMessageW(hwnd, WM_GETTEXT, n + 1, ctypes.byref(buf))
    return buf.value

def enum_child(hwnd, lparam):
    t = get_text(hwnd)
    if t:
        texts.append(t)
    return True

cb_child = WNDENUMPROC(enum_child)

def enum_top(hwnd, lparam):
    if get_text(hwnd) == "Options":
        u32.EnumChildWindows(hwnd, cb_child, 0)
        u32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    return True

u32.EnumWindows(WNDENUMPROC(enum_top), 0)

for t in texts:
    if len(t) >= 32 and " " not in t and "http" not in t:
        with open(r"Z:\data\trading\.mt5_native_mcp_key", "w", encoding="utf-8") as f:
            f.write(t.strip())
        break
PYEOF

wine "C:\\Python311\\python.exe" "Z:\\tmp\\extract_mt5_mcp_key.py" >/dev/null 2>&1 || true
rm -f /tmp/extract_mt5_mcp_key.py
[ -f "$KEY_FILE" ] && chmod 600 "$KEY_FILE" || true
