# TUI 职责边界

交互壳继续由 Tsukuyomi 持有，Pi 继续是 RPC 内核。抽取按“纯逻辑先行、事件/焦点后移”的顺序进行；任何拆分提交都必须通过 `npm test` 与 `npm run check`，不在提取步骤顺带改变按键或画面。

```text
app/tui.mjs                       terminal lifecycle + composition root (current)
app/tui/formatters.mjs            pure time/tool labels (extracted in step 2)
app/tui/message-band.mjs          full-column user prompt rendering (step 3)
app/tui/composer-layout.mjs       wide composer geometry contract (step 3)
app/tui/keybindings.mjs           OMP/legacy action chords and overrides (step 4)
app/tui/dialog-requests.mjs       serialized Pi extension UI dialog requests (step 5)
app/tui-layout.mjs                terminal geometry and viewport calculations
app/transcript-cache.mjs          transcript index, identity and incremental layout
app/live-tools.mjs                tool execution state and bounded output projection
app/tui-panels.mjs                workflow/todo/diff projections
app/design-system.mjs             Tsukuyomi palette and semantic status tokens
app/rpc.mjs                       Pi JSONL transport and request correlation
app/task-client.mjs               authenticated local task-service channel
src/backend.ts                    PI-side policies, tools and extension UI bridge
```

## Extraction order

1. Pure formatters and projections with direct unit tests.
2. Visual leaf components that receive explicit rendering dependencies; the root continues supplying runtime state and color/token functions.
3. Key action registry and focus router, keeping old bindings until the OMP preset is deliberately introduced.
4. Dialog request broker and typed extension bridge, after lifecycle behavior is tested. The Pi dialog broker now queues only RPC select/confirm/input/editor; local modal nesting still needs a separate focus stack and PTY replay.
5. Screens/Hub composed from those components.

Do not extract a view that reaches implicitly into global terminal state. Inject width, height, locale, palette, clock and callbacks. Keep network, provider auth, filesystem writes, task permissions and team authority outside view components.

## Current extraction in step 2

`app/tui/formatters.mjs` owns the previously nested `formatTime`, `formatAgo`, `formatDuration`, `toolLabel`, and immutable tool-label keys. It has no TUI/RPC/terminal imports and can be exercised with ordinary Node tests. `scripts/check-syntax.mjs` walks nested `app/` and `bin/` files, preventing newly extracted submodules from escaping syntax validation (the previous shell glob checked only selected shallower paths).
