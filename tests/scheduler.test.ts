// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ConversationScheduler } from "../src/daemon/scheduler";

describe("conversation scheduler", (): void => {
  it("serializes one conversation and runs another conversation in parallel", async (): Promise<void> => {
    const scheduler: ConversationScheduler = new ConversationScheduler(2);
    scheduler.addWorker("worker-1");
    scheduler.addWorker("worker-2");
    const releaseA1: { resolve: () => void } = { resolve: (): void => undefined };
    const releaseB1: { resolve: () => void } = { resolve: (): void => undefined };
    const a1Promise: Promise<string> = scheduler.enqueue("conversation-a", async (workerId: string): Promise<string> => {
      expect(workerId).toBe("worker-1");
      await new Promise<void>((resolve): void => { releaseA1.resolve = resolve; });
      return "a1";
    });
    const a2Promise: Promise<string> = scheduler.enqueue("conversation-a", async (): Promise<string> => "a2");
    const b1Promise: Promise<string> = scheduler.enqueue("conversation-b", async (workerId: string): Promise<string> => {
      expect(workerId).toBe("worker-2");
      await new Promise<void>((resolve): void => { releaseB1.resolve = resolve; });
      return "b1";
    });
    await Promise.resolve();
    expect(scheduler.runningCount()).toBe(2);
    expect(scheduler.queueLength()).toBe(1);
    releaseB1.resolve();
    expect(await b1Promise).toBe("b1");
    releaseA1.resolve();
    expect(await a1Promise).toBe("a1");
    expect(await a2Promise).toBe("a2");
  });

  it("does not start work beyond the configured worker count", async (): Promise<void> => {
    const scheduler: ConversationScheduler = new ConversationScheduler(1);
    scheduler.addWorker("worker-1");
    let started: number = 0;
    const first: Promise<string> = scheduler.enqueue("a", async (): Promise<string> => {
      started += 1;
      await new Promise<void>((resolve): void => { setTimeout(resolve, 10); });
      return "first";
    });
    const second: Promise<string> = scheduler.enqueue("b", async (): Promise<string> => {
      started += 1;
      return "second";
    });
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(started).toBe(2);
  });
});
