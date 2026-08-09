# Web2API

Expose logged-in ChatGPT and Gemini Chrome sessions through a local OpenAI Responses API.

Supported response types include text, streaming text, image generation, image input, and emulated function calling.

## Quick Start

Requirements:

- Chrome
- Node.js 22+
- A logged-in ChatGPT or Gemini account

The Chrome extension is not in the Chrome Web Store yet. Build and load it locally:

```sh
git clone --depth 1 https://github.com/glidea/web2api.git
cd web2api
corepack enable
pnpm install --frozen-lockfile
pnpm build:extension
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select:

```text
src/extension/.output/chrome-mv3
```

Pin Web2API and open its popup. Run the one-time command displayed there:

```sh
npx -y glidea-web2api@latest install --extension-id <extension-id>
```

Return to the popup and click **Check again**. Web2API starts the local companion and opens separate ChatGPT and Gemini worker pools. Log in to the provider pages you want to use.

The popup provides the Base URL, API key, daemon controls, independent provider status, and separate worker counts. Copy the API key and verify the complete path:

```sh
export WEB2API_KEY="wb2_replace_with_popup_value"

curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_OK"}'
```

The response should contain `WEB2API_OK`. Configure other OpenAI-compatible clients with:

- Base URL: `http://127.0.0.1:3210/v1`
- API key: the value shown in the popup
- Model: `chatgpt/default` or `gemini/default`

Use `GET /v1/models` to discover account-visible provider models. Dynamic IDs keep their provider prefix, such as `gemini/3.1-pro`.

The companion does not store prompts, responses, images, cookies, or provider credentials. The selected provider must already be logged in to its worker pages.

## Function Calling

Pass standard Responses API `function` tools, execute returned `function_call` items locally, then send `function_call_output` with `previous_response_id`. `tool_choice` and `parallel_tool_calls` are supported.

Function calling is emulated through a strict prompt protocol because the consumer pages do not expose caller-defined functions. Tool names and JSON arguments are validated, but `strict: true` cannot provide the same guarantee as native OpenAI Structured Outputs. Tool-enabled streaming is buffered until the page response completes.

## CLI

```sh
glidea-web2api doctor --extension-id <extension-id>
glidea-web2api start
glidea-web2api uninstall --extension-id <extension-id>
```

`start` is a manual fallback. Normal use is controlled from the extension popup.

## Development

```sh
pnpm install
pnpm build:daemon
pnpm build:extension
pnpm test
pnpm typecheck
pnpm test:e2e:extension
```

Load `src/extension/.output/chrome-mv3` through `chrome://extensions`, open the popup, and run its generated installation command. During local development, replace the published command with:

```sh
node bin/glidea-web2api.mjs install --extension-id <extension-id>
```

Real-page smoke tests use dedicated profiles:

```sh
pnpm test:smoke:chatgpt:setup
pnpm test:smoke:chatgpt
pnpm test:smoke:gemini:setup
pnpm test:smoke:gemini
```

The ChatGPT profile is stored under `~/.web2api/chatgpt-profile`. Gemini setup opens system Google Chrome with `~/.web2api/gemini-profile`; close that window before running its smoke test. Neither flow copies browser cookies.

## Documentation

- [Technical design](docs/v001/tech-design.md)
- [Implementation tasks](docs/v002/tasks.md)
- [Local acceptance](docs/acceptance.md)
