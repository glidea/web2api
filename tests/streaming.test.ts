// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import type { DaemonToExtensionMessage, ExtensionToDaemonMessage } from "../src/shared/protocol";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3213;
let configDirectory: string;
let daemon: DaemonProcess;
let socket: WebSocket;
let apiKey: string;
const weatherTools: Array<Record<string, unknown>> = [{
  type: "function",
  name: "get_weather",
  description: "Get the current weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  },
  strict: true
}];

async function startDaemon(): Promise<void> {
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-streaming-"));
  const configPath: string = join(configDirectory, "config.json");
  daemon = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath, "--port", String(port)], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output: string = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stdout.on("data", (chunk: string): void => {
    output += chunk;
  });
  const deadline: number = Date.now() + 10_000;
  while (!output.includes("API key:")) {
    if (Date.now() > deadline) {
      throw new Error(`daemon did not start: ${output}`);
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 50);
    });
  }
  const line: string | undefined = output.split("\n").find((value: string): boolean => value.startsWith("API key:"));
  if (line === undefined) {
    throw new Error("api key was not printed");
  }
  apiKey = line.slice("API key:".length).trim();
}

async function connectFakeExtension(): Promise<void> {
  socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: "chrome-extension://test" });
  await once(socket, "open");
  socket.send(JSON.stringify({ version: 1, type: "extension.hello", extension_version: "0.1.0", chrome_version: "151" } satisfies ExtensionToDaemonMessage));
  await readDaemonMessage();
  socket.send(JSON.stringify({ version: 1, type: "worker.ready", provider: "chatgpt", worker_id: "worker-1", capabilities: { models: ["chatgpt/default"], reasoning_efforts: [] } } satisfies ExtensionToDaemonMessage));
}

async function readDaemonMessage(): Promise<DaemonToExtensionMessage> {
  const [data]: [WebSocket.RawData] = await once(socket, "message") as [WebSocket.RawData];
  return JSON.parse(data.toString()) as DaemonToExtensionMessage;
}

async function stopDaemon(): Promise<void> {
  socket.close();
  await once(socket, "close");
  daemon.kill("SIGTERM");
  await once(daemon, "exit");
  await rm(configDirectory, { recursive: true, force: true });
}

describe("streaming responses", (): void => {
  beforeAll(async (): Promise<void> => {
    await startDaemon();
    await connectFakeExtension();
  });

  afterAll(async (): Promise<void> => {
    await stopDaemon();
  });

  it("projects ordered typed SSE events and preserves delta text", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "hello", stream: true })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-stream" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: "hel" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 2, delta: "lo" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));
    const response: Response = await responsePromise;
    expect(response.status).toBe(200);
    const text: string = await response.text();
    const events: string[] = Array.from(text.matchAll(/^event: ([^\n]+)$/gm)).map((match: RegExpMatchArray): string => match[1] as string);
    expect(events).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    const deltas: string[] = Array.from(text.matchAll(/"delta":"([^"]*)"/g)).map((match: RegExpMatchArray): string => match[1] as string);
    expect(deltas.join("")).toBe("hello");
  });

  it("buffers the private prompt protocol and streams a standard function call", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "Weather in Paris?", tools: weatherTools, stream: true })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-tool-stream" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: 'WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_weather",' } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 2, delta: '"name":"get_weather","arguments":{"city":"Paris"}}]}\nWEB2API_FUNCTION_CALLS_END' } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));

    const response: Response = await responsePromise;
    const content: string = await response.text();
    const events: string[] = Array.from(content.matchAll(/^event: ([^\n]+)$/gm)).map((match: RegExpMatchArray): string => match[1] as string);
    expect(events).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(content).toContain('"name":"get_weather"');
    expect(content).toContain('"arguments":"{\\"city\\":\\"Paris\\"}"');
    expect(content).not.toContain("web2api_function_calls");
  });

  it("reports a malformed streamed function call as a protocol error", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "Weather in Paris?", tools: weatherTools, stream: true })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-tool-error" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: "WEB2API_FUNCTION_CALLS_V1\nnot-json\nWEB2API_FUNCTION_CALLS_END" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));

    const response: Response = await responsePromise;
    const content: string = await response.text();
    expect(content).toContain("event: error");
    expect(content).toContain('"code":"tool_protocol_error"');
  });

  it("sends job.cancel when the HTTP client aborts", async (): Promise<void> => {
    const controller: AbortController = new AbortController();
    const requestPromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "cancel me", stream: true }),
      signal: controller.signal
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
    controller.abort();
    await expect(requestPromise).rejects.toThrow();
    const cancel: DaemonToExtensionMessage = await readDaemonMessage();
    expect(cancel).toEqual({ version: 1, type: "job.cancel", request_id: job.request_id, worker_id: job.worker_id });
  });
});
