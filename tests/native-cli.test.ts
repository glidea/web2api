// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { readNativeMessage, writeNativeMessage } from "../src/native/messaging";
import type { NativeHostRequest, NativeHostResponse } from "../src/shared/native-protocol";

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

const execFileAsync: (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }> = promisify(execFile);
const projectDirectory: string = process.cwd();
const cliPath: string = resolve("bin/glidea-web2api.mjs");
const extensionId: string = "abcdefghijklmnopabcdefghijklmnop";
let root: string = "";
let dataDirectory: string;
let manifestDirectory: string;
let port: number;
let environment: NodeJS.ProcessEnv;
let daemonRunning: boolean = false;

async function availablePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address: ReturnType<Server["address"]> = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  const value: number = address.port;
  server.close();
  await once(server, "close");
  return value;
}

async function runCli(argumentsList: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...argumentsList], { cwd: projectDirectory, env: environment });
}

async function sendNative(request: NativeHostRequest): Promise<NativeHostResponse> {
  const hostPath: string = join(dataDirectory, "bin", "glidea-web2api-host");
  const child: NativeProcess = spawn(hostPath, [`chrome-extension://${extensionId}/`], { stdio: ["pipe", "pipe", "pipe"], env: environment });
  await writeNativeMessage(child.stdin, request);
  child.stdin.end();
  const response: NativeHostResponse = await readNativeMessage(child.stdout) as NativeHostResponse;
  await once(child, "exit");
  return response;
}

describe("native CLI installation", (): void => {
  beforeAll(async (): Promise<void> => {
    await execFileAsync("pnpm", ["build:daemon"], { cwd: projectDirectory, env: process.env });
    root = await mkdtemp(join(tmpdir(), "web2api-native-cli-"));
    dataDirectory = join(root, "data");
    manifestDirectory = join(root, "NativeMessagingHosts");
    port = await availablePort();
    environment = {
      ...process.env,
      WEB2API_DATA_DIR: dataDirectory,
      WEB2API_NATIVE_MANIFEST_DIR: manifestDirectory
    };
    await runCli(["install", "--extension-id", extensionId]);
    await writeFile(join(dataDirectory, "config.json"), `${JSON.stringify({ api_key: "wb2_native_test", port, chatgpt_tabs: 2, gemini_tabs: 3, grok_tabs: 4, extension_id: extensionId }, null, 2)}\n`, "utf8");
  });

  afterAll(async (): Promise<void> => {
    if (daemonRunning) {
      await sendNative({ type: "stop", protocol_version: 1 });
    }
    if (root !== "") {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the copied native host outside the package directory", async (): Promise<void> => {
    const response: NativeHostResponse = await sendNative({ type: "ensure", protocol_version: 1 });
    daemonRunning = true;
    expect(response).toEqual({
      ok: true,
      protocol_version: 1,
      daemon: "running",
      base_url: `http://127.0.0.1:${port}`,
      api_key: "wb2_native_test",
      chatgpt_tabs: 2,
      gemini_tabs: 3,
      grok_tabs: 4
    });
    const health: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const log: string = await readFile(join(dataDirectory, "daemon.log"), "utf8");
    expect(log).not.toContain("wb2_native_test");
  });

  it("reports installation health and uninstalls cleanly", async (): Promise<void> => {
    const doctor: { stdout: string } = await runCli(["doctor", "--extension-id", extensionId]);
    expect(doctor.stdout).toContain("Native host: installed");

    await sendNative({ type: "stop", protocol_version: 1 });
    daemonRunning = false;
    await runCli(["uninstall", "--extension-id", extensionId]);
    await expect(readFile(join(manifestDirectory, "dev.glidea.web2api.json"), "utf8")).rejects.toThrow();
  });
});
