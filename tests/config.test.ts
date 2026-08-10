// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateConfig, type DaemonConfig } from "../src/daemon/config";

let temporaryDirectory: string | undefined;

afterEach(async (): Promise<void> => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function configPath(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "web2api-config-"));
  return join(temporaryDirectory, "config.json");
}

describe("daemon config", (): void => {
  it("creates separate default tab counts for every provider", async (): Promise<void> => {
    const path: string = await configPath();

    const config: DaemonConfig = await loadOrCreateConfig(path, {});

    expect(config.chatgpt_tabs).toBe(2);
    expect(config.gemini_tabs).toBe(2);
    expect(config.grok_tabs).toBe(2);
  });

  it("rejects the removed shared max_tabs setting", async (): Promise<void> => {
    const path: string = await configPath();
    await writeFile(path, `${JSON.stringify({ api_key: "wb2_test", port: 3210, max_tabs: 2 })}\n`);

    await expect(loadOrCreateConfig(path, {})).rejects.toThrow("invalid daemon config");
  });

  it("applies provider-specific tab overrides", async (): Promise<void> => {
    const path: string = await configPath();

    const config: DaemonConfig = await loadOrCreateConfig(path, { chatGptTabs: 3, geminiTabs: 4, grokTabs: 5 });

    expect(config.chatgpt_tabs).toBe(3);
    expect(config.gemini_tabs).toBe(4);
    expect(config.grok_tabs).toBe(5);
  });
});
