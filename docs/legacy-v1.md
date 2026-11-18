# Codex Browser Use for Antigravity (archived v1)

> Archived design notes. The "100% feature parity" wording below describes an
> earlier, unverified implementation and is not a current claim. See
> [compatibility.md](compatibility.md) for what the standalone core now
> implements and verifies.

Bản sao mã nguồn hoàn chỉnh (100% feature-parity) của cơ chế **Browser Use** từ OpenAI Codex, được thiết kế để điều khiển trực tiếp cửa sổ **Google Chrome thật** đang mở của người dùng thông qua Chrome WebExtension API (`chrome.debugger`) và Native Messaging Host, không cần khởi động Chrome với cờ `--remote-debugging-port`, không cần profile cô lập, và hoàn toàn độc lập, không gây ảnh hưởng đến ứng dụng ChatGPT Desktop hay agent Codex đang chạy trên máy.

---

## 1. Cấu trúc thư mục mã nguồn

```
codex-browser-use/
├── mcp-server/              # MCP Server cung cấp 19 công cụ Browser Use chuẩn Codex
│   ├── package.json         # Dependencies (@modelcontextprotocol/sdk, playwright-core, zod)
│   └── src/
│       ├── server.js        # Khai báo schema 19 MCP tools (hỗ trợ ép kiểu chuỗi/số tự động)
│       ├── browser-manager.js # Engine tương tác CDP, tính toán tọa độ, cuộn mượt, di chuột ảo
│       └── gateway-client.js  # Client IPC kết nối đến Gateway Socket (/tmp/antigravity-browser-gateway.sock)
│
├── chrome-extension/        # Extension "Antigravity Browser Bridge" (ID cố định: efahhkjnlabijbbnkommfpfjlclkmfgd)
│   ├── manifest.json        # Quyền debugger, nativeMessaging, tabs, scripting, favicon
│   ├── background.js        # Service Worker kết nối Native Host, điều phối attach CDP, favicon badge
│   ├── content-script.js    # Render chuột ảo neon qua Shadow DOM closed, vẽ đè favicon badge SVG
│   ├── key.json             # Khóa RSA public/private sinh ID cố định cho extension
│   └── images/
│       └── cursor-chat.png  # Graphic con trỏ chuột gốc với hiệu ứng phát sáng neon #339cff
│
├── native-host/             # Native Messaging Gateway Host chạy ngầm trên macOS
│   └── bin/
│       ├── host.js          # Gateway Server đa client, quản lý claim/release tab, giao tiếp stdio
│       └── host.sh          # Wrapper script thiết lập PATH môi trường /opt/homebrew/bin
│
├── chrome-configs/          # File đăng ký Native Messaging Host và External Extension với Google Chrome
│   ├── com.antigravity.browserhost.json # Đăng ký host com.antigravity.browserhost với Chrome
│   └── efahhkjnlabijbbnkommfpfjlclkmfgd.json # Đăng ký extension tự động load vào Chrome
│
├── skill/                   # Tài liệu định nghĩa Skill cho Antigravity CLI
│   └── SKILL.md             # Hướng dẫn chi tiết 19 công cụ và workflow cho AI Agent
│
├── rules/                   # Quy tắc toàn cục bắt buộc Antigravity sử dụng công cụ này
│   └── browser_use.md       # Rule always_on cấm agent tự ý dùng Playwright/Puppeteer ngoài
│
└── README.md                # Tài liệu kỹ thuật tổng quan và hướng dẫn triển khai
```

---

## 2. Kiến trúc 4 tầng (4-Layer Architecture)

```
+----------------------------------------------------------------------------------+
|                              Antigravity AI Agent                                |
+----------------------------------------------------------------------------------+
                                        | (MCP stdio protocol)
                                        v
+----------------------------------------------------------------------------------+
|                    Layer 1: codex-browser-use MCP Server                         |
|  - 19 MCP Tools (Navigation, AX Tree, Coordinate Click, Evaluate, Playwright)   |
|  - Auto Type Coercion (z.union: string | number)                                 |
+----------------------------------------------------------------------------------+
                                        | (UNIX Domain Socket)
                                        v
+----------------------------------------------------------------------------------+
|                    Layer 2: Multi-Agent Gateway Host (host.js)                   |
|  - Socket: /tmp/antigravity-browser-gateway.sock                                 |
|  - Registry: claim_tab / release_tab (Tránh xung đột đa agent trên cùng 1 tab)   |
+----------------------------------------------------------------------------------+
                                        | (Chrome Native Messaging stdio)
                                        v
+----------------------------------------------------------------------------------+
|             Layer 3: Chrome Extension (Antigravity Browser Bridge)              |
|  - chrome.debugger.attach({ tabId }, "1.3") -> Truy cập CDP toàn quyền           |
|  - Gửi lệnh TAB_FAVICON_BADGE và AGENT_CURSOR_STATE vào trang                     |
+----------------------------------------------------------------------------------+
                                        | (Content Script & Shadow DOM)
                                        v
+----------------------------------------------------------------------------------+
|                 Layer 4: Real User Chrome Window & Visual UX                     |
|  - Chuột ảo neon di chuyển mượt mà (Spring Physics & Bezier)                     |
|  - Ký hiệu con chuột ảo đè lên favicon tab (SVG overlay opacity 0.3)             |
+----------------------------------------------------------------------------------+
```

---

## 3. Danh mục 19 công cụ chuẩn Codex

### Tầng 1: Điều hướng & Quản lý Tab
1. `browser_list_tabs`: Quét toàn bộ tab thật đang mở, trạng thái active, và agent đang claim.
2. `browser_new_tab`: Mở tab mới trên Chrome thật (tuỳ chọn URL).
3. `browser_select_tab`: Chuyển active focus sang tab mục tiêu và đưa cửa sổ lên phía trước.
4. `browser_close_tab`: Đóng tab theo `tab_id`.
5. `browser_goto`: Điều hướng tab đang chọn đến một URL.
6. `browser_back`: Quay lại trang trước trong lịch sử duyệt web.
7. `browser_forward`: Đi tới trang tiếp theo trong lịch sử.
8. `browser_reload`: Tải lại tab hiện tại.
9. `browser_screenshot`: Chụp ảnh màn hình độ phân giải cao của trang web (trả về PNG base64).

### Tầng 2: Cây tương tác Accessibility (AX Tree) & Thao tác vật lý
10. `browser_get_state`: Trích xuất cây `<ax_state>` với chỉ số tuần tự (`element_index`), tên, vai trò và chụp ảnh màn hình đồng thời.
11. `browser_click`: Di chuyển chuột ảo đến phần tử (`element_index`) hoặc tọa độ (`x, y`), cuộn mượt (`DOM.scrollIntoViewIfNeeded`) và kích hoạt click. Hỗ trợ bấm liên tiếp nhiều điểm qua chuỗi (ví dụ: `"11, 12, 11, 24"`).
12. `browser_set_value`: Gán trực tiếp giá trị vào input/textarea qua `element_index`.
13. `browser_type_text`: Di chuột ảo vào ô nhập liệu, click focus và gõ chuỗi ký tự mô phỏng bàn phím.
14. `browser_press_key`: Bấm các phím đặc biệt hoặc tổ hợp phím (`Return`, `Tab`, `Escape`, `Meta+a`, v.v.).
15. `browser_scroll`: Cuộn trang mượt mà theo 4 hướng (`up`, `down`, `left`, `right`) theo số trang (`pages`).

### Tầng 3: Playwright & Trích xuất nội dung chuyên sâu
16. `browser_evaluate`: Thực thi mã JavaScript tuỳ ý trong ngữ cảnh website và nhận kết quả JSON.
17. `browser_locator_click`: Bấm phần tử bằng CSS selector hoặc text selector của Playwright.
18. `browser_locator_fill`: Điền form nhanh bằng CSS selector.
19. `browser_get_content`: Lấy toàn bộ văn bản hiển thị trên trang (`document.body.innerText`).

---

## 4. Đặc điểm nổi bật & Giải pháp kỹ thuật

1. **Không xung đột với ChatGPT Desktop:**
   - OpenAI Codex gắn vào socket `/tmp/codex-browser-use/*.sock` và native host `com.openai.codexextension`.
   - Hệ thống này đăng ký định danh hoàn toàn độc lập: host `com.antigravity.browserhost` và extension `efahhkjnlabijbbnkommfpfjlclkmfgd`. Cả hai chạy song song trên cùng một trình duyệt Chrome mà không hề va chạm.
2. **Hỗ trợ đa agent (Multi-Agent Tab Claiming):**
   - Chrome chỉ cho phép đúng 1 debugger gắn vào 1 tab tại một thời điểm.
   - `host.js` đóng vai trò Gateway Server thông minh: Agent A claim tab nào thì giữ quyền điều khiển tab đó; các agent khác muốn can thiệp sẽ nhận thông báo chờ hoặc phải chọn tab khác, loại bỏ hoàn toàn lỗi crash debugger.
3. **Hiệu ứng thị giác chuẩn 100%:**
   - **Favicon Badge:** Khi agent claim tab, favicon của website sẽ được tự động làm mờ còn 30% và đè một icon chuột màu đen viền trắng lên góc. Khi nhả tab, favicon gốc lập tức được phục hồi.
   - **Virtual Mouse Cursor:** Con trỏ chuột neon xanh `#339cff` xuất hiện qua Closed Shadow DOM và lướt mượt mà qua các phần tử trước khi click bằng thuật toán mô phỏng vật lý lò xo (Spring easing).

---

## 5. Hướng dẫn cài đặt trên môi trường mới

1. **Cài đặt dependencies cho MCP Server:**
   ```bash
   cd mcp-server
   npm install
   ```

2. **Đăng ký Native Messaging Host với Chrome:**
   Copy file manifest vào thư mục cấu hình của Chrome trên macOS:
   ```bash
   cp chrome-configs/com.antigravity.browserhost.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   chmod +x native-host/bin/host.sh native-host/bin/host.js
   ```

3. **Cài đặt Extension vào Chrome:**
   - Mở Chrome, truy cập: `chrome://extensions/`
   - Bật **Developer mode** ở góc phải trên.
   - Nhấn **Load unpacked** và chọn thư mục `chrome-extension/`.

4. **Khai báo trong cấu hình MCP của Antigravity (`~/.gemini/config/mcp_config.json`):**
   ```json
   {
     "mcpServers": {
       "codex-browser-use": {
         "command": "node",
         "args": [
           "/đường/dẫn/đến/codex-browser-use/mcp-server/src/server.js"
         ]
       }
     }
   }
   ```
