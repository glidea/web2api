# Web2API

Expose a logged-in ChatGPT Chrome session through a local OpenAI Responses API.

## Install

1. Install the Web2API Chrome extension.
2. Open its popup.
3. Run the one-time command shown by the popup:

```sh
npx -y glidea-web2api@latest install --extension-id <extension-id>
```

4. Click **Check again** in the popup.

The extension starts the local companion automatically. The popup provides the Base URL, API key, daemon controls, and concurrent tab setting.

Configure an OpenAI-compatible client with:

- Base URL: `http://127.0.0.1:3210/v1`
- API key: copy it from the extension popup
- Model: `chatgpt/default`

The companion does not store prompts, responses, images, cookies, or ChatGPT credentials. The account must already be logged in to `chatgpt.com`.

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

Real-page smoke testing opens a dedicated Chromium profile:

```sh
pnpm test:smoke:chatgpt
```

## Documentation

- [Technical design](docs/v001/tech-design.md)
- [Implementation tasks](docs/v001/tasks.md)
- [Local acceptance](docs/acceptance.md)
