import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parseExtensionMessage, type Capabilities, type DaemonToExtensionMessage, type ExtensionToDaemonMessage, type JobCancelMessage, type JobStartMessage } from "../shared/protocol";
import type { DaemonConfig } from "./config";
import type { DaemonServer, DaemonStatus } from "./server";
import { ConversationScheduler } from "./scheduler";

type WorkerState = {
  capabilities: Capabilities;
};

export type TextJobResult = {
  conversationId: string;
  text: string;
};

export class GatewayError extends Error {
  public readonly code: "extension_unavailable" | "chatgpt_adapter_error";

  public constructor(code: "extension_unavailable" | "chatgpt_adapter_error", message: string) {
    super(message);
    this.code = code;
  }
}

type PendingJob = {
  workerId: string | undefined;
  conversationId: string | undefined;
  text: string;
  resolve: (result: TextJobResult) => void;
  reject: (error: GatewayError) => void;
  timeout: NodeJS.Timeout | undefined;
  onConversationBound: (conversationId: string) => void;
  onDelta: (delta: string) => void;
};

export type TextJobCallbacks = {
  onConversationBound: (conversationId: string) => void;
  onDelta: (delta: string) => void;
};

export type TextJobHandle = {
  requestId: string;
  result: Promise<TextJobResult>;
};

export class ExtensionGateway {
  private readonly config: DaemonConfig;
  private readonly status: DaemonStatus;
  private readonly websocketServer: WebSocketServer;
  private readonly workers: Map<string, WorkerState> = new Map<string, WorkerState>();
  private readonly scheduler: ConversationScheduler;
  private readonly pendingJobs: Map<string, PendingJob> = new Map<string, PendingJob>();
  private connection: WebSocket | undefined;
  private lastHeartbeat: number = 0;
  private readonly heartbeatTimer: NodeJS.Timeout;

  public constructor(server: DaemonServer, config: DaemonConfig, status: DaemonStatus) {
    this.config = config;
    this.status = status;
    this.scheduler = new ConversationScheduler(config.max_tabs);
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
    this.scheduler.close(new GatewayError("extension_unavailable", "Daemon stopping"));
    for (const pendingJob of this.pendingJobs.values()) {
      if (pendingJob.timeout !== undefined) {
        clearTimeout(pendingJob.timeout);
      }
      pendingJob.reject(new GatewayError("extension_unavailable", "Extension disconnected"));
    }
    this.pendingJobs.clear();
    this.websocketServer.close();
  }

  public executeTextJob(model: string, input: string, conversationId?: string): Promise<TextJobResult> {
    return this.startTextJob(model, input, { onConversationBound: (): void => undefined, onDelta: (): void => undefined }, conversationId).result;
  }

  public startTextJob(model: string, input: string, callbacks: TextJobCallbacks, conversationId?: string): TextJobHandle {
    if (this.connection === undefined || this.status.extensionConnected === false) {
      throw new GatewayError("extension_unavailable", "Extension is not connected");
    }
    if (this.workers.size === 0) {
      throw new GatewayError("extension_unavailable", "No ready worker is available");
    }
    const requestId: string = `req_${randomUUID()}`;
    const result: Promise<TextJobResult> = new Promise<TextJobResult>((resolve, reject): void => {
      this.pendingJobs.set(requestId, { workerId: undefined, conversationId: undefined, text: "", resolve, reject, timeout: undefined, onConversationBound: callbacks.onConversationBound, onDelta: callbacks.onDelta });
    });
    const scheduled: { id: string; result: Promise<TextJobResult> } = this.scheduler.enqueueWithId(requestId, conversationId, async (workerId: string): Promise<TextJobResult> => {
      const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
      if (pendingJob === undefined || this.connection === undefined) {
        throw new GatewayError("extension_unavailable", "Extension is not connected");
      }
      pendingJob.workerId = workerId;
      pendingJob.timeout = setTimeout((): void => {
        this.failJob(requestId, new GatewayError("chatgpt_adapter_error", "ChatGPT job timed out"));
      }, 120_000);
      const payload: JobStartMessage["payload"] = conversationId === undefined ? { model, input } : { model, input, conversation_id: conversationId };
      const job: JobStartMessage = { version: 1, type: "job.start", request_id: requestId, worker_id: workerId, payload };
      this.send(this.connection, job);
      return result;
    });
    void scheduled.result.catch((): void => undefined);
    return { requestId, result };
  }

  public cancelJob(requestId: string): void {
    const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
    if (pendingJob === undefined) {
      return;
    }
    const queued: boolean = this.scheduler.cancel(requestId, new GatewayError("extension_unavailable", "Request cancelled"));
    if (queued) {
      this.failJob(requestId, new GatewayError("extension_unavailable", "Request cancelled"));
      return;
    }
    if (this.connection !== undefined && pendingJob.workerId !== undefined) {
      const cancel: JobCancelMessage = { version: 1, type: "job.cancel", request_id: requestId, worker_id: pendingJob.workerId };
      this.send(this.connection, cancel);
    }
    this.failJob(requestId, new GatewayError("extension_unavailable", "Request cancelled"));
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
    for (const [requestId, pendingJob] of this.pendingJobs.entries()) {
        if (pendingJob.timeout !== undefined) {
          clearTimeout(pendingJob.timeout);
        }
        pendingJob.reject(new GatewayError("extension_unavailable", "Extension disconnected"));
        this.pendingJobs.delete(requestId);
      }
      this.scheduler.close(new GatewayError("extension_unavailable", "Extension disconnected"));
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
        this.scheduler.addWorker(message.worker_id);
        this.status.workersReady = this.workers.size;
        return;
      case "worker.unhealthy":
        this.workers.delete(message.worker_id);
        this.scheduler.removeWorker(message.worker_id);
        for (const [requestId, pendingJob] of this.pendingJobs.entries()) {
          if (pendingJob.workerId === message.worker_id) {
            this.failJob(requestId, new GatewayError("extension_unavailable", "Worker became unhealthy"));
          }
        }
        this.status.workersReady = this.workers.size;
        return;
      case "capabilities.updated":
        if (this.workers.has(message.worker_id)) {
          this.workers.set(message.worker_id, { capabilities: message.capabilities });
        }
        return;
      case "job.conversation_bound":
        {
          const pendingJob: PendingJob | undefined = this.pendingJobs.get(message.request_id);
          if (pendingJob !== undefined) {
            pendingJob.conversationId = message.conversation_id;
            pendingJob.onConversationBound(message.conversation_id);
          }
        }
        return;
      case "job.output_text.delta":
        {
          const pendingJob: PendingJob | undefined = this.pendingJobs.get(message.request_id);
          if (pendingJob !== undefined) {
            pendingJob.text += message.delta;
            pendingJob.onDelta(message.delta);
          }
        }
        return;
      case "job.completed":
        this.finishJob(message.request_id);
        return;
      case "job.failed":
        this.failJob(message.request_id, new GatewayError("chatgpt_adapter_error", message.message));
        return;
    }
  }

  private finishJob(requestId: string): void {
    const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
    if (pendingJob === undefined) {
      return;
    }
    if (pendingJob.timeout !== undefined) {
      clearTimeout(pendingJob.timeout);
    }
    this.pendingJobs.delete(requestId);
    if (pendingJob.conversationId === undefined) {
      pendingJob.reject(new GatewayError("chatgpt_adapter_error", "ChatGPT did not bind a conversation"));
      return;
    }
    pendingJob.resolve({ conversationId: pendingJob.conversationId, text: pendingJob.text });
  }

  private failJob(requestId: string, error: GatewayError): void {
    const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
    if (pendingJob === undefined) {
      return;
    }
    if (pendingJob.timeout !== undefined) {
      clearTimeout(pendingJob.timeout);
    }
    this.pendingJobs.delete(requestId);
    pendingJob.reject(error);
  }

  private send(websocket: WebSocket, message: DaemonToExtensionMessage): void {
    websocket.send(JSON.stringify(message));
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    return origin?.startsWith("chrome-extension://") === true;
  }
}
