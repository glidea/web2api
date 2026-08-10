# Web2API

[简体中文](README.zh-CN.md)

Expose logged-in ChatGPT, Gemini, and Grok Chrome sessions through a local OpenAI-compatible Responses API.

## Features

- Independent ChatGPT, Gemini, and Grok providers
- Text, streaming text, multi-turn conversations, and reasoning effort
- Image input from URLs or base64 data URLs
- Image generation and image editing
- Emulated function calling
- Local execution without storing prompts, responses, images, cookies, or provider credentials

## Quick Start

Requirements: Google Chrome, Node.js 22+, and a logged-in ChatGPT, Gemini, or Grok account.

1. Install the ready-to-load extension. No repository clone or build is required:

```sh
npx -y glidea-web2api@latest prepare-extension
```

2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `Extension` directory printed by the command.

3. Pin Web2API and open its popup. Run the one-time installation command shown there:

```sh
npx -y glidea-web2api@latest install --extension-id <extension-id>
```

4. Return to the popup and click **Check again**. Web2API starts the local companion and provider worker tabs. Sign in to the providers you need, then copy the Base URL and API key from the popup.

Verify the complete path:

```sh
export WEB2API_BASE_URL="http://127.0.0.1:3210/v1"
export WEB2API_KEY="wb2_replace_with_popup_value"

curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_OK"}'
```

Seeing `WEB2API_OK` proves that the extension, companion, and real provider page are connected.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Daemon, extension connection, and ready worker status; no authentication |
| `GET` | `/v1/models` | Models available to the current accounts |
| `POST` | `/v1/responses` | Text, conversations, images, and function calls |

Every endpoint except `/healthz` requires `Authorization: Bearer <API_KEY>`.

`POST /v1/responses` currently accepts:

| Field | Behavior |
| --- | --- |
| `model` | Required; use an ID returned by `/v1/models` |
| `input` | A string or an array of `input_text`, `input_image`, and `function_call_output` items |
| `instructions` | Optional; applied to the emulated function-calling protocol |
| `previous_response_id` | Continue a web conversation on the same provider |
| `stream` | Set to `true` for text SSE |
| `reasoning.effort` | Strictly select an effort currently available in the page |
| `tools` | `image_generation` or `function` |
| `tool_choice` | `auto`, `none`, `required`, or a named function |
| `parallel_tool_calls` | Allow multiple calls in one response; defaults to `true` |

### Models

```sh
curl "$WEB2API_BASE_URL/models" \
  -H "Authorization: Bearer $WEB2API_KEY"
```

Stable default IDs are `chatgpt/default`, `gemini/default`, and `grok/default`. Dynamic account-visible models retain their provider prefix, such as `gemini/3.1-pro` or `grok/4.5`. Discover them through `/v1/models` instead of hard-coding them.

### Text

```sh
curl "$WEB2API_BASE_URL/responses" \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini/default",
    "input": "Explain why the sky is blue in two sentences."
  }'
```

Text is returned in `output[].content[].text`.

### Streaming Text

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

The response contains Responses API-style SSE events, including `response.output_text.delta` and `response.completed`.

### Multi-turn Conversations

Pass a response `id` back as `previous_response_id`. The next request must use the same provider.

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

### Reasoning Effort

```json
{
  "model": "grok/default",
  "input": "Solve this step by step: ...",
  "reasoning": {
    "effort": "expert"
  }
}
```

The effort must be a value currently reported for that provider in the popup. Web2API never silently falls back to another effort.

### Image Understanding

`input_image.image_url` accepts HTTP(S) URLs and base64 data URLs. Each image may be up to 16 MiB, and multiple images are accepted in order. `file_id` is not supported.

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

Convert a local image to a data URL with:

```sh
printf 'data:image/png;base64,'
base64 < input.png | tr -d '\n'
```

### Image Generation

Declare the `image_generation` tool and use a non-streaming request. ChatGPT and Gemini use their respective image UI. Grok automatically opens **Imagine**.

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

The final image is raw base64 in the `image_generation_call.result` output item:

```json
{
  "type": "image_generation_call",
  "status": "completed",
  "result": "iVBORw0KGgo..."
}
```

Extract it with Node.js 22+:

```sh
node -e 'const fs = require("node:fs"); const body = JSON.parse(fs.readFileSync("response.json", "utf8")); const image = body.output.find((item) => item.type === "image_generation_call"); fs.writeFileSync("generated-image", Buffer.from(image.result, "base64"));'
```

Run `file generated-image` to identify the actual format, then add a `.png` or `.jpg` extension.

Generation features and quotas depend on the current provider account. If the provider page shows an upgrade, quota, or regional restriction, the API returns a provider error and does not bypass it.

### Image Editing

Image editing combines `input_image` with `image_generation`. The input is uploaded to the real provider page and the edited image is returned:

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

To keep editing the generated image, include the previous response `id` as `previous_response_id` in the next request.

### Function Calling

Web2API accepts Responses API `function` tools:

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

Execute the returned `function_call`, then send its result with the original response `id` and `call_id`:

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

`tool_choice: "auto" | "none" | "required"`, named functions, and `parallel_tool_calls` are supported. Function calling is emulated through a strict prompt protocol rather than native provider functions. `strict: true` cannot provide the same guarantee as OpenAI Structured Outputs. Tool-enabled streaming is buffered until the page response completes.

## CLI

```sh
glidea-web2api prepare-extension
glidea-web2api doctor --extension-id <extension-id>
glidea-web2api start
glidea-web2api uninstall --extension-id <extension-id>
```

The extension popup controls the companion during normal use. `start` is only a manual fallback.

## Development

Only source development requires a build:

```sh
pnpm install
pnpm build:daemon
pnpm build:extension
pnpm test
pnpm typecheck
pnpm test:e2e:extension
```

Load `src/extension/.output/chrome-mv3`, then run:

```sh
node bin/glidea-web2api.mjs install --extension-id <extension-id>
```

Real-page smoke tests use dedicated Chrome profiles under `~/.web2api/` and never copy cookies. See `package.json` for the commands.

## Documentation

- [Technical design](docs/v001/tech-design.md)
- [Implementation tasks](docs/v003/tasks.md)
- [Local acceptance](docs/acceptance.md)

Web2API is an unofficial local tool and is not affiliated with OpenAI, Google, or xAI. Use it in accordance with each provider's terms and account restrictions.
