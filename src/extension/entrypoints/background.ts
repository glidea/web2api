import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { Capabilities, ExtensionHelloMessage, HeartbeatMessage, WorkerReadyMessage, WorkerUnhealthyMessage, DaemonToExtensionMessage, ExtensionToDaemonMessage, JobStartMessage } from "../../shared/protocol";
import type { NativeHostRequest, NativeHostResponse, NativeHostStatus } from "../../shared/native-protocol";
import type { PopupRequest, PopupStatus } from "../lib/popup-protocol";

type ContentReadyMessage = {
  type: "web2api:content-ready";
  url: string;
  capabilities?: Capabilities;
};

const nativeHostName: string = "dev.glidea.web2api";
let nativeHostInstalled: boolean = false;
let nativeHostError: string | undefined;
let daemonRunning: boolean = false;
let daemonConnected: boolean = false;
let daemonBaseUrl: string = "http://127.0.0.1:3210";
let apiKey: string | undefined;
let configuredMaxTabs: number = 0;
let shouldReconnect: boolean = true;
let contentScriptReady: boolean = false;
let workerReady: boolean = false;
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
    for (const [workerId, workerTabId] of workerTabs.entries()) {
      if (workerTabId === tabId) {
        workerTabs.delete(workerId);
        readyWorkers.delete(workerId);
        workerCapabilities.delete(workerId);
        sendWorkerUnhealthy(workerId, "worker_tab_closed");
      }
    }
    workerReady = readyWorkers.size > 0;
    if (configuredMaxTabs > 0 && shouldReconnect) {
      void ensureWorkerTabs(configuredMaxTabs);
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
      const response: NativeHostStatus = await sendNativeControl({ type: "configure", protocol_version: 1, max_tabs: request.maxTabs });
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
  configuredMaxTabs = status.max_tabs;
}

function popupStatus(): PopupStatus {
  return {
    nativeHostInstalled,
    nativeHostError,
    daemonRunning,
    daemonConnected,
    workerReady,
    contentScriptReady,
    baseUrl: nativeHostInstalled ? `${daemonBaseUrl}/v1` : undefined,
    apiKey,
    maxTabs: nativeHostInstalled ? configuredMaxTabs : undefined,
    installCommand: `npx -y glidea-web2api@latest install --extension-id ${browser.runtime.id}`
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
        configuredMaxTabs = message.max_tabs;
        void ensureWorkerTabs(message.max_tabs);
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
  contentScriptReady = true;
  const workerId: string | undefined = findWorkerId(tabId);
  if (workerId === undefined) {
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
  workerReady = true;
  sendWorkerReady(workerId);
  return undefined;
}

async function dispatchJob(message: JobStartMessage): Promise<void> {
  const workerTabId: number | undefined = workerTabs.get(message.worker_id);
  if (workerTabId === undefined) {
    return;
  }
  const targetUrl: string = message.payload.conversation_id === undefined
    ? "https://chatgpt.com/"
    : `https://chatgpt.com/c/${encodeURIComponent(message.payload.conversation_id)}`;
  const tab: { url?: string } = await browser.tabs.get(workerTabId);
  if (tab.url !== undefined && sameChatPage(tab.url, targetUrl)) {
    await browser.tabs.sendMessage(workerTabId, message);
    return;
  }
  pendingWorkerJobs.set(message.worker_id, message);
  readyWorkers.delete(message.worker_id);
  workerReady = readyWorkers.size > 0;
  await browser.tabs.update(workerTabId, { url: targetUrl });
}

function sameChatPage(currentUrl: string, targetUrl: string): boolean {
  const current: URL = new URL(currentUrl);
  const target: URL = new URL(targetUrl);
  return current.origin === target.origin && current.pathname === target.pathname;
}

async function ensureWorkerTabs(maxTabs: number): Promise<void> {
  for (const [workerId, tabId] of workerTabs.entries()) {
    const index: number = Number(workerId.slice("worker-".length));
    if (index > maxTabs) {
      workerTabs.delete(workerId);
      readyWorkers.delete(workerId);
      workerCapabilities.delete(workerId);
      await browser.tabs.remove(tabId);
    }
  }
  for (let index: number = 1; index <= maxTabs; index += 1) {
    const workerId: string = `worker-${index}`;
    if (workerTabs.has(workerId)) {
      continue;
    }
    const createdTab: unknown = await browser.tabs.create({ url: "https://chatgpt.com/", active: false });
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
  workerReady = false;
  contentScriptReady = false;
  if (tabIds.length > 0) {
    await browser.tabs.remove(tabIds);
  }
}

function sendWorkerReady(workerId: string): void {
  const message: WorkerReadyMessage = {
    version: 1,
    type: "worker.ready",
    worker_id: workerId,
    capabilities: workerCapabilities.get(workerId) ?? { models: ["chatgpt/default"], reasoning_efforts: [] }
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
  return value["type"] === "web2api:content-ready" && typeof value["url"] === "string";
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
      return typeof value["maxTabs"] === "number";
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
