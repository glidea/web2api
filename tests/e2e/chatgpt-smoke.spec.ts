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
  output: Array<
    | { type: "message"; content: Array<{ text: string }> }
    | { type: "image_generation_call"; result: string }
  >;
};

const profileDirectory: string = process.env["WEB2API_CHATGPT_PROFILE"] ?? join(homedir(), ".web2api", "chatgpt-profile");
const executablePath: string | undefined = process.env["WEB2API_CHATGPT_EXECUTABLE"];
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
    executablePath,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
  });
  const existingChatGptPage: Page | undefined = context.pages().find((candidate: Page): boolean => candidate.url().startsWith("https://chatgpt.com"));
  page = existingChatGptPage ?? await context.newPage();
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
  test.setTimeout(30_000);
  await page.locator('#prompt-textarea:visible, textarea[data-testid=composer]:visible, [contenteditable=true]:visible, [data-testid="login-button"]:visible').first().waitFor({ state: "visible", timeout: 15_000 });
  if (await page.locator('[data-testid="login-button"]:visible').count() > 0) {
    throw new Error("ChatGPT profile is logged out. Run pnpm test:smoke:chatgpt:setup first");
  }
  await expect(page.locator("#prompt-textarea:visible, textarea[data-testid=composer]:visible, [contenteditable=true]:visible").first()).toBeVisible();
  await expect(page.locator('input[data-testid="upload-photos-input"], input[data-testid="upload-input"]').first()).toBeAttached();
  await waitForWorkers();
});

test("completes a local text response and continues the same conversation", async (): Promise<void> => {
  test.setTimeout(300_000);
  const first: ResponseBody = await createResponse({
    model: "chatgpt/default",
    input: "Reply with exactly WEB2API_SMOKE_OK"
  });
  expect(messageText(first)).toBe("WEB2API_SMOKE_OK");

  const continued: ResponseBody = await createResponse({
    model: "chatgpt/default",
    input: "Reply with exactly WEB2API_SMOKE_CONTINUED",
    previous_response_id: first.id
  });
  expect(messageText(continued)).toBe("WEB2API_SMOKE_CONTINUED");
  expect(decodeResponseId(continued.id).conversationId).toBe(decodeResponseId(first.id).conversationId);
});

test("edits an external image and returns PNG bytes", async (): Promise<void> => {
  test.setTimeout(360_000);
  const response: ResponseBody = await createResponse({
    model: "chatgpt/default",
    input: [
      { type: "input_text", text: "Edit the attached image by adding a solid blue circle in the center. Return the edited image." },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA5UlEQVR4AeyUwQ2EMBADIyq4pqiapq4D+Puz8gMp2IPEI8pK4PEkx13+HKv8AUC5AAsDMKCcAEegXAAuQY4AR8Ak8D/PtfNrxuEO4A5wlfn6vP4/BiiRtjUGtDWueTFAibStMaCtcc2LAUqkbY0BbY1rXgxQIm1rDEhvfMqHAROh9H0MSG94yocBE6H0fQxIb3jKhwETofR9DEhveMqHAROh9H0MSGvYzYMBLrG0eQxIa9TNYxvwu6618/s6APcDu8/bBuweyP0/ALjE0uYxIK1RNw8GuMTS5jEgrVE3z+cNcAPr/AMAAP//H/T5aAAAAAZJREFUAwBBXneQY5kr+QAAAABJRU5ErkJggg==" }
    ],
    tools: [{ type: "image_generation" }]
  });
  const image: { type: "image_generation_call"; result: string } | undefined = response.output.find((item): item is { type: "image_generation_call"; result: string } => item.type === "image_generation_call");
  expect(image).toBeDefined();
  expect(Buffer.from(image?.result ?? "", "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

function messageText(response: ResponseBody): string | undefined {
  const message: { type: "message"; content: Array<{ text: string }> } | undefined = response.output.find((item): item is { type: "message"; content: Array<{ text: string }> } => item.type === "message");
  return message?.content[0]?.text;
}

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
