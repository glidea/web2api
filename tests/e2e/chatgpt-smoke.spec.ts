import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const profileDirectory: string | undefined = process.env["WEB2API_CHATGPT_PROFILE"];
test.skip(profileDirectory === undefined, "set WEB2API_CHATGPT_PROFILE to a dedicated logged-in profile");

let context: BrowserContext;
let page: Page;

test.beforeAll(async (): Promise<void> => {
  context = await chromium.launchPersistentContext(profileDirectory as string, { headless: false });
  page = await context.newPage();
  await page.goto("https://chatgpt.com/");
});

test.afterAll(async (): Promise<void> => {
  await context.close();
});

test("opens a real logged-in ChatGPT page for adapter smoke testing", async (): Promise<void> => {
  await expect(page).toHaveURL(/chatgpt\.com/);
  await expect(page.locator("body")).not.toHaveText(/log in|sign up/i);
});
