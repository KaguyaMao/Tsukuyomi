# TUI 对照基线（执行第 1 步）

> 范围：Tsukuyomi **已实现**的交互式 TUI。参考为 oh-my-pi **v18.3.0**（`62bc57be1b03ef0802a33cf7f5f530e534527531`）；不是将其 Bun 内核或 OMP 特有功能迁入本项目。此表记录**现状与验收目标**，不宣称目标已经实现。

## 固定来源、隔离与复现

- OMP npm 包：`@oh-my-pi/pi-coding-agent@18.3.0`；`omp/18.3.0` 已由隔离 Bun 1.3.14 验证。包内 CLI SHA-256：`33cf63aab3a109b339049c17549767096fe174b772b491e3f4ccbb53035b84f4`，Bun SHA-256：`9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74`。
- 源码：[OMP release](https://github.com/can1357/oh-my-pi/releases/tag/v18.3.0)、[gallery-cli](https://github.com/can1357/oh-my-pi/blob/v18.3.0/packages/coding-agent/src/cli/gallery-cli.ts)、[Agent Hub](https://github.com/can1357/oh-my-pi/blob/v18.3.0/docs/agent-hub.md)、[keybindings](https://github.com/can1357/oh-my-pi/blob/v18.3.0/docs/keybindings.md)、[Ask 组件](https://github.com/can1357/oh-my-pi/blob/v18.3.0/packages/tui/src/overlays/ask-dialog.ts)、[Plan Review 组件](https://github.com/can1357/oh-my-pi/blob/v18.3.0/packages/tui/src/overlays/plan-review-overlay.ts)。先确认固定 tag 再引用，不使用浮动 `main` 作为验收源。
- 上游官方参考图：[hero.png](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.3.0/assets/hero.png)（1500×540，SHA-256 `5b28a5f7a5af7773f756b462a6f2680a731e546ee478226193eb8637f1f9883d`）、[ask.webp](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.3.0/assets/ask.webp)（802×440 动画，SHA-256 `1f35492a938a163f18470c90549759d9c6d73fa1fff66cfab6a631ada50985bf`）。它们是**官方演示素材，不是本机真实会话截图**，也不是所有界面的代表图。
- 可复现的本机产物位于 `docs/tui-baseline/omp-18.3.0/`：gallery 的生产组件输出，80/120/160 列 × composer/read/bash/edit/task/todo，共 18 份 ANSI/纯文本成对快照；`SHA256SUMS` 验证文件完整性。ANSI 是渲染器采样而非交互会话；纯文本快照丢失颜色，不能替代 ANSI 验收。上游 edit 预览带随调度变化的 spinner；采集脚本仅将该 glyph 规范化为 `⠿`，其余输出原样保存。
- 本机安装在 `/tmp/tsukuyomi-omp-18.3.0-GJx6BA`，非全局安装；**临时目录并不保证长期存在**。复现时：

```bash
BASE=$(mktemp -d /tmp/tsukuyomi-omp-18.3.0-XXXXXX)
mkdir -p "$BASE/home" "$BASE/npm-cache" "$BASE/project"
HOME="$BASE/home" npm_config_cache="$BASE/npm-cache" npm install \
  --prefix "$BASE" --ignore-scripts --no-audit --no-fund --no-package-lock \
  bun@1.3.14 @oh-my-pi/pi-coding-agent@18.3.0
# Bun npm launcher requires a postinstall; run the platform package directly.
OMP_BASE="$BASE" bash scripts/capture-tui-baseline.sh
cd docs/tui-baseline/omp-18.3.0 && sha256sum -c SHA256SUMS
```

脚本用 `env -i`、隔离 HOME/XDG/项目工作目录和 `PI_OFFLINE=1` 运行 gallery，不传入当前 shell 的 API key，不读取真实会话。安装时可能访问 npm registry；执行程序时不访问模型。脚本要求 Linux x64 的 `@oven/bun-linux-x64`；其他平台先选择对应的隔离 Bun 可执行文件再运行同等命令。截图命令 `omp gallery --screenshot` 需要 VHS，本机未安装 VHS，因此**未伪称本轮生成了本机 PNG / PTY 截图**；后续运行交互画面要在隔离配置内用 PTY 和合成 RPC 事件捕获，再以相同字体、色彩和尺寸对比。

## 用户确认的产品合同

1. OMP 式**操作、选择器与状态反馈**为主；普通会话保留 `TuiAltScreen` 和鼠标/IME，不复制 OMP 的原生滚动模式。
2. **Grok Build 式全列宽用户提示词背景条与宽敞 composer 是硬性保留项**：背景沿所在会话列铺展，保留上下留白、内边距和圆角感，不能退化成短文本宽度的紧凑 OMP 消息。
3. Tsukuyomi `#121212` 画布、logo 和金色标识不替换为 OMP 品牌。原有 Files/Workflow/Todo 按需打开；窄屏不挤压正文。
4. 默认 OMP 快捷键，旧 Tsukuyomi 键位作为明确可选的兼容预设。第 4 步已加入设置切换、持久化及受限覆盖；模型切换使用 Pi 的可用模型列表，不虚构 OMP role models。能力实际不存在时不显示伪操作。后续仍须真实 PTY/终端冲突验收。
5. 不迁移 OMP 的 Vibe、Advisor、Collab、Review 等独立后端工作流。`--ask` 模式已移除；`questionnaire` 是工具，**不是 Ask 模式**。

## 界面与状态矩阵

下列「差异」由当前工作区代码与固定版本 OMP 源码/夹具对照得出；未经 PTY 实测之处标为「待截图」，不能以观察推断取代验证。每个入口在后续阶段还要覆盖：正常/空状态/加载/失败/取消、超长内容与窄屏，键盘及鼠标两条路径。

| Tsukuyomi 入口 / 代码 | OMP 参照 | 当前差异 / 目标 | 验收状态 |
|---|---|---|---|
| 启动首页 `app/tui.mjs#home` | welcome、composer gallery | 当前 Grok 动作卡；保留 logo/宽输入框，整理操作次序与提示 | 待截图 |
| 普通会话 `#session`, `app/tui-layout.mjs` | 主对话、composer gallery | OMP 预设默认单列、面板按需开启；legacy 仍保留默认右 rail/时间线。消息背景及宽 composer 保留 | 逻辑测试通过；待截图 |
| 用户消息 `#bandRow` → `app/tui/message-band.mjs` | OMP user-message | 当前全列背景、上下空行属**保留差异**；组件已独立且有全宽度单测。PTY/真实画面对照仍待做 | 单元测试通过；截图待做 |
| 编辑器 `#grokComposer` + `app/tui/composer-layout.mjs` | OMP box/band composer | 几何契约已提取/测试；全宽铺展不截成固定宽度。元数据与真实 IME/PTY 对照待后续实现/验收 | geometry 单测通过；gallery 已采 |
| 流式文本、思考 `#messageLines` | OMP assistant/thinking | 推理展开与工具展开耦合；流式标题和最终输出须无重复 | 待截图 |
| read/bash/edit/write 等 `app/live-tools.mjs` | gallery read/bash/edit 的四状态 | 工具卡明确 read 行数、bash 待输出、编辑未应用预览/已应用；状态/错误及未知工具回退。真实 ANSI 对照待截图 | 状态单测通过；待截图 |
| diff/Markdown `app/markdown.mjs`, `app/tui-panels.mjs` | OMP edit、tool cards | 保留旧新行号与语义色；保障 ANSI/CJK/极长行宽度 | edit 已采，其余待截图 |
| 队列与进度 `#dockView` | OMP queue/status | 保留 steer/follow-up 区分，改明确可见可撤回的行 | 待截图 |
| Build/Plan `src/plan-bridge.ts`, vendor plan | OMP plan review overlay | 整屏 Plan Review：目录、正文、动作、思考等级滑条、a 批注、d 删除、u 撤销、c 复制、e 外部编辑器。批注和改过的正文会随 Execute/Refine 交回内核。没有 OMP 的行级批注锚点和模型角色滑条 | 动作单测通过；待 PTY |
| 问答 `src/questionnaire.ts` | OMP ask-dialog 和官方 ask.webp | RPC 下一次打开全部题目：Tab/左右切换、推荐项、说明、Other、n 备注、Submit 汇总。仍限制 3 题/4 选项，没有 OMP 的倒计时和多选协议字段 | 会话单测通过；待 PTY |
| Agent 模板 `/agents` | OMP model/settings list | 当前连环选择/输入；需搜索、详情与回退焦点 | 待截图 |
| Team `/team`, `src/agent-team.ts` | OMP Agent Hub | `/team` 与 `Alt+A` 打开全屏 Hub；宽屏同列检查器，窄屏 Tab 切换。成员/权限/报告/当前工作区任务/模板均来自真实快照；usage、revive、parked、advisor 显示 `—` 且无按钮。权限与补丁操作前复核状态 | Hub 投影与键位单测通过；待 PTY |
| subagent/PTY `/tasks`, `app/task-service.mjs` | OMP task card/Hub | `/tasks` 进入 Hub；当前工作区任务实时更新，支持输出检查、运行中取消/steer 与完成补丁的显式确认；服务端仍检查身份、状态、workspace 指纹和 git apply --check | 逻辑测试通过；待 PTY |
| Todo `/todo` | OMP todo card | 当前侧栏状态推断；真实 `todo` 状态不能被渲染时的“working”篡改 | gallery todo 已采，待截图 |
| 模型/思考 `/model`, `/thinking` | OMP picker | OMP 默认 `Ctrl+P` 模型轮换、`Alt+M` 选模型、`Shift+Tab` 思考轮换；只读当前 Pi 可用列表。快捷键映射已单测，交互画面待截图 | 单元测试通过；待 PTY |
| 供应商/账户 `/provider`, `/accounts` | OMP login/model browser | 保留原鉴权/重启流程；选择器共用搜索、空结果、键鼠导航和取消语义；秘密输入仍遮罩。终端实测待做 | 搜索单测通过；待 PTY |
| `/tools`, `/skill` | OMP plugin/settings picker | 共享选择器过滤/边界；工具多选与技能保存仍按既有即时/重启机制，不假称统一后端应用时机 | 待 PTY |
| `/sessions`, `/workspace`, `/files` | OMP session selector/tree | 保留安全回收站、声明工作区才显示文件树；全面板键鼠焦点一致 | 待截图 |
| `/settings`, `/status`, `/update`, `/help`, `/language` | OMP settings, usage/status | 共用菜单状态与筛选逻辑，settings/sessions 保留全屏分组布局；真实无数据用 `—`，不估算 | 单测通过；待截图 |
| PI 扩展 UI `handleExtensionUi` + `app/tui/dialog-requests.mjs` | OMP ask/hook UI | 支持的 select/confirm/input/editor 已加单槽队列、请求归属及关闭取消；不支持 `ctx.ui.custom()`，高级界面需独立安全桥接/明确降级 | 队列单测通过；PTY/真实 RPC 重放待做 |

## 已知技术/安全差异及进入后续步骤的门槛

- `app/tui.mjs` 的 `state.dialog` 仍是单槽，但第 5 步已给 Pi 扩展 select/confirm/input/editor 加队列：本地模态占用时延迟显示，完成后逐一答复；应用退出或本地异步操作抢占 Pi 模态时显式取消原请求。本地模态若被异步新模态抢占，会恢复原输入并对原请求发取消，不再悄然丢弃回调；真实 RPC/PTY 重放**仍待验收**。高级界面只通过 `setWidget` + 一次性 nonce 绑定原生 `select`，不会调用 RPC 不支持的 `ctx.ui.custom()`。
- Pi RPC 的 `toolcall_delta` **没有累计 `partial`**；第 7 步现已用 `toolcall_start/delta/end` 按 contentIndex 有界增量组装参数，最终以 `message_end` 为准。
- `app/task-service.mjs` 快照提供输出、角色、补丁路径，但没有 OMP Hub 的 usage、parked/revive、advisor 能力。Hub 行现在显式写 `usage — · revive — · parked — · advisor —`，并且没有这些动作。
- README 与 `tsukuyomi --help` 已改为 Build/Plan，并说明 `--ask` 会在启动前拒绝；没有恢复 Ask 模式。
- 工作区在基线采集时**已有大量未提交变更**。后续步骤只追加文件，不 reset、stash 或覆盖既有改动，也不执行发布上传。

## 第 10 步验收记录

- 回归：`npm run check` 与 `npm test`。其中 `test/cli-compat.test.mjs` 确认 `--ask` 在 TUI/内核启动前退出。
- OMP v18.3.0 gallery 参考快照仍以 `docs/tui-baseline/omp-18.3.0/SHA256SUMS` 校验；它们是渲染器采样，不是本机交互截图。
- Tsukuyomi 叶子夹具由 `scripts/capture-tsukuyomi-leaves.mjs` 写入 `docs/tui-baseline/tsukuyomi-leaves/`。它只覆盖用户消息宽带、composer 几何和 Hub 投影，**不是**全屏 PTY/PNG。
- 本机没有 VHS，因此**没有**生成或宣称交互式 PNG 截图。真实终端的 IME、Kitty/tmux 修饰键、鼠标和颜色对照仍未验收。
