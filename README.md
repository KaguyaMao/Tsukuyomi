# Tsukuyomi

![Tsukuyomi](kaguya.jpg)

_tsukuyomi_ —— 一个由 PI 编码-agent 内核驱动的全屏终端界面。它不主题也不嵌入 PI 的交互式 TUI：_tsukuyomi_ 独立掌控终端、布局、编辑器、导航和对话框，而后台的 PI RPC 进程负责模型、工具、会话和扩展。

```text
终端 ── Tsukuyomi TUI ── JSONL RPC ── PI 内核
                                      ├── 提供者与模型
                                      ├── 会话与工具
                                      ├── 原生 PI 插件
                                      └── Tsukuyomi 紧急修复插件
```

原始的 `pi` 命令和 `~/.pi/agent` 保持不变。

## 界面

- **启动**：采用 Grok Build 风格的动作卡，支持新建/恢复会话、工作区切换、提供者/模型配置、设备和退出；全宽编辑器随时可用。
- **语言**：TUI 同时支持英文和简体中文。使用 `/language`、`--language en|zh`、`TSUKUYOMI_LANG` 环境变量，或持久化的 `tsukuyomi.json` preference；默认随系统 locale。
- **右侧 rail**：Workflow / Todo 面板默认在宽工作区打开；Files 为可选，所有 rail 在窄终端上变成叠加层。
- **正常会话**：按 Enter 或 `/new` 打开工作区布局，无需假设当前目录是已声明的工作区。
- **文件树**：仅在明确指定目录（`tsukuyomi <directory>`、`--workspace` 或 `/workspace`）出现。接受后，左侧为根目录的可折叠树，不跟随符号链接。
- **中心列**：采用 Grok Build 的连续滚动布局：一行的工作区/会话状态栏、有序的转历史、足够宽的会话时的两列转时间线、实时运行状态行、任务/队列档以及宽敞的圆角 composer。
- **用户输入**：使用 Grok 风格的 `❯` 条带。composer 使用相同的提示标记，并在底部边栏整合模型、模式、思考和上下文信息。
- **侧面面板**：文件树、Workflow 和 Todo 采用深色背景、紧凑的标题、树导航、独立滚动、悬停状态、可拖动滚动条。Workflow 卡暴露实时状态、已用时、预览文本和可折叠输出；Todo 使用 `[✓]`、 `[•]` 和 `[ ]` 状态。
- **工具**：`/tools` 打开内置和注册工具的实时多选列表，变更即时生效并跨启动持久化。
- **会话浏览**：`/sessions` 或 `Ctrl+S` 打开按工作区分组的全屏可搜索会话浏览器。`Tab` 过滤当前工作区，`Delete` 将会话移动到可恢复的 `.trash` 目录。
- **提供者浏览器**：`/provider` 打开搜索able OpenCode-style 提供者浏览器，包含断开的提供者。选择后在需要时执行 OAuth/API-key 登录，然后打开模型列表。最后一行只询问 id、name、URL 和 API key，从 `/models` 端点发现模型，并持久化配置到 `providers.json`（以及派生的 `models.json`）。自定义提供者也可手工编写；请见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md)。
- **推理结果**：完成后默认折叠。`Ctrl+E` 展开最新的推理和内联语义 diff；编辑 diff 使用旧/新行号配合红绿行，并提供 14 行的 collapsed preview。
- **状态**：`/status` 显示当前会话的 token/context 使用情况和当前提供者的查询：xAI/Grok 订阅计划（OAuth）、Codex 账户窗口、OpenRouter key 预算或 DeepSeek balance。不提供公共端点的提供者（例如带 API key 的 xAI）将说明使用实际所在位置，而非虚假请求；凭证永远不从另一提供者借用。`/status refresh` 绕过短期缓存。
- **窄屏适配**：在 120 列宽度以下，侧面面板变成中央浮动叠层，而非压缩对话。`Ctrl+B`、`Ctrl+O` 和 `Ctrl+T` 独立打开 Files、Workflow 和 Todo。
- **IME 友好**：会话编辑器使用硬件 blinking bar，光标下的字符保持正常绘制，确保 IME 预编辑文本可读。
- **鼠标支持**：鼠标是“一等公民”——点击对话行选择，点击控件关闭面板，点击目录展开，点击文件插入 `@path` 引用，点击 Workflow 卡展开输出，点击时间线跳转转，点击 composer metadata 选择模型/模式。鼠标滚轮独立滚动 Files、Workflow、Todo 或指针下的 transcript；每个滚动条都可拖动。Linux 下中键粘贴 PRIMARY 选择到 composer。设置 `TSUKUYOMI_TOUCH_MODE=1` 或使用 `/touch on` 禁用 transcript drag selection 用于 touchscreens。

## Markdown 渲染

_tsukuyomi_ 使用零依赖的自渲染器 (`app/markdown.mjs) 在终端中渲染 Markdown，无需运行时库。输出准备好的行携带 SGR/OSC 8 序列，因此在支持它们的终端中颜色和可点击的链接可以正常工作（例如 iTerm2、WezTerm、Ghostty、Kitty，以及 recent GNOME/VTE）。

Markdown 在四个地方应用：

- **聊天消息正文**（助手和用户转）：标题、段落、列表、块引用、表格、水平规则，以及 fenced/缩进代码块。内部粗体、斜体、 strikethrough、内部代码、链接、autolinks、图片（显示为 alt text）均被支持。流式文本增量包裹，仅在消息最终后重新渲染 Markdown，以避免 reflow jitter 和 O(n²) 重分析。
- **代码块**：围栏代码块带有语言标签和轻量语法高亮，支持 `js`/`ts`/`json`/`python`/`bash`/`yaml`/`sql`/`xml`/`css`/`markdown` 等；未知语言回退为纯文本。代码块永不自动换行，所以长行保持完整。
- **工具输出和文件预览**：纯文本工具行（例如 `read`/`exec` 输出和 `web_fetch` 正体）获取内联 Markdown；按扩展名阅读的文件内容按行按扩展名高亮。Diff、JSON 树和其他结构化工具输出保持原有渲染。
- **命令描述**：命令/模型/工具拾取器中的选项描述使用内联 Markdown。

**支持的语法**：

- 标题 `#`–`######`
- 粗体 `**x**` / `__x__`，斜体 `*x*` / `_x_`， strikethrough `~~x~~`
- 内联代码 `` `x` ``
- 链接 `[text](url)` 连同 OSC 8 超链接，以及 autolinks 和裸 URL
- 无序 `-`/`*`/`+`，有序 `1.`，以及任务 `- [ ]` / `- [x]` 列表，可嵌套
- 块引用 `>` (可嵌套)
- GFM 表格，左/中心/右对齐
- 水平规则 `---`
- Fenced ```` ``` ```` 和缩进代码块

渲染器 SGR 友好：单词包裹保留样式，每 emitted line 独立（重新打开并重置自己的样式），所以周围 UI 可以前置缩进而不破坏格式。`tsukuyomi.json` 中的 `markdown` preference（默认开启）可禁用上述所有内容，回退为纯文本包裹；可从 **Settings → Render Markdown in chat** 切换，或在 `~/.tsukuyomi/agent/tsukuyomi.json` 设置 `markdown: false`。

## PI 兼容性

_tsukuyomi_ 一次性导入原始 PI 配置到 `~/.tsukuyomi/agent`。继承包、扩展、技能、提示、模型、系统提示、 auth、trust 设置和提供者配置。相对 PI 资源路径在加载前转换为绝对路径。

独立的 TUI 通过 PI 的 RPC 扩展 UI 协议实现命令发现、通知、状态条、 widget、select/confirm 对话框和文本编辑器。插件工具和钩子正常在 PI 内部执行。直接通过 `ctx.ui.custom()` 注入 PI 专用终端组件的插件无法转移到独立的 RPC 前端；其非 TUI 工具、钩子和命令仍然可用。

## 提供者与登录

登录由前端掌控，而非 RPC 内核（PI 的 RPC 协议不暴露 auth 命令）。_tsukuyomi_ 通过 `ModelRuntime` 驱动 PI 自身的提供者 auth 实现，因此 OAuth 凭证携带 PI 期望的提供者特定字段（例如 `openai-codex` 存储 `accountId`）。凭证驻留在 `~/.tsukuyomi/agent/auth.json`（PI 的 schema，`0600`, atomic writes），并从 `~/.pi/agent/auth.json` once 导入。

内置提供者从 `/provider` 连接（OAuth 账户登录或 API key；`openai → openai-codex` 等别名解析）。自定义提供者使用 opencode-style `providers.json` 作为真实来源，转换为 PI 的 `models.json`；`models.json` 也可直接编辑并在此加载时导入。请见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md) 了解完整的提供者、模型和登录参考（内置提供者、自定义提供者、两种配置格式、转换规则、凭证和故障排除）。

## 可靠的压缩

`src/backend.ts` 是一个正常的 PI extension 加载到 RPC 内核。其 compact repair：

- 通过 `session_before_compact` 拦截手动、阈值和 overflow compaction；
- 写入 provider-independent continuity checkpoint，而非依赖第二个模型 summarization 请求；
- 保存先前的 checkpoints、相关的 transcript 和 read/modified file lists；
- 增加 82% 的 context-usage fallback trigger；
- 保持 `/kcompact` 供 plugin-level diagnostics 使用。

在 Tsukuyomi 中使用 `/compact` 进行手动压缩。结果和失败出现在右侧 Workflow 面板。

## 性能

前端合并重复的 message/stats refreshes，缓存 idle transcript layout，节流 live spinner redraws，且不因编辑器光标闪烁而 repaint。PI 的内核和已安装的 `pi-tui` package 保持未修改。

长时间运行的 prompt 仍可能由模型推理、网络/工具延迟或 context compaction 引起。请见 [`docs/performance.md`](docs/performance.md) 了解可选的 `pi-cache-optimizer` 审查以及为什么 launcher monkey-patching optimizers 未自动启动。

## 安装

npm 包需要 Node.js 20 或更新。x86_64 RPM、Arch 和 Debian 包是完整的快照，自带私有 Node.js/npm runtime，PI runtime 和 production dependencies 钉扎；它们不替换系统的 `node`、`npm` 或 `pi`。Tsukuyomi 在有 `socat` 时使用 PTY RPC 传输，否则回退到直接 Node pipes。

**从 npm 全局安装**：

```bash
npm install --global --ignore-scripts tsukuyomi
tsukuyomi
```

**使用 DNF 安装本地 RPM**：

```bash
sudo dnf install ./tsukuyomi-0.5.0-1.x86_64.rpm
tsukuyomi
```

**使用 pacman 安装本地 Arch 包**：

```bash
sudo pacman -U ./tsukuyomi-0.5.0-1-x86_64.pkg.tar.zst
tsukuyomi
```

**使用 APT 安装本地 Debian/Ubuntu 包**：

```bash
sudo apt install ./tsukuyomi_0.5.0-1_amd64.deb
tsukuyomi
```

**从检出构建所有包格式**（需要 Node.js/npm，已安装的项目依赖和 Podman）：

```bash
npm run package:all
```

原生 `node-pty` addon 在 glibc 2.28 构建器中重建，随后 RPM、Arch 和 Debian 包写入 `dist/packages/`。若无 npm，legacy symlink installer 仍可用：

```bash
chmod +x ~/Tsukuyomi/install.sh
~/Tsukuyomi/install.sh
tsukuyomi
```

现有的 PI 凭证一次性导入。新的登录独立保存到 Tsukuyomi 的 `auth.json`；提供者变更在保存的会话的同时重建 RPC 内核。

## 命令和快捷键

| Input | Action |
|---|---|
| `Enter` | 开始工作区会话 / 提交提示 |
| `Ctrl+P` | 打开 Tsukuyomi 和加载的 PI 插件的命令 |
| `Shift+Tab` | 循环 Build → Plan → Ask |
| `Ctrl+B` | 折叠/展开当前工作区的文件树 |
| `Ctrl+O` | 折叠/展开 Workflow |
| `Ctrl+T` | 折叠/展开 Todo |
| `/tools` | 启用或禁用任何注册的工具 |
| `/sessions` / `Ctrl+S` | 浏览和恢复已保存的会话 |
| `/provider` | 连接提供者或添加自定义提供者，然后选择模型 |
| `Ctrl+E` | 展开/折叠最新的完成推理和内联 diff |
| `/language [en\|zh]` | 切换并持久化 TUI 语言 |
| `/status [refresh]` | 显示会话使用情况和当前提供者配额 |
| 鼠标点击 | 选择对话框、展开文件/工具输出、跳转转、关闭面板或聚焦 composer |
| 鼠标滚轮 | 独立滚动 Files、Workflow、Todo 或指针下的 transcript |
| `/touch [on\|off]` | 启用 touch-safe 指针处理并防止意外 transcript 选择 |
| Linux 中键 | 将 X11/Wayland PRIMARY 选择粘贴到 composer |
| `PageUp` / `PageDown` | 滚动 transcript |
| `Esc` | 中止活动运行或关闭对话框 |
| `Ctrl+C` | 清除输入、中止或在空闲时退出 |

内置前端命令包括 `/new`、`/compact`、`/mode`、`/workspace`、`/files`、`/workflow`、`/todo`、`/sidebar`、`/model`、`/thinking`、`/tools`、`/sessions`、`/language`、`/status`、`/touch`、`/help` 和 `/quit`。`/model` 打开可点击/键盘模型选择器；`/model provider/model-id` 直接选择一个。`/thinking` 打开 centered、可点击/键盘 reasoning-intensity chooser；`/thinking <level>` 直接选择一个受支持的级别。其他发现的 slash command 传递给 PI，包括 extension commands、prompt templates 和 skills。

**直接在受限模式启动或通过 PI 的 session flags 恢复**：

```bash
tsukuyomi ~/my-project
tsukuyomi ~/my-project --plan
tsukuyomi --workspace ~/my-project
tsukuyomi --plan
tsukuyomi --ask
tsukuyomi --continue
tsukuyomi --session /path/to/session.jsonl
```

Inside Tsukuyomi, `/workspace /path/to/project` 切换 PI 内核到该目录并询问是否显示其文件树。

## Web 工具

_tsukuyomi_ 注册了两个 PI 工具：

- `web_fetch`：抓取公共 HTTP(S) URL，将公共 HTTP URL 升级为 HTTPS，阻止本地/私有 DNS 目标，跟随同主机重定向，将 HTML 转换为 Markdown，并截断过大的响应。
- `web_search`：默认使用 DuckDuckGo 的 HTML 端点，不需要 API key。设置 `TSUKUYOMI_WEBSEARCH_URL` 为 Responses API base URL（例如 `https://api.x.ai/v1`），加上 `TSUKUYOMI_WEBSEARCH_KEY` 或 provider 的 `XAI_API_KEY`，并可选地 `TSUKUYOMI_WEBSEARCH_MODEL`，以使用该后端代替。

可选的抓取限制和域白名单可存储在 `~/.tsukuyomi/agent/tsukuyomi-web.json`：

```json
{
  "allowedDomains": ["docs.example.com", "developer.mozilla.org"],
  "allowLocal": false,
  "timeoutMs": 30000,
  "maxBytes": 1048576,
  "maxChars": 120000
}
```

## 模式

| 模式 | 行为 |
|---|---|
| Build | 全 PI 和 plugin 工具集 |
| Plan | 只读探索；禁止编辑和变更 Shell 命令 |
| Ask | 只回答；禁止编辑和 Shell |

模式限制由 PI-side extension 强制执行，而非仅由前端展示。

## 配置

| 路径 | 用途 |
|---|---|
| `~/.tsukuyomi/agent/settings.json` | 合并的 PI 后端设置和资源 |
| `~/.tsukuyomi/agent/sessions/` | Tsukuyomi 会话，独立于 PI 的默认会话 |
| `~/.tsukuyomi/agent/tsukuyomi-tools.json` | 通过 `/tools` 持久化的已禁用工具 |
| `~/.tsukuyomi/agent/tsukuyomi-web.json` | 可选的 `web_fetch` 限制和域白名单 |
| `~/.tsukuyomi/agent/tsukuyomi.json` | 持久化的 Tsukuyomi preference，包括 `language` |
| `~/.tsukuyomi/agent/auth.json` | 凭证存储，与 PI 内核共享（0600 权限） |
| `~/.tsukuyomi/agent/providers.json` | opencode-style 自定义提供者（真实来源，JSONC） |
| `~/.tsukuyomi/agent/models.json` | PI-native provider config derived from `providers.json` |

请见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md) 了解完整的提供者、模型和登录参考（内置提供者、自定义提供者、两种配置格式、转换规则、凭证和故障排除）。

设置 `TSUKUYOMI_DIR` 以使用其他后端配置目录或 `TSUKUYOMI_PI` 以选择不同的 PI 可执行文件。设置 `TSUKUYOMI_LANG=en|zh` 选择界面语言，`TSUKUYOMI_STATUS_URL` 覆盖 HTTPS Codex 使用端点（Codex 仅当使用兼容网关时）。

## 旧名：KaguyaPi

`kaguyapi` 在 0.6.0 版本重命名为 `tsukuyomi`。配置从 `~/.kaguyapi/agent` 迁移至 `~/.tsukuyomi/agent`，环境变量从 `KAGUYAPI_*` 变为 `TSUKUYOMI_*`，内部 `kaguya*.json` 文件变为 `tsukuyomi*.json`。首次启动时，Tsukuyomi 执行一次性、非破坏性的迁移自 `~/.pi/agent` 和 `~/.kaguyapi/agent`；源从未被修改。遗留的 `KAGUYAPI_*` 变量仍被读取，`kaguyapi` 命令是一个转发至 `tsukuyomi` 的废弃 shim（删除 `bin/kaguyapi.mjs` 可移除它）。

## 卸载

```bash
rm -f ~/.local/bin/tsukuyomi
rm -rf ~/.tsukuyomi
```

这不移除或更改原始的 PI 安装。