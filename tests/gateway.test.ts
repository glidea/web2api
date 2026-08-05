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

const port: number = 3211;
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
    await startDaemon();
  });

  afterAll(async (): Promise<void> => {
    await stopDaemon();
    await rm(configDirectory, { recursive: true, force: true });
  });

  it("performs handshake, heartbeat and worker health lifecycle", async (): Promise<void> => {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: "chrome-extension://test" });
    await once(socket, "open");
    const hello: ExtensionToDaemonMessage = {
      version: 1,
      type: "extension.hello",
      extension_version: "0.1.0",
      chrome_version: "151"
    };
    socket.send(JSON.stringify(hello));
    expect(await readMessage(socket)).toEqual({ version: 1, type: "extension.configure", max_tabs: 2 });

    const ready: ExtensionToDaemonMessage = {
      version: 1,
      type: "worker.ready",
      worker_id: "worker-1",
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
});
