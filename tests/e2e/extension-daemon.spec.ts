import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3210;
const outputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const chatGptFixture: string = "<!doctype html><html><head><title>ChatGPT fixture</title></head><body><main>fixture</main></body></html>";
const geminiFixture: string = `<!doctype html><html><head><title>Gemini fixture</title></head><body>
<a href="https://accounts.google.com/SignOutOptions">Account</a>
<button data-test-id="bard-mode-menu-button">Flash</button>
<gem-menu-item role="menuitem" data-mode-id="flash"><span class="label">Flash</span></gem-menu-item>
<div role="textbox" contenteditable="true"></div>
</body></html>`;
const grokFixture: string = `<!doctype html><html><head><title>Grok fixture</title></head><body>
<button aria-label="Account menu"></button>
<button id="model-select-trigger">Fast</button>
<div role="menuitem"><span>Fast</span><span>Quick responses - Grok 4.5</span></div>
<textarea aria-label="Ask Grok anything"></textarea>
<button type="submit" data-testid="chat-submit" aria-label="Submit"></button>
</body></html>`;
let context: BrowserContext;
let userDataDirectory: string;
let configDirectory: string;
let daemon: DaemonProcess;

test.beforeAll(({}, testInfo): void => {
  if (process.env["WEB2API_EXTENSION_DAEMON_TEST"] !== "1") {
    testInfo.skip(true, "run through test:e2e:extension-daemon");
  }
});

async function startDaemon(): Promise<void> {
  configDirectory = await mkdtemp(join(tmpdir(), "web2api-extension-daemon-"));
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
  const deadline: number = Date.now() + 10_000;
  while (!output.includes("API key:")) {
    if (Date.now() > deadline) {
      throw new Error(`daemon did not start: ${output}`);
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 50);
    });
  }
}

async function waitForReady(): Promise<void> {
  const deadline: number = Date.now() + 10_000;
  let lastBody: { extension_connected: boolean; workers_ready: number } | undefined;
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    lastBody = body;
    if (body.extension_connected && body.workers_ready === 6) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(`extension worker did not become ready: ${JSON.stringify(lastBody)}`);
}

test.beforeAll(async (): Promise<void> => {
  await startDaemon();
  userDataDirectory = await mkdtemp(join(tmpdir(), "web2api-extension-e2e-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    args: [`--disable-extensions-except=${outputDirectory}`, `--load-extension=${outputDirectory}`]
  });
  await context.route("https://chatgpt.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: chatGptFixture });
  });
  await context.route("https://gemini.google.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: geminiFixture });
  });
  await context.route("https://grok.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: grokFixture });
  });
  const deadline: number = Date.now() + 10_000;
  let providerPages: Page[] = [];
  while (Date.now() < deadline) {
    providerPages = context.pages().filter((candidate: Page): boolean => candidate.url().startsWith("https://chatgpt.com/") || candidate.url().startsWith("https://gemini.google.com/") || candidate.url().startsWith("https://grok.com/"));
    if (providerPages.length === 6) {
      break;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  expect(providerPages).toHaveLength(6);
  for (const providerPage of providerPages) {
    await providerPage.reload();
  }
});

test.afterAll(async (): Promise<void> => {
  await context.close();
  daemon.kill("SIGTERM");
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(configDirectory, { recursive: true, force: true });
});

test("connects isolated ChatGPT, Gemini and Grok workers to daemon health", async (): Promise<void> => {
  await waitForReady();
  const workers: Worker[] = context.serviceWorkers();
  expect(workers.length).toBeGreaterThan(0);
  const pages: Page[] = context.pages();
  const chatGptPages: Page[] = pages.filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/"));
  const geminiPages: Page[] = pages.filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/"));
  const grokPages: Page[] = pages.filter((page: Page): boolean => page.url().startsWith("https://grok.com/"));
  expect(chatGptPages).toHaveLength(2);
  expect(geminiPages).toHaveLength(2);
  expect(grokPages).toHaveLength(2);
  for (const workerPage of [...chatGptPages, ...geminiPages, ...grokPages]) {
    await expect(workerPage.locator("html")).toHaveAttribute("data-web2api-content-script", "ready");
  }

  const chatGptPageUrls: string[] = chatGptPages.map((page: Page): string => page.url());
  await geminiPages[0]?.close();
  await waitForReady();
  const replacementDeadline: number = Date.now() + 5_000;
  while (Date.now() < replacementDeadline && context.pages().filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/")).length !== 2) {
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/"))).toHaveLength(2);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/")).map((page: Page): string => page.url())).toEqual(chatGptPageUrls);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://grok.com/"))).toHaveLength(2);
});
