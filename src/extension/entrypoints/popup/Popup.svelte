<script lang="ts">
  import { Check, Copy, Eye, EyeOff, Play, RefreshCw, Save, Square } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { browser } from "wxt/browser";
  import type { PopupRequest, PopupStatus } from "../../lib/popup-protocol";

  let status: PopupStatus | undefined = $state(undefined);
  let chatGptTabs: number = $state(2);
  let geminiTabs: number = $state(2);
  let grokTabs: number = $state(2);
  let apiKeyVisible: boolean = $state(false);
  let busy: boolean = $state(false);
  let copiedField: "command" | "url" | "key" | undefined = $state(undefined);

  onMount((): (() => void) => {
    void loadStatus();
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      if (!busy) {
        void loadStatus();
      }
    }, 1_000);
    return (): void => clearInterval(timer);
  });

  async function loadStatus(): Promise<void> {
    const nextStatus: PopupStatus = await send({ type: "web2api:popup", action: "status" });
    status = nextStatus;
    if (nextStatus.providers.chatgpt.tabs !== undefined) {
      chatGptTabs = nextStatus.providers.chatgpt.tabs;
    }
    if (nextStatus.providers.gemini.tabs !== undefined) {
      geminiTabs = nextStatus.providers.gemini.tabs;
    }
    if (nextStatus.providers.grok.tabs !== undefined) {
      grokTabs = nextStatus.providers.grok.tabs;
    }
  }

  async function runAction(request: PopupRequest): Promise<void> {
    busy = true;
    try {
      status = await send(request);
      if (status.providers.chatgpt.tabs !== undefined) {
        chatGptTabs = status.providers.chatgpt.tabs;
      }
      if (status.providers.gemini.tabs !== undefined) {
        geminiTabs = status.providers.gemini.tabs;
      }
      if (status.providers.grok.tabs !== undefined) {
        grokTabs = status.providers.grok.tabs;
      }
    } finally {
      busy = false;
    }
  }

  async function send(request: PopupRequest): Promise<PopupStatus> {
    return await browser.runtime.sendMessage(request) as PopupStatus;
  }

  async function copy(field: "command" | "url" | "key", value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout((): void => {
      if (copiedField === field) {
        copiedField = undefined;
      }
    }, 1_500);
  }
</script>

<svelte:head>
  <title>Web2API</title>
</svelte:head>

<main>
  <header>
    <div>
      <h1>Web2API</h1>
      <p class="subtitle">Browser AI local API</p>
    </div>
    {#if status?.nativeHostInstalled}
      <span class:online={status.daemonConnected} class="status-dot" title={status.daemonConnected ? "Connected" : "Disconnected"}></span>
    {/if}
  </header>

  {#if status === undefined}
    <p class="loading">Checking local companion...</p>
  {:else if !status.nativeHostInstalled}
    <section class="install">
      <h2>Local companion required</h2>
      <p>Run once in Terminal, then check again.</p>
      <div class="command-row">
        <code>{status.installCommand}</code>
        <button class="icon-button" title="Copy command" aria-label="Copy command" onclick={() => void copy("command", status.installCommand)}>
          {#if copiedField === "command"}<Check size={16} />{:else}<Copy size={16} />{/if}
        </button>
      </div>
      <button class="primary" disabled={busy} onclick={() => void runAction({ type: "web2api:popup", action: "start" })}>
        <RefreshCw size={15} />
        Check again
      </button>
    </section>
  {:else}
    <section>
      <div class="section-heading">
        <div>
          <h2>Companion</h2>
          <p>{status.daemonConnected ? "Connected" : status.daemonRunning ? "Starting" : "Stopped"}</p>
        </div>
        <div class="actions">
          {#if status.daemonRunning}
            <button class="icon-button" title="Stop" aria-label="Stop" disabled={busy} onclick={() => void runAction({ type: "web2api:popup", action: "stop" })}>
              <Square size={15} />
            </button>
          {:else}
            <button class="icon-button" title="Start" aria-label="Start" disabled={busy} onclick={() => void runAction({ type: "web2api:popup", action: "start" })}>
              <Play size={16} />
            </button>
          {/if}
          <button class="icon-button" title="Restart" aria-label="Restart" disabled={busy} onclick={() => void runAction({ type: "web2api:popup", action: "restart" })}>
            <RefreshCw size={16} class={busy ? "spinning" : ""} />
          </button>
        </div>
      </div>
    </section>

    <section>
      <label for="base-url">Base URL</label>
      <div class="field-row">
        <input id="base-url" readonly value={status.baseUrl ?? ""} />
        <button class="icon-button" title="Copy Base URL" aria-label="Copy Base URL" onclick={() => void copy("url", status.baseUrl ?? "")}>
          {#if copiedField === "url"}<Check size={16} />{:else}<Copy size={16} />{/if}
        </button>
      </div>

      <label for="api-key">API key</label>
      <div class="field-row">
        <input id="api-key" readonly type={apiKeyVisible ? "text" : "password"} value={status.apiKey ?? ""} />
        <button class="icon-button" title={apiKeyVisible ? "Hide API key" : "Show API key"} aria-label={apiKeyVisible ? "Hide API key" : "Show API key"} onclick={() => apiKeyVisible = !apiKeyVisible}>
          {#if apiKeyVisible}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
        </button>
        <button class="icon-button" title="Copy API key" aria-label="Copy API key" onclick={() => void copy("key", status.apiKey ?? "")}>
          {#if copiedField === "key"}<Check size={16} />{:else}<Copy size={16} />{/if}
        </button>
      </div>
    </section>

    <section>
      <div class="section-heading tabs-heading">
        <div>
          <label for="chatgpt-tabs">ChatGPT tabs</label>
          <p>Worker: {status.providers.chatgpt.workerReady ? "Ready" : "Unavailable"}</p>
        </div>
        <div class="number-control">
          <input id="chatgpt-tabs" type="number" min="1" max="8" bind:value={chatGptTabs} />
        </div>
      </div>
      <div class="section-heading tabs-heading">
        <div>
          <label for="gemini-tabs">Gemini tabs</label>
          <p>Worker: {status.providers.gemini.workerReady ? "Ready" : "Unavailable"}</p>
        </div>
        <div class="number-control">
          <input id="gemini-tabs" type="number" min="1" max="8" bind:value={geminiTabs} />
        </div>
      </div>
      <div class="section-heading tabs-heading">
        <div>
          <label for="grok-tabs">Grok tabs</label>
          <p>Worker: {status.providers.grok.workerReady ? "Ready" : "Unavailable"}</p>
        </div>
        <div class="number-control">
          <input id="grok-tabs" type="number" min="1" max="8" bind:value={grokTabs} />
          <button class="icon-button" title="Save and restart" aria-label="Save and restart" disabled={busy || chatGptTabs < 1 || chatGptTabs > 8 || geminiTabs < 1 || geminiTabs > 8 || grokTabs < 1 || grokTabs > 8} onclick={() => void runAction({ type: "web2api:popup", action: "configure", chatGptTabs, geminiTabs, grokTabs })}>
            <Save size={16} />
          </button>
        </div>
      </div>
    </section>
  {/if}

  {#if status !== undefined}
    <section class="diagnostics" aria-label="ChatGPT status">
      <h2>ChatGPT</h2>
      <p>Session {status.providers.chatgpt.loggedIn === undefined ? "Checking" : status.providers.chatgpt.loggedIn ? "Logged in" : "Sign-in required"}</p>
      <p>Content script {status.providers.chatgpt.contentScriptReady ? "Ready" : "Unavailable"}</p>
      <p>Worker {status.providers.chatgpt.workerReady ? "Ready" : "Unavailable"}</p>
      <p>Models {status.providers.chatgpt.models.length === 0 ? "Unavailable" : status.providers.chatgpt.models.join(", ")}</p>
      <p>Reasoning {status.providers.chatgpt.reasoningEfforts.length === 0 ? "Unavailable" : status.providers.chatgpt.reasoningEfforts.join(", ")}</p>
    </section>
    <section class="diagnostics" aria-label="Gemini status">
      <h2>Gemini</h2>
      <p>Session {status.providers.gemini.loggedIn === undefined ? "Checking" : status.providers.gemini.loggedIn ? "Logged in" : "Sign-in required"}</p>
      <p>Content script {status.providers.gemini.contentScriptReady ? "Ready" : "Unavailable"}</p>
      <p>Worker {status.providers.gemini.workerReady ? "Ready" : "Unavailable"}</p>
      <p>Models {status.providers.gemini.models.length === 0 ? "Unavailable" : status.providers.gemini.models.join(", ")}</p>
      <p>Reasoning {status.providers.gemini.reasoningEfforts.length === 0 ? "Unavailable" : status.providers.gemini.reasoningEfforts.join(", ")}</p>
    </section>
    <section class="diagnostics" aria-label="Grok status">
      <h2>Grok</h2>
      <p>Session {status.providers.grok.loggedIn === undefined ? "Checking" : status.providers.grok.loggedIn ? "Logged in" : "Sign-in required"}</p>
      <p>Content script {status.providers.grok.contentScriptReady ? "Ready" : "Unavailable"}</p>
      <p>Worker {status.providers.grok.workerReady ? "Ready" : "Unavailable"}</p>
      <p>Models {status.providers.grok.models.length === 0 ? "Unavailable" : status.providers.grok.models.join(", ")}</p>
      <p>Reasoning {status.providers.grok.reasoningEfforts.length === 0 ? "Unavailable" : status.providers.grok.reasoningEfforts.join(", ")}</p>
    </section>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    background: #ffffff;
    color: #18181b;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
  }

  :global(button),
  :global(input) {
    font: inherit;
  }

  main {
    width: 350px;
  }

  header {
    display: flex;
    min-height: 64px;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #e4e4e7;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 16px;
    font-weight: 680;
  }

  h2 {
    font-size: 14px;
    font-weight: 650;
  }

  .subtitle,
  .section-heading p,
  .install > p,
  .diagnostics p,
  .loading {
    margin-top: 3px;
    color: #71717a;
    font-size: 12px;
    line-height: 1.45;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #a1a1aa;
  }

  .status-dot.online {
    background: #16a34a;
  }

  section {
    padding: 14px 16px;
    border-bottom: 1px solid #e4e4e7;
  }

  section:last-child {
    border-bottom: 0;
  }

  .loading {
    padding: 18px 16px;
  }

  .command-row,
  .field-row,
  .section-heading,
  .actions,
  .number-control {
    display: flex;
    align-items: center;
  }

  .command-row {
    align-items: stretch;
    margin: 12px 0;
    border: 1px solid #d4d4d8;
    border-radius: 6px;
    background: #f4f4f5;
  }

  code {
    flex: 1;
    min-width: 0;
    padding: 9px 10px;
    overflow-wrap: anywhere;
    color: #27272a;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 11px;
    line-height: 1.5;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #d4d4d8;
    border-radius: 6px;
    background: #ffffff;
    color: #27272a;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: #a1a1aa;
    background: #f4f4f5;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .icon-button {
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    padding: 0;
  }

  .command-row .icon-button {
    height: auto;
    border-width: 0 0 0 1px;
    border-radius: 0;
    background: transparent;
  }

  .primary {
    min-height: 34px;
    gap: 7px;
    padding: 0 12px;
    border-color: #18181b;
    background: #18181b;
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
  }

  .primary:hover:not(:disabled) {
    border-color: #3f3f46;
    background: #3f3f46;
  }

  .section-heading {
    justify-content: space-between;
    gap: 12px;
  }

  .actions,
  .number-control {
    gap: 6px;
  }

  label {
    display: block;
    margin: 0 0 6px;
    color: #52525b;
    font-size: 11px;
    font-weight: 600;
  }

  .field-row {
    gap: 6px;
    margin-bottom: 12px;
  }

  .field-row:last-child {
    margin-bottom: 0;
  }

  input {
    min-width: 0;
    height: 32px;
    flex: 1;
    padding: 0 9px;
    border: 1px solid #d4d4d8;
    border-radius: 6px;
    outline: none;
    background: #fafafa;
    color: #27272a;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 11px;
  }

  input:focus {
    border-color: #71717a;
  }

  .tabs-heading label {
    margin-bottom: 0;
  }

  .number-control input {
    width: 58px;
    flex: none;
  }

  :global(.spinning) {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
