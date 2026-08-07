import type { Readable, Writable } from "node:stream";

export async function readNativeMessage(input: Readable): Promise<unknown> {
  const iterator: AsyncIterator<unknown> = input[Symbol.asyncIterator]();
  let buffer: Buffer = Buffer.alloc(0);
  while (true) {
    const result: IteratorResult<unknown> = await iterator.next();
    if (result.done === true) {
      break;
    }
    const chunk: Buffer = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value as Uint8Array);
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) {
      continue;
    }
    const bodyLength: number = buffer.readUInt32LE(0);
    if (buffer.length < bodyLength + 4) {
      continue;
    }
    return JSON.parse(buffer.subarray(4, bodyLength + 4).toString("utf8")) as unknown;
  }
  throw new Error("native message ended before one complete frame");
}

export function writeNativeMessage(output: Writable, message: unknown): Promise<void> {
  const body: Buffer = Buffer.from(JSON.stringify(message), "utf8");
  const header: Buffer = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return new Promise<void>((resolve, reject): void => {
    output.write(Buffer.concat([header, body]), (error?: Error | null): void => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
