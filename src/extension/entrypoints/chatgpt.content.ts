import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cancelGeneration, getCapabilities, parseConversationId, selectModel, selectReasoningEffort, submitPrompt, waitForFinalAssistantText } from "../lib/chatgpt-adapter";
import type { Capabilities, JobCancelMessage, JobStartMessage, ExtensionToDaemonMessage } from "../../shared/protocol";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  main(): void {
    document.documentElement.dataset.web2apiContentScript = "ready";
    void browser.runtime.sendMessage({
      type: "web2api:content-ready",
      url: window.location.href,
      capabilities: toProtocolCapabilities(getCapabilities(document))
    });
    browser.runtime.onMessage.addListener((message: unknown): Promise<void> => {
      if (isJobStartMessage(message)) {
        void runTextJob(message);
      }
      if (isJobCancelMessage(message)) {
        cancelGeneration(document);
      }
      return Promise.resolve();
    });
  }
});

async function runTextJob(message: JobStartMessage): Promise<void> {
  try {
    if (message.payload.conversation_id !== undefined) {
      window.history.pushState({}, "", `/c/${encodeURIComponent(message.payload.conversation_id)}`);
    }
    if (message.payload.model !== "chatgpt/default") {
      selectModel(document, message.payload.model.slice("chatgpt/".length));
    }
    if (message.payload.reasoning_effort !== undefined) {
      selectReasoningEffort(document, message.payload.reasoning_effort);
    }
    submitPrompt(document, message.payload.input);
    const conversationId: string = await waitForConversationId();
    const bound: ExtensionToDaemonMessage = { version: 1, type: "job.conversation_bound", request_id: message.request_id, worker_id: message.worker_id, conversation_id: conversationId };
    await browser.runtime.sendMessage(bound);
    const text: string = await waitForFinalAssistantText(document);
    const delta: ExtensionToDaemonMessage = { version: 1, type: "job.output_text.delta", request_id: message.request_id, worker_id: message.worker_id, sequence: 1, delta: text };
    await browser.runtime.sendMessage(delta);
    const completed: ExtensionToDaemonMessage = { version: 1, type: "job.completed", request_id: message.request_id, worker_id: message.worker_id };
    await browser.runtime.sendMessage(completed);
  } catch (error: unknown) {
    const failure: ExtensionToDaemonMessage = { version: 1, type: "job.failed", request_id: message.request_id, worker_id: message.worker_id, code: "chatgpt_adapter_error", message: error instanceof Error ? error.message : String(error) };
    await browser.runtime.sendMessage(failure);
  }
}

function toProtocolCapabilities(capabilities: { models: string[]; reasoningEfforts: string[] }): Capabilities {
  return {
    models: ["chatgpt/default", ...capabilities.models.map((model: string): string => model.startsWith("chatgpt/") ? model : `chatgpt/${model}`)],
    reasoning_efforts: capabilities.reasoningEfforts
  };
}

async function waitForConversationId(): Promise<string> {
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const conversationId: string | undefined = parseConversationId(window.location.href);
    if (conversationId !== undefined) {
      return conversationId;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("conversation_id_not_found");
}

function isJobStartMessage(message: unknown): message is JobStartMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "job.start";
}

function isJobCancelMessage(message: unknown): message is JobCancelMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "job.cancel";
}
