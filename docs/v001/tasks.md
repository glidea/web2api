# web2api v001 Tasks

Every completed task must be verified and committed before the next task starts.

## Task-001: WXT Extension and Extension E2E Skeleton

Build the WXT, Manifest V3, TypeScript, Svelte, Vitest, and Playwright foundation. The Playwright fixture must load the unpacked extension and verify the service worker, content script, and popup.

Out of scope:

- ChatGPT DOM operations
- daemon integration
- Responses API

Checklist:

- [x] Set up pnpm, WXT, TypeScript, Vitest, and Playwright
- [x] Add background, content script, and popup entry points
- [x] Add a persistent Playwright extension fixture
- [x] Route `chatgpt.com` to a local fixture page

Acceptance:

1. Run `pnpm test:e2e:extension`.
2. Confirm that the MV3 extension is built and loaded.
3. Confirm the popup, service worker, and ChatGPT-only content-script injection.

## Task-002: ChatGPT DOM Adapter Hard Points

Implement one ChatGPT adapter and verify its five hard points with deterministic fixtures. Real-page smoke testing is separate and must use a dedicated logged-in Chromium profile.

Checklist:

- [x] Read assistant text incrementally and detect completion
- [x] Parse the conversation ID
- [x] Upload images with `File` and `DataTransfer`
- [x] Discover and select models and reasoning effort
- [x] Extract final generated-image bytes
- [ ] Record a successful real-page smoke result and failure evidence

Acceptance:

1. Run `pnpm test` and confirm all adapter tests pass.
2. Run `pnpm test:smoke:chatgpt` in a dedicated profile.
3. Do not mark the real smoke item complete until text, continuation, model selection, image input, and image generation all pass.

Current status: the smoke command is implemented, but the real ChatGPT run is still pending a manual login in its dedicated Chromium profile. It never reads the user's daily Chrome profile.

## Task-003: Node.js Daemon CLI and Health Check

Provide a Node.js and TypeScript daemon that starts with `npx web2api start`. The first start creates a configuration file and API key. The daemon exposes authentication, `/healthz`, and clear terminal status.

Checklist:

- [x] Write CLI and HTTP E2E tests first
- [x] Create and persist the config and API key
- [x] Implement `GET /healthz` and Bearer authentication
- [x] Print the base URL, API key, and extension state

Acceptance:

1. Start with an empty config directory.
2. Confirm `/healthz` reports `daemon_ready` and `extension_disconnected`.
3. Restart and confirm the same API key is reused.
4. Occupy the port and confirm startup fails clearly without choosing another port.

## Task-004: Daemon-Extension Gateway and Worker Lifecycle

Implement the local WebSocket gateway, heartbeat, typed messages, and one extension-owned ChatGPT worker tab. The extension reports ready, unhealthy, and closed states to the daemon.

Checklist:

- [x] Write handshake, heartbeat, and disconnect E2E tests first
- [x] Define the shared WebSocket protocol
- [x] Implement the daemon gateway
- [x] Implement service-worker connection and worker-tab lifecycle
- [x] Show daemon, worker, and content-script status in the popup

Acceptance:

1. Run `pnpm test:e2e:extension-daemon`.
2. Confirm `/healthz` changes from disconnected to connected with ready workers.
3. Close a worker tab and confirm the lifecycle reports the failure and restores capacity when possible.

## Task-005: Non-Streaming Responses Loop

Connect a local `POST /v1/responses` request to one ChatGPT worker and return a non-streaming Responses-compatible JSON result. The default model is `chatgpt/default`.

Checklist:

- [x] Write daemon-to-fake-extension E2E coverage first
- [x] Implement request parsing and standard errors
- [x] Implement one-worker task execution
- [x] Submit text, read final text, and bind the conversation
- [x] Project the final Responses JSON

Acceptance:

1. Point an OpenAI-compatible client at `http://127.0.0.1:3210/v1`.
2. Send a `chatgpt/default` request.
3. Confirm a valid `response.id` and final text.
4. Confirm logged-out workers return `503 chatgpt_login_required`.

## Task-006: Streaming Text and Client Cancellation

Project the internal event stream as typed Responses SSE. When the client disconnects, send `job.cancel`, click the page stop button, and release the worker.

Checklist:

- [x] Write SSE ordering and disconnect-cancellation E2E tests first
- [x] Extract non-rollback assistant deltas
- [x] Emit the Responses SSE lifecycle
- [x] Cancel page generation after HTTP disconnect

Acceptance:

1. Send a request with `stream: true`.
2. Confirm event order and that concatenated deltas equal the final text.
3. Disconnect midway and confirm the worker returns to ready.

## Task-007: Conversation Continuation and Configurable Concurrency

Use encoded response IDs, `previous_response_id`, a FIFO scheduler, conversation locks, and a fixed worker pool. The default pool has two tabs. Different conversations may run in parallel; one conversation is serialized.

Checklist:

- [x] Write continuation, same-conversation serialization, and cross-conversation parallelism E2E tests first
- [x] Encode and decode response IDs
- [x] Implement the scheduler, locks, and worker leases
- [x] Navigate and rebind the fixed extension tab pool
- [x] Support `max_tabs`

Acceptance:

1. Continue a conversation with the first `response.id`.
2. Submit A1, A2, and B1 concurrently. A2 must wait for A1 while B1 can run in parallel.
3. Close a busy tab and confirm the active task fails without replaying it on another tab.

## Task-008: Dynamic Models and Reasoning Effort

Scan the models and reasoning effort visible to the current account. Expose them through `/v1/models`. Explicitly unavailable values must fail before prompt submission.

Checklist:

- [x] Write capability-update and strict-mapping tests first
- [x] Scan the live model and effort menus
- [x] Emit `capabilities.updated` and expose `/v1/models`
- [x] Select the requested model and effort before submission

Acceptance:

1. Confirm `/v1/models` includes `chatgpt/default` and visible models.
2. Select an available model and effort and confirm the page changes before sending.
3. Request an unavailable value and confirm `400` with no new ChatGPT message.

## Task-009: Image Input, Editing, and Generation

Support HTTP URLs and base64 data URLs, ordered multi-image uploads, text-to-image generation, image editing, and final base64 output through the ChatGPT page controls.

Checklist:

- [x] Write URL, data URL, multi-image, and generation E2E tests first
- [x] Implement the daemon image resolver
- [x] Transfer images over WebSocket and acknowledge attachment readiness
- [x] Submit image-editing and generation requests
- [x] Extract final image bytes and project `image_generation_call.result`

Acceptance:

1. Edit an image from a data URL and an HTTP URL and decode both results.
2. Upload two images and confirm order is preserved.
3. Generate an image from text and confirm the final base64 result.
4. Oversized or invalid images must fail before prompt submission.

## Task-010: npm Distribution and Release Acceptance

Package the daemon as an npm CLI and connect the extension artifact, configuration instructions, and real-page smoke command into a release check. Background-service installation and Node SEA remain follow-up evaluations.

Checklist:

- [x] Verify `npx web2api start` from a packed npm tarball
- [x] Build the Chrome extension zip and validate manifest permissions
- [x] Show connection and worker diagnostics in the popup
- [ ] Show explicit login and model diagnostics in the popup
- [x] Add a release-time real ChatGPT smoke command
- [x] Record the service-installation and Node SEA follow-up decisions

Acceptance:

1. Install the local tarball from outside the source tree and start the daemon.
2. Load the extension zip and run text, continuation, concurrency, model, and image checks.
3. Confirm default logs contain no prompts, responses, images, API keys, or ChatGPT credentials.
