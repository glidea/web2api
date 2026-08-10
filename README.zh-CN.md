# Web2API

[English](README.md)

将 Chrome 中已登录的 ChatGPT、Gemini 和 Grok 会话转换为本地 OpenAI Responses API。

## 功能

- ChatGPT、Gemini、Grok 三个独立 Provider
- 文本、流式文本、多轮对话和 reasoning effort
- URL 或 base64 data URL 图片输入
- 文生图和图片编辑
- 模拟 function calling
- 本地运行，不保存 prompt、响应、图片、Cookie 或 Provider 凭据

## 快速开始

要求：Google Chrome、Node.js 22+，以及至少一个已登录的 ChatGPT、Gemini 或 Grok 账号。

1. 下载成品扩展，无需克隆仓库或构建：

```sh
npx -y glidea-web2api@latest prepare-extension
```

2. 打开 `chrome://extensions`，启用「开发者模式」，点击「加载已解压的扩展程序」，选择命令输出的 `Extension` 目录。

3. 固定并打开 Web2API 扩展。执行 popup 中显示的一次性安装命令：

```sh
npx -y glidea-web2api@latest install --extension-id <extension-id>
```

4. 回到 popup 点击 **Check again**。Web2API 会启动本地 companion 和 Provider worker 标签页。登录需要使用的 Provider，然后从 popup 复制 Base URL 和 API key。

验证完整链路：

```sh
export WEB2API_BASE_URL="http://127.0.0.1:3210/v1"
export WEB2API_KEY="wb2_replace_with_popup_value"

curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_OK"}'
```

响应中出现 `WEB2API_OK` 即表示扩展、companion 和真实 Provider 页面全部连通。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | daemon、扩展连接和 ready worker 状态，无需认证 |
| `GET` | `/v1/models` | 当前账号可用的模型 |
| `POST` | `/v1/responses` | 文本、多轮、图片和函数调用 |

除 `/healthz` 外，所有请求都需要 `Authorization: Bearer <API_KEY>`。

`POST /v1/responses` 当前支持：

| 字段 | 行为 |
| --- | --- |
| `model` | 必填，使用 `/v1/models` 返回的 ID |
| `input` | 字符串，或 `input_text`、`input_image`、`function_call_output` 数组 |
| `instructions` | 可选，仅用于 function calling 的模拟工具协议 |
| `previous_response_id` | 续接同一 Provider 的网页对话 |
| `stream` | `true` 返回文本 SSE |
| `reasoning.effort` | 严格选择页面当前可用的思考等级 |
| `tools` | `image_generation` 或 `function` |
| `tool_choice` | `auto`、`none`、`required` 或指定函数 |
| `parallel_tool_calls` | 是否允许一次返回多个函数调用，默认 `true` |

### 模型

```sh
curl "$WEB2API_BASE_URL/models" \
  -H "Authorization: Bearer $WEB2API_KEY"
```

稳定默认模型为 `chatgpt/default`、`gemini/default` 和 `grok/default`。账号当前可见的动态模型会保留 Provider 前缀，例如 `gemini/3.1-pro` 或 `grok/4.5`。不要硬编码动态模型，使用 `/v1/models` 获取。

### 文本

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini/default",
    "input": "Explain why the sky is blue in two sentences."
  }'
```

文本位于 `output[].content[].text`。

### 流式文本

```sh
curl -N "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok/default",
    "input": "Count from 1 to 5 slowly.",
    "stream": true
  }'
```

接口返回 Responses API 风格的 SSE 事件，包括 `response.output_text.delta` 和 `response.completed`。

### 多轮对话

把上一轮响应的 `id` 作为下一轮的 `previous_response_id`。模型必须属于同一个 Provider。

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt/default",
    "previous_response_id": "resp_chatgpt_REPLACE_ME",
    "input": "Now summarize your previous answer in one sentence."
  }'
```

### Reasoning effort

```json
{
  "model": "grok/default",
  "input": "Solve this step by step: ...",
  "reasoning": {
    "effort": "expert"
  }
}
```

effort 必须是 popup 中当前 Provider 实际上报的值。Web2API 不会静默降级到其他等级。

### 图片理解

`input_image.image_url` 支持 HTTP(S) URL 和 base64 data URL，单张图片最大 16 MiB，也可以按顺序传入多张图片。不支持 `file_id`。

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini/default",
    "input": [
      {"type": "input_text", "text": "Describe this image precisely."},
      {"type": "input_image", "image_url": "https://example.com/input.png"}
    ]
  }'
```

本地图片可转换为 data URL：

```sh
printf 'data:image/png;base64,'
base64 < input.png | tr -d '\n'
```

### 图片生成

在 `tools` 中声明 `image_generation`。图片生成应使用非流式请求。ChatGPT 和 Gemini 使用各自网页中的图片能力；Grok 自动进入 **Imagine**。

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok/default",
    "input": "A product photo of a transparent mechanical keyboard on a white desk, soft daylight",
    "tools": [{"type": "image_generation"}]
  }' > response.json
```

最终图片是 `output` 中 `image_generation_call.result` 的原始 base64 数据：

```json
{
  "type": "image_generation_call",
  "status": "completed",
  "result": "iVBORw0KGgo..."
}
```

Node.js 22+ 可直接提取图片：

```sh
node -e 'const fs = require("node:fs"); const body = JSON.parse(fs.readFileSync("response.json", "utf8")); const image = body.output.find((item) => item.type === "image_generation_call"); fs.writeFileSync("generated-image", Buffer.from(image.result, "base64"));'
```

使用 `file generated-image` 查看实际图片格式后添加 `.png` 或 `.jpg` 扩展名。

生成能力和配额由当前 Provider 账号决定。网页显示升级、配额或地区限制时，API 会返回 Provider 错误，不会绕过限制。

### 图片编辑

图片编辑就是同时提交 `input_image` 和 `image_generation`。下面的请求会把输入图上传到真实 Provider 页面，再返回编辑后的图片：

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt/default",
    "input": [
      {"type": "input_text", "text": "Remove the background and keep the object unchanged."},
      {"type": "input_image", "image_url": "https://example.com/product.png"}
    ],
    "tools": [{"type": "image_generation"}]
  }'
```

继续修改同一张生成图时，在下一次请求中加入上一轮的 `previous_response_id`。

### Function calling

Web2API 接受 Responses API 的 `function` 工具：

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt/default",
    "input": "What is the weather in Paris?",
    "tools": [{
      "type": "function",
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": false
      },
      "strict": true
    }],
    "tool_choice": "auto"
  }'
```

执行返回的 `function_call` 后，用原响应 `id` 和 `call_id` 回传结果：

```json
{
  "model": "chatgpt/default",
  "previous_response_id": "resp_chatgpt_REPLACE_ME",
  "input": [{
    "type": "function_call_output",
    "call_id": "call_REPLACE_ME",
    "output": "{\"temperature\":21,\"unit\":\"C\"}"
  }]
}
```

支持 `tool_choice: "auto" | "none" | "required"`、指定函数和 `parallel_tool_calls`。函数调用由严格提示词协议模拟，不等同于 Provider 原生 function calling；`strict: true` 也不具备 OpenAI Structured Outputs 的确定性保证。工具流式请求会等网页响应完成后再返回调用。

## CLI

```sh
glidea-web2api prepare-extension
glidea-web2api doctor --extension-id <extension-id>
glidea-web2api start
glidea-web2api uninstall --extension-id <extension-id>
```

正常使用由扩展 popup 控制 companion。`start` 只是手动兜底。

## 开发

源码开发才需要构建：

```sh
pnpm install
pnpm build:daemon
pnpm build:extension
pnpm test
pnpm typecheck
pnpm test:e2e:extension
```

加载 `src/extension/.output/chrome-mv3`，然后使用：

```sh
node bin/glidea-web2api.mjs install --extension-id <extension-id>
```

真实页面 smoke test 使用 `~/.web2api/` 下的独立 Chrome profile，不复制 Cookie。具体命令见 `package.json`。

## 文档

- [技术设计](docs/v001/tech-design.md)
- [实现任务](docs/v003/tasks.md)
- [本地验收](docs/acceptance.md)

Web2API 是非官方本地工具，不隶属于 OpenAI、Google 或 xAI。使用时需遵守对应 Provider 的条款和账号限制。
