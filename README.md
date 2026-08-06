# web2api

Expose a logged-in ChatGPT Chrome session through a local OpenAI Responses API.

## Run

```sh
npx web2api start
```

Install the Web2API Chrome extension separately, then configure an OpenAI-compatible client with:

- Base URL: `http://127.0.0.1:3210/v1`
- API key: the value printed by the daemon
- Model: `chatgpt/default`

The daemon does not store prompts, responses, images, cookies, or ChatGPT credentials. The account must already be logged in to `chatgpt.com`.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm test:e2e:extension
pnpm pack:extension
```

Real-page smoke testing opens a dedicated Chromium profile. Log in to ChatGPT in the opened window on the first run:

```sh
pnpm test:smoke:chatgpt
```

Set `WEB2API_CHATGPT_PROFILE` only to override the default `~/.web2api/chatgpt-profile` directory.

## Documentation

- [Technical design](docs/v001/tech-design.md)
- [Implementation tasks](docs/v001/tasks.md)
- [Acceptance manual](docs/acceptance.md)
