import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const port: number = 3210;
const outputDirectory: string = resolve("src/extension/.output/chrome-mv3");
const fixture: string = "<!doctype html><html><head><title>ChatGPT fixture</title></head><body><main>fixture</main></body></html>";
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
  while (Date.now() < deadline) {
    const response: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body: { extension_connected: boolean; workers_ready: number } = await response.json() as { extension_connected: boolean; workers_ready: number };
    if (body.extension_connected && body.workers_ready === 2) {
      return;
    }
    await new Promise<void>((resolvePromise): void => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error("extension worker did not become ready");
}

test.beforeAll(async (): Promise<void> => {
  await startDaemon();
  userDataDirectory = await mkdtemp(join(tmpdir(), "web2api-extension-e2e-"));
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    args: [`--disable-extensions-except=${outputDirectory}`, `--load-extension=${outputDirectory}`]
  });
  await context.route("https://chatgpt.com/**", async (route): Promise<void> => {
    await route.fulfill({ contentType: "text/html", body: fixture });
  });
});

test.afterAll(async (): Promise<void> => {
  await context.close();
  daemon.kill("SIGTERM");
  await rm(userDataDirectory, { recursive: true, force: true });
  await rm(configDirectory, { recursive: true, force: true });
});

test("connects the real extension worker to daemon health", async (): Promise<void> => {
  await waitForReady();
  const workers: Worker[] = context.serviceWorkers();
  expect(workers.length).toBeGreaterThan(0);
  const pages: Page[] = context.pages();
  const workerPage: Page | undefined = pages.find((page: Page): boolean => page.url().startsWith("https://chatgpt.com/"));
  if (workerPage === undefined) {
    throw new Error("worker tab was not created");
  }
  await expect(workerPage.locator("html")).toHaveAttribute("data-web2api-content-script", "ready");
});
