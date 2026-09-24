# Tsukuyomi

![Tsukuyomi](kaguya.jpg)

_tsukuyomi_ —— 一个由 PI 编码-agent 内核驱动、但由 Tsukuyomi 完整掌控配置和交互的全屏终端界面。它不主题也不嵌入 PI 的交互式 TUI：_tsukuyomi_ 独立掌控终端、布局、编辑器、导航和对话框，而后台的 PI RPC 进程只负责模型、工具、会话和扩展运行时。

```text
终端 ── Tsukuyomi TUI ── JSONL RPC ── PI 内核
                                      ├── 提供者与模型
                                      ├── 会话与工具
                                      ├── 原生 PI 插件
                                      └── Tsukuyomi 紧急修复插件
```

Tsukuyomi 使用 `~/.tsukuyomi/agent` 作为唯一运行时配置根目录；Pi 作为内核读取该目录。旧的 `~/.pi/agent` 只在首次启动时作为迁移源，不会继续参与运行。

## 快捷键预设

默认采用 OMP 风格快捷键：`Ctrl+P` / `Ctrl+Shift+P` 顺序切换当前可用模型，`Alt+M` 选择模型，`Alt+Shift+P` 切换 Build/Plan，`Shift+Tab` 轮换当前模型的思考等级，`Ctrl+T` 切换最近的思考块，`Ctrl+O` 展开最近的工具输出，`Ctrl+Q` / `Ctrl+Enter` 排入后续消息，`Alt+A` 打开 Agent Hub。只轮换 Pi 报告的实际可用模型和思考等级；无可用项时显示提示。`Ctrl+B` 文件、`Ctrl+S` 会话等 Tsukuyomi 特有键位保留；`Ctrl+S` 不是 OMP 的 Hub 别名。

在 `/settings` →「键盘快捷键」可切回 Tsukuyomi 旧版预设（`Ctrl+P` 命令面板、`Shift+Tab` 模式、`Ctrl+O/T` 工作流/Todo、`Alt+Enter` 后续消息、`Ctrl+Enter` 强制插话）。选择写入 `tsukuyomi.json` 的 `keybindingPreset`（`omp` 或 `legacy`）；可通过 `keybindingOverrides` 对单个动作指定 chord 数组，空数组表示禁用。完整动作表见 [`docs/TUI-KEYBINDINGS.md`](docs/TUI-KEYBINDINGS.md)。未实现的 OMP 专用动作（外部编辑器、role model、revive、advisor）不显示伪快捷键。

## 界面

- **启动**：采用 Grok Build 风格的动作卡，支持新建/恢复会话、工作区切换、提供者/模型配置、设备和退出；全宽编辑器随时可用。
- **语言**：TUI 同时支持英文和简体中文。使用 `/language`、`--language en|zh`、`TSUKUYOMI_LANG` 环境变量，或持久化的 `tsukuyomi.json` preference；默认随系统 locale。
- **右侧 rail**：OMP 预设默认单列，Workflow / Todo 按需打开；旧版预设仍默认打开。Files 仅在声明工作区后可选，所有 rail 在窄终端上变成叠加层。
- **正常会话**：按 Enter 或 `/new` 打开工作区布局，无需假设当前目录是已声明的工作区。
- **文件树**：仅在明确指定目录（`tsukuyomi <directory>`、`--workspace` 或 `/workspace`）出现。接受后，左侧为根目录的可折叠树，不跟随符号链接。
- **中心列**：采用 Grok Build 的连续滚动布局：一行的工作区/会话状态栏、有序的转历史、实时运行状态行、任务/队列档以及宽敞的圆角 composer。用户消息背景铺满会话列。双列时间线只在旧版预设的宽会话中显示。
- **用户输入**：使用 Grok 风格的 `❯` 条带。composer 使用相同的提示标记，并在底部边栏整合模型、模式、思考和上下文信息。
- **侧面面板**：文件树、Workflow 和 Todo 采用深色背景、紧凑的标题、树导航、独立滚动、悬停状态、可拖动滚动条。Workflow 卡暴露实时状态、已用时、预览文本和可折叠输出；Todo 使用 `[✓]`、 `[•]` 和 `[ ]` 状态。
- **工具**：`/tools` 打开内置和注册工具的实时多选列表，变更即时生效并跨启动持久化。
- **会话浏览**：`/sessions` 或 `Ctrl+S` 打开按工作区分组的全屏可搜索会话浏览器。`Tab` 过滤当前工作区，`Delete` 将会话移动到可恢复的 `.trash` 目录。
- **提供者浏览器**：`/provider` 打开可搜索的 OpenCode-style 提供者浏览器，包含断开的提供者。选择后在需要时执行 OAuth/API-key 登录，然后打开模型列表。最后一行只询问 id、name、URL 和 API key，从 `/models` 端点发现模型，并持久化配置到 `providers.json`（以及派生的 `models.json`）。自定义提供者也可手工编写；请见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md)。
- **自定义 Agent**：`/agents` 创建和保存具名 Agent。每个 Agent 可独立绑定供应商、模型、账户、系统提示词、思考强度、模式和工具集；会话恢复时自动恢复当前 Agent。
- **Skills**：`/skill` 打开由 Tsukuyomi 管理的 Skill 清单，可查看、选择开启或关闭；配置保存到 `tsukuyomi-skills.json`，应用后重启 PI 内核。开启的 Skill 可通过 `/skill:<name>` 调用，PI 不再读取其他 skill 根目录。
- **Agent Hub / Team**：`/team`、`/tasks` 或 OMP 预设的 `Alt+A` 打开统一 Hub。宽屏同时显示名单和检查器，窄屏用 Tab 切换。Hub 只列出真实团队成员、待批权限、报告、当前工作区任务和 Agent 模板；usage、revive、parked、advisor 显示 `—`，没有对应按钮。成员配置仍走原授权流程。支持 `Peer` 与 `Leader`；Leader 方案必须经用户批准后才会启动执行成员。每个成员可独立选择 research/review/build 权限和只读、Git worktree 或 shared-write 单写者租约。取消、steer 和应用补丁前会重新核对任务状态；服务端继续检查 subagent 开关、工作区指纹和 `git apply --check`。
- **Plan 模式**：采用 Codex 风格的只读探索与执行审批。模型只在会实质改变方案的歧义上通过原生 questionnaire 对话框询问至多三个问题；方案完成后可选择执行、继续规划或细化方案。
- **推理结果**：完成后默认折叠。OMP 预设用 `Ctrl+T` 切换最近思考块、`Ctrl+O` 展开最近工具输出；旧版预设保留 `Ctrl+E` 联动展开。编辑 diff 使用旧/新行号配合红绿行。
- **状态**：`/status` 显示当前会话的 token/context 使用情况和当前提供者的查询：xAI/Grok 订阅计划（OAuth）、Codex 账户窗口、OpenRouter key 预算或 DeepSeek balance。不提供公共端点的提供者（例如带 API key 的 xAI）将说明使用实际所在位置，而非虚假请求；凭证永远不从另一提供者借用。`/status refresh` 绕过短期缓存。
- **错误回弹**：任意一轮模型/供应商请求失败时（`stopReason: "error"`），底部自动弹出红色错误摘要（带 provider/model 与脱敏），同时该错误以红色行保留在对话记录中，不再只留下一个空白回复块。
- **窄屏适配**：在 120 列宽度以下，侧面面板变成中央浮动叠层，而非压缩对话。`Ctrl+B` 打开 Files。Workflow / Todo 的 `Ctrl+O` / `Ctrl+T` 属于旧版预设；OMP 预设用这两个键展开工具输出和思考块，面板仍可从命令或界面打开。
- **IME 友好**：会话编辑器使用硬件 blinking bar，光标下的字符保持正常绘制，确保 IME 预编辑文本可读。
- **鼠标支持**：鼠标是“一等公民”——点击对话行选择，点击控件关闭面板，点击目录展开，点击文件插入 `@path` 引用，点击 Workflow 卡展开输出，点击时间线跳转转，点击 composer metadata 选择模型/模式。鼠标滚轮独立滚动 Files、Workflow、Todo 或指针下的 transcript；每个滚动条都可拖动。Linux 下中键粘贴 PRIMARY 选择到 composer。设置 `TSUKUYOMI_TOUCH_MODE=1` 或使用 `/touch on` 禁用 transcript drag selection 用于 touchscreens。

## Markdown 渲染

_tsukuyomi_ 使用零依赖的自渲染器 (`app/markdown.mjs`) 在终端中渲染 Markdown，无需运行时库。输出准备好的行携带 SGR/OSC 8 序列，因此在支持它们的终端中颜色和可点击的链接可以正常工作（例如 iTerm2、WezTerm、Ghostty、Kitty，以及 recent GNOME/VTE）。

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

_tsukuyomi_ 一次性导入原始 PI 配置到 `~/.tsukuyomi/agent`，之后由 Tsukuyomi 作为唯一配置入口运行 PI。模型、提供者、账户、工具、模式、会话、扩展和 Skill 都从 Tsukuyomi 的界面与 canonical root 管理；旧的 `~/.pi/agent` 和项目级 PI 资源不会参与默认运行。

内核已集成进 Tsukuyomi：`@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 都是包的普通依赖，启动时由 Node 的模块解析定位随包安装的那一份（连同 `pi-tui`），因此不需要系统级 `pi`，RPM/Arch/Debian 快照也直接使用内置 runtime。内核仍以独立 RPC 子进程运行，保持隔离；`TSUKUYOMI_PI` 可覆盖为外部 `pi`，`TSUKUYOMI_USE_SOURCE=1` 可强制使用源码检出。

Skill 由 Tsukuyomi 独立发现和保存启用状态。启动 PI RPC 内核时，Tsukuyomi 传入 `--no-skills` 及已开启的 Skill 文件列表，因此 PI 的独立 Skill 配置、`~/.pi/agent/skills`、`~/.agents/skills` 和项目 Skill 不会覆盖 Tsukuyomi 的选择。`/skill` 是唯一的 Skill 管理入口。

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

针对长会话造成的卡顿，前端采用 Grok Build / Codex 风格增量同步，而不是每次事件都重新拉取整份历史：

- **JSONL 增量缓冲**：RPC 读取器只扫描新到达的字节，不再对累积缓冲从 0 重新扫描；长会话的 `get_messages` 响应不再让事件循环 O(n²) 阻塞，键盘输入因此保持响应。
- **增量消息镜像**：前端跟随内核的 `message_end` 直接追加最终消息（与内核自身的 `state.messages.push` 一致），而不是每条消息都请求一次完整快照。完整快照只作为安全网：首个回合、周期性（每 10 个回合）以及压缩后运行一次。
- **增量派生状态**：Workflow、Todo、user/assistant 计数按新增消息更新，避免每个回合重新遍历全部历史。
- **会话目录缓存**：`/sessions` 只读取每个会话文件的有界头部/尾部并缓存元数据，不再把上百 MB 的 JSONL 全部解析到主线程。
- **懒文件树刷新**：只有在 Files 面板可见时才重新扫描工作区目录。
- **异步 curl 回退**：配额/OAuth 端点的 curl 回退改为异步 `spawn`。此前同步的 `spawnSync` 会在 `/status`、登录或 token 刷新期间阻塞整个 TUI 事件循环（最长到 `--max-time`），表现为界面和键盘完全卡死。

长时间运行的 prompt 仍可能由模型推理、网络/工具延迟或 context compaction 引起。请见 [`docs/performance.md`](docs/performance.md) 了解可选的 `pi-cache-optimizer` 审查以及为什么 launcher monkey-patching optimizers 未自动启动。

## 安装

npm 包需要 Node.js 20 或更新。**PI 内核已作为依赖随包安装**（`@earendil-works/pi-coding-agent` 及 `pi-agent-core`/`pi-ai`），Tsukuyomi 通过 Node 自身的模块解析使用自己钉扎的那一份，因此无需再单独全局安装 `pi`；`TSUKUYOMI_PI` 仍可覆盖为一个外部 `pi`。x86_64 RPM、Arch 和 Debian 包是完整的快照，自带私有 Node.js/npm runtime，PI runtime 和 production dependencies 钉扎；它们不替换系统的 `node`、`npm` 或 `pi`。Tsukuyomi 默认使用直接 Node pipes；只有显式配置 `TSUKUYOMI_SOCAT`（或兼容的 `KAGUYAPI_SOCAT`）时才使用 PTY RPC 传输，以兼容包含非 ASCII 字符的安装路径。

## 自动更新

从 GitHub 源代码检出目录启动时，Tsukuyomi 会通过 GitHub Compare API 检查 `origin` 的默认分支。只有 `app/`、`bin/`、`src/` 或包清单发生变化时，才会显示最新 commits、变更文件并询问是否更新。

- 确认后仅接受干净工作区上的 `git pull --ff-only`，不会覆盖本地改动。
- `package.json` 或 `package-lock.json` 变化时，会在更新后运行 `npm install --ignore-scripts`，然后自动重启。
- RPM、Arch 和 Debian 安装包不是 Git 检出目录，因此不会绕过系统包管理器自更新。
- 设置 `TSUKUYOMI_UPDATE_CHECK=0` 可关闭启动检查；运行 `/update` 可在 TUI 中手动检查。

**从 npm 全局安装**：

```bash
npm install --global --ignore-scripts tsukuyomi
tsukuyomi
```

**在 Windows 上安装（PowerShell / Windows Terminal）**：

1. 安装 Node.js 20 或更新版本（<https://nodejs.org> 的 LTS 安装包，或 `winget install OpenJS.NodeJS.LTS`）。
2. 安装 Tsukuyomi（内核随依赖一起安装，无需单独装 `pi`）：

   ```powershell
   npm install -g --ignore-scripts .\tsukuyomi-0.6.0.tgz
   # 或者，在源码目录中：
   # npm install -g --ignore-scripts .
   ```

3. 运行：

   ```powershell
   tsukuyomi
   # 中文界面：
   tsukuyomi --language zh
   ```

   配置与凭据保存在 `%USERPROFILE%\.tsukuyomi\agent`。

注意事项：

- 请使用 **Windows Terminal**（或支持 ANSI/鼠标转义的终端）；旧版 `conhost.exe` 的鼠标/颜色支持不完整。
- 内核已内置，`tsukuyomi` 会使用 `node_modules\@earendil-works\pi-coding-agent` 那份；只有当你想用外部 `pi` 时才需要 `npm install -g @earendil-works/pi-coding-agent` 并设置 `TSUKUYOMI_PI`。
- `node-pty` 内置 `win32-x64`/`win32-arm64` 预编译，`@oh-my-pi/pi-natives` 也提供对应的 Windows 可选依赖，因此**不需要 Visual Studio / node-gyp**；`--ignore-scripts` 不会影响它们（原生模块在运行时从 `prebuilds/` 加载）。
- 若 PowerShell 禁止运行 `npm.ps1`，改用 `npm.cmd`，或执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- 建议安装 Git for Windows；`/team`、worktree 隔离和部分工具需要 `git` 在 `PATH` 中。
- 终端命令（subagent/PTY 任务）在 Windows 上通过 `ComSpec`（`cmd.exe`）执行；任务的本地控制通道使用命名管道。
- 从源码目录运行时，`npm install` 会安装包括 `pi-tui` 在内的依赖；`npm link` 或 `npm install -g .` 都可让 `tsukuyomi` 命令全局可用。

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

如果 OpenCode 使用文件式凭据，可运行 `tsukuyomi --migrate-opencode` 将其所有已登录供应商复制到 canonical root；OpenCode 的 `api` 凭据会转换为 PI 的 `api_key`，OpenAI OAuth 会转换为 `openai-codex`，源文件不会被修改。支持 `--dry-run` 预览，或用 `--opencode-auth` / `--opencode-config` 指定文件。

## 命令和快捷键

| Input | Action |
|---|---|
| `Enter` | 开始工作区会话 / 提交提示 |
| `Ctrl+Q` / `Ctrl+Enter` | OMP 预设：将输入作为 follow-up 排队 |
| `Alt+Enter` | 旧版预设：follow-up；OMP 预设不占用此键 |
| `Ctrl+Enter` | 旧版预设：强制打断并发送；通用命令仍是 `/interrupt <text>` |
| `Ctrl+P` | OMP 预设：轮换模型；旧版预设：命令面板 |
| `Alt+Shift+P` / `Shift+Tab` | 分别在 OMP / 旧版预设中切换 Build/Plan。没有 Ask 模式 |
| `Alt+A` | OMP 预设：打开 Agent Hub |
| `Ctrl+B` | 折叠/展开当前工作区的文件树 |
| `Ctrl+O` / `Ctrl+T` | OMP 预设：展开工具 / 切换思考；旧版预设：Workflow / Todo |
| `/settings` / `/config` | 打开全屏设置界面（界面偏好、供应商与鉴权、账户、模型、工具、会话、关于） |
| `/tools` | 启用或禁用任何注册的工具 |
| `/sessions` / `Ctrl+S` | 浏览和恢复已保存的会话 |
| `/provider` | 连接提供者或添加自定义提供者，然后选择模型 |
| `/accounts` | 查看并切换已保存的供应商账户 |
| `/interrupt <text>` | 强制打断当前回合并插入该提示词 |
| `/steer <text>` | 在当前回合内插入纠正 |
| `/followup <text>` | 在当前回合后追加提示词 |
| `/agents` | 创建、编辑、启用或删除可复用 Agent |
| `/skill` | 查看并开启/关闭 Skill（`/skills` 为兼容别名） |
| `/team` / `/tasks` | 打开 Agent Hub；团队管理、任务检查、权限和补丁确认都从这里进入 |
| `/mode plan` | 进入 Codex 风格只读计划模式（支持交互式澄清问题） |
| `Ctrl+E` | 旧版预设：展开/折叠最新推理和内联 diff |
| `/language [en\|zh]` | 切换并持久化 TUI 语言 |
| `/status [refresh]` | 显示会话使用情况和当前提供者配额 |
| 鼠标点击 | 选择对话框、展开文件/工具输出、跳转转、关闭面板或聚焦 composer |
| 鼠标滚轮 | 独立滚动 Files、Workflow、Todo 或指针下的 transcript |
| `/touch [on\|off]` | 启用 touch-safe 指针处理并防止意外 transcript 选择 |
| Linux 中键 | 将 X11/Wayland PRIMARY 选择粘贴到 composer |
| `PageUp` / `PageDown` | 滚动 transcript |
| `Esc` | 中止活动运行或关闭对话框 |
| `Ctrl+C` | 清除输入、中止或在空闲时退出 |

内置前端命令包括 `/new`、`/compact`、`/mode`、`/workspace`、`/files`、`/workflow`、`/todo`、`/sidebar`、`/model`、`/provider`、`/accounts`、`/agents`、`/skill`、`/team`、`/thinking`、`/tools`、`/sessions`、`/language`、`/status`、`/touch`、`/help` 和 `/quit`。`/skills` 是 `/skill` 的兼容别名。`/model` 打开可点击/键盘模型选择器；`/model provider/model-id` 直接选择一个。`/thinking` 打开 centered、可点击/键盘 reasoning-intensity chooser；`/thinking <level>` 直接选择一个受支持的级别。其他发现的 slash command 传递给 PI，包括 extension commands、prompt templates 和已开启的 skills。

**直接在受限模式启动或通过 PI 的 session flags 恢复**：

```bash
tsukuyomi ~/my-project
tsukuyomi ~/my-project --plan
tsukuyomi --workspace ~/my-project
tsukuyomi --plan
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
| Plan | 只读探索；禁止编辑和变更 Shell 命令。`--ask` 已删除，启动时会直接拒绝 |

模式限制由 PI-side extension 强制执行，而非仅由前端展示。questionnaire 是澄清工具，不是 Ask 模式。

## 配置

| 路径 | 用途 |
|---|---|
| `~/.tsukuyomi/agent/settings.json` | Tsukuyomi 维护的 PI 运行时桥接配置 |
| `~/.tsukuyomi/agent/sessions/` | Tsukuyomi 会话，独立于 PI 的默认会话 |
| `~/.tsukuyomi/agent/tsukuyomi-tools.json` | 通过 `/tools` 持久化的已禁用工具 |
| `~/.tsukuyomi/agent/tsukuyomi-web.json` | 可选的 `web_fetch` 限制和域白名单 |
| `~/.tsukuyomi/agent/tsukuyomi.json` | 持久化的 Tsukuyomi preference，包括 `language` |
| `~/.tsukuyomi/agent/tsukuyomi-skills.json` | 由 Tsukuyomi 管理的 Skill 开关状态 |
| `~/.tsukuyomi/agent/skills/` | Tsukuyomi 唯一管理的 Skill 安装目录 |
| `~/.tsukuyomi/agent/auth.json` | 凭证存储，与 PI 内核共享（0600 权限） |
| `~/.tsukuyomi/agent/providers.json` | opencode-style 自定义提供者（真实来源，JSONC） |
| `~/.tsukuyomi/agent/models.json` | PI-native provider config derived from `providers.json` |

请见 [`docs/PROVIDERS.md`](docs/PROVIDERS.md) 了解完整的提供者、模型和登录参考（内置提供者、自定义提供者、两种配置格式、转换规则、凭证和故障排除）。

设置 `TSUKUYOMI_DIR` 以选择唯一的 Tsukuyomi 配置根目录，或设置 `TSUKUYOMI_PI` 以选择不同的 PI 可执行文件。默认忽略项目 `.pi` 配置和所有外部 Skill 根目录；显式传入 `--approve` 只影响项目级 PI 资源，不会绕过 `/skill` 的开关管理。设置 `TSUKUYOMI_LANG=en|zh` 选择界面语言，`TSUKUYOMI_STATUS_URL` 覆盖 HTTPS Codex 使用端点（Codex 仅当使用兼容网关时）。

## 旧名：KaguyaPi

`kaguyapi` 在 0.6.0 版本重命名为 `tsukuyomi`。配置从 `~/.kaguyapi/agent` 迁移至 `~/.tsukuyomi/agent`，环境变量从 `KAGUYAPI_*` 变为 `TSUKUYOMI_*`，内部 `kaguya*.json` 文件变为 `tsukuyomi*.json`。首次启动时，Tsukuyomi 执行一次性、非破坏性的迁移自 `~/.pi/agent` 和 `~/.kaguyapi/agent`；这些目录只作为迁移源，运行时不会再读取。遗留的 `KAGUYAPI_*` 变量仍被读取，`kaguyapi` 命令是一个转发至 `tsukuyomi` 的废弃 shim（删除 `bin/kaguyapi.mjs` 可移除它）。

## 卸载

```bash
rm -f ~/.local/bin/tsukuyomi
rm -rf ~/.tsukuyomi
```

这不移除或更改原始的 PI 安装。
