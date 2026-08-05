import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DaemonConfig } from "./config";

export type DaemonStatus = {
  extensionConnected: boolean;
  workersReady: number;
};

export type ModelList = {
  object: "list";
  data: Array<{ id: string; object: "model"; owned_by: "web2api" }>;
};

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
export type ResponsesHandler = (request: IncomingMessage, response: ServerResponse) => void;

export class DaemonServer {
  private readonly config: DaemonConfig;
  private readonly status: DaemonStatus;
  private readonly httpServer: Server;
  private responsesHandler: ResponsesHandler | undefined;

  public constructor(config: DaemonConfig, status: DaemonStatus) {
    this.config = config;
    this.status = status;
    this.httpServer = createServer((request: IncomingMessage, response: ServerResponse): void => {
      this.handleRequest(request, response);
    });
  }

  public listen(): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
      const onError = (error: Error): void => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.httpServer.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.config.port, "127.0.0.1");
    });
  }

  public close(): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
      this.httpServer.close((error?: Error): void => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public onUpgrade(handler: UpgradeHandler): void {
    this.httpServer.on("upgrade", handler);
  }

  public setResponsesHandler(handler: ResponsesHandler): void {
    this.responsesHandler = handler;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const method: string = request.method ?? "GET";
    const path: string = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (method === "GET" && path === "/healthz") {
      this.sendJson(response, 200, {
        status: "ok",
        daemon: "ready",
        extension_connected: this.status.extensionConnected,
        workers_ready: this.status.workersReady
      });
      return;
    }
    if (method === "GET" && path === "/v1/models") {
      if (!this.isAuthorized(request)) {
        this.sendError(response, 401, "invalid_api_key", "Invalid API key");
        return;
      }
      const models: ModelList = {
        object: "list",
        data: [{ id: "chatgpt/default", object: "model", owned_by: "web2api" }]
      };
      this.sendJson(response, 200, models);
      return;
    }
    if (method === "POST" && path === "/v1/responses") {
      if (!this.isAuthorized(request)) {
        this.sendError(response, 401, "invalid_api_key", "Invalid API key");
        return;
      }
      if (this.responsesHandler === undefined) {
        this.sendError(response, 503, "extension_unavailable", "Responses service is unavailable");
        return;
      }
      this.responsesHandler(request, response);
      return;
    }
    this.sendJson(response, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.config.api_key}`;
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const content: string = JSON.stringify(body);
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
    response.end(content);
  }

  private sendError(response: ServerResponse, statusCode: number, code: string, message: string): void {
    this.sendJson(response, statusCode, { error: { message, type: "invalid_request_error", code } });
  }
}
