# Local Chrome for Claude

让 Claude Code（或任何 MCP 客户端）直接控制你本地的 Chrome，**不需要插件和 Claude 登录同一个账户**。沿用浏览器里已有的所有登录态。

```
Claude Code ──stdio MCP──▶ 本地 MCP Server (Node)
                              │ ws://127.0.0.1:18765  (配对 token + Origin 校验)
                              ▼
                     Chrome 插件 (MV3 service worker)
                              │ chrome.debugger (CDP) / tabs
                              ▼
                          你的 Chrome
```

## 安装

```bash
pnpm install
pnpm build
```

### 1. 注册 MCP Server 到 Claude Code

```bash
claude mcp add local-chrome -s user -- node /绝对路径/claude-chrome/packages/server/dist/index.js
```

首次运行会生成配对 token，保存在 `~/.claude-chrome/token`（权限 0600）。

### 2. 加载插件

1. 打开 `chrome://extensions`，打开右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `packages/extension/dist`
3. 点插件图标，粘贴 token（`pnpm token` 或 `cat ~/.claude-chrome/token`），点「保存并连接」

启动一个 Claude Code 会话后，插件图标上的徽标会变成绿色 **ON**。

## 工具

| 工具 | 说明 |
|---|---|
| `status` | 连接状态、本会话的标签（如 Claude 1）、窗口和标签页 |
| `tabs_list` / `tabs_create` / `tabs_select` / `tabs_close` | 标签页管理；每个会话的标签页开在自己的窗口和分组里，`owner` 字段标明归属 |
| `navigate` | 打开 URL，或传 `back` / `forward` |
| `screenshot` | 默认截可视区域（图片像素 = CSS 像素，可直接用于 `click` 坐标）；`fullPage: true` 截整页（最高 16000px）；`ref` 只截某个元素 |
| `read_page` | 无障碍树，元素带 `ref_N`，`filter: "interactive"` 只列可操作元素 |
| `find` | 按角色、名称、值模糊查找元素 |
| `click` / `hover` | 按 `ref` 或 `coordinate` |
| `type` / `key` | 输入文本 / 按键（如 `Enter`、`cmd+a Backspace`） |
| `scroll` | 滚轮滚动 |
| `get_page_text` | 页面正文 |
| `eval_js` | 在页面执行 JS（支持顶层 await，结果 JSON 编码） |
| `console_logs` | 控制台日志与未捕获异常 |
| `file_upload` | 上传本地文件：`ref` 可以是 `<input type=file>`，也可以是会弹出文件选择框的按钮（自动拦截选择框）；页面只有一个文件输入框时可以省略 `ref` |

Claude 默认只操作本会话当前选中的标签页：先用 `tabs_create` 新开，或用 `tabs_select` / `tabId` 明确指定。

## 安全设计

- 只监听 `127.0.0.1`，并校验 Host 头（防 DNS rebinding）
- 插件连接必须来自 `chrome-extension://` Origin，并带正确 token；可设置 `CLAUDE_CHROME_EXTENSION_ID` 锁定插件 id
- `chrome://`、扩展页、Chrome 网上应用店始终禁止；可在弹窗里添加禁止的域名（包含子域名）
- 被控制的标签页会显示 Chrome 的「正在调试」提示条；用户点了「取消」后，Claude 不会静默地重新附加
- 弹窗里可以一键「暂停控制」或「断开所有标签页的调试」
- 文件上传在 Server 端校验路径：必须是绝对路径、真实存在的普通文件（先解析软链接），单个文件不超过 200 MB；`~/.ssh`、`~/.aws`、`~/.gnupg`、`.env`、`.netrc`、私钥文件和 `~/.claude-chrome` 始终禁止上传；设置 `CLAUDE_CHROME_UPLOAD_DIRS` 后，只允许上传这些目录下的文件

## 多个 Claude 会话同时工作

每个 Claude Code 会话都会启动一个 server 进程。第一个绑定端口的进程成为 hub，之后的进程作为 peer 通过 hub 转发请求；hub 退出后，peer 会自动选出新的 hub，插件也会自动重连。

每个请求都带有会话 id，插件按会话隔离：

- 每个会话有自己的窗口和标签页分组（「Claude 1」「Claude 2」…），截图时切换前台互不干扰
- 每个会话有自己的「当前标签页」，另一个会话新开标签页不会影响它
- 会话不能操作其他会话的标签页（返回 `TAB_IN_USE`）；只有用户要求时，才用 `tabs_select` 加 `takeOver: true` 接管
- 会话结束后，它的标签页保留给用户，归属关系随之释放

## 环境变量

| 变量 | 默认值 |
|---|---|
| `CLAUDE_CHROME_PORT` | `18765`（修改后，插件弹窗里也要改成同样的端口） |
| `CLAUDE_CHROME_HOME` | `~/.claude-chrome` |
| `CLAUDE_CHROME_TOKEN` | 从 token 文件读取 |
| `CLAUDE_CHROME_EXTENSION_ID` | 不限制 |
| `CLAUDE_CHROME_UPLOAD_DIRS` | 不限制目录（敏感文件仍然禁止）；用冒号分隔多个目录，如 `~/Downloads:~/Documents` |

## 开发

```bash
pnpm typecheck
pnpm test          # hub / peer / 选主 单元测试
CHROME_PATH="/path/to/Google Chrome for Testing" pnpm e2e
```

E2E 测试会用真实浏览器加载插件，通过 MCP 客户端逐个调用所有工具，覆盖文件上传，以及两个会话并发操作的场景。正式版 Chrome 137 起不再支持 `--load-extension`，所以 E2E 需要使用 Chromium 或 Chrome for Testing。

## 已知限制

- `read_page` / `find` 只覆盖主 frame，暂不深入 iframe
- 同一时刻只能连接一个 Chrome（一个配置文件）；多个 Claude 会话可以同时操作这一个 Chrome。多个 Chrome 配置文件都装了插件时，后连上的会替换先连上的
- 插件会话状态存在 `chrome.storage.session` 中，浏览器重启后清空
- 控制台日志从 Claude 首次附加到该标签页时才开始收集
