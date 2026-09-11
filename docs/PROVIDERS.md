# 供应商、模型与登录

本文档说明 Tsukuyomi（原 KaguyaPi）的多供应商登录体系：内置供应商如何连接、自定义供应商如何声明、凭据保存在哪里、以及 opencode 风格配置与 PI `models.json` 之间的转换规则。

> 适用版本：Tsukuyomi 0.6.0（由 kaguyapi 0.5.1 改名而来）。

## 1. 总体结构

```text
终端 ── Tsukuyomi TUI ── JSONL RPC ── PI 内核
                                     ├── 供应商定义与模型目录
                                     ├── 凭据解析 / OAuth 刷新（auth.json）
                                     └── 自定义供应商（models.json）
```

- **PI 内核**负责真正的模型请求、供应商定义、凭据解析与 OAuth 刷新。Tsukuyomi 不重复实现这些逻辑，而是通过 PI 的 `ModelRuntime` 调用它们。
- **凭据**保存在 `<agentDir>/auth.json`，格式与 PI 完全一致，因此 PI 内核能直接读取。
- **自定义供应商**有两份文件：
  - `<agentDir>/providers.json` —— **opencode 风格的唯一事实来源**，由你编辑或由向导生成；
  - `<agentDir>/models.json` —— PI 原生格式，**由前者派生**，供内核消费。
- 默认 `<agentDir>` 为 `~/.tsukuyomi/agent`，可用 `TSUKUYOMI_DIR` 覆盖。

### 文件一览

| 路径 | 用途 |
| --- | --- |
| `~/.tsukuyomi/agent/auth.json` | 凭据存储（`0600`，`api_key` / `oauth`） |
| `~/.tsukuyomi/agent/providers.json` | opencode 风格自定义供应商（事实来源，JSONC） |
| `~/.tsukuyomi/agent/models.json` | PI 原生供应商配置（派生，JSONC） |
| `~/.tsukuyomi/agent/models-store.json` | PI 动态模型目录缓存 |
| `~/.pi/agent/auth.json` | 原版 PI 的凭据，首次启动时**一次性复制导入**（不覆盖已有项） |

## 2. 连接内置供应商

在会话中输入 `/provider`，会打开可搜索的供应商浏览器（opencode 风格分组：当前 / 已连接 / 常用 / 自定义 / 其他）。

1. 选择供应商：
   - 未配置 → 直接进入登录；
   - 已配置 → 先列出其可用模型，再选择模型；
   - 底部 “+ 添加自定义供应商” 进入自定义向导。
2. 登录方式（若供应商提供多种）：
   - **账号登录（OAuth）**：例如 `Anthropic (Claude Pro/Max)`、`OpenAI (ChatGPT Plus/Pro)`、GitHub Copilot、xAI SuperGrok、Kimi Coding 等。会打开浏览器回调或显示 device code。
   - **API Key 登录**：弹出隐藏输入的密钥输入框。
3. 登录成功后，TUI 会重启 RPC 内核以加载新凭据；已保存的会话不受影响。
4. 在模型列表中选 “退出登录” 可删除该供应商的凭据。

### 供应商别名

某些供应商的“账号登录”实际存放在同级供应商 id 下。Tsukuyomi 会声明式地解析别名，例如：

- `openai` 的账号登录 → 凭据写入 `openai-codex`（即 ChatGPT Plus/Pro）。

别名表中不存在的目标会被忽略；`/provider` 会以 “显示名 · id” 提示实际写入的供应商。

### 仅环境变量的供应商

Amazon Bedrock、Vertex AI、本机无鉴权推理服务等只从环境读取凭据（AWS profile、gcloud ADC、密钥文件等）。这类供应商没有可交互登录方式，`/provider` 会提示“此供应商从运行环境读取凭据”。

## 3. 自定义供应商快速开始

`/provider` → “+ 添加自定义供应商”，只需四项：

1. **供应商 id**：仅小写字母、数字、`_`、`-`（例如 `myprovider`）。
2. **显示名称**。
3. **Base URL**：`https://...`；仅本机回环允许 `http://`（`localhost` / `127.0.0.1` / `::1`）。
4. **API Key**：可直接粘贴，或写 `{env:变量名}` 引用环境变量。

提交后 Tsukuyomi 会：

1. 请求 `GET {baseURL}/models`（Anthropic 协议则请求 `/v1/models`）自动发现模型；
2. 校验配置（id、URL、协议、模型）；
3. 写入 `providers.json` 与 `models.json`，并立即注册到运行中的内核；
4. 将密钥写入 `auth.json`，**不会**写进配置文件。

任一步失败都不会留下半成品配置。

## 4. `providers.json` 完整参考（opencode 风格）

文件为 **JSONC**（允许注释与尾随逗号）。顶层为 `provider` 映射，键是供应商 id。

```jsonc
{
  "$schema": "https://tsukuyomi.local/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible", // 或直接写 "api"
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MY_PROVIDER_KEY}",
        "headers": { "X-Custom": "value" }
      },
      "models": {
        "my-model": {
          "name": "My Model",
          "limit": { "context": 200000, "output": 65536 }
        }
      },
      "blacklist": [],
      "whitelist": []
    }
  }
}
```

### 供应商级字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `npm` | string | opencode 的 AI SDK 包名，决定 `api`。见下方映射表。 |
| `api` | string | PI 协议 id，显式给出时优先于 `npm`。 |
| `name` | string | 显示名称。 |
| `options.baseURL` | string | 端点 URL；HTTPS 或本机回环 HTTP。 |
| `options.apiKey` | string | 密钥、`{env:VAR}` 或 `{file:path}`。 |
| `options.headers` | object | 额外请求头，值同样支持插值。 |
| `models` | object \| array | 模型定义；对象键为模型 id，也接受数组形式。 |
| `blacklist` | string[] | 从模型列表移除这些 id（写入 `models.json` 时生效）。 |
| `whitelist` | string[] | 仅保留这些 id，再应用 `blacklist`。 |
| `authHeader` | boolean | 为 `true` 时把密钥作为 `Authorization: Bearer ...` 发送。 |
| `compat` | object | PI 兼容性开关（见 `models.json` 参考）。 |
| `modelOverrides` | object | 按模型 id 覆盖 `name`/`cost`/`contextWindow` 等。 |
| `origin` | string | 标记来源（例如由 `models.json` 导入时为 `pi-models`），由工具写入。 |

### 模型级字段

| 字段 | 说明 |
| --- | --- |
| `name` | 显示名称。 |
| `limit.context` / `contextWindow` | 上下文窗口（二选一，推荐 `limit.context`）。 |
| `limit.output` / `maxTokens` | 最大输出 token。 |
| `reasoning` | 是否为推理模型。 |
| `input` | `["text"]` 或 `["text","image"]`。 |
| `cost` | `{ input, output, cacheRead, cacheWrite }`（每百万 token 价格）。 |
| `headers` | 该模型专用的请求头。 |
| `compat` | 模型级兼容开关。 |
| `thinkingLevelMap` | 思考等级映射（`off`…`max`，`null` 表示不支持）。 |
| `samplingParams` | 透传的采样参数。 |
| `remoteId` | 实际发送给上游的模型 id（与展示 id 不同时使用）。 |
| `api` / `baseUrl` | 模型级协议/端点覆盖。 |

### 键值插值

| 写法 | 含义 |
| --- | --- |
| `{env:VAR}` | 读取环境变量 `VAR`。 |
| `{file:~/path}` | 读取文件内容并去除首尾空白。 |
| 其它 | 原样作为字面量（写入 PI 时 `$` 会被转义为 `$$`，不会被展开）。 |

### API / npm 映射

| `npm` | `api`（PI 协议） |
| --- | --- |
| `@ai-sdk/openai-compatible` | `openai-completions` |
| `@ai-sdk/openai` | `openai-responses` |
| `@ai-sdk/anthropic` | `anthropic-messages` |
| `@ai-sdk/google` | `google-generative-ai` |
| `@ai-sdk/mistral` | `mistral-conversations` |
| `@ai-sdk/azure` | `azure-openai-responses` |

未列出的 `npm` 必须配合显式 `api`。

### 更多示例

**OpenAI 兼容（带自定义头与密钥文件）**

```jsonc
{
  "provider": {
    "helicone": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Helicone",
      "options": {
        "baseURL": "https://ai-gateway.helicone.ai",
        "apiKey": "{file:~/.secrets/helicone}",
        "headers": { "Helicone-Cache-Enabled": "true" }
      },
      "models": { "gpt-4o": { "name": "GPT-4o" } }
    }
  }
}
```

**Anthropic 兼容代理**

```jsonc
{
  "provider": {
    "my-claude-proxy": {
      "api": "anthropic-messages",
      "name": "Claude Proxy",
      "options": { "baseURL": "https://claude.example.com/v1", "apiKey": "{env:CLAUDE_PROXY_KEY}" },
      "models": { "claude-sonnet-4": { "name": "Claude Sonnet 4", "limit": { "context": 200000, "output": 64000 } } }
    }
  }
}
```

**本机推理（无鉴权，回环 HTTP）**

```jsonc
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "llama3.1:8b": { "name": "Llama 3.1 8B" } }
    }
  }
}
```

**给已有供应商增删模型**

对内置供应商只写要新增/隐藏的模型即可（不必写 `baseURL`）：

```jsonc
{
  "provider": {
    "openrouter": {
      "models": { "some/new-model": { "name": "New Model" } },
      "blacklist": ["some/experimental-model"]
    }
  }
}
```

## 5. `models.json` 完整参考（PI 原生）

`models.json` 由 Tsukuyomi 自动生成，也可直接手工编辑。Tsukuyomi 在加载时会把其中**独有的**供应商导入 `providers.json`（已有项不覆盖），因此两种方式都可用。

```jsonc
{
  "providers": {
    "myprovider": {
      "name": "My Provider",
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_PROVIDER_KEY",
      "headers": { "X-Custom": "value" },
      "authHeader": false,
      "compat": { "supportsDeveloperRole": true },
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 65536,
          "headers": {},
          "compat": {}
        }
      ],
      "modelOverrides": {
        "my-model": { "contextWindow": 100000, "name": "Renamed" }
      }
    }
  }
}
```

### 配置值语法（`apiKey`、`headers` 的值）

| 写法 | 含义 |
| --- | --- |
| `!命令` | 执行 shell 命令，取 `stdout` 去空白后的结果（有缓存）。 |
| `$VAR` / `${VAR}` | 展开环境变量。 |
| `$$` / `$!` | 转义为字面量 `$` / `!`。 |
| 其它 | 字面量。 |

### 供应商级字段

| 字段 | 说明 |
| --- | --- |
| `name` / `baseUrl` / `api` | 名称、端点、协议。 |
| `apiKey` | 密钥或配置值（见上表）。 |
| `headers` / `compat` / `authHeader` | 请求头、兼容开关、Bearer 头。 |
| `oauth` | 仅支持 `"radius"`（PI 内置的 Radius 网关 OAuth）。 |
| `models` | 模型定义数组。 |
| `modelOverrides` | 按 id 覆盖模型字段（最上层配置，最后应用）。 |

### 转换：`{env:VAR}` → `$VAR`

Tsukuyomi 写入时会把 opencode 插值改写成 PI 语法：

| `providers.json` | `models.json` |
| --- | --- |
| `{env:MY_KEY}` | `$MY_KEY` |
| `{file:~/.secrets/key}` | `!cat '~/.secrets/key'` |
| `sk-$literal` | `sk-$$literal`（转义，保持字面量） |

## 6. 转换总表

| `providers.json`（opencode 风格） | `models.json`（PI） |
| --- | --- |
| `provider.<id>` | `providers.<id>` |
| `npm` / `api` | `api` |
| `options.baseURL` | `baseUrl` |
| `options.headers` | `headers` |
| `options.apiKey` | `apiKey`（插值改写，见上表） |
| `models.<id>.limit.context` | `models[].contextWindow` |
| `models.<id>.limit.output` | `models[].maxTokens` |
| `models.<id>.name` | `models[].name` |
| `models.<id>.remoteId` | `models[].id` |
| `models.<id>.reasoning/input/cost/headers/compat/samplingParams/thinkingLevelMap` | 同名 |
| `blacklist` / `whitelist` | 写入时过滤 `models[]`（PI 无对应字段） |
| `authHeader` | `authHeader` |
| `origin` | 不写入 |

## 7. 优先级与冲突

1. `providers.json` 中的供应商是事实来源，`models.json` 中的同名项会被其覆盖。
2. 仅存在于 `models.json` 的供应商会在下次启动时被导入 `providers.json`（标记 `origin: "pi-models"`）；已有项不会被覆盖，除非显式导入覆盖。
3. 内置供应商只在需要增删模型或改端点时才在 `providers.json` 中出现；对其写 `baseURL` 会覆盖内置端点。
4. `blacklist` / `whitelist` 在**写入 `models.json` 时**对自定义供应商生效；对内置供应商的同类需求请在 `providers.json` 中列出显式模型。

## 8. 凭据

- **位置与权限**：`~/.tsukuyomi/agent/auth.json`，权限 `0600`，原子写入。
- **格式**：
  ```jsonc
  {
    "anthropic": { "type": "api_key", "key": "sk-..." },
    "openai-codex": { "type": "oauth", "access": "...", "refresh": "...", "expires": 1789993591013, "accountId": "..." }
  }
  ```
  OAuth 凭据可能带有供应商专用字段（如 `accountId`）；这些字段由 PI 的 OAuth 实现生成与刷新，请勿手工构造。
- **导入**：首次启动会把 `~/.pi/agent/auth.json` 一次性复制到 Tsukuyomi（原文件不改；已有供应商不被覆盖）。旧版 `~/.kaguyapi/agent` 同样会被导入。
- **导出**：`/provider` 与诊断输出只展示脱敏信息（是否已配置、类型、过期时间、额外字段名），不含密钥或令牌。
- **刷新**：OAuth 令牌在请求前自动刷新，刷新在凭据锁内进行，避免并发重复刷新；刷新失败会保留原凭据并要求重新登录。
- **退出登录**：删除对应供应商的凭据，不影响环境变量与 `models.json` 配置。

## 9. 改名与迁移（kaguyapi → Tsukuyomi）

| 项目 | 旧 | 新 |
| --- | --- | --- |
| 命令 | `kaguyapi` | `tsukuyomi` |
| 配置目录 | `~/.kaguyapi/agent` | `~/.tsukuyomi/agent` |
| 环境变量 | `KAGUYAPI_*` | `TSUKUYOMI_*` |
| 偏好文件 | `kaguya.json` | `tsukuyomi.json` |
| 工具白名单 | `kaguya-tools.json` | `tsukuyomi-tools.json` |
| 网络工具配置 | `kaguya-web.json` | `tsukuyomi-web.json` |

- 首次以 `tsukuyomi` 启动时，会从 `~/.pi/agent` 与 `~/.kaguyapi/agent` 执行**一次性迁移**：复制凭据、供应商、会话，并把上述旧文件名重命名为新名字。源目录**不会被修改**。
- 旧环境变量在过渡期内仍被识别（`KAGUYAPI_DIR`、`KAGUYAPI_PI`、`KAGUYAPI_LANG`、`KAGUYAPI_STATUS_URL`、`KAGUYAPI_WEBSEARCH_*`、`KAGUYAPI_TASK_SOCKET` 等）。
- 仍可使用 `kaguyapi` 命令：它只是一个转发外壳，会打印一行弃用提示（`TSUKUYOMI_QUIET_RENAME=1` 可静默），然后执行 `tsukuyomi`。新安装可删除 `bin/kaguyapi.mjs` 及 `package.json` 中的 `kaguyapi` bin 以彻底移除别名。

## 10. 安全

- 配置文件**只保存引用**：优先使用 `{env:VAR}` / `{file:path}`，不要把密钥写进 `providers.json`。
- 写入 `models.json` 时字面量中的 `$` 会被转义，避免被当成环境变量展开。
- 自定义供应商 URL 必须为 HTTPS，仅本机回环允许 HTTP；URL 中禁止内嵌用户名/密码。
- 配额查询只会把凭据发给其所属供应商的已知计费端点；若模型 `baseUrl` 的主机与该端点不一致，则跳过，避免把代理密钥泄漏给公共计费服务。
- 会话、任务输出、错误信息在展示前都会脱敏。

## 11. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 登录后仍显示未配置 | 内核需要重启以加载新凭据；`/provider` 会自动重启。若提示 “已登录，内核将重新加载”，等重启完成即可。 |
| HTTP 401 / 403 | 密钥无效或已过期。重新 `登录`，或检查 `{env:VAR}` 是否已设置。 |
| `Environment variable X is not set` | `providers.json` 引用了未设置的变量。设置该变量后重启。 |
| `!cat` 取不到值 | `models.json` 中的密钥文件路径不可读，或命令退出码非 0。 |
| `Invalid models.json schema` | 手工编辑出错。修正后重启；Tsukuyomi 不会覆盖非法文件。 |
| 自定义供应商保存失败 | 校验未通过（id/URL/协议/模型）。错误信息会说明具体字段，且不会写入半成品。 |
| 模型列表为空 | 端点的 `/models` 无返回，或密钥无权限。可在 `providers.json` 中手写 `models`。 |
| 自定义供应商不支持账号登录 | PI 的 `models.json` 仅支持 `oauth: "radius"`；其它自定义 OAuth 需由 PI 扩展提供。 |
| 想彻底移除旧命令 | 删除 `bin/kaguyapi.mjs` 并同步 `package.json` 的 `bin`。 |

## 12. 网络与代理（登录与额度）

Tsukuyomi 有三个需要联网的位置，且都在**前端进程**内发起：

| 场景 | 端点 | 处理方式 |
| --- | --- | --- |
| OpenAI/Codex 账号登录与令牌刷新 | `auth.openai.com` | 经 curl 走代理 |
| xAI（SuperGrok / X Premium）登录 | `auth.x.ai/oauth2/*` | 经 curl 走代理 |
| 账户额度查询（`/status`） | `chatgpt.com/backend-api/wham/usage` | 先直连，失败后经 curl 走代理 |
| 自定义供应商模型发现 | 任意 `baseURL` | 先直连，失败后经 curl 走代理 |
| 模型推理（由 PI 内核发起） | 各供应商 API，如 `api.x.ai` | 内核继承代理并启用 `NODE_USE_ENV_PROXY` |

原因：Node 的原生 `fetch`（undici）默认**不读取** `HTTP_PROXY` / `HTTPS_PROXY`（除非用 `--use-env-proxy` 启动，且该选项对旧版 Node 不可用），而 OpenAI 还会拒绝数据中心 IP 的 TLS 指纹返回 `403 unsupported_country_region_territory`。因此：

1. `app/net-env.mjs` 在启动时从 `.env` 读取代理（顺序：`<agent>/.env` → `~/.tsukuyomi` → `~/.kaguyapi` → `~/.pi` → `~/.codex`），并**不覆盖**你已显式导出的变量。
2. 若检测到代理且未启用 `NODE_USE_ENV_PROXY`，Tsukuyomi 会**自动重启一次**并带上该变量（`TSUKUYOMI_NET_PROXY_EXEC=1` 防止循环），使所有原生 fetch 都走代理。旧版 Node 忽略该变量，仍由下面的 curl 兜底。
3. `app/curl-fetch.cjs` 用 `curl -x <proxy>` 处理登录与额度请求（curl 的 TLS 指纹被接受）。默认只匹配**非流式**端点：`auth.openai.com`、`auth.x.ai`、`chatgpt.com/backend-api/wham/`；**不会**碰 `api.x.ai`、`…/backend-api/codex/*` 等流式请求，避免破坏逐字输出。
4. `app/http.mjs` 的 `createProxyAwareFetch()` 保留原生 fetch 为快路径，仅在连接类失败且已配置代理时用 curl 重试。

> 注意：代理变量只影响登录、额度与发现；模型推理由 PI 内核发起，内核会继承同样的代理设置。若某供应商的 API 主机在你的网络只能走代理，请确认代理进程正常运行。

相关变量：

| 变量 | 说明 |
| --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 标准代理变量（大小写均可） |
| `TSUKUYOMI_CURL_PROXY` | 仅 curl 使用的代理，优先级最高 |
| `TSUKUYOMI_ENV_FILE` | 指定读取哪个 `.env` |
| `TSUKUYOMI_NO_PROXY_FILE=1` | 不读取任何 `.env` |
| `TSUKUYOMI_CURL_FETCH` | 指定自定义 curl-fetch 钩子路径 |
| `TSUKUYOMI_CURL_FETCH_MATCH` | 替换默认匹配规则（正则） |
| `TSUKUYOMI_CURL_FETCH_EXTRA` | 在默认规则上追加一条（正则） |
| `TSUKUYOMI_CURL_FETCH_DEBUG=1` | 打印每个被 curl 接管/放行的 URL |

## 13. 故障排查补充

| 现象 | 原因与处理 |
| --- | --- |
| `/status` 显示 `fetch failed` / “额度接口直连与代理均不可达” | 配额端点直连不可达，且代理重试也失败。确认代理进程在跑（默认 `127.0.0.1:12450`）、`HTTP_PROXY` 或 `TSUKUYOMI_CURL_PROXY` 正确；用 `TSUKUYOMI_CURL_FETCH_DEBUG=1 tsukuyomi` 观察是否被 curl 接管。 |
| 登录后仍被判“该地区不支持” | 钩子未生效。检查 `app/curl-fetch.cjs` 是否存在、`NODE_OPTIONS` 是否被注入（启动日志无 “could not install the curl-fetch hook”）。 |
| 模型输出卡住不动 | 钩子匹配范围被改得太宽，把流式端点也接管了。默认规则不含 `…/backend-api/codex/*`；如自定义了 `TSUKUYOMI_CURL_FETCH_MATCH`，请排除流式路径。 |
| 自定义供应商“模型发现失败” | 端点或密钥问题；若端点仅代理可达，会自动重试，仍失败则为端点返回异常。 |

## 14. xAI（SuperGrok / X Premium）登录说明

- 在 `/provider` 中选择 **xAI**，会出现两个登录方式：
  - **Sign in with SuperGrok or X Premium**（OAuth，device code）
  - **xAI API key**（API Key）
- 选择 OAuth 后，界面会显示授权网址与一次性 code（例如 `https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX`），并自动尝试打开浏览器。用 SuperGrok 或 X Premium 账号完成授权即可。
- 若**完全没有出现登录界面**，通常是登录端点在发起请求前就失败了。此时会显示：
  「直连与代理都无法访问 xAI 的登录端点。你也可以改用 API Key 登录。」
  处理：`TSUKUYOMI_CURL_FETCH_DEBUG=1 tsukuyomi` 观察 `auth.x.ai` 是否被 curl 接管；确认代理可用；或直接用 API Key 登录。

## 15. `/status` 额度查询支持矩阵

`/status` 只查询**该供应商自己的**额度接口，且按凭据类型区分能力：

| 供应商 | 凭据类型 | 接口 | 展示内容 |
| --- | --- | --- | --- |
| Anthropic（Claude Pro/Max） | OAuth | `GET https://api.anthropic.com/api/oauth/usage` | 5 小时窗口、7 天窗口、Sonnet/Opus 分项周额度、Extra Usage 额度 |
| OpenAI Codex（ChatGPT） | OAuth | `chatgpt.com/backend-api/wham/usage` | 主/次速率窗口、额度金、计划类型 |
| OpenRouter | API Key | `GET https://openrouter.ai/api/v1/key` | 本月用量、上限、剩余额度 |
| DeepSeek | API Key | `GET https://api.deepseek.com/user/balance` | 余额（含币种） |
| xAI / Grok | OAuth | `GET https://grok.com/rest/subscriptions` | 订阅套餐等级、状态、计费周期（每周用量池不在此接口，见下） |
| xAI / Grok | API Key | — | **无公开额度接口**，见下 |
| 其它（含自定义与代理） | — | — | 明确返回“无支持的额度接口” |

### Anthropic 实现细节（与 Claude Code `/usage` 一致）

- 请求头：`Authorization: Bearer <OAuth access>`、`anthropic-beta: oauth-2025-04-20`、`User-Agent: claude-code/`、`Accept/Content-Type: application/json`。
- **`User-Agent: claude-code/` 是必需的**：缺失时该接口会持续返回 429。
- 响应字段：`five_hour`、`seven_day`、`seven_day_sonnet`、`seven_day_opus`、`seven_day_oauth_apps`、`seven_day_cowork`，每项含 `utilization` 与 `resets_at`；另有 `extra_usage: { is_enabled, monthly_limit, used_credits, utilization }`。
- `utilization` 在不同部署下既可能是小数（0.34）也可能是百分数（34.0）。Tsukuyomi 按整份响应中最大的取值判定比例，再统一换算为百分比。
- 仅**订阅（OAuth）**账号支持；API Key 账号没有公开用量接口，会明确提示并给出控制台链接。
- 可用 `TSUKUYOMI_ANTHROPIC_USAGE_URL` 覆盖接口地址（例如自建兼容网关）。

### xAI / Grok 额度说明

xAI **没有**对外提供额度余额 REST 接口（已核对官方文档），但 OAuth 登录后可以读到订阅套餐：

- **订阅套餐（OAuth 可读）**：`GET https://grok.com/rest/subscriptions` 返回当前订阅的等级（如 `grok pro`）、状态（`active`/`inactive`）与计费周期截止时间。`/status` 会用它展示「Plan」一行并注明周期。
- **每周用量池（不可 API 读取）**：`grok.com/rest/rate-limits` 这个端点确实存在，但 xAI 明确拒绝 OAuth2 令牌访问，返回 `oauth2-auth-forbidden`；它只在 **grok.com 网页端 `Settings → Usage`** 可见。因此 `/status` 会提示「每周用量池仅在网页端显示，API 令牌无法读取」，并给出对应链接。
- **API Key 账号**：没有消费者订阅，也没有配额接口；速率限制只在**模型调用响应头**中返回（`x-ratelimit-limit-requests`、`x-ratelimit-remaining-requests`、`x-ratelimit-reset-requests`），前端不做模型调用，因此无法主动获取。API 用量在控制台：<https://console.x.ai/usage>。

因此 `/status` 对 xAI 会展示订阅套餐（OAuth）或明确提示「无公开额度接口，请打开下方用量页面查看」（API Key），而不是伪造一个必然失败的请求。

### 安全约束

- 适配器声明了所属主机；若模型的 `baseUrl` 指向其它主机（自建代理/网关），查询会被拒绝，避免把订阅令牌发给第三方。
- 凭据只取自该供应商 id 对应的条目，不会借用其它供应商的密钥。
