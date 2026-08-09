import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { Capabilities, ExtensionHelloMessage, HeartbeatMessage, WorkerReadyMessage, WorkerUnhealthyMessage, DaemonToExtensionMessage, ExtensionToDaemonMessage, JobStartMessage, Provider } from "../../shared/protocol";
import type { NativeHostRequest, NativeHostResponse, NativeHostStatus } from "../../shared/native-protocol";
import type { PopupProviderStatus, PopupRequest, PopupStatus } from "../lib/popup-protocol";

type ContentReadyMessage = {
  type: "web2api:content-ready";
  provider: Provider;
  url: string;
  loggedIn: boolean;
  capabilities?: Capabilities;
};

type ProviderUiState = {
  contentScriptReady: boolean;
  loggedIn: boolean | undefined;
  capabilities: Capabilities;
};

const nativeHostName: string = "dev.glidea.web2api";
let nativeHostInstalled: boolean = false;
let nativeHostError: string | undefined;
let daemonRunning: boolean = false;
let daemonConnected: boolean = false;
let daemonBaseUrl: string = "http://127.0.0.1:3210";
let apiKey: string | undefined;
let configuredChatGptTabs: number = 0;
let configuredGeminiTabs: number = 0;
let shouldReconnect: boolean = true;
const providerUiStates: Record<Provider, ProviderUiState> = {
  chatgpt: { contentScriptReady: false, loggedIn: undefined, capabilities: { models: [], reasoning_efforts: [] } },
  gemini: { contentScriptReady: false, loggedIn: undefined, capabilities: { models: [], reasoning_efforts: [] } }
};
const workerTabs: Map<string, number> = new Map<string, number>();
const readyWorkers: Set<string> = new Set<string>();
const workerCapabilities: Map<string, Capabilities> = new Map<string, Capabilities>();
const pendingWorkerJobs: Map<string, JobStartMessage> = new Map<string, JobStartMessage>();
let websocket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

export default defineBackground((): void => {
  void initializeDaemon();
  browser.tabs.onRemoved.addListener((tabId: number): void => {
    let removedProvider: Provider | undefined;
    for (const [workerId, workerTabId] of workerTabs.entries()) {
      if (workerTabId === tabId) {
        removedProvider = providerFromWorkerId(workerId);
        workerTabs.delete(workerId);
        readyWorkers.delete(workerId);
        workerCapabilities.delete(workerId);
        sendWorkerUnhealthy(workerId, "worker_tab_closed");
      }
    }
    if (removedProvider !== undefined && shouldReconnect) {
      void ensureWorkerTabs(removedProvider, configuredTabCount(removedProvider));
    }
  });
  browser.runtime.onMessage.addListener((message: unknown, sender): Promise<PopupStatus | undefined> => {
    if (isJobEvent(message)) {
      sendToDaemon(message);
      return Promise.resolve(undefined);
    }
    if (isContentReadyMessage(message)) {
      return handleContentReady(message, sender.tab?.id);
    }
    if (isPopupRequest(message)) {
      return handlePopupRequest(message);
    }
    return Promise.resolve(undefined);
  });
});

async function initializeDaemon(): Promise<void> {
  try {
    const response: NativeHostStatus = await sendNativeControl({ type: "ensure", protocol_version: 1 });
    applyNativeStatus(response);
  } catch {
    daemonBaseUrl = "http://127.0.0.1:3210";
  }
  await connectToDaemon();
}

async function handlePopupRequest(request: PopupRequest): Promise<PopupStatus> {
  switch (request.action) {
    case "status":
      return popupStatus();
    case "start": {
      shouldReconnect = true;
      try {
        const response: NativeHostStatus = await sendNativeControl({ type: "ensure", protocol_version: 1 });
        applyNativeStatus(response);
        await connectToDaemon();
      } catch {
        await connectToDaemon();
      }
      return popupStatus();
    }
    case "stop": {
      shouldReconnect = false;
      if (nativeHostInstalled) {
        const response: NativeHostStatus = await sendNativeControl({ type: "stop", protocol_version: 1 });
        applyNativeStatus(response);
      }
      disconnectFromDaemon();
      await closeWorkerTabs();
      return popupStatus();
    }
    case "restart": {
      shouldReconnect = false;
      if (nativeHostInstalled) {
        await sendNativeControl({ type: "stop", protocol_version: 1 });
      }
      disconnectFromDaemon();
      shouldReconnect = true;
      const response: NativeHostStatus = await sendNativeControl({ type: "ensure", protocol_version: 1 });
      applyNativeStatus(response);
      await connectToDaemon();
      return popupStatus();
    }
    case "configure": {
      shouldReconnect = true;
      const response: NativeHostStatus = await sendNativeControl({ type: "configure", protocol_version: 1, chatgpt_tabs: request.chatGptTabs, gemini_tabs: request.geminiTabs });
      applyNativeStatus(response);
      disconnectFromDaemon();
      await connectToDaemon();
      return popupStatus();
    }
  }
}

async function sendNativeControl(request: NativeHostRequest): Promise<NativeHostStatus> {
  let value: unknown;
  try {
    value = await browser.runtime.sendNativeMessage(nativeHostName, request);
  } catch (error: unknown) {
    nativeHostInstalled = false;
    nativeHostError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  nativeHostInstalled = true;
  if (!isNativeHostResponse(value)) {
    nativeHostError = "Native host returned an invalid response";
    throw new Error(nativeHostError);
  }
  if (!value.ok) {
    nativeHostError = value.message;
    throw new Error(value.message);
  }
  nativeHostError = undefined;
  return value;
}

function applyNativeStatus(status: NativeHostStatus): void {
  daemonRunning = status.daemon === "running";
  daemonBaseUrl = status.base_url;
  apiKey = status.api_key;
  configuredChatGptTabs = status.chatgpt_tabs;
  configuredGeminiTabs = status.gemini_tabs;
}

function popupStatus(): PopupStatus {
  return {
    nativeHostInstalled,
    nativeHostError,
    daemonRunning,
    daemonConnected,
    baseUrl: nativeHostInstalled ? `${daemonBaseUrl}/v1` : undefined,
    apiKey,
    providers: {
      chatgpt: providerPopupStatus("chatgpt", nativeHostInstalled ? configuredChatGptTabs : undefined),
      gemini: providerPopupStatus("gemini", nativeHostInstalled ? configuredGeminiTabs : undefined)
    },
    installCommand: `npx -y glidea-web2api@latest install --extension-id ${browser.runtime.id}`
  };
}

function providerPopupStatus(provider: Provider, tabs: number | undefined): PopupProviderStatus {
  const state: ProviderUiState = providerUiStates[provider];
  const models: Set<string> = new Set<string>(state.capabilities.models);
  const reasoningEfforts: Set<string> = new Set<string>(state.capabilities.reasoning_efforts);
  let workerReady: boolean = false;
  for (const [workerId, capabilities] of workerCapabilities.entries()) {
    if (providerFromWorkerId(workerId) !== provider) {
      continue;
    }
    workerReady = workerReady || readyWorkers.has(workerId);
    for (const model of capabilities.models) {
      models.add(model);
    }
    for (const effort of capabilities.reasoning_efforts) {
      reasoningEfforts.add(effort);
    }
  }
  return {
    contentScriptReady: state.contentScriptReady,
    workerReady,
    loggedIn: state.loggedIn,
    models: Array.from(models),
    reasoningEfforts: Array.from(reasoningEfforts),
    tabs
  };
}

async function connectToDaemon(): Promise<void> {
  if (!shouldReconnect || websocket !== undefined) {
    return;
  }
  const socketUrl: URL = new URL(daemonBaseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.pathname = "/extension";
  const socket: WebSocket = new WebSocket(socketUrl.toString());
  websocket = socket;
  socket.addEventListener("open", (): void => {
    daemonRunning = true;
    daemonConnected = true;
    const hello: ExtensionHelloMessage = { version: 1, type: "extension.hello", extension_version: "0.1.0", chrome_version: navigator.userAgent };
    socket.send(JSON.stringify(hello));
    for (const workerId of readyWorkers) {
      sendWorkerReady(workerId);
    }
    heartbeatTimer = setInterval((): void => {
      const heartbeat: HeartbeatMessage = { version: 1, type: "heartbeat", timestamp: Date.now() };
      socket.send(JSON.stringify(heartbeat));
    }, 20_000);
  });
  socket.addEventListener("message", (event: MessageEvent<string>): void => {
    const message: DaemonToExtensionMessage = JSON.parse(event.data) as DaemonToExtensionMessage;
    switch (message.type) {
      case "extension.configure":
        configuredChatGptTabs = message.chatgpt_tabs;
        configuredGeminiTabs = message.gemini_tabs;
        void synchronizeWorkerTabs();
        break;
      case "job.start":
        void dispatchJob(message);
        break;
      case "job.cancel": {
        const workerTabId: number | undefined = workerTabs.get(message.worker_id);
        if (workerTabId !== undefined) {
          void browser.tabs.sendMessage(workerTabId, message);
        }
        break;
      }
    }
  });
  socket.addEventListener("close", (): void => {
    daemonConnected = false;
    websocket = undefined;
    clearHeartbeat();
    if (shouldReconnect) {
      reconnectTimer = setTimeout((): void => {
        reconnectTimer = undefined;
        void recoverDaemon();
      }, 1_000);
    }
  });
  socket.addEventListener("error", (): void => {
    socket.close();
  });
}

async function recoverDaemon(): Promise<void> {
  if (nativeHostInstalled) {
    try {
      const status: NativeHostStatus = await sendNativeControl({ type: "ensure", protocol_version: 1 });
      applyNativeStatus(status);
    } catch {
      daemonRunning = false;
    }
  }
  await connectToDaemon();
}

function disconnectFromDaemon(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  clearHeartbeat();
  websocket?.close();
  websocket = undefined;
  daemonConnected = false;
}

function clearHeartbeat(): void {
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

async function handleContentReady(message: ContentReadyMessage, tabId: number | undefined): Promise<undefined> {
  const providerState: ProviderUiState = providerUiStates[message.provider];
  providerState.contentScriptReady = true;
  providerState.loggedIn = message.loggedIn;
  if (message.capabilities !== undefined) {
    providerState.capabilities = message.capabilities;
  }
  const workerId: string | undefined = findWorkerId(tabId);
  if (workerId === undefined || providerFromWorkerId(workerId) !== message.provider) {
    return undefined;
  }
  if (message.capabilities !== undefined) {
    workerCapabilities.set(workerId, message.capabilities);
  }
  const pendingJob: JobStartMessage | undefined = pendingWorkerJobs.get(workerId);
  if (pendingJob !== undefined && tabId !== undefined) {
    pendingWorkerJobs.delete(workerId);
    await browser.tabs.sendMessage(tabId, pendingJob);
    return undefined;
  }
  readyWorkers.add(workerId);
  sendWorkerReady(workerId);
  return undefined;
}

async function dispatchJob(message: JobStartMessage): Promise<void> {
  const workerTabId: number | undefined = workerTabs.get(message.worker_id);
  if (workerTabId === undefined || providerFromWorkerId(message.worker_id) !== message.provider) {
    return;
  }
  const targetUrl: string = conversationUrl(message.provider, message.payload.conversation_id);
  const tab: { url?: string } = await browser.tabs.get(workerTabId);
  if (tab.url !== undefined && sameChatPage(tab.url, targetUrl)) {
    await browser.tabs.sendMessage(workerTabId, message);
    return;
  }
  pendingWorkerJobs.set(message.worker_id, message);
  readyWorkers.delete(message.worker_id);
  await browser.tabs.update(workerTabId, { url: targetUrl });
}

function sameChatPage(currentUrl: string, targetUrl: string): boolean {
  const current: URL = new URL(currentUrl);
  const target: URL = new URL(targetUrl);
  return current.origin === target.origin && current.pathname === target.pathname;
}

async function synchronizeWorkerTabs(): Promise<void> {
  await ensureWorkerTabs("chatgpt", configuredChatGptTabs);
  await ensureWorkerTabs("gemini", configuredGeminiTabs);
}

async function ensureWorkerTabs(provider: Provider, tabCount: number): Promise<void> {
  for (const [workerId, tabId] of workerTabs.entries()) {
    const workerProvider: Provider | undefined = providerFromWorkerId(workerId);
    const index: number = workerIndex(workerId);
    if (workerProvider === provider && index > tabCount) {
      workerTabs.delete(workerId);
      readyWorkers.delete(workerId);
      workerCapabilities.delete(workerId);
      await browser.tabs.remove(tabId);
    }
  }
  for (let index: number = 1; index <= tabCount; index += 1) {
    const workerId: string = `${provider}-worker-${index}`;
    if (workerTabs.has(workerId)) {
      continue;
    }
    const createdTab: unknown = await browser.tabs.create({ url: providerHomeUrl(provider), active: false });
    if (typeof createdTab !== "object" || createdTab === null) {
      throw new Error("worker tab has no id");
    }
    const tabRecord: Record<string, unknown> = createdTab as Record<string, unknown>;
    if (typeof tabRecord["id"] !== "number") {
      throw new Error("worker tab has no id");
    }
    workerTabs.set(workerId, tabRecord["id"]);
  }
}

async function closeWorkerTabs(): Promise<void> {
  const tabIds: number[] = Array.from(workerTabs.values());
  workerTabs.clear();
  readyWorkers.clear();
  workerCapabilities.clear();
  pendingWorkerJobs.clear();
  if (tabIds.length > 0) {
    await browser.tabs.remove(tabIds);
  }
}

function sendWorkerReady(workerId: string): void {
  const provider: Provider | undefined = providerFromWorkerId(workerId);
  if (provider === undefined) {
    return;
  }
  const message: WorkerReadyMessage = {
    version: 1,
    type: "worker.ready",
    provider,
    worker_id: workerId,
    capabilities: workerCapabilities.get(workerId) ?? { models: [`${provider}/default`], reasoning_efforts: [] }
  };
  sendToDaemon(message);
}

function sendWorkerUnhealthy(workerId: string, code: string): void {
  const message: WorkerUnhealthyMessage = { version: 1, type: "worker.unhealthy", worker_id: workerId, code };
  sendToDaemon(message);
}

function findWorkerId(tabId: number | undefined): string | undefined {
  if (tabId === undefined) {
    return undefined;
  }
  for (const [workerId, workerTabId] of workerTabs.entries()) {
    if (workerTabId === tabId) {
      return workerId;
    }
  }
  return undefined;
}

function providerFromWorkerId(workerId: string): Provider | undefined {
  if (workerId.startsWith("chatgpt-worker-")) {
    return "chatgpt";
  }
  if (workerId.startsWith("gemini-worker-")) {
    return "gemini";
  }
  return undefined;
}

function workerIndex(workerId: string): number {
  const separator: number = workerId.lastIndexOf("-");
  return Number(workerId.slice(separator + 1));
}

function configuredTabCount(provider: Provider): number {
  switch (provider) {
    case "chatgpt":
      return configuredChatGptTabs;
    case "gemini":
      return configuredGeminiTabs;
  }
}

function providerHomeUrl(provider: Provider): string {
  switch (provider) {
    case "chatgpt":
      return "https://chatgpt.com/";
    case "gemini":
      return "https://gemini.google.com/app";
  }
}

function conversationUrl(provider: Provider, conversationId: string | undefined): string {
  if (conversationId === undefined) {
    return providerHomeUrl(provider);
  }
  switch (provider) {
    case "chatgpt":
      return `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
    case "gemini":
      return `https://gemini.google.com/app/${encodeURIComponent(conversationId)}`;
  }
}

function sendToDaemon(message: ExtensionHelloMessage | HeartbeatMessage | WorkerReadyMessage | WorkerUnhealthyMessage | ExtensionToDaemonMessage): void {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
  }
}

function isJobEvent(message: unknown): message is ExtensionToDaemonMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  const type: unknown = value["type"];
  return type === "job.conversation_bound" || type === "job.output_text.delta" || type === "job.image.completed" || type === "job.completed" || type === "job.failed";
}

function isContentReadyMessage(message: unknown): message is ContentReadyMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "web2api:content-ready"
    && (value["provider"] === "chatgpt" || value["provider"] === "gemini")
    && typeof value["url"] === "string"
    && typeof value["loggedIn"] === "boolean";
}

function isPopupRequest(message: unknown): message is PopupRequest {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  if (value["type"] !== "web2api:popup") {
    return false;
  }
  switch (value["action"]) {
    case "status":
    case "start":
    case "stop":
    case "restart":
      return true;
    case "configure":
      return typeof value["chatGptTabs"] === "number" && typeof value["geminiTabs"] === "number";
    default:
      return false;
  }
}

function isNativeHostResponse(value: unknown): value is NativeHostResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return typeof record["ok"] === "boolean" && record["protocol_version"] === 1;
}
