import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parseExtensionMessage, type Capabilities, type DaemonToExtensionMessage, type ExtensionToDaemonMessage } from "../shared/protocol";
import type { DaemonConfig } from "./config";
import type { DaemonServer, DaemonStatus } from "./server";

type WorkerState = {
  capabilities: Capabilities;
};

export class ExtensionGateway {
  private readonly config: DaemonConfig;
  private readonly status: DaemonStatus;
  private readonly websocketServer: WebSocketServer;
  private readonly workers: Map<string, WorkerState> = new Map<string, WorkerState>();
  private connection: WebSocket | undefined;
  private lastHeartbeat: number = 0;
  private readonly heartbeatTimer: NodeJS.Timeout;

  public constructor(server: DaemonServer, config: DaemonConfig, status: DaemonStatus) {
    this.config = config;
    this.status = status;
    this.websocketServer = new WebSocketServer({ noServer: true });
    server.onUpgrade((request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      this.handleUpgrade(request, socket, head);
    });
    this.heartbeatTimer = setInterval((): void => {
      if (this.connection !== undefined && Date.now() - this.lastHeartbeat > 40_000) {
        this.connection.close(1001, "heartbeat timeout");
      }
    }, 20_000);
    this.heartbeatTimer.unref();
  }

  public close(): void {
    clearInterval(this.heartbeatTimer);
    this.connection?.close(1000, "daemon stopping");
    this.websocketServer.close();
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestUrl: URL = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/extension" || !this.isAllowedOrigin(request.headers.origin)) {
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket): void => {
      this.accept(websocket);
    });
  }

  private accept(websocket: WebSocket): void {
    this.connection?.close(1012, "replaced by newer extension connection");
    this.connection = websocket;
    this.lastHeartbeat = Date.now();
    this.status.extensionConnected = true;
    websocket.on("message", (data: RawData): void => {
      this.handleMessage(websocket, data.toString());
    });
    websocket.on("close", (): void => {
      if (this.connection !== websocket) {
        return;
      }
      this.connection = undefined;
      this.workers.clear();
      this.status.extensionConnected = false;
      this.status.workersReady = 0;
    });
  }

  private handleMessage(websocket: WebSocket, content: string): void {
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      websocket.close(1003, "invalid json");
      return;
    }
    const message: ExtensionToDaemonMessage | undefined = parseExtensionMessage(value);
    if (message === undefined) {
      websocket.close(1003, "invalid protocol message");
      return;
    }
    switch (message.type) {
      case "extension.hello":
        this.send(websocket, { version: 1, type: "extension.configure", max_tabs: this.config.max_tabs });
        return;
      case "heartbeat":
        this.lastHeartbeat = Date.now();
        this.send(websocket, message);
        return;
      case "worker.ready":
        this.workers.set(message.worker_id, { capabilities: message.capabilities });
        this.status.workersReady = this.workers.size;
        return;
      case "worker.unhealthy":
        this.workers.delete(message.worker_id);
        this.status.workersReady = this.workers.size;
        return;
      case "capabilities.updated":
        if (this.workers.has(message.worker_id)) {
          this.workers.set(message.worker_id, { capabilities: message.capabilities });
        }
        return;
    }
  }

  private send(websocket: WebSocket, message: DaemonToExtensionMessage): void {
    websocket.send(JSON.stringify(message));
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    return origin?.startsWith("chrome-extension://") === true;
  }
}
