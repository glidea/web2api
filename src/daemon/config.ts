import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export type DaemonConfig = {
  api_key: string;
  port: number;
  chatgpt_tabs: number;
  gemini_tabs: number;
  extension_id?: string;
};

export type ConfigOverrides = {
  port?: number;
  chatGptTabs?: number;
  geminiTabs?: number;
  extensionId?: string;
};

export function defaultDataDirectory(): string {
  const override: string | undefined = process.env["WEB2API_DATA_DIR"];
  if (override !== undefined) {
    return override;
  }
  if (process.platform === "win32") {
    const localAppData: string | undefined = process.env["LOCALAPPDATA"];
    if (localAppData === undefined) {
      throw new Error("LOCALAPPDATA is required on Windows");
    }
    return join(localAppData, "Glidea", "Web2API");
  }
  return join(homedir(), ".web2api");
}

export function defaultConfigPath(): string {
  return join(defaultDataDirectory(), "config.json");
}

export async function loadOrCreateConfig(path: string, overrides: ConfigOverrides): Promise<DaemonConfig> {
  let config: DaemonConfig;
  try {
    const content: string = await readFile(path, "utf8");
    config = parseConfig(content);
  } catch (error: unknown) {
    if (!isFileNotFound(error)) {
      throw error;
    }
    config = {
      api_key: `wb2_${randomBytes(24).toString("base64url")}`,
      port: 3210,
      chatgpt_tabs: 2,
      gemini_tabs: 2
    };
  }

  if (overrides.port !== undefined) {
    config.port = overrides.port;
  }
  if (overrides.chatGptTabs !== undefined) {
    config.chatgpt_tabs = overrides.chatGptTabs;
  }
  if (overrides.geminiTabs !== undefined) {
    config.gemini_tabs = overrides.geminiTabs;
  }
  if (overrides.extensionId !== undefined) {
    config.extension_id = overrides.extensionId;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return config;
}

function parseConfig(content: string): DaemonConfig {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid daemon config");
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (typeof record["api_key"] !== "string" || typeof record["port"] !== "number" || typeof record["chatgpt_tabs"] !== "number" || typeof record["gemini_tabs"] !== "number") {
    throw new Error("invalid daemon config");
  }
  const extensionId: unknown = record["extension_id"];
  if (extensionId !== undefined && (typeof extensionId !== "string" || !/^[a-p]{32}$/.test(extensionId))) {
    throw new Error("invalid daemon config");
  }
  return {
    api_key: record["api_key"],
    port: record["port"],
    chatgpt_tabs: record["chatgpt_tabs"],
    gemini_tabs: record["gemini_tabs"],
    ...(typeof extensionId === "string" ? { extension_id: extensionId } : {})
  };
}

function isFileNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record: Record<string, unknown> = error as Record<string, unknown>;
  return record["code"] === "ENOENT";
}
