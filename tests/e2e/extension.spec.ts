import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionOutputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const chatgptFixture: string = `<!doctype html><html><head><title>ChatGPT fixture</title></head><body><main>fixture</main></body></html>`;

let context: BrowserContext;
let userDataDirectory: string;
let extensionId: string;

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

test.beforeAll(async (): Promise<void> => {
  userDataDirectory = await mkdtemp(join(tmpdir(), "web2api-extension-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionOutputDirectory}`,
      `--load-extension=${extensionOutputDirectory}`
    ]
  });
  await context.route("https://chatgpt.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: chatgptFixture });
  });
  await context.route("https://example.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>example</body></html>" });
  });
  extensionId = await findExtensionId(context);
});

test.afterAll(async (): Promise<void> => {
  await context.close();
  await rm(userDataDirectory, { recursive: true, force: true });
});

test("loads the extension and exposes its service worker", async (): Promise<void> => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("injects content script only into ChatGPT pages", async (): Promise<void> => {
  const chatgptPage: Page = await context.newPage();
  await chatgptPage.goto("https://chatgpt.com/");
  await expect(chatgptPage.locator("html")).toHaveAttribute("data-web2api-content-script", "ready");
  await chatgptPage.close();

  const otherPage: Page = await context.newPage();
  await otherPage.goto("https://example.com/");
  await expect(otherPage.locator("html")).not.toHaveAttribute("data-web2api-content-script", "ready");
  await otherPage.close();
});

test("opens popup and reports content script readiness", async (): Promise<void> => {
  const popup: Page = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole("heading", { name: "Web2API" })).toBeVisible();
  await expect(popup.getByText("Local companion required")).toBeVisible();
  await expect(popup.getByText(`npx -y glidea-web2api@latest install --extension-id ${extensionId}`)).toBeVisible();
  await expect(popup.getByText("Content script ready")).toBeVisible();
  await expect(popup.getByText("ChatGPT Logged in")).toBeVisible();
  await expect(popup.getByText("Models chatgpt/default")).toBeVisible();
  await popup.getByRole("button", { name: "Check again" }).click();
  await expect(popup.getByText("Local companion required")).toBeVisible();
  await popup.close();
});
