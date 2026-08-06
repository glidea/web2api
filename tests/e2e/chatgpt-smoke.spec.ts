import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { decodeResponseId } from "../../src/daemon/response-id";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

type ResponseBody = {
  id: string;
  output: Array<{ type: "message"; content: Array<{ text: string }> }>;
};

const profileDirectory: string = process.env["WEB2API_CHATGPT_PROFILE"] ?? join(homedir(), ".web2api", "chatgpt-profile");
const extensionDirectory: string = resolve("src/extension/.output/chrome-mv3");
const port: number = 3210;
const apiKey: string = "wb2_chatgpt_smoke";

let context: BrowserContext;
let page: Page;
let daemon: DaemonProcess;
let configDirectory: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async (): Promise<void> => {
  test.setTimeout(660_000);
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-chatgpt-smoke-"));
  const configPath: string = join(configDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify({ api_key: apiKey, port, max_tabs: 2 }, null, 2)}\n`);
  daemon = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForDaemon();

  await mkdir(profileDirectory, { recursive: true });
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
  });
  page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://chatgpt.com/");
});

test.afterAll(async (): Promise<void> => {
  await context?.close();
  daemon?.kill("SIGTERM");
  if (configDirectory !== undefined) {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("loads the extension in a dedicated logged-in ChatGPT profile", async (): Promise<void> => {
  test.setTimeout(600_000);
  await page.getByTestId("login-button").waitFor({ state: "detached", timeout: 600_000 });
  await expect(page.locator("#prompt-textarea")).toBeVisible();
  await expect(page.getByTestId("upload-photos-input")).toBeAttached();
  await waitForWorkers();
});

test("completes a local text response and continues the same conversation", async (): Promise<void> => {
  test.setTimeout(300_000);
  const first: ResponseBody = await createResponse({
    model: "chatgpt/default",
    input: "Reply with exactly WEB2API_SMOKE_OK"
  });
  expect(first.output[0]?.content[0]?.text.length).toBeGreaterThan(0);

  const continued: ResponseBody = await createResponse({
    model: "chatgpt/default",
    input: "Reply with exactly WEB2API_SMOKE_CONTINUED",
    previous_response_id: first.id
  });
  expect(decodeResponseId(continued.id).conversationId).toBe(decodeResponseId(first.id).conversationId);
  expect(continued.output[0]?.content[0]?.text.length).toBeGreaterThan(0);
});

async function createResponse(body: Record<string, unknown>): Promise<ResponseBody> {
  const response: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Responses request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as ResponseBody;
}

async function waitForDaemon(): Promise<void> {
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise<void>((resolvePromise): void => {
        setTimeout(resolvePromise, 100);
      });
    }
  }
  throw new Error("daemon did not start");
}

async function waitForWorkers(): Promise<void> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    if (health.extension_connected && health.workers_ready === 2) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("extension workers did not become ready");
}
