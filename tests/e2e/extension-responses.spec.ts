import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3210;
const outputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const chatGptFixture: string = `<!doctype html><html><head><title>ChatGPT fixture</title></head><body>
<textarea data-testid="composer"></textarea><button data-testid="send-button">Send</button>
<script>
document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
  const composer = document.querySelector('textarea[data-testid=composer]');
  const startingPath = location.pathname;
  const currentConversation = startingPath.startsWith('/c/') ? startingPath.slice(3) : undefined;
  const conversationId = currentConversation || (composer.value === 'hello' ? 'fixture-conversation' : 'fresh-conversation');
  history.pushState({}, '', '/c/' + conversationId);
  setTimeout(() => {
    const assistant = document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = composer.value.includes('WEB2API FUNCTION PROTOCOL V1')
      ? 'WEB2API_FUNCTION_CALLS_V1\\n{"calls":[{"call_id":"call_weather","name":"get_weather","arguments":{"city":"Paris"}}]}\\nWEB2API_FUNCTION_CALLS_END'
      : composer.value === 'hello' ? 'hello from fixture' : startingPath;
    document.body.append(assistant);
  }, 100);
});
</script></body></html>`;
const geminiFixture: string = `<!doctype html><html><head><title>Gemini fixture</title></head><body>
<a href="https://accounts.google.com/SignOutOptions">Account</a>
<button data-test-id="bard-mode-menu-button" aria-expanded="true">Flash</button>
<gem-menu-item role="menuitem" data-mode-id="flash"><span class="label">3.6 Flash</span></gem-menu-item>
<gem-menu-item role="menuitem"><span class="label">Extended thinking</span></gem-menu-item>
<button aria-label="Upload and tools" aria-expanded="true">Tools</button>
<button role="menuitemcheckbox" aria-checked="false"><span data-mat-icon-name="image_create"></span>Image</button>
<input class="hidden-file-input" type="file" multiple>
<div id="attachment-previews"></div>
<div class="ql-editor" role="textbox" contenteditable="true"></div>
<button aria-label="Send"><span data-mat-icon-name="send"></span></button>
<script>
const uploadInput = document.querySelector('input[type=file]');
document.querySelector('button[role=menuitemcheckbox]').addEventListener('click', (event) => {
  event.currentTarget.setAttribute('aria-checked', 'true');
});
uploadInput.addEventListener('change', () => {
  const previews = document.querySelector('#attachment-previews');
  for (const file of Array.from(uploadInput.files || [])) {
    const preview = document.createElement('file-preview');
    preview.dataset.mediaType = file.type;
    previews.append(preview);
  }
});
document.querySelector('button[aria-label=Send]').addEventListener('click', () => {
  const composer = document.querySelector('[role=textbox]');
  const prompt = composer.textContent;
  const attachmentTypes = Array.from(uploadInput.files || []).map((file) => file.type);
  const startingPath = location.pathname;
  const currentConversation = startingPath.startsWith('/app/') ? startingPath.slice(5) : undefined;
  const conversationId = currentConversation || (prompt === 'hello gemini' ? 'gemini-fixture-conversation' : 'gemini-fresh-conversation');
  history.pushState({}, '', '/app/' + conversationId);
  setTimeout(() => {
    const assistant = document.createElement('model-response');
    const message = document.createElement('message-content');
    if (prompt === 'generate fixture image') {
      const image = document.createElement('img');
      image.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      assistant.append(image);
    } else if (prompt.includes('"tool_outputs":[{"call_id":"call_weather"')) {
      message.textContent = 'Gemini says 21 degrees.';
      assistant.append(message);
    } else if (prompt.includes('WEB2API FUNCTION PROTOCOL V1')) {
      message.textContent = 'WEB2API_FUNCTION_CALLS_V1\\n{"calls":[{"call_id":"call_weather","name":"get_weather","arguments":{"city":"Paris"}}]}\\nWEB2API_FUNCTION_CALLS_END';
      assistant.append(message);
    } else if (prompt === 'describe attachments') {
      message.textContent = attachmentTypes.join(',');
      assistant.append(message);
    } else {
      message.textContent = prompt === 'hello gemini' ? 'hello from gemini fixture' : startingPath;
      assistant.append(message);
    }
    document.body.append(assistant);
  }, 100);
});
</script></body></html>`;

let daemon: DaemonProcess;
let context: BrowserContext;
let userDataDirectory: string;
let configDirectory: string;
let apiKey: string;
let daemonErrors: string = "";
const pageErrors: string[] = [];

test.beforeAll(({}, testInfo): void => {
  if (process.env["WEB2API_EXTENSION_RESPONSES_TEST"] !== "1") {
    testInfo.skip(true, "run through test:e2e:extension-responses");
  }
});

async function startDaemon(): Promise<void> {
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-responses-e2e-"));
  const configPath: string = join(configDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify({ api_key: "wb2_responses_e2e", port, chatgpt_tabs: 2, gemini_tabs: 2 }, null, 2)}\n`);
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
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk: string): void => {
    daemonErrors += chunk;
  });
  const deadline: number = Date.now() + 10_000;
  while (!output.includes("API key:")) {
    if (Date.now() > deadline) {
      throw new Error(`daemon did not start: ${output}`);
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 50);
    });
  }
  const line: string | undefined = output.split("\n").find((value: string): boolean => value.startsWith("API key:"));
  if (line === undefined) {
    throw new Error("api key was not printed");
  }
  apiKey = line.slice("API key:".length).trim();
}

test.beforeAll(async (): Promise<void> => {
  userDataDirectory = await mkdtemp(join(tmpdir(), "web2api-responses-e2e-profile-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    args: [`--disable-extensions-except=${outputDirectory}`, `--load-extension=${outputDirectory}`]
  });
  context.on("page", (openedPage: Page): void => {
    openedPage.on("pageerror", (error: Error): void => {
      pageErrors.push(error.message);
    });
  });
  await context.route("https://chatgpt.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: chatGptFixture });
  });
  await context.route("https://gemini.google.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: geminiFixture });
  });
  await startDaemon();
});

test.afterAll(async (): Promise<void> => {
  await context.close();
  daemon.kill("SIGTERM");
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(configDirectory, { recursive: true, force: true });
});

test("keeps ChatGPT Responses API behavior after introducing Provider routing", async (): Promise<void> => {
  const pageDeadline: number = Date.now() + 10_000;
  let workerPages: Page[] = [];
  while (Date.now() < pageDeadline && workerPages.length < 4) {
    workerPages = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://chatgpt.com/") || candidate.url().startsWith("https://gemini.google.com/"));
    if (workerPages.length < 4) {
      await new Promise<void>((resolvePromise): void => {
        setTimeout(resolvePromise, 100);
      });
    }
  }
  if (workerPages.length < 4) {
    throw new Error("worker tabs were not created");
  }
  for (const workerPage of workerPages) {
    await workerPage.reload();
  }
  const deadline: number = Date.now() + 10_000;
  let ready: boolean = false;
  while (Date.now() < deadline) {
    const healthResponse: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health: { extension_connected: boolean; workers_ready: number } = await healthResponse.json() as { extension_connected: boolean; workers_ready: number };
    ready = health.extension_connected && health.workers_ready === 4;
    if (ready) {
      break;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  expect(ready, pageErrors.join("\n")).toBe(true);
  const response: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "hello" })
  });
  if (response.status !== 200) {
    throw new Error(`response failed: ${response.status} ${await response.text()} daemon=${daemonErrors}`);
  }
  const body: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await response.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(body.id).toMatch(/^resp_chatgpt_fixture-conversation_/);
  expect(body.output[0]?.content[0]?.text).toBe("hello from fixture");

  const freshResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "fresh" })
  });
  const freshBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await freshResponse.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(freshBody.id).toMatch(/^resp_chatgpt_fresh-conversation_/);
  expect(freshBody.output[0]?.content[0]?.text).toBe("/");

  const continuedResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "continue", previous_response_id: body.id })
  });
  const continuedBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await continuedResponse.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(continuedBody.id).toMatch(/^resp_chatgpt_fixture-conversation_/);
  expect(continuedBody.output[0]?.content[0]?.text).toBe("/c/fixture-conversation");

  const toolResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt/default",
      input: "Weather in Paris?",
      tools: [{
        type: "function",
        name: "get_weather",
        description: "Get the current weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
        strict: true
      }]
    })
  });
  const toolBody: { output: Array<Record<string, unknown>> } = await toolResponse.json() as { output: Array<Record<string, unknown>> };
  expect(toolBody.output).toMatchObject([{
    type: "function_call",
    call_id: "call_weather",
    name: "get_weather",
    arguments: '{"city":"Paris"}'
  }]);

});

test("serves Gemini text, streaming and continued responses without using ChatGPT tabs", async (): Promise<void> => {
  const chatGptPages: Page[] = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://chatgpt.com/"));
  const chatGptUrlsBefore: string[] = chatGptPages.map((page: Page): string => page.url());
  const geminiPages: Page[] = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://gemini.google.com/"));
  expect(geminiPages).toHaveLength(2);
  for (const geminiPage of geminiPages) {
    await expect(geminiPage.locator('a[href*="accounts.google.com/SignOutOptions"]')).toHaveCount(1);
  }
  const modelsDeadline: number = Date.now() + 5_000;
  let modelIds: string[] = [];
  while (Date.now() < modelsDeadline) {
    const modelsResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const modelsBody: { data: Array<{ id: string }> } = await modelsResponse.json() as { data: Array<{ id: string }> };
    modelIds = modelsBody.data.map((model: { id: string }): string => model.id);
    if (modelIds.includes("gemini/3.6-flash")) {
      break;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  expect(modelIds).toContain("gemini/3.6-flash");

  const modelResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/3.6-flash", input: "dynamic gemini", reasoning: { effort: "extended" } })
  });
  expect(modelResponse.status).toBe(200);
  const unsupportedReasoningResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "invalid reasoning", reasoning: { effort: "high" } })
  });
  expect(unsupportedReasoningResponse.status).toBe(400);
  expect(await unsupportedReasoningResponse.json()).toMatchObject({ error: { code: "reasoning_effort_not_available" } });

  const firstResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "hello gemini" })
  });
  const firstContent: string = await firstResponse.text();
  if (firstResponse.status !== 200) {
    throw new Error(`Gemini response failed: ${firstResponse.status} ${firstContent} pages=${pageErrors.join("|")} daemon=${daemonErrors}`);
  }
  const firstBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = JSON.parse(firstContent) as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(firstBody.id).toMatch(/^resp_gemini_gemini-fixture-conversation_/);
  expect(firstBody.output[0]?.content[0]?.text).toBe("hello from gemini fixture");

  const streamResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "stream gemini", stream: true })
  });
  const streamBody: string = await streamResponse.text();
  expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
  expect(streamBody).toContain("event: response.output_text.delta");
  expect(streamBody).toContain("/app");
  expect(streamBody).toContain("event: response.completed");

  const continuedResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "continue gemini", previous_response_id: firstBody.id })
  });
  const continuedBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await continuedResponse.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(continuedBody.id).toMatch(/^resp_gemini_gemini-fixture-conversation_/);
  expect(continuedBody.output[0]?.content[0]?.text).toBe("/app/gemini-fixture-conversation");
  expect(chatGptPages.map((page: Page): string => page.url())).toEqual(chatGptUrlsBefore);

  const parallelChatGptPromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "parallel chatgpt" })
  });
  const parallelGeminiPromise: Promise<Response> = fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "parallel gemini" })
  });
  const [parallelChatGptResponse, parallelGeminiResponse]: [Response, Response] = await Promise.all([parallelChatGptPromise, parallelGeminiPromise]);
  const parallelChatGptBody: { id: string } = await parallelChatGptResponse.json() as { id: string };
  const parallelGeminiBody: { id: string } = await parallelGeminiResponse.json() as { id: string };
  expect(parallelChatGptResponse.status).toBe(200);
  expect(parallelGeminiResponse.status).toBe(200);
  expect(parallelChatGptBody.id).toMatch(/^resp_chatgpt_/);
  expect(parallelGeminiBody.id).toMatch(/^resp_gemini_/);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/"))).toHaveLength(2);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/"))).toHaveLength(2);
});

test("serves Gemini image input and generated image responses", async (): Promise<void> => {
  const inputResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini/default",
      input: [
        { type: "input_text", text: "describe attachments" },
        { type: "input_image", image_url: "data:image/png;base64,AQID" },
        { type: "input_image", image_url: "data:image/jpeg;base64,BAUG" }
      ]
    })
  });
  expect(inputResponse.status).toBe(200);
  const inputBody: { output: Array<{ content?: Array<{ text: string }> }> } = await inputResponse.json() as { output: Array<{ content?: Array<{ text: string }> }> };
  expect(inputBody.output[0]?.content?.[0]?.text).toBe("image/png,image/jpeg");

  const generationResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini/default",
      input: "generate fixture image",
      tools: [{ type: "image_generation" }]
    })
  });
  expect(generationResponse.status).toBe(200);
  const generationBody: { output: Array<{ type: string; result?: string }> } = await generationResponse.json() as { output: Array<{ type: string; result?: string }> };
  const imageResult: string | undefined = generationBody.output.find((item: { type: string }): boolean => item.type === "image_generation_call")?.result;
  expect(imageResult).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
  expect(Buffer.from(imageResult ?? "", "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
});

test("round trips Gemini function calls and hides the private streaming protocol", async (): Promise<void> => {
  const tools: Array<Record<string, unknown>> = [{
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
  const callResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "Weather in Paris?", tools })
  });
  expect(callResponse.status).toBe(200);
  const callBody: { id: string; output: Array<Record<string, unknown>> } = await callResponse.json() as { id: string; output: Array<Record<string, unknown>> };
  expect(callBody.output).toMatchObject([{
    type: "function_call",
    status: "completed",
    call_id: "call_weather",
    name: "get_weather",
    arguments: '{"city":"Paris"}'
  }]);

  const finalResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini/default",
      previous_response_id: callBody.id,
      input: [{ type: "function_call_output", call_id: "call_weather", output: '{"temperature":21}' }]
    })
  });
  expect(finalResponse.status).toBe(200);
  const finalBody: { id: string; output: Array<{ content?: Array<{ text: string }> }> } = await finalResponse.json() as { id: string; output: Array<{ content?: Array<{ text: string }> }> };
  expect(finalBody.id.split("_").slice(0, 3)).toEqual(callBody.id.split("_").slice(0, 3));
  expect(finalBody.output[0]?.content?.[0]?.text).toBe("Gemini says 21 degrees.");

  const streamResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini/default", input: "Weather in Paris?", tools, stream: true })
  });
  const streamBody: string = await streamResponse.text();
  expect(streamResponse.status).toBe(200);
  expect(streamBody).toContain("event: response.function_call_arguments.done");
  expect(streamBody).toContain('"name":"get_weather"');
  expect(streamBody).not.toContain("web2api_function_calls");
});
