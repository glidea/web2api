import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ExtensionGateway, GatewayError, type TextJobResult } from "./extension-gateway";

type ResponsesRequest = {
  model: string;
  input: string;
  stream: boolean;
};

type ResponsesBody = {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<{
    id: string;
    type: "message";
    status: "completed";
    role: "assistant";
    content: Array<{ type: "output_text"; text: string; annotations: [] }>;
  }>;
};

export class ResponsesService {
  private readonly gateway: ExtensionGateway;

  public constructor(gateway: ExtensionGateway) {
    this.gateway = gateway;
  }

  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body: ResponsesRequest = await this.parseRequest(request);
      const result: TextJobResult = await this.gateway.executeTextJob(body.model, body.input);
      const responseBody: ResponsesBody = {
        id: `resp_${result.conversationId}_${randomUUID()}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: body.model,
        output: [{
          id: `msg_${randomUUID()}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: result.text, annotations: [] }]
        }]
      };
      this.sendJson(response, 200, responseBody);
    } catch (error: unknown) {
      this.sendServiceError(response, error);
    }
  }

  private async parseRequest(request: IncomingMessage): Promise<ResponsesRequest> {
    const content: string = await readBody(request);
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new RequestError(400, "invalid_request", "Request body must be valid JSON");
    }
    if (typeof value !== "object" || value === null) {
      throw new RequestError(400, "invalid_request", "Request body must be an object");
    }
    const record: Record<string, unknown> = value as Record<string, unknown>;
    if (record["model"] !== "chatgpt/default") {
      throw new RequestError(400, "model_not_available", "Only chatgpt/default is available");
    }
    if (typeof record["input"] !== "string") {
      throw new RequestError(400, "unsupported_parameter", "Only string input is supported");
    }
    if (record["stream"] === true) {
      throw new RequestError(400, "unsupported_parameter", "Streaming is not available in this endpoint yet");
    }
    return { model: "chatgpt/default", input: record["input"], stream: false };
  }

  private sendServiceError(response: ServerResponse, error: unknown): void {
    if (error instanceof RequestError) {
      this.sendJson(response, error.statusCode, { error: { message: error.message, type: "invalid_request_error", code: error.code } });
      return;
    }
    if (error instanceof GatewayError) {
      const statusCode: number = error.code === "extension_unavailable" ? 503 : 502;
      this.sendJson(response, statusCode, { error: { message: error.message, type: "server_error", code: error.code } });
      return;
    }
    this.sendJson(response, 500, { error: { message: "Internal daemon error", type: "server_error", code: "internal_error" } });
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    const content: string = JSON.stringify(body);
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
    response.end(content);
  }
}

class RequestError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject): void => {
    let content: string = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string): void => {
      content += chunk;
    });
    request.on("end", (): void => resolve(content));
    request.on("error", reject);
  });
}
