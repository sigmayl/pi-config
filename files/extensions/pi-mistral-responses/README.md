# pi-mistral-responses

给 [Pi](https://pi.dev) 用的第二个 Mistral 渠道：同一个账号，走 OpenAI **Responses** 协议
（`openai-responses`），而不是内置 `mistral` 渠道的 `mistral-conversations`。

- 渠道 ID：`mistral-responses`，显示名 `Mistral (Responses)`
- 默认端点：`https://api.mistral.ai/v1`（`POST /v1/responses`）
- 自动读取模型列表：`GET /v1/models`，只保留 `capabilities.completion_chat` 为真的模型，
  跳过 embedding / OCR / TTS / 转写模型和已废弃模型
- 不覆盖内置 `mistral` 渠道：两个渠道并存，各自使用自己的协议

## 为什么用插件而不是 `models.json`

`models.json` 的 provider 级 `api` 只对**新增**模型生效，`modelOverrides` 也没有 `api` 字段。
要让内置 mistral 模型换协议，只能把 34 个模型整份抄进 `models.json` 覆盖——既冗长，又会在
Pi 更新目录后过期。插件形式只声明“端点 + 协议”，模型列表交给服务端。

## 安装

插件目录已在 Pi 的用户扩展目录下，重启 Pi 即可加载：

```
~/.pi/agent/extensions/pi-mistral-responses/
```

也可以用 `pi install /home/seey6/.pi/agent/extensions/pi-mistral-responses` 显式登记。

## 认证

按顺序解析，第一个可用的生效：

1. 本渠道自己的凭证：`/login mistral-responses`（写入 `auth.json`）
2. 环境变量 `MISTRAL_API_KEY`
3. `auth.json` 里 `mistral` 渠道的 key

第 3 步让两个渠道共用同一份密钥：`/login mistral` 换 key 后，本渠道自动跟着换，不需要维护第二份副本。

## 模型列表

`GET /v1/models` 只提供 id、上下文长度和能力标记，没有价格和输出上限。插件用 Pi 内置的
Mistral 目录补齐这些元数据（价格、`maxTokens`、`thinkingLevelMap`、图片限制），因此费用统计、
thinking 档位和上下文显示与内置渠道一致。

- 内置目录同时作为**静态基线**：首次启动、没有 key、`--offline` 时渠道不会空掉。
- 服务端返回的模型会覆盖同名基线模型，并追加目录里没有的新模型（例如 `mistral-vibe-cli-*`、
  `zai-glm-5`、`mistral-medium-3`）。
- 发现结果持久化在 `models-store.json` 的 `mistral-responses` 条目里，下次启动先离线恢复。
- 刷新时机：交互式 Pi 启动时、打开 `/model` 时。`pi --list-models` 只读缓存，不会触发网络刷新。
- 请求失败时保留上一份列表，不会把选型器清空。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MISTRAL_API_KEY` | — | API key |
| `MISTRAL_RESPONSES_BASE_URL` | `https://api.mistral.ai/v1` | 端点根路径，Responses 会拼 `/responses` |
| `MISTRAL_RESPONSES_MODELS_URL` | `${baseUrl}/models` | 模型发现地址 |
| `MISTRAL_RESPONSES_MODELS` | — | 逗号分隔的模型 ID，发现结果为空时作为兜底 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | 读取 `auth.json` 的配置目录 |

## 使用

```bash
pi --model mistral-responses/deepseek-v4-1-flash-1017
```

想让它进入 `Ctrl+P` 循环，在 `settings.json` 的 `enabledModels` 里加一行：

```json
"mistral-responses/deepseek-v4-1-flash-1017"
```

## 结构

| 文件 | 作用 |
|---|---|
| `src/index.ts` | `pi.registerProvider(createProvider(...))` |
| `src/models.ts` | 模型发现、目录补齐、离线基线 |
| `src/api-key.ts` | 三级凭证解析 |
| `src/config.ts` | 环境变量 |
