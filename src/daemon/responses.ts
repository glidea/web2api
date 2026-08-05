import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ExtensionGateway, GatewayError, type TextJobResult, type TextJobHandle } from "./extension-gateway";
import { decodeResponseId, encodeResponseId } from "./response-id";
import { resolveImage, type ResolvedImage } from "./image-resolver";

type ResponsesRequest = {
  model: string;
  input: string;
  stream: boolean;
  conversationId: string | undefined;
  reasoningEffort: string | undefined;
  images: Array<ResolvedImage>;
  generateImage: boolean;
};

type StreamResponseState = {
  responseId: string | undefined;
  outputItemId: string;
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
  } | {
    id: string;
    type: "image_generation_call";
    status: "completed";
    result: string;
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
      if (body.stream) {
        await this.handleStream(request, response, body);
        return;
      }
      const result: TextJobResult = await this.gateway.executeTextJob(body.model, body.input, body.conversationId, body.reasoningEffort, body.images.map(toProtocolImage), body.generateImage);
      const output: ResponsesBody["output"] = [{
        id: `msg_${randomUUID()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: result.text, annotations: [] }]
      }];
      if (result.image !== undefined) {
        output.push({ id: `ig_${randomUUID()}`, type: "image_generation_call", status: "completed", result: result.image.data });
      }
      const responseBody: ResponsesBody = {
        id: encodeResponseId(result.conversationId, randomUUID()),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: body.model,
        output
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
    if (typeof record["model"] !== "string" || !this.gateway.supportsModel(record["model"])) {
      throw new RequestError(400, "model_not_available", "Requested model is not available");
    }
    let input: string = "";
    const images: Array<ResolvedImage> = [];
    if (typeof record["input"] === "string") {
      input = record["input"];
    } else if (Array.isArray(record["input"])) {
      for (const item of record["input"]) {
        if (typeof item !== "object" || item === null) {
          throw new RequestError(400, "invalid_request", "input item must be an object");
        }
        const content: Record<string, unknown> = item as Record<string, unknown>;
        if (content["type"] === "input_text" && typeof content["text"] === "string") {
          input += `${input.length === 0 ? "" : "\n"}${content["text"]}`;
          continue;
        }
        if (content["type"] === "input_image" && typeof content["image_url"] === "string") {
          try {
            images.push(await resolveImage(content["image_url"]));
          } catch (error: unknown) {
            throw new RequestError(400, "image_invalid", error instanceof Error ? error.message : String(error));
          }
          continue;
        }
        throw new RequestError(400, "unsupported_parameter", "Unsupported input item");
      }
    } else {
      throw new RequestError(400, "unsupported_parameter", "input must be a string or input item array");
    }
    let conversationId: string | undefined;
    if (record["previous_response_id"] !== undefined) {
      if (typeof record["previous_response_id"] !== "string") {
        throw new RequestError(400, "invalid_request", "previous_response_id must be a string");
      }
      try {
        conversationId = decodeResponseId(record["previous_response_id"]).conversationId;
      } catch {
        throw new RequestError(400, "invalid_request", "Invalid previous_response_id");
      }
    }
    let reasoningEffort: string | undefined;
    if (record["reasoning"] !== undefined) {
      if (typeof record["reasoning"] !== "object" || record["reasoning"] === null) {
        throw new RequestError(400, "invalid_request", "reasoning must be an object");
      }
      const reasoning: Record<string, unknown> = record["reasoning"] as Record<string, unknown>;
      if (reasoning["effort"] !== undefined && typeof reasoning["effort"] !== "string") {
        throw new RequestError(400, "invalid_request", "reasoning.effort must be a string");
      }
      reasoningEffort = reasoning["effort"] as string | undefined;
      if (reasoningEffort !== undefined && !this.gateway.supportsReasoningEffort(reasoningEffort)) {
        throw new RequestError(400, "reasoning_effort_not_available", "Requested reasoning effort is not available");
      }
    }
    let generateImage: boolean = false;
    if (record["tools"] !== undefined) {
      if (!Array.isArray(record["tools"])) {
        throw new RequestError(400, "invalid_request", "tools must be an array");
      }
      generateImage = record["tools"].some((tool: unknown): boolean => typeof tool === "object" && tool !== null && (tool as Record<string, unknown>)["type"] === "image_generation");
    }
    return { model: record["model"], input, stream: record["stream"] === true, conversationId, reasoningEffort, images, generateImage };
  }

  private async handleStream(request: IncomingMessage, response: ServerResponse, body: ResponsesRequest): Promise<void> {
    const state: StreamResponseState = { responseId: undefined, outputItemId: `msg_${randomUUID()}` };
    let clientClosed: boolean = false;
    let handle: TextJobHandle;
    try {
      handle = this.gateway.startTextJob(body.model, body.input, {
        onConversationBound: (conversationId: string): void => {
          state.responseId = encodeResponseId(conversationId, randomUUID());
          this.writeEvent(response, "response.created", { type: "response.created", response: { id: state.responseId, object: "response", status: "in_progress", model: body.model } });
          this.writeEvent(response, "response.in_progress", { type: "response.in_progress", response_id: state.responseId });
          this.writeEvent(response, "response.output_item.added", { type: "response.output_item.added", response_id: state.responseId, item: { id: state.outputItemId, type: "message", role: "assistant" } });
          this.writeEvent(response, "response.content_part.added", { type: "response.content_part.added", response_id: state.responseId, item_id: state.outputItemId });
        },
        onDelta: (delta: string): void => {
          if (state.responseId !== undefined) {
            this.writeEvent(response, "response.output_text.delta", { type: "response.output_text.delta", response_id: state.responseId, item_id: state.outputItemId, delta });
          }
        },
        onImage: (): void => undefined
      }, body.conversationId, body.reasoningEffort, body.images.map(toProtocolImage), body.generateImage);
    } catch (error: unknown) {
      this.sendServiceError(response, error);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const cancelOnDisconnect = (): void => {
      if (!clientClosed) {
        clientClosed = true;
        this.gateway.cancelJob(handle.requestId);
      }
    };
    request.on("close", cancelOnDisconnect);
    response.on("close", cancelOnDisconnect);
    try {
      const result: TextJobResult = await handle.result;
      if (clientClosed || state.responseId === undefined) {
        return;
      }
      this.writeEvent(response, "response.output_text.done", { type: "response.output_text.done", response_id: state.responseId, item_id: state.outputItemId, text: result.text });
      this.writeEvent(response, "response.content_part.done", { type: "response.content_part.done", response_id: state.responseId, item_id: state.outputItemId });
      this.writeEvent(response, "response.output_item.done", { type: "response.output_item.done", response_id: state.responseId, item_id: state.outputItemId });
      this.writeEvent(response, "response.completed", { type: "response.completed", response_id: state.responseId });
      response.end();
    } catch (error: unknown) {
      if (!clientClosed) {
        this.writeEvent(response, "error", { type: "error", error: { message: error instanceof Error ? error.message : String(error), code: error instanceof GatewayError ? error.code : "internal_error" } });
        response.end();
      }
    }
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

  private writeEvent(response: ServerResponse, event: string, body: unknown): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
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

function toProtocolImage(image: ResolvedImage): { data: string; media_type: string; name: string } {
  return { data: Buffer.from(image.bytes).toString("base64"), media_type: image.mediaType, name: image.name };
}
