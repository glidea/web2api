// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const projectDirectory: string = process.cwd();
const port: number = 32_10;
let configDirectory: string;
let configPath: string;
let daemon: DaemonProcess;
let apiKey: string;

async function startDaemon(): Promise<DaemonProcess> {
  const child: DaemonProcess = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath, "--port", String(port)], {
    cwd: projectDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output: string = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string): void => {
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
  const keyLine: string | undefined = output.split("\n").find((line: string): boolean => line.startsWith("API key:"));
  if (keyLine === undefined) {
    throw new Error("daemon api key was not printed");
  }
  apiKey = keyLine.slice("API key:".length).trim();
  return child;
}

async function stopDaemon(child: DaemonProcess): Promise<void> {
  child.kill("SIGTERM");
  await once(child, "exit");
}

describe("daemon CLI", (): void => {
  beforeAll(async (): Promise<void> => {
    configDirectory = await mkdtemp(join(tmpdir(), "web2api-daemon-"));
    configPath = join(configDirectory, "config.json");
    daemon = await startDaemon();
  });

  afterAll(async (): Promise<void> => {
    await stopDaemon(daemon);
    await rm(configDirectory, { recursive: true, force: true });
  });

  it("serves unauthenticated health and authenticated model discovery", async (): Promise<void> => {
    const healthResponse: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ status: "ok", daemon: "ready", extension_connected: false, workers_ready: 0 });

    const unauthorizedResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(unauthorizedResponse.status).toBe(401);

    const modelsResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    expect(modelsResponse.status).toBe(200);
    expect(await modelsResponse.json()).toEqual({
      object: "list",
      data: [
        { id: "chatgpt/default", object: "model", owned_by: "web2api" },
        { id: "gemini/default", object: "model", owned_by: "web2api" }
      ]
    });
  });

  it("persists the generated API key across restarts", async (): Promise<void> => {
    const firstKey: string = apiKey;
    await stopDaemon(daemon);
    daemon = await startDaemon();
    expect(apiKey).toBe(firstKey);
    const config: string = await readFile(configPath, "utf8");
    expect(config).toContain(firstKey);
  });

  it("fails clearly when the configured port is already occupied", async (): Promise<void> => {
    const second: DaemonProcess = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath, "--port", String(port)], {
      cwd: projectDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [code]: [number | null] = await once(second, "exit") as [number | null];
    expect(code).not.toBe(0);
  });

  it("stops through the authenticated control endpoint", async (): Promise<void> => {
    const exited: Promise<unknown[]> = once(daemon, "exit");
    const response: Response = await fetch(`http://127.0.0.1:${port}/_web2api/control/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stopping" });
    await exited;
    daemon = await startDaemon();
  });
});
