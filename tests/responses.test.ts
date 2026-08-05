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

const port: number = 3212;
let configDirectory: string;
let daemon: DaemonProcess;
let socket: WebSocket;
let apiKey: string;

async function startDaemon(): Promise<void> {
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-responses-"));
  const configPath: string = join(configDirectory, "config.json");
  daemon = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath, "--port", String(port)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
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
  const hello: ExtensionToDaemonMessage = { version: 1, type: "extension.hello", extension_version: "0.1.0", chrome_version: "151" };
  socket.send(JSON.stringify(hello));
  await readDaemonMessage();
  const ready: ExtensionToDaemonMessage = {
    version: 1,
    type: "worker.ready",
    worker_id: "worker-1",
    capabilities: { models: ["chatgpt/default", "chatgpt/gpt-4o"], reasoning_efforts: ["low", "high"] }
  };
  socket.send(JSON.stringify(ready));
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

describe("non-streaming responses", (): void => {
  beforeAll(async (): Promise<void> => {
    await startDaemon();
    await connectFakeExtension();
  });

  afterAll(async (): Promise<void> => {
    await stopDaemon();
  });

  it("projects fake extension text events into a Responses JSON object", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "hello" })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    expect(job.payload).toEqual({ model: "chatgpt/default", input: "hello" });
    const bound: ExtensionToDaemonMessage = { version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-123" };
    socket.send(JSON.stringify(bound));
    const firstDelta: ExtensionToDaemonMessage = { version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: "hel" };
    socket.send(JSON.stringify(firstDelta));
    const secondDelta: ExtensionToDaemonMessage = { version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 2, delta: "lo" };
    socket.send(JSON.stringify(secondDelta));
    const completed: ExtensionToDaemonMessage = { version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id };
    socket.send(JSON.stringify(completed));

    const response: Response = await responsePromise;
    expect(response.status).toBe(200);
    const body: { id: string; object: string; output: Array<{ content: Array<{ text: string }> }> } = await response.json() as { id: string; object: string; output: Array<{ content: Array<{ text: string }> }> };
    expect(body.id).toMatch(/^resp_conv-123_[a-f0-9-]+$/);
    expect(body.object).toBe("response");
    expect(body.output[0]?.content[0]?.text).toBe("hello");
  });

  it("exposes worker models and forwards reasoning effort", async (): Promise<void> => {
    const modelsResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const models: { data: Array<{ id: string }> } = await modelsResponse.json() as { data: Array<{ id: string }> };
    expect(models.data.map((model: { id: string }): string => model.id)).toEqual(["chatgpt/default", "chatgpt/gpt-4o"]);
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/gpt-4o", input: "think", reasoning: { effort: "high" } })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    expect(job.payload).toMatchObject({ model: "chatgpt/gpt-4o", reasoning_effort: "high" });
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-model" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: "ok" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));
    expect((await responsePromise).status).toBe(200);
  });

  it("rejects an unsupported model before sending a page job", async (): Promise<void> => {
    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/unknown", input: "hello" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_available" } });
  });

  it("rejects an unsupported reasoning effort before sending a page job", async (): Promise<void> => {
    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "hello", reasoning: { effort: "max" } })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "reasoning_effort_not_available" } });
  });

  it("routes previous_response_id to the original conversation", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/default", input: "continue", previous_response_id: "resp_conv-123_turn-1" })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    expect(job.payload.conversation_id).toBe("conv-123");
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-123" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 1, delta: "continued" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));
    const response: Response = await responsePromise;
    expect(response.status).toBe(200);
    const body: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await response.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
    expect(body.id).toMatch(/^resp_conv-123_[a-f0-9-]+$/);
    expect(body.output[0]?.content[0]?.text).toBe("continued");
  });

  it("resolves input images and projects a generated image result", async (): Promise<void> => {
    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt/default",
        input: [{ type: "input_text", text: "edit" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }],
        tools: [{ type: "image_generation" }]
      })
    });
    const job: DaemonToExtensionMessage = await readDaemonMessage();
    if (job.type !== "job.start") {
      throw new Error(`expected job.start, got ${job.type}`);
    }
    expect(job.payload.input).toBe("edit");
    expect(job.payload.images).toEqual([{ data: "AQID", media_type: "image/png", name: "image.png" }]);
    expect(job.payload.generate_image).toBe(true);
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "conv-image" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.image.completed", request_id: job.request_id, worker_id: job.worker_id, media_type: "image/png", data: "BAUG" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));
    const response: Response = await responsePromise;
    expect(response.status).toBe(200);
    const body: { output: Array<{ type: string; result?: string }> } = await response.json() as { output: Array<{ type: string; result?: string }> };
    expect(body.output.find((item: { type: string }): boolean => item.type === "image_generation_call")?.result).toBe("BAUG");
  });
});
