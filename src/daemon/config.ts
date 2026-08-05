import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export type DaemonConfig = {
  api_key: string;
  port: number;
  max_tabs: number;
};

export type ConfigOverrides = {
  port?: number;
  maxTabs?: number;
};

export function defaultConfigPath(): string {
  return join(homedir(), ".web2api", "config.json");
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
      max_tabs: 2
    };
  }

  if (overrides.port !== undefined) {
    config.port = overrides.port;
  }
  if (overrides.maxTabs !== undefined) {
    config.max_tabs = overrides.maxTabs;
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
  if (typeof record["api_key"] !== "string" || typeof record["port"] !== "number" || typeof record["max_tabs"] !== "number") {
    throw new Error("invalid daemon config");
  }
  return {
    api_key: record["api_key"],
    port: record["port"],
    max_tabs: record["max_tabs"]
  };
}

function isFileNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record: Record<string, unknown> = error as Record<string, unknown>;
  return record["code"] === "ENOENT";
}
