import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const profileDirectory: string = process.env["WEB2API_CHATGPT_PROFILE"] ?? join(homedir(), ".web2api", "chatgpt-profile");
const executablePath: string | undefined = process.env["WEB2API_CHATGPT_EXECUTABLE"];
const extensionDirectory: string = resolve("src/extension/.output/chrome-mv3");

await mkdir(profileDirectory, { recursive: true });

const context: BrowserContext = await chromium.launchPersistentContext(profileDirectory, {
  headless: false,
  executablePath,
  args: ["--no-first-run", "--no-default-browser-check", `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
});

try {
  const page: Page = await context.newPage();
  await page.goto("https://chatgpt.com/");
  await page.bringToFront();
  const pages: Page[] = context.pages();
  for (const candidate of pages) {
    if (candidate !== page && candidate.url().startsWith("chrome://ungoogled-first-run")) {
      await candidate.close();
    }
  }
  process.stdout.write("Log in to ChatGPT in the opened Chromium window. This command will exit automatically when the profile is ready.\n");
  await page.locator("#prompt-textarea:visible, textarea[data-testid=composer]:visible, [contenteditable=true]:visible").first().waitFor({ state: "visible", timeout: 0 });
  await page.locator('input[data-testid="upload-photos-input"], input[data-testid="upload-input"]').first().waitFor({ state: "attached", timeout: 30_000 });
  process.stdout.write(`ChatGPT profile is ready: ${profileDirectory}\n`);
} finally {
  await context.close();
}
