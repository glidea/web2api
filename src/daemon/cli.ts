import { closeSync, fchmodSync, openSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { loadOrCreateConfig, defaultConfigPath, type ConfigOverrides, type DaemonConfig } from "./config";
import { DaemonServer, type DaemonStatus, type ModelList } from "./server";
import { ExtensionGateway } from "./extension-gateway";
import { ResponsesService } from "./responses";
import { defaultNativeInstallOptions, inspectNativeHost, installNativeHost, uninstallNativeHost, type NativeInstallInspection, type NativeInstallOptions, type NativeInstallResult } from "../native/installer";
import { readNativeMessage, writeNativeMessage } from "../native/messaging";
import { handleNativeRequest, type NativeControllerDependencies } from "../native/controller";
import type { NativeHostRequest, NativeHostResponse } from "../shared/native-protocol";

type CliOptions = {
  configPath: string;
  overrides: ConfigOverrides;
};

const runtimePath: string = process.env["GLIDEA_WEB2API_RUNTIME_PATH"] ?? process.argv[1] ?? "";

async function main(): Promise<void> {
  const [command, ...argumentsList]: string[] = process.argv.slice(2);
  switch (command) {
    case "start":
      await runDaemon(argumentsList);
      return;
    case "install":
      await runInstall(argumentsList);
      return;
    case "uninstall":
      await runUninstall(argumentsList);
      return;
    case "doctor":
      await runDoctor(argumentsList);
      return;
    case "native-host":
      await runNativeHost();
      return;
    default:
      throw new Error("usage: glidea-web2api <start|install|uninstall|doctor>");
  }
}

async function runDaemon(argumentsList: string[]): Promise<void> {
  const options: CliOptions = parseDaemonOptions(argumentsList);
  const config: DaemonConfig = await loadOrCreateConfig(options.configPath, options.overrides);
  const status: DaemonStatus = { extensionConnected: false, workersReady: 0 };
  const server: DaemonServer = new DaemonServer(config, status);
  const gateway: ExtensionGateway = new ExtensionGateway(server, config, status);
  const responses: ResponsesService = new ResponsesService(gateway);
  server.setModelsProvider((): ModelList => ({ object: "list", data: gateway.models().map((id: string): ModelList["data"][number] => ({ id, object: "model", owned_by: "web2api" })) }));
  server.setResponsesHandler((request, response): void => {
    void responses.handle(request, response);
  });
  await server.listen();
  if (process.env["WEB2API_DAEMON_BACKGROUND"] !== "1") {
    console.log(`Web2API listening on http://127.0.0.1:${config.port}`);
    console.log(`API key: ${config.api_key}`);
    console.log(`Config: ${options.configPath}`);
    console.log("Extension: disconnected");
  }
  let stopping: boolean = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    gateway.close();
    void server.close().then((): void => {
      process.exit(0);
    });
  };
  server.setStopHandler(stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runInstall(argumentsList: string[]): Promise<void> {
  const extensionId: string = parseExtensionId(argumentsList);
  const options: NativeInstallOptions = defaultNativeInstallOptions(extensionId, runtimePath);
  const installed: NativeInstallResult = await installNativeHost(options);
  await loadOrCreateConfig(defaultConfigPath(), { extensionId });
  console.log("Native host: installed");
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Host: ${installed.hostPath}`);
}

async function runUninstall(argumentsList: string[]): Promise<void> {
  const extensionId: string = parseExtensionId(argumentsList);
  const options: NativeInstallOptions = defaultNativeInstallOptions(extensionId, runtimePath);
  await uninstallNativeHost(options);
  console.log("Native host: uninstalled");
}

async function runDoctor(argumentsList: string[]): Promise<void> {
  const extensionId: string = parseExtensionId(argumentsList);
  const options: NativeInstallOptions = defaultNativeInstallOptions(extensionId, runtimePath);
  const inspection: NativeInstallInspection = await inspectNativeHost(options);
  console.log(`Native host: ${inspection.installed ? "installed" : "missing"}`);
  const config: DaemonConfig = await loadOrCreateConfig(defaultConfigPath(), {});
  console.log(`Daemon: ${await isDaemonRunning(config) ? "running" : "stopped"}`);
  console.log(`Base URL: http://127.0.0.1:${config.port}`);
}

async function runNativeHost(): Promise<void> {
  try {
    const value: unknown = await readNativeMessage(process.stdin);
    if (!isNativeHostRequest(value)) {
      await writeNativeMessage(process.stdout, { ok: false, protocol_version: 1, code: "invalid_request", message: "Invalid native host request" });
      return;
    }
    const response: NativeHostResponse = await handleNativeRequest(value, nativeControllerDependencies());
    await writeNativeMessage(process.stdout, response);
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    await writeNativeMessage(process.stdout, { ok: false, protocol_version: 1, code: "native_host_error", message });
  }
}

function nativeControllerDependencies(): NativeControllerDependencies {
  const configPath: string = defaultConfigPath();
  return {
    configPath,
    runtimePath,
    loadConfig: async (overrides?: ConfigOverrides): Promise<DaemonConfig> => loadOrCreateConfig(configPath, overrides ?? {}),
    isRunning: isDaemonRunning,
    start: async (config: DaemonConfig): Promise<void> => startDetachedDaemon(config, configPath),
    stop: stopDaemon
  };
}

async function isDaemonRunning(config: DaemonConfig): Promise<boolean> {
  try {
    const response: Response = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
      headers: { Authorization: `Bearer ${config.api_key}` },
      signal: AbortSignal.timeout(500)
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function startDetachedDaemon(config: DaemonConfig, configPath: string): Promise<void> {
  const logPath: string = join(dirname(configPath), "daemon.log");
  const log: number = openSync(logPath, "a", 0o600);
  fchmodSync(log, 0o600);
  const environment: NodeJS.ProcessEnv = { ...process.env, WEB2API_DAEMON_BACKGROUND: "1" };
  const child: ChildProcess = spawn(process.execPath, [runtimePath, "start", "--config", configPath], {
    detached: true,
    env: environment,
    stdio: ["ignore", log, log]
  });
  child.unref();
  closeSync(log);
  await waitForDaemon(config, true);
}

async function stopDaemon(config: DaemonConfig): Promise<void> {
  const response: Response = await fetch(`http://127.0.0.1:${config.port}/_web2api/control/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.api_key}` },
    signal: AbortSignal.timeout(1_000)
  });
  if (response.status !== 200) {
    throw new Error(`daemon stop failed with HTTP ${response.status}`);
  }
  await waitForDaemon(config, false);
}

async function waitForDaemon(config: DaemonConfig, running: boolean): Promise<void> {
  const deadline: number = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isDaemonRunning(config) === running) {
      return;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(running ? "daemon did not start" : "daemon did not stop");
}

function parseDaemonOptions(argumentsList: string[]): CliOptions {
  let configPath: string = defaultConfigPath();
  let port: number | undefined;
  let chatGptTabs: number | undefined;
  let geminiTabs: number | undefined;
  for (let index: number = 0; index < argumentsList.length; index += 1) {
    const argument: string | undefined = argumentsList[index];
    switch (argument) {
      case "--config":
        configPath = requireValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--port":
        port = Number(requireValue(argumentsList, index, argument));
        index += 1;
        break;
      case "--chatgpt-tabs":
        chatGptTabs = Number(requireValue(argumentsList, index, argument));
        index += 1;
        break;
      case "--gemini-tabs":
        geminiTabs = Number(requireValue(argumentsList, index, argument));
        index += 1;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  return { configPath, overrides: { port, chatGptTabs, geminiTabs } };
}

function parseExtensionId(argumentsList: string[]): string {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--extension-id") {
    throw new Error("missing required option: --extension-id <id>");
  }
  return requireValue(argumentsList, 0, "--extension-id");
}

function requireValue(argumentsList: string[], index: number, option: string): string {
  const value: string | undefined = argumentsList[index + 1];
  if (value === undefined) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

function isNativeHostRequest(value: unknown): value is NativeHostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (record["protocol_version"] !== 1) {
    return false;
  }
  switch (record["type"]) {
    case "ensure":
    case "status":
    case "stop":
      return true;
    case "configure":
      return typeof record["chatgpt_tabs"] === "number" && typeof record["gemini_tabs"] === "number";
    default:
      return false;
  }
}

void main().catch((error: unknown): void => {
  const message: string = error instanceof Error ? error.message : String(error);
  console.error(`glidea-web2api: ${message}`);
  process.exitCode = 1;
});
