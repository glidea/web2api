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

type ExtensionsSession = {
  send(method: "Extensions.getExtensions"): Promise<{ extensions: ExtensionInfo[] }>;
  send(method: "Extensions.uninstall", params: { id: string }): Promise<void>;
  send(method: "Extensions.loadUnpacked", params: { path: string }): Promise<{ id: string }>;
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

type ModelsBody = {
  data: Array<{ id: string }>;
};

const defaultChromeExecutable: string | undefined = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined;
const profileDirectory: string = process.env["WEB2API_GROK_PROFILE"] ?? join(homedir(), ".web2api", "grok-profile");
const executablePath: string | undefined = process.env["WEB2API_GROK_EXECUTABLE"] ?? defaultChromeExecutable;
const extensionDirectory: string = resolve("src/extension/.output/chrome-mv3");
const port: number = 3210;
const apiKey: string = "wb2_grok_smoke";
const inputImageDataUrl: string = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA5UlEQVR4AeyUwQ2EMBADIyq4pqiapq4D+Puz8gMp2IPEI8pK4PEkx13+HKv8AUC5AAsDMKCcAEegXAAuQY4AR8Ak8D/PtfNrxuEO4A5wlfn6vP4/BiiRtjUGtDWueTFAibStMaCtcc2LAUqkbY0BbY1rXgxQIm1rDEhvfMqHAROh9H0MSG94yocBE6H0fQxIb3jKhwETofR9DEhveMqHAROh9H0MSGvYzYMBLrG0eQxIa9TNYxvwu6618/s6APcDu8/bBuweyP0/ALjE0uYxIK1RNw8GuMTS5jEgrVE3z+cNcAPr/AMAAP//H/T5aAAAAAZJREFUAwBBXneQY5kr+QAAAABJRU5ErkJggg==";
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
let connectedBrowser: Browser | undefined;
let ownsContext: boolean = false;
let page: Page;
let daemon: DaemonProcess;
let configDirectory: string;
let extensionId: string;
let dynamicModel: string;
let reasoningEffort: string;
let imageInputResponseId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async (): Promise<void> => {
  test.setTimeout(180_000);
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-grok-smoke-"));
  const configPath: string = join(configDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify({ api_key: apiKey, port, chatgpt_tabs: 0, gemini_tabs: 0, grok_tabs: 1 }, null, 2)}\n`);
  daemon = spawn("pnpm", ["exec", "tsx", "src/daemon/cli.ts", "start", "--config", configPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForDaemon();

  const cdpUrl: string | undefined = process.env["WEB2API_GROK_CDP_URL"];
  if (cdpUrl !== undefined) {
    connectedBrowser = await chromium.connectOverCDP(cdpUrl);
    context = connectedBrowser.contexts()[0] as BrowserContext;
  } else {
    await mkdir(profileDirectory, { recursive: true });
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: false,
      executablePath,
      ignoreDefaultArgs: ["--use-mock-keychain", "--disable-extensions"],
      args: ["--no-first-run", "--no-default-browser-check", "--enable-unsafe-extension-debugging"]
    });
    ownsContext = true;
  }
  const launchedBrowser: Browser | null = context.browser() ?? connectedBrowser ?? null;
  if (launchedBrowser === null) {
    throw new Error("Chrome browser connection is unavailable");
  }
  const browserSession: CDPSession = await launchedBrowser.newBrowserCDPSession();
  const extensionsSession: ExtensionsSession = browserSession as unknown as ExtensionsSession;
  const installedExtensions: { extensions: ExtensionInfo[] } = await extensionsSession.send("Extensions.getExtensions");
  for (const installedExtension of installedExtensions.extensions.filter((extension: ExtensionInfo): boolean => extension.path === extensionDirectory)) {
    await extensionsSession.send("Extensions.uninstall", { id: installedExtension.id });
  }
  const loadedExtension: { id: string } = await extensionsSession.send("Extensions.loadUnpacked", { path: extensionDirectory });
  extensionId = loadedExtension.id;
  await browserSession.detach();
  const activationPopup: Page = await context.newPage();
  await activationPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await activationPopup.close();
  page = await waitForGrokPage();
  await waitForGrokReadyPage();
  await waitForWorkers();
  const models: string[] = await waitForDynamicGrokModels();
  dynamicModel = models[0] as string;
  reasoningEffort = await waitForGrokReasoningEffort();
});

test.afterAll(async (): Promise<void> => {
  if (ownsContext) {
    await context?.close();
  }
  daemon?.kill("SIGTERM");
  if (configDirectory !== undefined) {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("loads the extension in a dedicated Grok profile and discovers capabilities", async (): Promise<void> => {
  expect(dynamicModel).toMatch(/^grok\/.+/);
  expect(reasoningEffort.length).toBeGreaterThan(0);
});

test("completes text, streaming, continued, dynamic-model and reasoning responses", async (): Promise<void> => {
  test.setTimeout(420_000);
  const dynamic: ResponseBody = await createResponse({
    model: dynamicModel,
    input: "Reply with exactly WEB2API_GROK_DYNAMIC_OK",
    reasoning: { effort: reasoningEffort }
  });
  expect(messageText(dynamic)).toBe("WEB2API_GROK_DYNAMIC_OK");

  const continued: ResponseBody = await createResponse({
    model: "grok/default",
    input: "Reply with exactly WEB2API_GROK_CONTINUED",
    previous_response_id: dynamic.id
  });
  expect(messageText(continued)).toBe("WEB2API_GROK_CONTINUED");
  expect(decodeResponseId(continued.id).conversationId).toBe(decodeResponseId(dynamic.id).conversationId);

  const streamContent: string = await createStream({
    model: "grok/default",
    input: "Reply with exactly WEB2API_GROK_STREAM_OK",
    previous_response_id: continued.id,
    stream: true
  });
  expect(streamContent).toContain("event: response.output_text.delta");
  expect(streamContent).toContain("WEB2API_GROK_STREAM_OK");
  expect(streamContent).toContain("event: response.completed");
});

test("accepts an input image", async (): Promise<void> => {
  test.setTimeout(480_000);
  const inputResponse: ResponseBody = await createResponse({
    model: "grok/default",
    input: [
      { type: "input_text", text: "Reply with exactly WEB2API_GROK_IMAGE_INPUT_OK" },
      { type: "input_image", image_url: inputImageDataUrl }
    ]
  });
  expect(messageText(inputResponse)).toBe("WEB2API_GROK_IMAGE_INPUT_OK");
  imageInputResponseId = inputResponse.id;
});

test("returns generated image bytes", async (): Promise<void> => {
  test.setTimeout(480_000);
  const generationResponse: ResponseBody = await createResponse({
    model: "grok/default",
    input: "Generate an image containing one solid blue circle on a white background.",
    previous_response_id: imageInputResponseId,
    tools: [{ type: "image_generation" }]
  });
  const image: ImageOutput | undefined = generationResponse.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is ImageOutput => item.type === "image_generation_call");
  expect(image).toBeDefined();
  const imageBytes: Buffer = Buffer.from(image?.result ?? "", "base64");
  const isPng: boolean = imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg: boolean = imageBytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  expect(isPng || isJpeg).toBe(true);
});

test("round trips a function call through the same Grok conversation", async (): Promise<void> => {
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
    throw new Error("Grok did not return a function call");
  }
  expect(JSON.parse(call.arguments)).toMatchObject({ sku: "WB2-123" });

  const finalResponse: ResponseBody = await createResponse({
    model: dynamicModel,
    previous_response_id: callResponse.id,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: '{"available":7}' },
      { type: "input_text", text: "Reply with exactly WEB2API_GROK_FUNCTION_OK" }
    ]
  });
  expect(messageText(finalResponse)).toBe("WEB2API_GROK_FUNCTION_OK");
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

async function waitForGrokPage(): Promise<Page> {
  const deadline: number = Date.now() + 30_000;
  let recoveredNavigation: boolean = false;
  while (Date.now() < deadline) {
    const grokPages: Page[] = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://grok.com"));
    for (const grokPage of grokPages) {
      const ready: string | null = await grokPage.locator("html").getAttribute("data-web2api-content-script").catch((): null => null);
      const composerCount: number = await grokPage.locator('[contenteditable="true"][role="textbox"], textarea:visible').count().catch((): number => 0);
      if (ready === "ready" && composerCount > 0) {
        return grokPage;
      }
    }
    const failedWorkerPage: Page | undefined = context.pages().find((candidate: Page): boolean => candidate.url().startsWith("chrome-error://"));
    if (failedWorkerPage !== undefined && !recoveredNavigation) {
      recoveredNavigation = true;
      await failedWorkerPage.goto("https://grok.com/");
      continue;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("Grok worker page was not created");
}

async function waitForGrokReadyPage(): Promise<void> {
  const deadline: number = Date.now() + 30_000;
  let challengeReloaded: boolean = false;
  while (Date.now() < deadline) {
    const bodyText: string = await page.locator("body").innerText().catch((): string => "");
    const challengeVisible: boolean = await page.locator('input[name="cf-turnstile-response"]').count() > 0
      || /Performing security verification|正在进行安全验证/.test(bodyText);
    if (challengeVisible && !challengeReloaded) {
      challengeReloaded = true;
      await page.waitForTimeout(3_000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      continue;
    }
    const composerVisible: boolean = await page.locator('[contenteditable="true"][role="textbox"]:visible, textarea:visible').first().isVisible();
    const signInVisible: boolean = await page.getByRole("button", { name: /^(Log in|Sign in|登录)$/i }).isVisible();
    if (composerVisible && !signInVisible) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  const bodyText: string = await page.locator("body").innerText();
  throw new Error(`Grok profile is logged out or unavailable: ${bodyText.slice(0, 500)}`);
}

async function waitForDynamicGrokModels(): Promise<string[]> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body: ModelsBody = await response.json() as ModelsBody;
    const models: string[] = body.data
      .map((item: { id: string }): string => item.id)
      .filter((id: string): boolean => id.startsWith("grok/") && id !== "grok/default");
    if (models.length > 0) {
      return models;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("Grok dynamic models were not discovered");
}

async function waitForGrokReasoningEffort(): Promise<string> {
  const deadline: number = Date.now() + 30_000;
  const popup: Page = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    while (Date.now() < deadline) {
      const statusText: string = await popup.getByRole("region", { name: "Grok status" }).innerText();
      const reasoningLine: string | undefined = statusText.split("\n").find((line: string): boolean => line.startsWith("Reasoning "));
      if (reasoningLine !== undefined && reasoningLine !== "Reasoning Unavailable") {
        const efforts: string[] = reasoningLine.slice("Reasoning ".length).split(", ").filter((effort: string): boolean => effort.length > 0);
        const preferredEffort: string | undefined = efforts.find((effort: string): boolean => effort === "expert") ?? efforts[0];
        if (preferredEffort !== undefined) {
          return preferredEffort;
        }
      }
      await new Promise<void>((resolvePromise): void => {
        setTimeout(resolvePromise, 100);
      });
    }
  } finally {
    await popup.close();
  }
  throw new Error("Grok reasoning modes were not discovered");
}
