import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { decodeResponseId } from "../../src/daemon/response-id";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

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

let context: BrowserContext;
let page: Page;
let daemon: DaemonProcess;
let configDirectory: string;
let dynamicModel: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async (): Promise<void> => {
  test.setTimeout(120_000);
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-gemini-smoke-"));
  const configPath: string = join(configDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify({ api_key: apiKey, port, chatgpt_tabs: 1, gemini_tabs: 2 }, null, 2)}\n`);
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
    ignoreDefaultArgs: ["--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check", `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
  });
  const existingGeminiPage: Page | undefined = context.pages().find((candidate: Page): boolean => candidate.url().startsWith("https://gemini.google.com"));
  page = existingGeminiPage ?? await context.newPage();
  await page.goto("https://gemini.google.com/app");
});

test.afterAll(async (): Promise<void> => {
  await context?.close();
  daemon?.kill("SIGTERM");
  if (configDirectory !== undefined) {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("loads the extension in a dedicated logged-in Gemini profile and discovers models", async (): Promise<void> => {
  test.setTimeout(60_000);
  await page.locator('a[href*="accounts.google.com/SignOutOptions"], [role="textbox"][contenteditable="true"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
  if (await page.locator('a[href*="accounts.google.com/SignOutOptions"]').count() === 0) {
    throw new Error("Gemini profile is logged out. Run pnpm test:smoke:gemini:setup first");
  }
  await expect(page.locator('[role="textbox"][contenteditable="true"]:visible').first()).toBeVisible();
  await expect(page.locator('input[type="file"].hidden-file-input, input[type="file"][data-test-id="local-image-upload-input"]').first()).toBeAttached();
  await waitForWorkers();
  dynamicModel = await waitForDynamicGeminiModel();
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

test("accepts an input image and returns generated PNG bytes", async (): Promise<void> => {
  test.setTimeout(480_000);
  const inputResponse: ResponseBody = await createResponse({
    model: "gemini/default",
    input: [
      { type: "input_text", text: "Reply with exactly WEB2API_GEMINI_IMAGE_INPUT_OK" },
      { type: "input_image", image_url: inputImageDataUrl }
    ]
  });
  expect(messageText(inputResponse)).toBe("WEB2API_GEMINI_IMAGE_INPUT_OK");

  const generationResponse: ResponseBody = await createResponse({
    model: "gemini/default",
    input: "Generate a 64 by 64 pixel PNG containing one solid blue circle on a white background.",
    tools: [{ type: "image_generation" }]
  });
  const image: ImageOutput | undefined = generationResponse.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is ImageOutput => item.type === "image_generation_call");
  expect(image).toBeDefined();
  expect(Buffer.from(image?.result ?? "", "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("round trips a function call through the same Gemini conversation", async (): Promise<void> => {
  test.setTimeout(360_000);
  const callResponse: ResponseBody = await createResponse({
    model: "gemini/default",
    input: "What is the weather in Paris?",
    tools: weatherTools,
    tool_choice: "required"
  });
  const call: FunctionOutput | undefined = callResponse.output.find((item: MessageOutput | ImageOutput | FunctionOutput): item is FunctionOutput => item.type === "function_call");
  expect(call).toMatchObject({ name: "get_weather" });
  if (call === undefined) {
    throw new Error("Gemini did not return a function call");
  }
  expect(JSON.parse(call.arguments)).toMatchObject({ city: expect.any(String) });

  const finalResponse: ResponseBody = await createResponse({
    model: "gemini/default",
    previous_response_id: callResponse.id,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: '{"temperature":21}' },
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
  const deadline: number = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    if (health.extension_connected && health.workers_ready === 3) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("extension workers did not become ready");
}

async function waitForDynamicGeminiModel(): Promise<string> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body: { data: Array<{ id: string }> } = await response.json() as { data: Array<{ id: string }> };
    const model: string | undefined = body.data.map((item: { id: string }): string => item.id).find((id: string): boolean => id.startsWith("gemini/") && id !== "gemini/default");
    if (model !== undefined) {
      return model;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("Gemini dynamic models were not discovered");
}
