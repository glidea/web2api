import type { ConfigOverrides, DaemonConfig } from "../daemon/config";
import type { NativeHostRequest, NativeHostResponse } from "../shared/native-protocol";

export type NativeControllerDependencies = {
  configPath: string;
  runtimePath: string;
  loadConfig: (overrides?: ConfigOverrides) => Promise<DaemonConfig>;
  isRunning: (config: DaemonConfig) => Promise<boolean>;
  start: (config: DaemonConfig) => Promise<void>;
  stop: (config: DaemonConfig) => Promise<void>;
};

export async function handleNativeRequest(request: NativeHostRequest, dependencies: NativeControllerDependencies): Promise<NativeHostResponse> {
  switch (request.type) {
    case "ensure": {
      const config: DaemonConfig = await dependencies.loadConfig();
      if (!await dependencies.isRunning(config)) {
        await dependencies.start(config);
      }
      return statusResponse(config, "running");
    }
    case "status": {
      const config: DaemonConfig = await dependencies.loadConfig();
      const running: boolean = await dependencies.isRunning(config);
      return statusResponse(config, running ? "running" : "stopped");
    }
    case "stop": {
      const config: DaemonConfig = await dependencies.loadConfig();
      if (await dependencies.isRunning(config)) {
        await dependencies.stop(config);
      }
      return statusResponse(config, "stopped");
    }
    case "configure": {
      if (!validTabCount(request.chatgpt_tabs) || !validTabCount(request.gemini_tabs)) {
        return { ok: false, protocol_version: 1, code: "invalid_tab_count", message: "tab counts must be integers between 1 and 8" };
      }
      const config: DaemonConfig = await dependencies.loadConfig({ chatGptTabs: request.chatgpt_tabs, geminiTabs: request.gemini_tabs });
      if (await dependencies.isRunning(config)) {
        await dependencies.stop(config);
      }
      await dependencies.start(config);
      return statusResponse(config, "running");
    }
  }
}

function validTabCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

function statusResponse(config: DaemonConfig, daemon: "running" | "stopped"): NativeHostResponse {
  return {
    ok: true,
    protocol_version: 1,
    daemon,
    base_url: `http://127.0.0.1:${config.port}`,
    api_key: config.api_key,
    chatgpt_tabs: config.chatgpt_tabs,
    gemini_tabs: config.gemini_tabs
  };
}
