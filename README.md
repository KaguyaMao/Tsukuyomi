# Tsukuyomi

Tsukuyomi is an independent full-screen terminal interface powered by the PI coding-agent kernel. It does not theme or embed PI's interactive TUI: Tsukuyomi owns the terminal, layout, editor, navigation, and dialogs, while a headless PI RPC process owns models, tools, sessions, and extensions.

```text
terminal ── Tsukuyomi TUI ── JSONL RPC ── PI kernel
                                      ├── providers and models
                                      ├── sessions and tools
                                      ├── original PI plugins
                                      └── Tsukuyomi compact repair plugin
```

The original `pi` command and `~/.pi/agent` remain untouched.

## Interface

- Startup uses a Grok Build-style action card for new/resumed sessions, workspace switching, provider/model setup, settings, and quit; the full-width composer remains immediately available.
- The TUI supports English and Simplified Chinese. Use `/language`, `--language en|zh`, `TSUKUYOMI_LANG`, or the persisted `tsukuyomi.json` preference; the default follows the system locale.
- The right Context/Workflow/Todo rail opens by default in a wide active workspace; Files remains opt-in and all rails become overlays on narrow terminals.
- Starting a normal session with Enter or `/new` opens the workspace layout without assuming that the current directory is a declared workspace.
- The file-tree question appears only after a workspace is explicitly supplied with `tsukuyomi <directory>`, `--workspace`, or `/workspace`. `/files` and `Ctrl+B` can also explicitly request the current directory.
- If accepted, the left panel is a collapsible tree rooted strictly at that workspace. Directory symlinks are not followed.
- The center column follows Grok Build's continuous scrollback layout: a one-line workspace/session status bar, ordered turn history, a two-column turn timeline on sufficiently wide sessions, a live run-status row, a task/queue dock, and a wide rounded composer.
- User turns use the Grok-style `❯` band. The composer uses the same prompt marker and integrates model, mode, thinking, and context information into its bottom border.
- The file tree, Workflow, and Todo surfaces follow the OpenCode CLI panel pattern: dark panel backgrounds, compact headings, tree guides, independent scrolling, hover states, and draggable scrollbars. Workflow tool cards expose live status, elapsed time, preview text, and collapsible output; Todo uses `[✓]`, `[•]`, and `[ ]` states.
- `/tools` opens a live multi-select list for every built-in and registered custom tool. Changes apply immediately and persist across launches.
- `/sessions` or `Ctrl+S` opens a full-screen, searchable session browser grouped by workspace. `Tab` filters the current workspace and `Delete` moves a session to the recoverable `.trash` directory.
- `/provider` opens a searchable OpenCode-style provider browser, including disconnected providers. Selecting one performs OAuth/API-key login when needed, then opens its model list. The final row asks only for id, name, URL and API key, discovers models from the `/models` endpoint, and persists the configuration to `providers.json` (and the derived `models.json`). Custom providers can also be authored by hand; see [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- Completed reasoning is collapsed by default. `Ctrl+E` expands the latest reasoning and inline semantic diff; edit diffs use old/new line numbers with red/green rows and a 14-line collapsed preview.
- `/status` shows current-session token/context usage and queries the current provider: Codex account windows, OpenRouter key budget, or DeepSeek balance. Other providers explicitly report unsupported quota lookup; credentials are never borrowed from another provider. `/status refresh` bypasses the short cache.
- At widths below 120 columns, side panels become centered floating overlays instead of shrinking the conversation. `Ctrl+B`, `Ctrl+O`, and `Ctrl+T` independently open Files, Workflow, and Todo.
- The session editor uses a hardware blinking bar and leaves the character under the cursor painted normally, which keeps IME pre-edit text readable.
- Mouse input is first-class: click dialog rows to choose them, close controls to dismiss panels, directories to expand them, files to insert an `@path` reference, Workflow cards to expand output, timeline ticks to jump between turns, and composer metadata to select model/mode. The wheel scrolls Files, Workflow, Todo, or the transcript under the pointer; each scrollbar can be dragged. On Linux, middle-click pastes the PRIMARY selection like Grok Build. Set `TSUKUYOMI_TOUCH_MODE=1` or use `/touch on` to disable transcript drag selection for touchscreens.

## PI compatibility

Tsukuyomi imports the original PI configuration once into `~/.tsukuyomi/agent`. It inherits packages, extensions, skills, prompts, models, system prompts, auth, trust settings, and provider configuration. Relative PI resource paths are converted to absolute paths before loading.

The independent TUI implements PI's RPC extension UI protocol for command discovery, notifications, status entries, widgets, select/confirm dialogs, and text editors. Plugin tools and hooks execute inside PI normally. A plugin that directly injects a PI-specific terminal component through `ctx.ui.custom()` cannot transfer that component to an independent RPC frontend; its non-TUI tools, hooks, and commands still work.

## Providers and sign-in

Sign-in is owned by the frontend, not the RPC kernel (PI's RPC protocol exposes no auth commands). Tsukuyomi drives PI's own provider auth implementations through `ModelRuntime`, so OAuth credentials carry the provider-specific fields PI expects (for example `openai-codex` stores `accountId`). Credentials live in `~/.tsukuyomi/agent/auth.json` (PI's schema, `0600`, atomic writes) and are imported once from `~/.pi/agent/auth.json`.

Built-in providers are connected from `/provider` (OAuth account login or API key; alias resolution such as `openai → openai-codex`). Custom providers use an opencode-style `providers.json` as the source of truth, which is translated into PI's `models.json`; `models.json` may also be edited directly and is imported back on load. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

## Reliable compaction

`src/backend.ts` is a normal PI extension loaded into the RPC kernel. Its compact repair:

- intercepts manual, threshold, and overflow compaction through `session_before_compact`;
- writes a provider-independent continuity checkpoint instead of making compaction depend on a second model summarization request;
- preserves prior checkpoints, relevant transcript, and read/modified file lists;
- adds an 82% context-usage fallback trigger;
- keeps `/kcompact` available for plugin-level diagnostics.

Use `/compact` in Tsukuyomi for manual compaction. The result and failures appear in the right workflow panel.

## Performance

The frontend coalesces duplicate message/stats refreshes, caches idle transcript
layout, throttles live spinner redraws, and does not repaint for editor cursor
blinking. PI's kernel and the installed `pi-tui` package are not modified.

A long-running prompt may still be caused by model inference, network/tool
latency, or context compaction. See [`docs/performance.md`](docs/performance.md)
for the optional `pi-cache-optimizer` review and why launcher monkey-patching
optimizers are not enabled automatically.

## Install

The npm package requires Node.js 20 or newer. The x86_64 RPM, Arch and Debian packages are complete snapshots with a private Node.js/npm runtime, pinned PI runtime and production dependencies; they do not replace the system `node`, `npm` or `pi`. Tsukuyomi uses `socat` for a PTY RPC transport when available and falls back to direct Node pipes when it is not.

Install from npm:

```bash
npm install --global --ignore-scripts tsukuyomi
tsukuyomi
```

Install a locally built RPM with DNF:

```bash
sudo dnf install ./tsukuyomi-0.5.0-1.x86_64.rpm
tsukuyomi
```

Install a locally built Arch package with pacman:

```bash
sudo pacman -U ./tsukuyomi-0.5.0-1-x86_64.pkg.tar.zst
tsukuyomi
```

Install a locally built Debian/Ubuntu package with APT:

```bash
sudo apt install ./tsukuyomi_0.5.0-1_amd64.deb
tsukuyomi
```

Build all package formats from a checkout (requires Node.js/npm, the installed project dependencies and Podman):

```bash
npm run package:all
```

The native `node-pty` addon is rebuilt in a glibc 2.28 builder, then the RPM, Arch and Debian packages are written to `dist/packages/`. For a source checkout without npm, the legacy symlink installer remains available:

```bash
chmod +x ~/Tsukuyomi/install.sh
~/Tsukuyomi/install.sh
tsukuyomi
```

Existing PI credentials are imported once. New logins are saved independently in Tsukuyomi's `auth.json`; provider changes rebuild the RPC kernel while preserving saved sessions.

## Commands and shortcuts

| Input | Action |
|---|---|
| `Enter` | Start the workspace session / submit a prompt |
| `Ctrl+P` | Open commands from Tsukuyomi and loaded PI plugins |
| `Shift+Tab` | Cycle Build → Plan → Ask |
| `Ctrl+B` | Fold/unfold the current-workspace file tree |
| `Ctrl+O` | Fold/unfold Workflow |
| `Ctrl+T` | Fold/unfold Todo |
| `/tools` | Enable or disable any registered tool |
| `/sessions` / `Ctrl+S` | Browse and restore saved sessions |
| `/provider` | Connect a provider or add a custom provider, then choose a model |
| `Ctrl+E` | Expand/collapse the latest completed reasoning and inline diff |
| `/language [en\|zh]` | Switch and persist the TUI language |
| `/status [refresh]` | Show session usage and current-provider quota |
| Mouse click | Choose dialogs, expand files/tool output, jump turns, close panels, or focus the composer |
| Mouse wheel | Independently scroll Files, Workflow, Todo, or the transcript under the pointer |
| `/touch [on\|off]` | Enable touch-safe pointer handling and prevent accidental transcript selection |
| Middle click (Linux) | Paste the X11/Wayland PRIMARY selection into the composer |
| `PageUp` / `PageDown` | Scroll the transcript |
| `Esc` | Abort an active run or close a dialog |
| `Ctrl+C` | Clear input, abort, or exit when idle |

Built-in frontend commands include `/new`, `/compact`, `/mode`, `/workspace`, `/files`, `/workflow`, `/todo`, `/sidebar`, `/model`, `/thinking`, `/tools`, `/sessions`, `/language`, `/status`, `/touch`, `/help`, and `/quit`. `/model` opens a clickable/keyboard model chooser; `/model provider/model-id` selects one directly. `/thinking` opens a centered, clickable/keyboard reasoning-intensity chooser; `/thinking <level>` selects a supported level directly. Other discovered slash commands are passed to PI, including extension commands, prompt templates, and skills.

Start directly in a restricted mode or resume through PI's session flags:

```bash
tsukuyomi ~/my-project
tsukuyomi ~/my-project --plan
tsukuyomi --workspace ~/my-project
tsukuyomi --plan
tsukuyomi --ask
tsukuyomi --continue
tsukuyomi --session /path/to/session.jsonl
```

Inside Tsukuyomi, `/workspace /path/to/project` switches the PI kernel to that directory and asks whether its file tree should be shown.

## Web tools

Tsukuyomi registers two PI tools:

- `web_fetch` fetches a public HTTP(S) URL, upgrades public HTTP URLs to HTTPS, blocks local/private DNS targets, follows same-host redirects, converts HTML to Markdown, and truncates oversized responses.
- `web_search` uses DuckDuckGo's HTML endpoint without an API key by default. Set `TSUKUYOMI_WEBSEARCH_URL` to a Responses API base URL (for example `https://api.x.ai/v1`), plus `TSUKUYOMI_WEBSEARCH_KEY` or the provider's `XAI_API_KEY`, and optionally `TSUKUYOMI_WEBSEARCH_MODEL`, to use that backend instead.

Optional fetch limits and domain restrictions can be stored in `~/.tsukuyomi/agent/tsukuyomi-web.json`:

```json
{
  "allowedDomains": ["docs.example.com", "developer.mozilla.org"],
  "allowLocal": false,
  "timeoutMs": 30000,
  "maxBytes": 1048576,
  "maxChars": 120000
}
```

## Modes

| Mode | Behavior |
|---|---|
| Build | Full PI and plugin tool set |
| Plan | Read-only exploration; edits and mutating shell commands are blocked |
| Ask | Answers only; edits and shell are blocked |

Mode restrictions are enforced by the PI-side extension, not just displayed by the frontend.

## Configuration

| Path | Purpose |
|---|---|
| `~/.tsukuyomi/agent/settings.json` | Merged PI backend settings and resources |
| `~/.tsukuyomi/agent/sessions/` | Tsukuyomi sessions, separate from PI's default sessions |
| `~/.tsukuyomi/agent/tsukuyomi-tools.json` | Persisted tools disabled through `/tools` |
| `~/.tsukuyomi/agent/tsukuyomi-web.json` | Optional `web_fetch` limits and domain restrictions |
| `~/.tsukuyomi/agent/tsukuyomi.json` | Persisted Tsukuyomi preferences, including `language` |
| `~/.tsukuyomi/agent/auth.json` | Credential store, shared with the PI kernel (0600 permissions) |
| `~/.tsukuyomi/agent/providers.json` | opencode-style custom providers (source of truth, JSONC) |
| `~/.tsukuyomi/agent/models.json` | PI-native provider config derived from `providers.json` |

See [`docs/PROVIDERS.md`](docs/PROVIDERS.md) for the full provider, model, and sign-in reference (built-in providers, custom providers, both config formats, conversion rules, credentials, and troubleshooting).

Set `TSUKUYOMI_DIR` to use another backend config directory or `TSUKUYOMI_PI` to select a different PI executable. Set `TSUKUYOMI_LANG=en|zh` to choose the interface language and `TSUKUYOMI_STATUS_URL` to override the HTTPS Codex usage endpoint (Codex only) when using a compatible gateway.

## Renamed from KaguyaPi

`kaguyapi` was renamed to `tsukuyomi` in 0.6.0. Config moved from `~/.kaguyapi/agent` to `~/.tsukuyomi/agent`, environment variables from `KAGUYAPI_*` to `TSUKUYOMI_*`, and the internal `kaguya*.json` files to `tsukuyomi*.json`. On first launch Tsukuyomi performs a one-time, non-destructive migration from `~/.pi/agent` and `~/.kaguyapi/agent`; the sources are never modified. The legacy `KAGUYAPI_*` variables are still read, and the `kaguyapi` command is a deprecation shim that forwards to `tsukuyomi` (delete `bin/kaguyapi.mjs` to drop it).

## Uninstall

```bash
rm -f ~/.local/bin/tsukuyomi
rm -rf ~/.tsukuyomi
```

This does not remove or change the original PI installation.
