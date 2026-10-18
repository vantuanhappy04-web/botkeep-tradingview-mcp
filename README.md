# TradingView MCP on Botkeep (Full 84 Tools + Headless Chromium + HTTP/SSE)

Bản triển khai đầy đủ **84 công cụ** của [`tradesdontlie/tradingview-mcp`](https://github.com/tradesdontlie/tradingview-mcp) được tích hợp sẵn:
1. **Headless Chromium tự chứa (`@sparticuz/chromium`)**: Tự giải nén và khởi chạy biểu đồ `https://www.tradingview.com/chart/` ngay trong container Linux của **Botkeep** (2GB RAM / 1.5 CPU) mà **không cần quyền `root`, không cần `apt`/`snap`, không cần `Xvfb`**.
2. **Remote MCP Server (`Streamable HTTP` & `SSE`)**: Mở sẵn cổng HTTP để bạn chỉ việc dán URL MCP vào Claude / Cursor / Bot / Agent và gọi toàn bộ 84 tool từ xa.

---

## 1. Triển khai trên Botkeep (`botkeep.cloud`)

1. Tạo server **Node.js** (khuyến nghị cấu hình **2GB RAM / 1.5 vCPU**).
2. Chọn **Import from GitHub** → chọn repo:
   - Repository: `vantuanhappy04-web/botkeep-tradingview-mcp`
   - Branch: `main`
   - Start command: `npm start`
3. *(Tùy chọn)* Cài đặt biến môi trường (**Environment**) trên Botkeep:
   - `MCP_API_KEY`: Mật khẩu bảo vệ endpoint MCP (nếu để trống thì mở tự do không cần token).
   - `TV_SESSIONID` và `TV_SESSIONID_SIGN`: Cookie đăng nhập tài khoản TradingView của bạn (lấy trong DevTools → Application → Cookies → `https://www.tradingview.com`) nếu bạn muốn dùng tài khoản trả phí, lưu layout hoặc Pine Script cá nhân. Không điền vẫn dùng được bình thường ở chế độ khách (xem giá, nến OHLCV, thêm/bớt chỉ báo RSI/MACD/EMA, vẽ chart, chụp ảnh chart...).
4. Bấm **Start** và đợi khoảng 15–20 giây để Chromium khởi động biểu đồ TradingView.

---

## 2. Các đường dẫn (Endpoints) sau khi chạy

Giả sử URL Botkeep cấp cho bạn là `https://your-app.botkeep.cloud`:

| Endpoint | Mục đích |
|---|---|
| `GET https://your-app.botkeep.cloud/health` | Kiểm tra trạng thái Chromium + biểu đồ TradingView (`cdp_connected: true`, `api_available: true`, mã đang mở) |
| `https://your-app.botkeep.cloud/mcp` | **Streamable HTTP MCP** (chuẩn MCP mới nhất — hỗ trợ cả có session và stateless) |
| `https://your-app.botkeep.cloud/sse` | **SSE MCP** (cho các client MCP dùng giao thức SSE) |
| `POST https://your-app.botkeep.cloud/login` | Truyền JSON `{"sessionid":"...", "sessionid_sign":"..."}` để đăng nhập TradingView lúc đang chạy |
| `POST https://your-app.botkeep.cloud/restart-browser` | Khởi động lại Headless Chromium |

---

## 3. Cách kết nối từ MCP Client (Claude, Cursor, Bot...)

### Cách A — Kết nối trực tiếp qua Streamable HTTP / SSE
Nếu client hỗ trợ URL MCP trực tiếp:
```json
{
  "mcpServers": {
    "tradingview": {
      "url": "https://your-app.botkeep.cloud/mcp"
    }
  }
}
```
*(Hoặc đổi `/mcp` thành `/sse` nếu client dùng SSE).*

### Cách B — Kết nối từ Claude Desktop / Claude Code qua `mcp-remote`
```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-app.botkeep.cloud/mcp"
      ]
    }
  }
}
```
Nếu bạn có đặt `MCP_API_KEY=mat-khau-cua-ban`, thêm `?apiKey=mat-khau-cua-ban` vào cuối URL hoặc truyền header `Authorization: Bearer mat-khau-cua-ban`.

---

## 4. Danh sách 14 nhóm công cụ (84 Tools)

- **Health & Launch**: `tv_health_check`, `tv_discover`, `tv_ui_state`, `tv_launch`, `tv_update`
- **Chart Navigation**: `chart_get_state`, `chart_set_symbol`, `chart_set_timeframe`, `chart_set_type`, `chart_manage_indicator`, `chart_scroll_to_date`, `chart_zoom`, `chart_reset_view`, ...
- **Market Data & Indicators**: `quote_get`, `data_get_ohlcv`, `data_get_study_values`, `data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_tables`, `data_get_pine_boxes`, `data_get_strategy_results`, ...
- **Indicators Config**: `indicator_list`, `indicator_add`, `indicator_remove`, `indicator_toggle`, `indicator_get_inputs`, `indicator_set_inputs`
- **Pine Script**: `pine_get_source`, `pine_set_source`, `pine_smart_compile`, `pine_get_errors`, `pine_get_console`, `pine_analyze`, ...
- **Drawing**: `draw_shape`, `draw_list`, `draw_get`, `draw_remove`, `draw_clear`
- **Screenshots**: `capture_screenshot`
- **Alerts, Watchlist, Replay, Batch, Panes, Tabs, UI**: Đầy đủ từ `tradesdontlie/tradingview-mcp`.
