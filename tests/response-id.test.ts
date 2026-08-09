// @vitest-environment node

import { describe, expect, it } from "vitest";
import { decodeResponseId, encodeResponseId } from "../src/daemon/response-id";

describe("response id", (): void => {
  it("round trips a conversation id", (): void => {
    const id: string = encodeResponseId("gemini", "conversation_123", "turn-1");
    expect(id).toBe("resp_gemini_conversation_123_turn-1");
    expect(decodeResponseId(id)).toEqual({ provider: "gemini", conversationId: "conversation_123", turnId: "turn-1" });
  });

  it("rejects ids outside the web2api format", (): void => {
    expect((): void => { decodeResponseId("resp_invalid"); }).toThrow("Invalid response id");
  });

  it("rejects ids with an unsupported provider", (): void => {
    expect((): void => { decodeResponseId("resp_unknown_conversation_turn"); }).toThrow("Invalid response id");
  });
});
