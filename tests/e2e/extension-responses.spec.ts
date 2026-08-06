import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3210;
const outputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const fixture: string = `<!doctype html><html><head><title>ChatGPT fixture</title></head><body>
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
    assistant.textContent = composer.value === 'hello' ? 'hello from fixture' : startingPath;
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
    await route.fulfill({ contentType: "text/html", body: fixture });
  });
  await startDaemon();
});

test.afterAll(async (): Promise<void> => {
  await context.close();
  daemon.kill("SIGTERM");
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(configDirectory, { recursive: true, force: true });
});

test("sends a real extension page job and returns non-streaming response", async (): Promise<void> => {
  const pageDeadline: number = Date.now() + 10_000;
  let workerPages: Page[] = [];
  while (Date.now() < pageDeadline && workerPages.length < 2) {
    workerPages = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://chatgpt.com/"));
    if (workerPages.length < 2) {
      await new Promise<void>((resolvePromise): void => {
        setTimeout(resolvePromise, 100);
      });
    }
  }
  if (workerPages.length < 2) {
    throw new Error("worker tabs were not created");
  }
  for (const workerPage of workerPages) {
    await workerPage.evaluate((): void => {
      document.body.innerHTML = '<textarea data-testid="composer"></textarea><button data-testid="send-button">Send</button>';
      const button: HTMLButtonElement = document.querySelector("[data-testid=send-button]") as HTMLButtonElement;
      button.addEventListener("click", (): void => {
        const composer: HTMLTextAreaElement = document.querySelector("textarea[data-testid=composer]") as HTMLTextAreaElement;
        const startingPath: string = window.location.pathname;
        const currentConversation: string | undefined = startingPath.startsWith("/c/") ? startingPath.slice(3) : undefined;
        const conversationId: string = currentConversation ?? (composer.value === "hello" ? "fixture-conversation" : "fresh-conversation");
        history.pushState({}, "", `/c/${conversationId}`);
        setTimeout((): void => {
          const assistant: HTMLElement = document.createElement("div");
          assistant.dataset.messageAuthorRole = "assistant";
          assistant.textContent = composer.value === "hello" ? "hello from fixture" : startingPath;
          document.body.append(assistant);
        }, 100);
      });
    });
  }
  const deadline: number = Date.now() + 10_000;
  let ready: boolean = false;
  while (Date.now() < deadline) {
    const healthResponse: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const health: { extension_connected: boolean; workers_ready: number } = await healthResponse.json() as { extension_connected: boolean; workers_ready: number };
    ready = health.extension_connected && health.workers_ready === 2;
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
  expect(body.id).toMatch(/^resp_fixture-conversation_/);
  expect(body.output[0]?.content[0]?.text).toBe("hello from fixture");

  const freshResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "fresh" })
  });
  const freshBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await freshResponse.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(freshBody.id).toMatch(/^resp_fresh-conversation_/);
  expect(freshBody.output[0]?.content[0]?.text).toBe("/");

  const continuedResponse: Response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt/default", input: "continue", previous_response_id: body.id })
  });
  const continuedBody: { id: string; output: Array<{ content: Array<{ text: string }> }> } = await continuedResponse.json() as { id: string; output: Array<{ content: Array<{ text: string }> }> };
  expect(continuedBody.id).toMatch(/^resp_fixture-conversation_/);
  expect(continuedBody.output[0]?.content[0]?.text).toBe("/c/fixture-conversation");
});
