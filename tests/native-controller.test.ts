// @vitest-environment node

import { describe, expect, it } from "vitest";
import { handleNativeRequest, type NativeControllerDependencies } from "../src/native/controller";
import type { ConfigOverrides, DaemonConfig } from "../src/daemon/config";
import type { NativeHostResponse } from "../src/shared/native-protocol";

function dependencies(running: boolean): { value: NativeControllerDependencies; events: string[] } {
  const events: string[] = [];
  let config: DaemonConfig = { api_key: "wb2_test", port: 3210, chatgpt_tabs: 2, gemini_tabs: 3 };
  return {
    events,
    value: {
      configPath: "/tmp/config.json",
      runtimePath: "/tmp/glidea-web2api.mjs",
      loadConfig: async (overrides?: ConfigOverrides): Promise<DaemonConfig> => {
        if (overrides?.chatGptTabs !== undefined && overrides.geminiTabs !== undefined) {
          config = { ...config, chatgpt_tabs: overrides.chatGptTabs, gemini_tabs: overrides.geminiTabs };
          events.push(`configure:${overrides.chatGptTabs}:${overrides.geminiTabs}`);
        }
        return config;
      },
      isRunning: async (): Promise<boolean> => running,
      start: async (): Promise<void> => {
        running = true;
        events.push("start");
      },
      stop: async (): Promise<void> => {
        running = false;
        events.push("stop");
      }
    }
  };
}

describe("native host controller", (): void => {
  it("starts the daemon only when it is not running", async (): Promise<void> => {
    const fixture: { value: NativeControllerDependencies; events: string[] } = dependencies(false);
    const response: NativeHostResponse = await handleNativeRequest({ type: "ensure", protocol_version: 1 }, fixture.value);

    expect(response).toEqual({
      ok: true,
      protocol_version: 1,
      daemon: "running",
      base_url: "http://127.0.0.1:3210",
      api_key: "wb2_test",
      chatgpt_tabs: 2,
      gemini_tabs: 3
    });
    expect(fixture.events).toEqual(["start"]);

    await handleNativeRequest({ type: "ensure", protocol_version: 1 }, fixture.value);
    expect(fixture.events).toEqual(["start"]);
  });

  it("persists provider tab counts and restarts a running daemon", async (): Promise<void> => {
    const fixture: { value: NativeControllerDependencies; events: string[] } = dependencies(true);
    const response: NativeHostResponse = await handleNativeRequest({ type: "configure", protocol_version: 1, chatgpt_tabs: 4, gemini_tabs: 5 }, fixture.value);

    expect(response.ok).toBe(true);
    expect(response.ok && response.chatgpt_tabs).toBe(4);
    expect(response.ok && response.gemini_tabs).toBe(5);
    expect(fixture.events).toEqual(["configure:4:5", "stop", "start"]);
  });

  it("stops a running daemon", async (): Promise<void> => {
    const fixture: { value: NativeControllerDependencies; events: string[] } = dependencies(true);
    const response: NativeHostResponse = await handleNativeRequest({ type: "stop", protocol_version: 1 }, fixture.value);

    expect(response).toEqual({
      ok: true,
      protocol_version: 1,
      daemon: "stopped",
      base_url: "http://127.0.0.1:3210",
      api_key: "wb2_test",
      chatgpt_tabs: 2,
      gemini_tabs: 3
    });
    expect(fixture.events).toEqual(["stop"]);
  });
});
