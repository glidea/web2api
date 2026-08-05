import { loadOrCreateConfig, defaultConfigPath, type ConfigOverrides, type DaemonConfig } from "./config";
import { DaemonServer, type DaemonStatus } from "./server";

type CliOptions = {
  configPath: string;
  overrides: ConfigOverrides;
};

async function main(): Promise<void> {
  const [command, ...argumentsList]: string[] = process.argv.slice(2);
  if (command !== "start") {
    throw new Error("usage: web2api start [--config path] [--port number]");
  }
  const options: CliOptions = parseOptions(argumentsList);
  const config: DaemonConfig = await loadOrCreateConfig(options.configPath, options.overrides);
  const status: DaemonStatus = { extensionConnected: false, workersReady: 0 };
  const server: DaemonServer = new DaemonServer(config, status);
  await server.listen();
  console.log(`Web2API listening on http://127.0.0.1:${config.port}`);
  console.log(`API key: ${config.api_key}`);
  console.log(`Config: ${options.configPath}`);
  console.log("Extension: disconnected");
  const stop = (): void => {
    void server.close().then((): void => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function parseOptions(argumentsList: string[]): CliOptions {
  let configPath: string = defaultConfigPath();
  let port: number | undefined;
  let maxTabs: number | undefined;
  for (let index: number = 0; index < argumentsList.length; index += 1) {
    const argument: string | undefined = argumentsList[index];
    if (argument === "--config") {
      configPath = requireValue(argumentsList, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--port") {
      port = Number(requireValue(argumentsList, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--max-tabs") {
      maxTabs = Number(requireValue(argumentsList, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { configPath, overrides: { port, maxTabs } };
}

function requireValue(argumentsList: string[], index: number, option: string): string {
  const value: string | undefined = argumentsList[index + 1];
  if (value === undefined) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

void main().catch((error: unknown): void => {
  const message: string = error instanceof Error ? error.message : String(error);
  console.error(`web2api: ${message}`);
  process.exitCode = 1;
});
