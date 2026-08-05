// @vitest-environment node

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveImage } from "../src/daemon/image-resolver";

let server: Server | undefined;

afterEach(async (): Promise<void> => {
  if (server !== undefined) {
    await new Promise<void>((resolve): void => { server?.close((): void => resolve()); });
    server = undefined;
  }
});

describe("image resolver", (): void => {
  it("decodes an image data URL", async (): Promise<void> => {
    const image = await resolveImage("data:image/png;base64,AQID");
    expect(image.mediaType).toBe("image/png");
    expect(image.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("downloads an image URL", async (): Promise<void> => {
    server = createServer((_request, response): void => {
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(Buffer.from([4, 5, 6]));
    });
    await new Promise<void>((resolve): void => { server?.listen(0, "127.0.0.1", (): void => resolve()); });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not start");
    }
    const image = await resolveImage(`http://127.0.0.1:${address.port}/image.jpg`);
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });
});
