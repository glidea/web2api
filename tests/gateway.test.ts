// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import type { DaemonToExtensionMessage, ExtensionToDaemonMessage } from "../src/shared/protocol";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3211;
const extensionId: string = "abcdefghijklmnopabcdefghijklmnop";
const projectDirectory: string = process.cwd();
let configDirectory: string;
let configPath: string;
let daemon: DaemonProcess;

async function startDaemon(): Promise<void> {
  daemon = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath, "--port", String(port)], {
    cwd: projectDirectory,
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
}

async function stopDaemon(): Promise<void> {
  daemon.kill("SIGTERM");
  await once(daemon, "exit");
}

async function readMessage(socket: WebSocket): Promise<DaemonToExtensionMessage> {
  const [data]: [WebSocket.RawData] = await once(socket, "message") as [WebSocket.RawData];
  return JSON.parse(data.toString()) as DaemonToExtensionMessage;
}

async function waitForHealth(expected: boolean, workers: number): Promise<void> {
  const deadline: number = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    if (body.extension_connected === expected && body.workers_ready === workers) {
      return;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("health state did not converge");
}

describe("extension gateway", (): void => {
  beforeAll(async (): Promise<void> => {
    configDirectory = await mkdtemp(join(tmpdir(), "web2api-gateway-"));
    configPath = join(configDirectory, "config.json");
    await writeFile(configPath, `${JSON.stringify({ api_key: "wb2_gateway", port, chatgpt_tabs: 2, gemini_tabs: 3, extension_id: extensionId }, null, 2)}\n`, "utf8");
    await startDaemon();
  });

  afterAll(async (): Promise<void> => {
    await stopDaemon();
    await rm(configDirectory, { recursive: true, force: true });
  });

  it("performs handshake, heartbeat and worker health lifecycle", async (): Promise<void> => {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${extensionId}` });
    await once(socket, "open");
    const hello: ExtensionToDaemonMessage = {
      version: 1,
      type: "extension.hello",
      extension_version: "0.1.0",
      chrome_version: "151"
    };
    socket.send(JSON.stringify(hello));
    expect(await readMessage(socket)).toEqual({ version: 1, type: "extension.configure", chatgpt_tabs: 2, gemini_tabs: 3 });

    const ready: ExtensionToDaemonMessage = {
      version: 1,
      type: "worker.ready",
      provider: "chatgpt",
      worker_id: "chatgpt-worker-1",
      capabilities: { models: ["chatgpt/default"], reasoning_efforts: ["low"] }
    };
    socket.send(JSON.stringify(ready));
    await waitForHealth(true, 1);

    const heartbeat: ExtensionToDaemonMessage = { version: 1, type: "heartbeat", timestamp: 1 };
    socket.send(JSON.stringify(heartbeat));
    expect(await readMessage(socket)).toEqual({ version: 1, type: "heartbeat", timestamp: 1 });

    socket.close();
    await once(socket, "close");
    await waitForHealth(false, 0);
  });

  it("rejects a different extension origin", async (): Promise<void> => {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" });
    const result: "open" | "rejected" = await new Promise<"open" | "rejected">((resolve): void => {
      socket.once("open", (): void => resolve("open"));
      socket.once("error", (): void => resolve("rejected"));
    });
    expect(result).toBe("rejected");
  });

  it("routes a Gemini model only to a Gemini worker", async (): Promise<void> => {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${extensionId}` });
    await once(socket, "open");
    socket.send(JSON.stringify({
      version: 1,
      type: "extension.hello",
      extension_version: "0.1.0",
      chrome_version: "151"
    } satisfies ExtensionToDaemonMessage));
    await readMessage(socket);
    socket.send(JSON.stringify({
      version: 1,
      type: "worker.ready",
      provider: "chatgpt",
      worker_id: "chatgpt-worker-1",
      capabilities: { models: ["chatgpt/default"], reasoning_efforts: [] }
    } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({
      version: 1,
      type: "worker.ready",
      provider: "gemini",
      worker_id: "gemini-worker-1",
      capabilities: { models: ["gemini/default", "gemini/3.6-flash"], reasoning_efforts: [] }
    } satisfies ExtensionToDaemonMessage));
    await waitForHealth(true, 2);

    const responsePromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer wb2_gateway", "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini/default", input: "hello" })
    });
    const job: DaemonToExtensionMessage = await readMessage(socket);
    expect(job).toMatchObject({ type: "job.start", provider: "gemini", worker_id: "gemini-worker-1" });
    if (job.type !== "job.start") {
      throw new Error("expected job.start");
    }
    socket.send(JSON.stringify({ version: 1, type: "job.conversation_bound", request_id: job.request_id, worker_id: job.worker_id, conversation_id: "gemini-conversation" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.output_text.delta", request_id: job.request_id, worker_id: job.worker_id, sequence: 0, delta: "hello from gemini" } satisfies ExtensionToDaemonMessage));
    socket.send(JSON.stringify({ version: 1, type: "job.completed", request_id: job.request_id, worker_id: job.worker_id } satisfies ExtensionToDaemonMessage));

    const response: Response = await responsePromise;
    expect(response.status).toBe(200);
    const body: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await response.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
    expect(body.id).toMatch(/^resp_gemini_gemini-conversation_/);
    expect(body.output[0]?.content[0]?.text).toBe("hello from gemini");
    socket.close();
    await once(socket, "close");
  });
});
