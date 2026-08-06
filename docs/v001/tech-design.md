# web2api v001 Technical Design

## 1. Decisions

### 1.1 Product Boundary

- The first release supports ChatGPT only.
- Local clients use an OpenAI Responses-compatible HTTP API.
- The system reuses a ChatGPT session already logged in through Chrome.
- Ease of installation and client compatibility are the primary product goals.
- Private ChatGPT behavior is not treated as a stable public contract.
- Text, image input, image editing, and image generation are in scope.

### 1.2 Daemon Runtime

The daemon uses Node.js and TypeScript and is distributed through npm.

```sh
npx web2api start
```

This keeps the daemon, extension, shared protocol, and runtime schemas in one language. A Go binary or Node SEA may be evaluated later for users without Node.js, but neither is required for v001.

### 1.3 Daemon-Extension Transport

The extension opens a local WebSocket connection to the daemon:

```text
ws://127.0.0.1:3210/extension
```

The daemon cannot directly address a Chrome extension. An extension-initiated WebSocket provides bidirectional streaming without Native Messaging installation or HTTP polling.

### 1.4 ChatGPT Execution

The content script operates the visible ChatGPT DOM. It does not reproduce or call private ChatGPT network APIs.

This approach delegates login, risk controls, model access, and request submission to the official web application. DOM changes remain the main compatibility risk.

### 1.5 Public API

The first release implements:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/responses`

Chat Completions is intentionally excluded. Supporting one complete API contract is preferable to maintaining two partial contracts.

### 1.6 Conversation State

The ChatGPT conversation ID is encoded in `response.id`. A subsequent request passes the ID through `previous_response_id`.

This avoids a local response-to-conversation database and survives daemon restarts. The response ID is opaque to clients and authenticated only by the local Bearer key boundary.

### 1.7 Concurrency

The daemon owns a FIFO scheduler and conversation locks. The extension owns a fixed pool of ChatGPT worker tabs.

- Default worker count: `2`
- Different conversations may run concurrently.
- Requests for the same conversation are serialized.
- A task is never retried automatically after prompt submission.

### 1.8 Models and Reasoning Effort

`chatgpt/default` is always available and leaves the current ChatGPT selection unchanged. Other model IDs use `chatgpt/<visible-model-id>` and are discovered from the current account's model menu.

Reasoning effort is also discovered dynamically. An unavailable explicit model or effort fails before prompt submission. There is no silent fallback.

### 1.9 Images

The accepted image inputs are:

- HTTPS or HTTP URLs
- base64 data URLs

The daemon resolves and validates bytes in memory, then transfers them to the extension. The extension creates `File` objects and populates ChatGPT's upload input through `DataTransfer`.

Generated images are returned as final base64 in `image_generation_call.result`. Partial image events are not promised because the ChatGPT page does not expose a stable equivalent.

## 2. Goals and Non-Goals

### Goals

- Expose a logged-in ChatGPT web session to local tools.
- Support non-streaming and streaming text responses.
- Continue existing conversations.
- Support configurable parallel worker tabs.
- Discover visible models and reasoning effort.
- Support image input, editing, and generation.
- Avoid storing prompts, responses, images, cookies, or ChatGPT credentials.

### Non-Goals

- Bypassing login, CAPTCHA, rate limits, or platform controls
- Calling undocumented ChatGPT private APIs
- Supporting every OpenAI Responses field
- Persisting a task queue
- Retrying uncertain page operations
- Installing a system background service in v001
- Automatically installing the extension into the user's browser

### Runtime Requirements

- Node.js 22 or newer
- Chromium-based browser with Manifest V3 support
- A ChatGPT account logged in on the worker pages
- Local access to `127.0.0.1:3210`

## 3. Architecture

### 3.1 Deployment View

```text
Local client
    |
    | HTTP + Bearer token
    v
Node.js daemon
    |
    | local WebSocket
    v
Chrome extension service worker
    |
    | extension messages
    v
ChatGPT worker tabs
    |
    | DOM interaction
    v
chatgpt.com
```

The local client never connects to the extension directly. The extension never exposes a public listener.

### 3.2 Runtime Components

```text
Daemon
  Config
  HTTP Server
  Responses Service
  Scheduler
  Extension Gateway
  Image Resolver

Extension
  Background Service Worker
  Worker Tab Pool
  ChatGPT Content Script
  ChatGPT Adapter
  Popup Diagnostics
```

### 3.3 Responsibilities

| Component | Responsibility |
| --- | --- |
| Config | Persist the API key, port, and worker count |
| HTTP Server | Bind localhost, authenticate requests, route endpoints |
| Responses Service | Validate the supported request subset and project JSON or SSE |
| Scheduler | Queue work, lock conversations, and lease workers |
| Extension Gateway | Own the WebSocket, worker state, and active jobs |
| Image Resolver | Fetch and validate input images in memory |
| Background Worker | Maintain the daemon connection and fixed tab pool |
| Content Script | Execute one assigned job in one ChatGPT page |
| ChatGPT Adapter | Isolate all DOM selectors and page operations |
| Popup | Show connection and worker diagnostics |

### 3.4 State Ownership

| State | Owner |
| --- | --- |
| API key and port | daemon config file |
| Request queue and conversation locks | daemon scheduler |
| Active job mapping | daemon extension gateway |
| Worker tab identity | extension background worker |
| Visible models and efforts | ChatGPT page, reported by extension |
| Conversation content | ChatGPT |
| Conversation ID for a response | encoded `response.id` |

No state is mirrored without a defined owner.

### 3.5 Dependency Direction

```text
HTTP Server -> Responses Service -> Extension Gateway -> Scheduler
                              |-> Image Resolver

Extension Background -> Shared Protocol
Content Script -> ChatGPT Adapter -> Browser DOM
```

The daemon never imports extension code. Both sides depend only on the shared protocol.

## 4. Core Flows

### 4.1 First Start

1. The user runs `npx web2api start`.
2. The daemon reads `~/.web2api/config.json`.
3. If the file does not exist, it creates an API key, port `3210`, and `max_tabs: 2`.
4. The daemon listens only on `127.0.0.1`.
5. The extension connects to the WebSocket endpoint.
6. The daemon sends the desired worker count.
7. The extension creates or restores its worker tabs.
8. Each content script reports readiness and capabilities.

### 4.2 Text Request

```text
Client            Daemon             Extension           ChatGPT tab
  | POST /responses  |                    |                    |
  |----------------->| validate + queue   |                    |
  |                  | lease worker       |                    |
  |                  | job.start          |                    |
  |                  |------------------->| submit prompt      |
  |                  |                    |------------------->|
  |                  | conversation bound |                    |
  |                  |<-------------------|                    |
  |                  | text deltas        | read assistant DOM |
  |                  |<-------------------|                    |
  |                  | job.completed      |                    |
  |                  |<-------------------|                    |
  | Response JSON/SSE| release worker     |                    |
  |<-----------------|                    |                    |
```

Detailed sequence:

1. The HTTP server validates the Bearer token.
2. The Responses service validates the supported request subset.
3. The scheduler waits for a free worker and the conversation lock.
4. The gateway sends `job.start` with model, prompt, effort, images, and conversation ID.
5. The background worker navigates the selected tab to `/` or `/c/<id>`.
6. The content script verifies login and applies explicit model or effort selection.
7. It uploads images in request order.
8. It records the current assistant-message count and submits the prompt.
9. It reports the new conversation ID.
10. It emits only text added to the new assistant message.
11. It extracts the final generated image when requested.
12. The daemon projects the result and releases both worker and conversation lock.

### 4.3 Conversation Continuation

1. The client sends `previous_response_id`.
2. The daemon decodes its ChatGPT conversation ID.
3. The scheduler locks that conversation.
4. The extension navigates a leased worker to `/c/<conversation-id>`.
5. The response uses the same conversation ID in its new opaque response ID.

### 4.4 Cancellation

1. A streaming client closes its HTTP connection.
2. The daemon sends `job.cancel` to the active worker.
3. The content script clicks ChatGPT's stop button.
4. The daemon releases the worker when the job finishes or fails.

### 4.5 Worker Failure

- Closing an idle worker removes it and allows capacity restoration.
- Closing a busy worker fails its task.
- Tasks are not replayed because ChatGPT may already have accepted the prompt.
- A disconnected extension fails pending work explicitly.

## 5. State Models

### 5.1 Request Task

```text
queued -> assigned -> running -> completed
                         |-----> failed
                         |-----> cancelled
```

A task contains the request ID, model, text, optional conversation ID, optional effort, images, generation flag, and stream callbacks.

### 5.2 Worker

```text
starting -> ready -> busy -> ready
    |         |       |
    +-------> unhealthy
```

A worker is identified by the extension-owned tab ID. The gateway is the authoritative source for daemon-visible readiness.

### 5.3 Persistence

Persisted:

- API key
- port
- maximum tab count

Not persisted:

- queue
- active jobs
- prompts or outputs
- images
- worker state
- ChatGPT credentials

## 6. HTTP API

### 6.1 Authentication

Every `/v1/*` request requires:

```http
Authorization: Bearer <daemon-api-key>
```

`/healthz` is local diagnostics and does not require authentication.

### 6.2 Models

`GET /v1/models` returns `chatgpt/default` plus the currently reported model IDs. The list can change when the account or ChatGPT menu changes.

### 6.3 Text Request

```json
{
  "model": "chatgpt/default",
  "input": "Hello",
  "stream": false
}
```

### 6.4 Continuation

```json
{
  "model": "chatgpt/default",
  "input": "Continue",
  "previous_response_id": "resp_<opaque-value>"
}
```

### 6.5 Image Editing

```json
{
  "model": "chatgpt/default",
  "input": [
    { "type": "input_text", "text": "Remove the background" },
    { "type": "input_image", "image_url": "data:image/png;base64,..." }
  ],
  "tools": [{ "type": "image_generation" }]
}
```

### 6.6 Supported Request Fields

| Field | Support |
| --- | --- |
| `model` | required |
| `input` string | supported |
| `input` item array | `input_text` and `input_image` |
| `stream` | supported |
| `previous_response_id` | supported |
| `reasoning.effort` | dynamically supported |
| `tools[].type=image_generation` | supported |

Unknown or unsupported behavior must fail explicitly rather than being ignored.

### 6.7 Error Shape

```json
{
  "error": {
    "message": "Requested model is not available",
    "type": "invalid_request_error",
    "code": "model_not_available"
  }
}
```

Important codes include:

- `invalid_request`
- `unsupported_parameter`
- `model_not_available`
- `reasoning_effort_not_available`
- `image_invalid`
- `extension_unavailable`
- `chatgpt_login_required`
- `chatgpt_adapter_error`

## 7. Extension Protocol

Every message has a protocol version and type.

```json
{
  "version": 1,
  "type": "worker.ready",
  "worker_id": "42",
  "capabilities": {
    "models": ["chatgpt/default"],
    "reasoning_efforts": []
  }
}
```

Daemon to extension:

- `extension.configure`
- `heartbeat`
- `job.start`
- `job.cancel`

Extension to daemon:

- `extension.hello`
- `heartbeat`
- `worker.ready`
- `worker.unhealthy`
- `capabilities.updated`
- `job.conversation_bound`
- `job.output_text.delta`
- `job.image.completed`
- `job.completed`
- `job.failed`

The protocol is intentionally small. It carries behavior, not duplicated page state.

## 8. Chrome Extension Design

### 8.1 Permissions

The manifest is limited to:

- `tabs`
- `storage`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

The daemon connection targets localhost directly from the extension service worker.

### 8.2 Service Worker

The background service worker owns:

- WebSocket reconnect
- heartbeat
- worker-tab creation
- worker navigation
- message routing between daemon and content scripts

The design assumes service-worker suspension. Reconnect and worker-ready messages reconstruct daemon-visible state.

### 8.3 ChatGPT Adapter

All unstable DOM selectors are isolated in one module. It owns:

- login detection
- model and effort discovery
- model and effort selection
- composer submission
- assistant delta extraction
- stop-button cancellation
- image upload
- generated-image extraction

No other module should directly depend on ChatGPT DOM structure.

## 9. Latency and Caching

The daemon adds no response cache. ChatGPT remains the only response producer.

Expected latency sources:

1. scheduler wait
2. worker navigation
3. model or effort selection
4. image resolution and upload
5. ChatGPT generation
6. DOM polling interval

The local daemon and WebSocket add negligible latency compared with web generation. Caching would change conversation semantics and is therefore intentionally excluded.

## 10. Security and Privacy

- Bind only to `127.0.0.1`.
- Require a generated Bearer token for `/v1/*`.
- Store the config with user-only file permissions.
- Never log prompts, responses, image bytes, cookies, or ChatGPT credentials by default.
- Never read or copy the user's normal browser profile.
- Never bypass CAPTCHA or platform controls.
- Never retry after an uncertain prompt submission.
- Keep images in memory and enforce a size limit before transfer.

## 11. Testing Strategy

### 11.1 Unit and Service Tests

Vitest covers request validation, response IDs, scheduling, WebSocket behavior, streaming order, image resolution, and deterministic ChatGPT DOM fixtures.

```sh
pnpm test
pnpm typecheck
```

### 11.2 Extension E2E

Playwright loads the real unpacked MV3 extension into an isolated Chromium profile. ChatGPT routes are replaced by deterministic fixture pages.

```sh
pnpm test:e2e:extension
pnpm test:e2e:extension-daemon
pnpm test:e2e:extension-responses
```

These tests prove extension loading and the complete client-to-DOM protocol without requiring an account. They do not prove compatibility with the current ChatGPT production DOM.

### 11.3 Real ChatGPT Smoke

```sh
pnpm test:smoke:chatgpt
```

The command launches the extension in a dedicated persistent Chromium profile. A tester signs in manually on the first run. The test must never copy cookies from another browser profile.

Required release smoke coverage:

- new text conversation
- streaming deltas
- continuation with `previous_response_id`
- visible model and reasoning effort selection
- image input and editing
- text-to-image generation
- two worker tabs on different conversations
- logged-out failure

Current status: the automated smoke harness exists, but a successful real logged-in run has not yet been recorded. Production compatibility must not be claimed until this passes.

## 12. Delivery

Development extension artifact:

```sh
pnpm pack:extension
```

This produces `dist/web2api-extension.zip`. Development users load the unpacked build through `chrome://extensions`. A production release should use the Chrome Web Store.

The npm package contains the daemon CLI and shared runtime code. npm cannot silently install a Chrome extension, so daemon installation and extension installation remain explicit separate steps.

## 13. Main Risks

| Risk | Level | Mitigation |
| --- | --- | --- |
| Platform terms and account actions | High | No bypasses, no official-API claims, explicit review before release |
| ChatGPT DOM changes | High | One adapter, fixture tests, mandatory real smoke |
| Generated-image DOM changes | High | Release smoke and explicit adapter failure |
| Account-specific model menus | Medium | Dynamic discovery and strict mapping |
| MV3 service-worker suspension | Medium | Heartbeat, reconnect, state reconstruction |
| Background-tab throttling | Medium | Dedicated workers and real smoke measurement |
| CAPTCHA or risk control | Medium | Stop and expose the page to the user |

## 14. References

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [Chrome Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome WebSocket in extension service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome extension message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Playwright Chrome extensions](https://playwright.dev/docs/chrome-extensions)
- [npm global packages](https://docs.npmjs.com/downloading-and-installing-packages-globally/)
- [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
