# pi-anyrouter-provider

为 [Pi](https://pi.dev) 提供的 `anyrouter.top` 专属 provider 插件。

- API Key 登录：`/login anyrouter`，或使用环境变量 `ANYROUTER_API_KEY`。
- 自动发现模型：请求 `https://anyrouter.top/v1/models`，按关键字分成两组。
  - `gpt` → OpenAI Responses 协议（`openai-responses`）
  - `claude` → Claude Code Messages 协议（`anthropic-messages`）
- 针对中转站“挤容量”的 429/5xx 重试：只对本 provider 生效，高频重试，不影响 Pi 的全局重试设置。
- 复用 Pi 内置的模型元数据（上下文长度、最大输出、thinking 等），并保留 `models.json` 覆盖能力。

## 安装

在插件目录中执行：

```bash
pi install /absolute/path/to/pi-anyrouter-provider
```

或者只对当前进程临时加载：

```bash
pi -e /absolute/path/to/pi-anyrouter-provider
```

安装后运行：

```bash
pi
/login anyrouter
```

也可以不写入 `auth.json`，直接使用环境变量：

```bash
export ANYROUTER_API_KEY=sk-...
pi
```

支持 `ANYROUTER_API_KEY` 和 `ANYROUTER_KEY` 两个变量名，前者优先。

## 模型

默认从 `https://anyrouter.top/v1/models` 发现模型：

| 分组 | 匹配关键字 | Pi API | 默认 Base URL |
|---|---|---|---|
| OpenAI | `gpt` | `openai-responses` | `https://anyrouter.top/v1` |
| Claude | `claude` | `anthropic-messages` | `https://anyrouter.top` |

发现的模型会缓存到 Pi 的 `models-store.json`，下次启动即使离线也能显示。首次运行或需要刷新时：

```bash
pi update --models
```

如果中转站没有 `/v1/models`，可以直接写死模型列表：

```bash
export ANYROUTER_MODELS="gpt-5.5,claude-sonnet-4-5"
```

或按分组写：

```bash
export ANYROUTER_OPENAI_MODELS="gpt-5.5,gpt-5-codex"
export ANYROUTER_CLAUDE_MODELS="claude-sonnet-4-5,claude-opus-4-5"
```

按分组写时不需要包含关键字，插件会强制使用对应协议。

## “挤容量”重试（429 / 5xx）

anyrouter 的会话容量有限，没挤进去时：Claude（Messages）侧通常返回 429；GPT（Responses）侧返回 **500**，body 为空或为 `get_channel_failed` / “负载已经达到上限”。插件在 provider 的 `fetch` 层做了专属重试：

- 默认最多重试 `60` 次。
- 初始等待约 `2s`，指数增长但上限 `8s`，每次乘以 0.5–1.0 的随机系数（依次约 1–2s、2–4s，之后 4–8s）。
- 如果响应带 `Retry-After`，它只作为下限（且不超过 `maxDelayMs`），随机抖动始终保留，避免 `Retry-After: 0` 时齐步猛刷。
- 自动识别 `insufficient_quota`、`billing`、`余额不足`、`额度已用尽` 等真正的配额错误，不会无脑重试。
- 内层 API 的 `maxRetries` 设为 `0`，避免 Pi 的慢速 provider 重试叠加。
- 该逻辑只作用于 `anyrouter` provider；Pi 的全局 `retry.*` 设置不受影响，其他 provider 行为不变。

### 重试是可见的

重试发生在 provider 的 `fetch` 层，Pi 自己的重试指示器看不到它，所以插件把进度接到 Pi 现有的两个 UI 通道上：

```
Working 行（TUI）:  ⠋ anyrouter 429 · retry 3/60 · 4s (esc to interrupt)
页脚（TUI / RPC）:  anyrouter 429 · retry 3/60 · 4s
```

- 每次重试前更新，重试成功、耗尽或按 Esc 中断后立即恢复，不留残留。
- 页脚状态在 RPC 模式下也会作为 `extension_ui_request`（`setStatus`）发出。
- 重试耗尽后仍会返回错误，之后由 Pi 内置的自动重试（`auto_retry_start` / `RetryStatusIndicator`）接手，两者不冲突。
- 想完全静默（保持旧行为）：`ANYROUTER_RETRY_NOTICE=off`。

可调参数：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `ANYROUTER_RETRY_MAX_RETRIES` | `60` | 首次请求之后的额外重试次数，`0` 关闭 |
| `ANYROUTER_RETRY_BASE_DELAY_MS` | `2000` | 初始退避毫秒数 |
| `ANYROUTER_RETRY_MAX_DELAY_MS` | `8000` | 单次退避上限 |
| `ANYROUTER_RETRY_STATUSES` | `429,500,502,503,504` | 需要重试的 HTTP 状态码，逗号分隔；设为 `429` 可恢复旧行为 |
| `ANYROUTER_RETRY_NOTICE` | `on` | 是否在 working 行 / 页脚显示重试进度；`off` 关闭 |

## 全部配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ANYROUTER_API_KEY` / `ANYROUTER_KEY` | 无 | API Key |
| `ANYROUTER_BASE_URL` | `https://anyrouter.top` | 中转站根地址，可带 `/v1` |
| `ANYROUTER_OPENAI_BASE_URL` | 根地址 + `/v1` | OpenAI 协议 Base URL |
| `ANYROUTER_ANTHROPIC_BASE_URL` | 根地址 | Claude 协议 Base URL（SDK 会追加 `/v1/messages`） |
| `ANYROUTER_MODELS_URL` | OpenAI Base URL + `/models` | 模型发现地址 |
| `ANYROUTER_OPENAI_API` | `openai-responses` | 可设为 `openai-completions` 兼容只支持 Chat Completions 的中转 |
| `ANYROUTER_OPENAI_FILTER` | `gpt` | OpenAI 模型关键字，逗号分隔 |
| `ANYROUTER_CLAUDE_FILTER` | `claude` | Claude 模型关键字，逗号分隔 |
| `ANYROUTER_ANTHROPIC_AUTH` | `both` | `both` 同时发 `x-api-key` 和 `Authorization`；`bearer` 只发 Bearer；`x-api-key` 只发 SDK 默认头 |
| `ANYROUTER_CONTEXT_WINDOW` | 自动 | 强制覆盖所有模型的上下文窗口 |
| `ANYROUTER_MAX_TOKENS` | 自动 | 强制覆盖所有模型的最大输出 |

示例：如果中转只支持 Chat Completions：

```bash
export ANYROUTER_OPENAI_API=openai-completions
```

如果 Claude Code 风格的中转只接受 Bearer：

```bash
export ANYROUTER_ANTHROPIC_AUTH=bearer
```

## 模型元数据

插件会优先匹配 Pi 内置模型目录中的同名模型，例如：

- `claude-sonnet-4-5` → 200K 上下文、64K 输出、thinking
- `gpt-5.5` → 272K 上下文、128K 输出、reasoning

匹配时会忽略日期后缀和 `-latest` 等变体。未知模型使用保守的启发式值。

中转站价格未知，所以所有模型的 `cost` 都设为 0。需要调整元数据时，用 Pi 的 `models.json` 覆盖即可：

```json
{
  "providers": {
    "anyrouter": {
      "modelOverrides": {
        "gpt-5.5": {
          "contextWindow": 400000,
          "maxTokens": 128000
        }
      }
    }
  }
}
```

## 排错

- 看不到模型：先 `pi update --models` 刷新；仍为空时检查 Key 和 `ANYROUTER_MODELS_URL`。
- `/v1/models` 返回 404：用 `ANYROUTER_MODELS` 手动列出模型。
- OpenAI 请求报 404：中转可能只支持 `openai-completions`，设置 `ANYROUTER_OPENAI_API=openai-completions`。
- Claude 请求 401：尝试 `ANYROUTER_ANTHROPIC_AUTH=bearer` 或 `x-api-key`。
- GPT 模型报 `500 status code (no body)`：这是 Responses 侧没挤进容量，插件会自动高频重试；重试耗尽仍失败可调大 `ANYROUTER_RETRY_MAX_RETRIES`。
- 429 一直失败：查看是否是余额/额度问题；真正的配额 429 不会被高频重试。

## 开发

```bash
npm test
npm run typecheck
```

测试覆盖配置解析、模型筛选与元数据、模型发现与离线缓存恢复、429/500 重试、以及 OpenAI Responses / Claude Messages 的完整流式请求（本地 fake fetch，不访问网络）。
