// @vitest-environment node

import { describe, expect, it } from "vitest";
import { handleNativeRequest, type NativeControllerDependencies } from "../src/native/controller";
import type { DaemonConfig } from "../src/daemon/config";
import type { NativeHostResponse } from "../src/shared/native-protocol";

function dependencies(running: boolean): { value: NativeControllerDependencies; events: string[] } {
  const events: string[] = [];
  let config: DaemonConfig = { api_key: "wb2_test", port: 3210, max_tabs: 2 };
  return {
    events,
    value: {
      configPath: "/tmp/config.json",
      runtimePath: "/tmp/glidea-web2api.mjs",
      loadConfig: async (maxTabs?: number): Promise<DaemonConfig> => {
        if (maxTabs !== undefined) {
          config = { ...config, max_tabs: maxTabs };
          events.push(`configure:${maxTabs}`);
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
      max_tabs: 2
    });
    expect(fixture.events).toEqual(["start"]);

    await handleNativeRequest({ type: "ensure", protocol_version: 1 }, fixture.value);
    expect(fixture.events).toEqual(["start"]);
  });

  it("persists max tabs and restarts a running daemon", async (): Promise<void> => {
    const fixture: { value: NativeControllerDependencies; events: string[] } = dependencies(true);
    const response: NativeHostResponse = await handleNativeRequest({ type: "configure", protocol_version: 1, max_tabs: 4 }, fixture.value);

    expect(response.ok).toBe(true);
    expect(response.ok && response.max_tabs).toBe(4);
    expect(fixture.events).toEqual(["configure:4", "stop", "start"]);
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
      max_tabs: 2
    });
    expect(fixture.events).toEqual(["stop"]);
  });
});
