# Web2API Acceptance Manual

This manual separates deterministic automated acceptance from the real ChatGPT smoke test. A fixture-based pass does not prove compatibility with the current ChatGPT production page.

## 1. Prerequisites

- Node.js 22 or newer
- pnpm 10
- A Chromium-based browser with extension developer mode
- A ChatGPT test account
- Port `3210` available on localhost

Verify the toolchain:

```sh
node --version
pnpm --version
```

## 2. Automated Acceptance

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Run unit tests and static checks:

```sh
pnpm test
pnpm typecheck
```

Expected result:

- All Vitest suites pass.
- TypeScript reports no errors.

Run the isolated extension tests:

```sh
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
```

Expected result:

- The MV3 service worker starts.
- The popup loads.
- The content script injects only on ChatGPT pages.
- Two extension-owned workers connect to the daemon.
- A local Responses request reaches the real extension and fixture DOM.
- A new conversation and a continued conversation use the correct worker URL.

Build the extension artifact:

```sh
pnpm pack:extension
```

Expected artifact:

```text
dist/web2api-extension.zip
```

## 3. npm Package Acceptance

Create the package tarball:

```sh
pnpm pack
```

Install it from a directory outside the repository:

```sh
TEST_DIRECTORY="$(mktemp -d)"
cd "$TEST_DIRECTORY"
npm init -y
npm install /absolute/path/to/web2api/web2api-0.1.0.tgz
npx web2api start
```

Expected terminal output contains:

```text
Web2API listening on http://127.0.0.1:3210
API key: wb2_...
Config: ...
Extension: disconnected
```

Stop the daemon before continuing with the source-tree acceptance run.

## 4. Load the Development Extension

Build the unpacked extension:

```sh
pnpm build:extension
```

In a Chromium-based browser:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose `src/extension/.output/chrome-mv3`.
5. Open the Web2API popup.

At this stage the popup should show the daemon as disconnected.

## 5. Start the Daemon

Run:

```sh
npx tsx src/daemon/cli.ts start
```

Record the printed API key without committing or sharing it. The default config is stored at `~/.web2api/config.json` with user-only permissions.

The extension should connect and create two ChatGPT worker tabs. Log in to ChatGPT in those worker tabs if required.

Check daemon health:

```sh
curl http://127.0.0.1:3210/healthz
```

Expected state:

```json
{
  "status": "ok",
  "daemon": "ready",
  "extension_connected": true,
  "workers_ready": 2
}
```

These four values are the acceptance criteria.

## 6. Models

Set the API key printed by the daemon:

```sh
export WEB2API_KEY="wb2_replace_with_real_key"
```

List models:

```sh
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $WEB2API_KEY"
```

Acceptance criteria:

- `chatgpt/default` is present.
- Any additional model reflects an option visible to the logged-in account.
- The daemon does not advertise a hard-coded unavailable model.

## 7. Non-Streaming Text

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_TEXT_OK"}'
```

Acceptance criteria:

- HTTP status is `200`.
- `object` is `response`.
- `status` is `completed`.
- `id` starts with `resp_`.
- The assistant output is non-empty.
- The selected worker tab contains exactly one new user message.

## 8. Conversation Continuation

Copy the previous response ID and run:

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Reply with exactly WEB2API_CONTINUED_OK","previous_response_id":"resp_replace_with_previous_id"}'
```

Acceptance criteria:

- HTTP status is `200`.
- The request appears in the same ChatGPT conversation.
- The response ID encodes the same conversation ID.
- No duplicate prompt appears.

## 9. Streaming and Cancellation

```sh
curl --no-buffer http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Write four short numbered lines","stream":true}'
```

Acceptance criteria:

- The response content type is `text/event-stream`.
- Events start with `response.created` and end with `response.completed`.
- `response.output_text.delta` arrives incrementally.
- Concatenated deltas equal the final text.

Cancellation check:

1. Start a long streaming request.
2. Interrupt `curl` while ChatGPT is generating.
3. Confirm the page stops generating.
4. Confirm the worker returns to ready.

## 10. Concurrency

Set `max_tabs` to `2` in `~/.web2api/config.json` and restart the daemon.

1. Start request A1 for a new conversation.
2. Start request B1 for another new conversation before A1 completes.
3. Continue conversation A with request A2 while A1 is still running.

Acceptance criteria:

- A1 and B1 may run on separate worker tabs.
- A2 waits for A1.
- No worker executes two jobs simultaneously.
- Closing a busy worker fails its active request and does not replay the prompt.

## 11. Model and Reasoning Selection

Use only values returned by `/v1/models` or visibly available in the current ChatGPT account.

Acceptance criteria:

- `chatgpt/default` does not change the page selection.
- An explicit available model is selected before prompt submission.
- An explicit unavailable model returns `400 model_not_available` and adds no page message.
- An unavailable reasoning effort returns `400 reasoning_effort_not_available` and adds no page message.

Some accounts expose no separate model or reasoning controls. In that case, record the capability as unavailable rather than fabricating a passing result.

## 12. Image Input and Generation

Create a small PNG fixture and convert it to a data URL:

```sh
IMAGE_BASE64="$(base64 < /absolute/path/to/input.png | tr -d '\n')"
```

Send an edit request:

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"chatgpt/default\",\"input\":[{\"type\":\"input_text\",\"text\":\"Create a monochrome version\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,$IMAGE_BASE64\"}],\"tools\":[{\"type\":\"image_generation\"}]}"
```

Send a text-to-image request:

```sh
curl http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $WEB2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt/default","input":"Generate a simple black square on a white background","tools":[{"type":"image_generation"}]}'
```

Acceptance criteria:

- The page shows each uploaded image in request order.
- The response contains `image_generation_call.result`.
- The result decodes as non-empty image bytes.
- Invalid URLs and oversized images fail before a ChatGPT message is submitted.

## 13. Logged-Out and Authentication Failures

Invalid daemon key:

```sh
curl -i http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer invalid"
```

Expected result: `401`.

Log out of the dedicated ChatGPT worker profile and send a valid request.

Expected result:

- HTTP status is `503`.
- Error code is `chatgpt_login_required`.
- No prompt is submitted.

## 14. Dedicated Real-Page Smoke

Run:

```sh
pnpm test:smoke:chatgpt
```

The command opens a dedicated profile at `~/.web2api/chatgpt-profile`. Sign in manually on the first run. The test must not read or copy another browser's session data.

The current automated smoke covers extension loading, login detection, one text request, and conversation continuation. Model, reasoning, image, and concurrency checks remain manual until automated cases are added.

## 15. Privacy and Release Gate

Inspect daemon output and generated test artifacts.

Acceptance criteria:

- No prompt or response text appears in daemon logs.
- No image bytes appear in daemon logs.
- No API key appears after the initial explicit startup output.
- No browser cookies or ChatGPT credentials are stored by Web2API.
- The real ChatGPT smoke result is recorded separately from fixture E2E results.

Release is blocked if any automated test fails or if the real-page smoke has not passed on the current ChatGPT production page.
