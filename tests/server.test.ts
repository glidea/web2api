// @vitest-environment node

import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonServer } from "../src/daemon/server";

let daemon: DaemonServer | undefined;

afterEach(async (): Promise<void> => {
  await daemon?.close();
  daemon = undefined;
});

describe("daemon server", (): void => {
  it("exposes every default provider without a dynamic model source", async (): Promise<void> => {
    const port: number = await getFreePort();
    daemon = new DaemonServer(
      { api_key: "wb2_server_test", port, chatgpt_tabs: 2, gemini_tabs: 2, grok_tabs: 2 },
      { extensionConnected: false, workersReady: 0 }
    );
    await daemon.listen();

    const response: Response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: "Bearer wb2_server_test" }
    });

    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "chatgpt/default", object: "model", owned_by: "web2api" },
        { id: "gemini/default", object: "model", owned_by: "web2api" },
        { id: "grok/default", object: "model", owned_by: "web2api" }
      ]
    });
  });
});

async function getFreePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address: ReturnType<Server["address"]> = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  server.close();
  await once(server, "close");
  return address.port;
}
