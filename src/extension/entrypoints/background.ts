import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { ExtensionHelloMessage, HeartbeatMessage, WorkerReadyMessage, WorkerUnhealthyMessage, DaemonToExtensionMessage } from "../../shared/protocol";

type ContentReadyMessage = {
  type: "web2api:content-ready";
  url: string;
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
let workerTabId: number | undefined;
let websocket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
const workerId: string = "worker-1";

export default defineBackground((): void => {
  void connectToDaemon();
  browser.tabs.onRemoved.addListener((tabId: number): void => {
    if (tabId !== workerTabId) {
      return;
    }
    workerTabId = undefined;
    workerReady = false;
    sendWorkerUnhealthy("worker_tab_closed");
  });
  browser.runtime.onMessage.addListener((message: unknown, sender): Promise<PopupStatus | undefined> => {
    if (isContentReadyMessage(message)) {
      contentScriptReady = true;
      if (sender.tab?.id === workerTabId) {
        workerReady = true;
        sendWorkerReady();
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
    heartbeatTimer = setInterval((): void => {
      const heartbeat: HeartbeatMessage = { version: 1, type: "heartbeat", timestamp: Date.now() };
      socket.send(JSON.stringify(heartbeat));
    }, 20_000);
  });
  socket.addEventListener("message", (event: MessageEvent<string>): void => {
    const message: DaemonToExtensionMessage = JSON.parse(event.data) as DaemonToExtensionMessage;
    if (message.type === "extension.configure") {
      void ensureWorkerTab();
    }
  });
  socket.addEventListener("close", (): void => {
    daemonConnected = false;
    workerReady = false;
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

async function ensureWorkerTab(): Promise<void> {
  if (workerTabId !== undefined) {
    return;
  }
  const createdTab: unknown = await browser.tabs.create({ url: "https://chatgpt.com/", active: false });
  if (typeof createdTab !== "object" || createdTab === null) {
    throw new Error("worker tab has no id");
  }
  const tabRecord: Record<string, unknown> = createdTab as Record<string, unknown>;
  if (typeof tabRecord["id"] !== "number") {
    throw new Error("worker tab has no id");
  }
  workerTabId = tabRecord["id"];
}

function sendWorkerReady(): void {
  const message: WorkerReadyMessage = {
    version: 1,
    type: "worker.ready",
    worker_id: workerId,
    capabilities: { models: ["chatgpt/default"], reasoning_efforts: [] }
  };
  sendToDaemon(message);
}

function sendWorkerUnhealthy(code: string): void {
  const message: WorkerUnhealthyMessage = { version: 1, type: "worker.unhealthy", worker_id: workerId, code };
  sendToDaemon(message);
}

function sendToDaemon(message: ExtensionHelloMessage | HeartbeatMessage | WorkerReadyMessage | WorkerUnhealthyMessage): void {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
  }
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
