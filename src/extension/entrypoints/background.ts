import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { Capabilities, ExtensionHelloMessage, HeartbeatMessage, WorkerReadyMessage, WorkerUnhealthyMessage, DaemonToExtensionMessage, ExtensionToDaemonMessage, JobStartMessage } from "../../shared/protocol";

type ContentReadyMessage = {
  type: "web2api:content-ready";
  url: string;
  capabilities?: Capabilities;
};

type PopupStatusMessage = {
  type: "web2api:popup-status";
};

type PopupStatus = {
  contentScriptReady: boolean;
  daemonConnected: boolean;
  workerReady: boolean;
};

let contentScriptReady: boolean = false;
let daemonConnected: boolean = false;
let workerReady: boolean = false;
const workerTabs: Map<string, number> = new Map<string, number>();
const readyWorkers: Set<string> = new Set<string>();
const workerCapabilities: Map<string, Capabilities> = new Map<string, Capabilities>();
let configuredMaxTabs: number = 0;
let websocket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
export default defineBackground((): void => {
  void connectToDaemon();
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
    if (configuredMaxTabs > 0) {
      void ensureWorkerTabs(configuredMaxTabs);
    }
  });
  browser.runtime.onMessage.addListener((message: unknown, sender): Promise<PopupStatus | undefined> => {
    if (isJobEvent(message)) {
      sendToDaemon(message);
      return Promise.resolve(undefined);
    }
    if (isContentReadyMessage(message)) {
      contentScriptReady = true;
      const workerId: string | undefined = findWorkerId(sender.tab?.id);
      if (workerId !== undefined) {
        if (message.capabilities !== undefined) {
          workerCapabilities.set(workerId, message.capabilities);
        }
        readyWorkers.add(workerId);
        workerReady = true;
        sendWorkerReady(workerId);
      }
      return Promise.resolve(undefined);
    }

    if (isPopupStatusMessage(message)) {
      return Promise.resolve({ contentScriptReady, daemonConnected, workerReady });
    }

    return Promise.resolve(undefined);
  });
});

async function connectToDaemon(): Promise<void> {
  if (websocket !== undefined) {
    return;
  }
  const socket: WebSocket = new WebSocket("ws://127.0.0.1:3210/extension");
  websocket = socket;
  socket.addEventListener("open", (): void => {
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
    if (message.type === "extension.configure") {
      configuredMaxTabs = message.max_tabs;
      void ensureWorkerTabs(message.max_tabs);
      return;
    }
    if (message.type === "job.start") {
      const workerTabId: number | undefined = workerTabs.get(message.worker_id);
      if (workerTabId !== undefined) {
        void browser.tabs.sendMessage(workerTabId, message);
      }
      return;
    }
    if (message.type === "job.cancel") {
      const workerTabId: number | undefined = workerTabs.get(message.worker_id);
      if (workerTabId !== undefined) {
        void browser.tabs.sendMessage(workerTabId, message);
      }
    }
  });
  socket.addEventListener("close", (): void => {
    daemonConnected = false;
    workerReady = readyWorkers.size > 0;
    websocket = undefined;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    reconnectTimer = setTimeout((): void => {
      reconnectTimer = undefined;
      void connectToDaemon();
    }, 1_000);
  });
  socket.addEventListener("error", (): void => {
    socket.close();
  });
}

async function ensureWorkerTabs(maxTabs: number): Promise<void> {
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
  return type === "job.conversation_bound" || type === "job.output_text.delta" || type === "job.completed" || type === "job.failed";
}

function isContentReadyMessage(message: unknown): message is ContentReadyMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "web2api:content-ready" && typeof value["url"] === "string";
}

function isPopupStatusMessage(message: unknown): message is PopupStatusMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "web2api:popup-status";
}
