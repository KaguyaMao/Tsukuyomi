# 快捷键动作表（第 4 步）

参考固定版本 [OMP v18.3.0 keybindings](https://github.com/can1357/oh-my-pi/blob/v18.3.0/docs/keybindings.md)。Tsukuyomi 默认 `omp`，`/settings` 可切 `legacy`；`tsukuyomi.json` 中 `keybindingPreset` 持久化选择。空 `keybindingOverrides` 数组解除一个动作的绑定；合法 chord 由 `app/tui/keybindings.mjs` 限定。自定义 chord 发生跨动作冲突时，以 `app/tui.mjs` 输入路由顺序为准，当前**尚未实现冲突诊断 UI**，应避免重复绑定。

| 动作 ID | OMP 预设 | Legacy 预设 | 能力边界 |
|---|---|---|---|
| model.cycleForward / cycleBackward | Ctrl+P / Ctrl+Shift+P | — | 轮换 Pi `get_available_models` 返回的模型；不是 OMP 的角色模型 |
| model.select | Alt+M | — | 当前 Pi 模型列表，非多角色指派 |
| mode.toggle | Alt+Shift+P | Shift+Tab | 仅 Build/Plan，不恢复 Ask 模式 |
| thinking.cycle | Shift+Tab | — | 只轮换 Pi `get_available_thinking_levels` 返回的等级 |
| thinking.toggle | Ctrl+T | — | 最近包含 thinking 的 assistant 消息，不改变工具展开状态 |
| tools.expand | Ctrl+O | — | 最近包含 toolCall 的 assistant 消息；扩展输出与 inline diff 同时切换 |
| message.followUp | Ctrl+Q、Ctrl+Enter | Alt+Enter | followUp 队列类型；无草稿时不发送 |
| message.interrupt | — | Ctrl+Enter | 旧版强制打断仍可用 `/interrupt <text>` |
| palette.open | — | Ctrl+P | OMP 下用 `/` 命令输入或选择器；不能抢占模型键位 |
| workflow.toggle / todo.toggle | — | Ctrl+O / Ctrl+T | OMP 下仍可经面板/命令打开 |
| files.toggle / sessions.open | Ctrl+B / Ctrl+S | Ctrl+B / Ctrl+S | Tsukuyomi 附加动作，依然遵守已声明 workspace 边界 |
| hub.open | Alt+A | — | 打开本项目 Agent Hub；不是 OMP 的 revive/parked/advisor 控制台。`Ctrl+S` 仍是会话浏览器 |
| thinking.expand | — | Ctrl+E | 保留旧版联动工具展开行为 |

**暂不伪装** OMP 的 `Ctrl+R` prompt history 搜索、外部编辑器 `Ctrl+G`、Vim、OSC 5522 clipboard、角色模型指派、parked revive 和 advisor 行。Hub 缺失指标显示 `usage —`，不提供对应按钮。高优先级模态对话框、PTY 输入透传与焦点事件优先于全局快捷键，详见根输入路由。TTY 不能区分修饰键、输入法提交或终端吞键时，应以 `/model`、`/thinking`、`/kmode`、`/followup` 等命令回退；真实终端矩阵仍待验证。
