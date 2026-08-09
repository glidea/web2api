import { chromium, expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { decodeResponseId } from "../../src/daemon/response-id";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

type ExtensionInfo = {
  id: string;
  path: string;
};

type ExtensionReloadSession = {
  send(method: "Extensions.reload", params: { id: string }): Promise<unknown>;
};

type MessageOutput = {
  type: "message";
  content: Array<{ text: string }>;
};

type ImageOutput = {
  type: "image_generation_call";
  result: string;
};

type FunctionOutput = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

type ResponseBody = {
  id: string;
  output: Array<MessageOutput | ImageOutput | FunctionOutput>;
};

const defaultChromeExecutable: string | undefined = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined;
const profileDirectory: string = process.env["WEB2API_GEMINI_PROFILE"] ?? join(homedir(), ".web2api", "gemini-profile");
const executablePath: string | undefined = process.env["WEB2API_GEMINI_EXECUTABLE"] ?? defaultChromeExecutable;
const extensionDirectory: string = resolve("src/extension/.output/chrome-mv3");
const port: number = 3210;
const apiKey: string = "wb2_gemini_smoke";
const inputImageDataUrl: string = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const inventoryTools: Array<Record<string, unknown>> = [{
  type: "function",
  name: "lookup_inventory",
  description: "Look up inventory for a product SKU",
  parameters: {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"],
    additionalProperties: false
  },
  strict: true
}];

let context: BrowserContext;
let page: Page;
let daemon: DaemonProcess;
let configDirectory: string;
let dynamicModel: string;
let imageGenerationModel: string;
let imageGenerationAvailable: boolean;

test.describe.configure({ mode: "serial" });

test.beforeAll(async (): Promise<void> => {
  test.setTimeout(120_000);
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-gemini-smoke-"));
  const configPath: string = join(configDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify({ api_key: apiKey, port, chatgpt_tabs: 0, gemini_tabs: 1 }, null, 2)}\n`);
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
    ignoreDefaultArgs: ["--use-mock-keychain", "--disable-extensions"],
    args: ["--no-first-run", "--no-default-browser-check", "--enable-unsafe-extension-debugging"]
  });
  const launchedBrowser: Browser | null = context.browser();
  if (launchedBrowser === null) {
    throw new Error("Chrome browser connection is unavailable");
  }
  const browserSession: CDPSession = await launchedBrowser.newBrowserCDPSession();
  const installedExtensions: { extensions: ExtensionInfo[] } = await browserSession.send("Extensions.getExtensions") as { extensions: ExtensionInfo[] };
  const installedExtension: ExtensionInfo | undefined = installedExtensions.extensions.find((extension: ExtensionInfo): boolean => extension.path === extensionDirectory);
  if (installedExtension === undefined) {
    await browserSession.send("Extensions.loadUnpacked", { path: extensionDirectory });
  } else {
    const reloadSession: ExtensionReloadSession = browserSession as unknown as ExtensionReloadSession;
    await reloadSession.send("Extensions.reload", { id: installedExtension.id });
  }
  await browserSession.detach();
  page = await waitForGeminiPage();
  await expect(page.locator('[role="textbox"][contenteditable="true"]:visible').first()).toBeVisible();
  await expect(page.locator('button[data-test-id="bard-mode-menu-button"]')).toBeVisible();
  await waitForWorkers();
  const models: string[] = await waitForDynamicGeminiModels();
  dynamicModel = models.find((model: string): boolean => model.includes("flash-lite"))
    ?? models.find((model: string): boolean => model.includes("flash"))
    ?? models[0] as string;
  imageGenerationModel = models.find((model: string): boolean => model.includes("flash") && !model.includes("flash-lite"))
    ?? dynamicModel;
  imageGenerationAvailable = await hasImageGenerationTool();
});

test.afterAll(async (): Promise<void> => {
  await context?.close();
  daemon?.kill("SIGTERM");
  if (configDirectory !== undefined) {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("loads the extension in a dedicated Gemini profile and discovers models", async (): Promise<void> => {
  expect(dynamicModel).toMatch(/^gemini\/.+/);
});

test("completes text, streaming, continued and dynamic-model responses", async (): Promise<void> => {
  test.setTimeout(420_000);
  const first: ResponseBody = await createResponse({
    model: "gemini/default",
    input: "Reply with exactly WEB2API_GEMINI_OK"
  });
  expect(messageText(first)).toBe("WEB2API_GEMINI_OK");

  const continued: ResponseBody = await createResponse({
    model: "gemini/default",
    input: "Reply with exactly WEB2API_GEMINI_CONTINUED",
    previous_response_id: first.id
  });
  expect(messageText(continued)).toBe("WEB2API_GEMINI_CONTINUED");
  expect(decodeResponseId(continued.id).conversationId).toBe(decodeResponseId(first.id).conversationId);

  const dynamic: ResponseBody = await createResponse({
    model: dynamicModel,
    input: "Reply with exactly WEB2API_GEMINI_DYNAMIC_OK"
  });
  expect(messageText(dynamic)).toBe("WEB2API_GEMINI_DYNAMIC_OK");

  const streamContent: string = await createStream({
    model: "gemini/default",
    input: "Reply with exactly WEB2API_GEMINI_STREAM_OK",
    stream: true
  });
  expect(streamContent).toContain("event: response.output_text.delta");
  expect(streamContent).toContain("WEB2API_GEMINI_STREAM_OK");
  expect(streamContent).toContain("event: response.completed");
});

test("accepts an input image", async (): Promise<void> => {
  test.setTimeout(480_000);
  const inputResponse: ResponseBody = await createResponse({
    model: "gemini/default",
    input: [
      { type: "input_text", text: "Reply with exactly WEB2API_GEMINI_IMAGE_INPUT_OK" },
      { type: "input_image", image_url: inputImageDataUrl }
    ]
  });
  expect(messageText(inputResponse)).toBe("WEB2API_GEMINI_IMAGE_INPUT_OK");
});

test("returns generated image bytes", async (): Promise<void> => {
  test.skip(!imageGenerationAvailable, "Gemini image generation is unavailable in the dedicated profile");
  test.setTimeout(480_000);
  const generationResponse: ResponseBody = await createResponse({
    model: imageGenerationModel,
    input: "Generate a 64 by 64 pixel image containing one solid blue circle on a white background.",
    tools: [{ type: "image_generation" }]
  });
  const image: ImageOutput | undefined = generationResponse.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is ImageOutput => item.type === "image_generation_call");
  expect(image).toBeDefined();
  const imageBytes: Buffer = Buffer.from(image?.result ?? "", "base64");
  const isPng: boolean = imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg: boolean = imageBytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  expect(isPng || isJpeg).toBe(true);
});

test("round trips a function call through the same Gemini conversation", async (): Promise<void> => {
  test.setTimeout(360_000);
  const callResponse: ResponseBody = await createResponse({
    model: dynamicModel,
    input: "Check inventory for SKU WB2-123.",
    tools: inventoryTools,
    tool_choice: "required"
  });
  const call: FunctionOutput | undefined = callResponse.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is FunctionOutput => item.type === "function_call");
  expect(call).toMatchObject({ name: "lookup_inventory" });
  if (call === undefined) {
    throw new Error("Gemini did not return a function call");
  }
  expect(JSON.parse(call.arguments)).toMatchObject({ sku: "WB2-123" });

  const finalResponse: ResponseBody = await createResponse({
    model: dynamicModel,
    previous_response_id: callResponse.id,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: '{"available":7}' },
      { type: "input_text", text: "Reply with exactly WEB2API_GEMINI_FUNCTION_OK" }
    ]
  });
  expect(messageText(finalResponse)).toBe("WEB2API_GEMINI_FUNCTION_OK");
  expect(decodeResponseId(finalResponse.id).conversationId).toBe(decodeResponseId(callResponse.id).conversationId);
});

function messageText(response: ResponseBody): string | undefined {
  const message: MessageOutput | undefined = response.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is MessageOutput => item.type === "message");
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

async function createStream(body: Record<string, unknown>): Promise<string> {
  const response: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Streaming request failed: ${response.status} ${await response.text()}`);
  }
  return await response.text();
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
  let lastHealth: { extension_connected: boolean; workers_ready: number } | undefined;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    lastHealth = health;
    if (health.extension_connected && health.workers_ready === 1) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(`extension workers did not become ready: ${JSON.stringify(lastHealth)}`);
}

async function waitForGeminiPage(): Promise<Page> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const geminiPage: Page | undefined = context.pages().find((candidate: Page): boolean => candidate.url().startsWith("https://gemini.google.com"));
    if (geminiPage !== undefined) {
      return geminiPage;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  const pageOrigins: string[] = context.pages().map((candidate: Page): string => {
    const url: URL = new URL(candidate.url());
    return `${url.protocol}//${url.host}${url.pathname}`;
  });
  const serviceWorkerCount: number = context.serviceWorkers().length;
  throw new Error(`Gemini worker page was not created: service_workers=${serviceWorkerCount}; pages=${JSON.stringify(pageOrigins)}`);
}

async function waitForDynamicGeminiModels(): Promise<string[]> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body: { data: Array<{ id: string }> } = await response.json() as { data: Array<{ id: string }> };
    const models: string[] = body.data
      .map((item: { id: string }): string => item.id)
      .filter((id: string): boolean => id.startsWith("gemini/") && id !== "gemini/default");
    if (models.length > 0) {
      return models;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("Gemini dynamic models were not discovered");
}

async function hasImageGenerationTool(): Promise<boolean> {
  await page.locator('button[aria-label="Upload and tools"], button[aria-label="Upload & tools"], button[aria-label="上传和工具"]').click();
  const imageToolCount: number = await page.locator('button[role="menuitemcheckbox"]:visible')
    .filter({ has: page.locator('[data-mat-icon-name="image_create"], mat-icon[fonticon="image_create"]') })
    .count();
  await page.keyboard.press("Escape");
  return imageToolCount > 0;
}
