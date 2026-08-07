// @vitest-environment node

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { readNativeMessage, writeNativeMessage } from "../src/native/messaging";

describe("native messaging framing", (): void => {
  it("reads one length-prefixed JSON message across chunks", async (): Promise<void> => {
    const stream: PassThrough = new PassThrough();
    const body: Buffer = Buffer.from(JSON.stringify({ type: "ensure", protocol_version: 1 }), "utf8");
    const header: Buffer = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const reading: Promise<unknown> = readNativeMessage(stream);
    stream.write(header.subarray(0, 2));
    stream.write(Buffer.concat([header.subarray(2), body.subarray(0, 3)]));
    stream.end(body.subarray(3));

    await expect(reading).resolves.toEqual({ type: "ensure", protocol_version: 1 });
  });

  it("writes one length-prefixed JSON message", async (): Promise<void> => {
    const stream: PassThrough = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer): void => {
      chunks.push(chunk);
    });

    await writeNativeMessage(stream, { ok: true });
    const output: Buffer = Buffer.concat(chunks);
    expect(output.readUInt32LE(0)).toBe(output.length - 4);
    expect(JSON.parse(output.subarray(4).toString("utf8"))).toEqual({ ok: true });
  });
});
