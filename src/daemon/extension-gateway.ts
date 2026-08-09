import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parseExtensionMessage, providerFromModel, type Capabilities, type DaemonToExtensionMessage, type ExtensionToDaemonMessage, type JobCancelMessage, type JobStartMessage, type Provider } from "../shared/protocol";
import type { DaemonConfig } from "./config";
import type { DaemonServer, DaemonStatus } from "./server";
import { ConversationScheduler } from "./scheduler";

type WorkerState = {
  provider: Provider;
  capabilities: Capabilities;
};

export type TextJobResult = {
  conversationId: string;
  text: string;
  image: { mediaType: string; data: string } | undefined;
};

export class GatewayError extends Error {
  public readonly code: "extension_unavailable" | "adapter_error" | "login_required";

  public constructor(code: "extension_unavailable" | "adapter_error" | "login_required", message: string) {
    super(message);
    this.code = code;
  }
}

type PendingJob = {
  provider: Provider;
  workerId: string | undefined;
  conversationId: string | undefined;
  text: string;
  resolve: (result: TextJobResult) => void;
  reject: (error: GatewayError) => void;
  timeout: NodeJS.Timeout | undefined;
  onConversationBound: (conversationId: string) => void;
  onDelta: (delta: string) => void;
  onImage: (image: { mediaType: string; data: string }) => void;
  image: { mediaType: string; data: string } | undefined;
};

export type TextJobCallbacks = {
  onConversationBound: (conversationId: string) => void;
  onDelta: (delta: string) => void;
  onImage: (image: { mediaType: string; data: string }) => void;
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
  private readonly schedulers: Record<Provider, ConversationScheduler>;
  private readonly pendingJobs: Map<string, PendingJob> = new Map<string, PendingJob>();
  private connection: WebSocket | undefined;
  private lastHeartbeat: number = 0;
  private readonly heartbeatTimer: NodeJS.Timeout;

  public constructor(server: DaemonServer, config: DaemonConfig, status: DaemonStatus) {
    this.config = config;
    this.status = status;
    this.schedulers = {
      chatgpt: new ConversationScheduler(config.chatgpt_tabs),
      gemini: new ConversationScheduler(config.gemini_tabs)
    };
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
    this.schedulers.chatgpt.close(new GatewayError("extension_unavailable", "Daemon stopping"));
    this.schedulers.gemini.close(new GatewayError("extension_unavailable", "Daemon stopping"));
    for (const pendingJob of this.pendingJobs.values()) {
      if (pendingJob.timeout !== undefined) {
        clearTimeout(pendingJob.timeout);
      }
      pendingJob.reject(new GatewayError("extension_unavailable", "Extension disconnected"));
    }
    this.pendingJobs.clear();
    this.websocketServer.close();
  }

  public executeTextJob(model: string, input: string, conversationId?: string, reasoningEffort?: string, images?: Array<{ data: string; media_type: string; name: string }>, generateImage: boolean = false): Promise<TextJobResult> {
    return this.startTextJob(model, input, { onConversationBound: (): void => undefined, onDelta: (): void => undefined, onImage: (): void => undefined }, conversationId, reasoningEffort, images, generateImage).result;
  }

  public startTextJob(model: string, input: string, callbacks: TextJobCallbacks, conversationId?: string, reasoningEffort?: string, images?: Array<{ data: string; media_type: string; name: string }>, generateImage: boolean = false): TextJobHandle {
    if (this.connection === undefined || this.status.extensionConnected === false) {
      throw new GatewayError("extension_unavailable", "Extension is not connected");
    }
    const provider: Provider | undefined = providerFromModel(model);
    if (provider === undefined) {
      throw new GatewayError("adapter_error", "Requested model is not available");
    }
    if (!Array.from(this.workers.values()).some((worker: WorkerState): boolean => worker.provider === provider)) {
      throw new GatewayError("extension_unavailable", `No ready ${provider} worker is available`);
    }
    const requestId: string = `req_${randomUUID()}`;
    const result: Promise<TextJobResult> = new Promise<TextJobResult>((resolve, reject): void => {
      this.pendingJobs.set(requestId, { provider, workerId: undefined, conversationId: undefined, text: "", resolve, reject, timeout: undefined, onConversationBound: callbacks.onConversationBound, onDelta: callbacks.onDelta, onImage: callbacks.onImage, image: undefined });
    });
    const scheduled: { id: string; result: Promise<TextJobResult> } = this.schedulers[provider].enqueueWithId(requestId, conversationId, async (workerId: string): Promise<TextJobResult> => {
      const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
      if (pendingJob === undefined || this.connection === undefined) {
        throw new GatewayError("extension_unavailable", "Extension is not connected");
      }
      if (!this.workerSupports(workerId, model, reasoningEffort)) {
        throw new GatewayError("adapter_error", "Requested model or reasoning effort is not available");
      }
      pendingJob.workerId = workerId;
      pendingJob.timeout = setTimeout((): void => {
        this.failJob(requestId, new GatewayError("adapter_error", `${provider} job timed out`));
      }, generateImage ? 300_000 : 120_000);
      const payload: JobStartMessage["payload"] = {
        model,
        input,
        ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(images === undefined || images.length === 0 ? {} : { images }),
        ...(generateImage ? { generate_image: true } : {})
      };
      const job: JobStartMessage = { version: 1, type: "job.start", provider, request_id: requestId, worker_id: workerId, payload };
      this.send(this.connection, job);
      return result;
    });
    void scheduled.result.catch((): void => undefined);
    return { requestId, result };
  }

  public models(): string[] {
    const models: Set<string> = new Set<string>(["chatgpt/default", "gemini/default"]);
    for (const worker of this.workers.values()) {
      for (const model of worker.capabilities.models) {
        models.add(model);
      }
    }
    return Array.from(models);
  }

  public supportsModel(model: string): boolean {
    return this.models().includes(model);
  }

  public supportsReasoningEffort(model: string, effort: string): boolean {
    const provider: Provider | undefined = providerFromModel(model);
    for (const worker of this.workers.values()) {
      if (worker.provider === provider && worker.capabilities.reasoning_efforts.includes(effort)) {
        return true;
      }
    }
    return false;
  }

  public cancelJob(requestId: string): void {
    const pendingJob: PendingJob | undefined = this.pendingJobs.get(requestId);
    if (pendingJob === undefined) {
      return;
    }
    const queued: boolean = this.schedulers[pendingJob.provider].cancel(requestId, new GatewayError("extension_unavailable", "Request cancelled"));
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
      this.schedulers.chatgpt.close(new GatewayError("extension_unavailable", "Extension disconnected"));
      this.schedulers.gemini.close(new GatewayError("extension_unavailable", "Extension disconnected"));
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
        this.send(websocket, { version: 1, type: "extension.configure", chatgpt_tabs: this.config.chatgpt_tabs, gemini_tabs: this.config.gemini_tabs });
        return;
      case "heartbeat":
        this.lastHeartbeat = Date.now();
        this.send(websocket, message);
        return;
      case "worker.ready":
        this.workers.set(message.worker_id, { provider: message.provider, capabilities: message.capabilities });
        this.schedulers[message.provider].addWorker(message.worker_id);
        this.status.workersReady = this.workers.size;
        return;
      case "worker.unhealthy":
        {
          const worker: WorkerState | undefined = this.workers.get(message.worker_id);
          this.workers.delete(message.worker_id);
          if (worker !== undefined) {
            this.schedulers[worker.provider].removeWorker(message.worker_id);
          }
        }
        for (const [requestId, pendingJob] of this.pendingJobs.entries()) {
          if (pendingJob.workerId === message.worker_id) {
            this.failJob(requestId, new GatewayError("extension_unavailable", "Worker became unhealthy"));
          }
        }
        this.status.workersReady = this.workers.size;
        return;
      case "capabilities.updated":
        {
          const worker: WorkerState | undefined = this.workers.get(message.worker_id);
          if (worker !== undefined) {
            this.workers.set(message.worker_id, { provider: worker.provider, capabilities: message.capabilities });
          }
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
      case "job.image.completed":
        {
          const pendingJob: PendingJob | undefined = this.pendingJobs.get(message.request_id);
          if (pendingJob !== undefined) {
            pendingJob.image = { mediaType: message.media_type, data: message.data };
            pendingJob.onImage(pendingJob.image);
          }
        }
        return;
      case "job.completed":
        this.finishJob(message.request_id);
        return;
      case "job.failed":
        this.failJob(message.request_id, new GatewayError(message.code === "login_required" ? "login_required" : "adapter_error", message.message));
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
      pendingJob.reject(new GatewayError("adapter_error", "Worker did not bind a conversation"));
      return;
    }
    pendingJob.resolve({ conversationId: pendingJob.conversationId, text: pendingJob.text, image: pendingJob.image });
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

  private workerSupports(workerId: string, model: string, reasoningEffort: string | undefined): boolean {
    const worker: WorkerState | undefined = this.workers.get(workerId);
    if (worker === undefined) {
      return false;
    }
    const provider: Provider | undefined = providerFromModel(model);
    const modelAvailable: boolean = worker.provider === provider && (model.endsWith("/default") || worker.capabilities.models.includes(model));
    const effortAvailable: boolean = reasoningEffort === undefined || worker.capabilities.reasoning_efforts.includes(reasoningEffort);
    return modelAvailable && effortAvailable;
  }

  private send(websocket: WebSocket, message: DaemonToExtensionMessage): void {
    websocket.send(JSON.stringify(message));
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (this.config.extension_id === undefined) {
      return origin?.startsWith("chrome-extension://") === true;
    }
    return origin === `chrome-extension://${this.config.extension_id}`;
  }
}
