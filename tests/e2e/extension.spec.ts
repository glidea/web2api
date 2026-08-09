import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installNativeHost } from "../../src/native/installer";

const extensionOutputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const chatgptFixture: string = `<!doctype html><html><head><title>ChatGPT fixture</title></head><body><main>fixture</main></body></html>`;
const geminiFixture: string = `<!doctype html><html><head><title>Gemini fixture</title></head><body><main>fixture</main></body></html>`;

let context: BrowserContext;
let userDataDirectory: string;
let testHomeDirectory: string;
let extensionId: string;

function extensionIdFromPath(path: string): string {
  const digest: Buffer = createHash("sha256").update(path).digest().subarray(0, 16);
  return Array.from(digest)
    .flatMap((byte: number): number[] => [byte >> 4, byte & 15])
    .map((value: number): string => String.fromCharCode(97 + value))
    .join("");
}

async function findExtensionId(browserContext: BrowserContext): Promise<string> {
  const workers: Worker[] = browserContext.serviceWorkers();
  if (workers.length > 0) {
    const worker: Worker = workers[0] as Worker;
    const url: URL = new URL(worker.url());
    return url.hostname;
  }
  const worker: Worker = await browserContext.waitForEvent("serviceworker");
  const url: URL = new URL(worker.url());
  return url.hostname;
}

async function waitForProviderPageCounts(chatGptCount: number, geminiCount: number): Promise<void> {
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const chatGptPages: Page[] = context.pages().filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/"));
    const geminiPages: Page[] = context.pages().filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/"));
    if (chatGptPages.length === chatGptCount && geminiPages.length === geminiCount) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(`expected ${chatGptCount} ChatGPT pages and ${geminiCount} Gemini pages`);
}

test.beforeAll(async (): Promise<void> => {
  testHomeDirectory = await mkdtemp(join(tmpdir(), "web2api-extension-home-"));
  userDataDirectory = join(testHomeDirectory, "chrome-profile");
  extensionId = extensionIdFromPath(extensionOutputDirectory);
  await installNativeHost({
    platform: process.platform,
    extensionId,
    dataDirectory: join(testHomeDirectory, ".web2api"),
    manifestDirectory: join(userDataDirectory, "NativeMessagingHosts"),
    runtimeSource: resolve("dist/glidea-web2api.cjs"),
    nodePath: process.execPath
  });
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    env: { ...process.env, HOME: testHomeDirectory },
    args: [
      `--disable-extensions-except=${extensionOutputDirectory}`,
      `--load-extension=${extensionOutputDirectory}`
    ]
  });
  await context.route("https://chatgpt.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: chatgptFixture });
  });
  await context.route("https://gemini.google.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: geminiFixture });
  });
  await context.route("https://example.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>example</body></html>" });
  });
  expect(await findExtensionId(context)).toBe(extensionId);
});

test.afterAll(async (): Promise<void> => {
  const cleanupPage: Page = context.pages().find((page: Page): boolean => page.url().startsWith(`chrome-extension://${extensionId}/`)) ?? await context.newPage();
  if (!cleanupPage.url().startsWith(`chrome-extension://${extensionId}/`)) {
    await cleanupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  }
  await cleanupPage.evaluate("chrome.runtime.sendMessage({type:'web2api:popup',action:'stop'})");
  await context.close();
  await rm(testHomeDirectory, { recursive: true, force: true });
});

test("loads the extension and exposes its service worker", async (): Promise<void> => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("injects provider content scripts only into supported pages", async (): Promise<void> => {
  const chatgptPage: Page = await context.newPage();
  await chatgptPage.goto("https://chatgpt.com/");
  await expect(chatgptPage.locator("html")).toHaveAttribute("data-web2api-content-script", "ready");
  await chatgptPage.close();

  const geminiPage: Page = await context.newPage();
  await geminiPage.goto("https://gemini.google.com/app");
  await expect(geminiPage.locator("html")).toHaveAttribute("data-web2api-content-script", "ready");
  await geminiPage.close();

  const otherPage: Page = await context.newPage();
  await otherPage.goto("https://example.com/");
  await expect(otherPage.locator("html")).not.toHaveAttribute("data-web2api-content-script", "ready");
  await otherPage.close();
});

test("reports isolated provider status and saves separate worker counts", async (): Promise<void> => {
  const popup: Page = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole("heading", { name: "Web2API" })).toBeVisible();
  await expect(popup.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10_000 });
  await waitForProviderPageCounts(2, 2);
  for (const workerPage of context.pages().filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/") || page.url().startsWith("https://gemini.google.com/"))) {
    await workerPage.reload();
  }
  await expect(popup.getByRole("textbox", { name: "Base URL" })).toHaveValue("http://127.0.0.1:3210/v1");
  const chatGptStatus = popup.getByRole("region", { name: "ChatGPT status" });
  await expect(chatGptStatus.getByText("Session Logged in")).toBeVisible();
  await expect(chatGptStatus.getByText("Content script Ready")).toBeVisible();
  await expect(chatGptStatus.getByText("Worker Ready")).toBeVisible();
  await expect(chatGptStatus.getByText("Models chatgpt/default")).toBeVisible();
  const geminiStatus = popup.getByRole("region", { name: "Gemini status" });
  await expect(geminiStatus.getByText("Session Sign-in required")).toBeVisible();
  await expect(geminiStatus.getByText("Content script Ready")).toBeVisible();
  await expect(geminiStatus.getByText("Worker Ready")).toBeVisible();
  await expect(geminiStatus.getByText("Models gemini/default")).toBeVisible();

  await popup.getByLabel("ChatGPT tabs").fill("1");
  await popup.getByLabel("Gemini tabs").fill("3");
  await popup.getByRole("button", { name: "Save and restart" }).click();
  await expect(popup.getByLabel("ChatGPT tabs")).toHaveValue("1", { timeout: 10_000 });
  await expect(popup.getByLabel("Gemini tabs")).toHaveValue("3");
  await waitForProviderPageCounts(1, 3);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://chatgpt.com/"))).toHaveLength(1);
  expect(context.pages().filter((page: Page): boolean => page.url().startsWith("https://gemini.google.com/"))).toHaveLength(3);
  await popup.close();
});
