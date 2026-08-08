import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cancelGeneration, getAssistantMessageCount, getCapabilities, isChatGPTLoggedIn, parseConversationId, selectModel, selectReasoningEffort, streamAssistantText, submitPrompt, uploadImages, waitForGeneratedImage, type ImagePayload } from "../lib/chatgpt-adapter";
import type { Capabilities, JobCancelMessage, JobStartMessage, ExtensionToDaemonMessage } from "../../shared/protocol";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  main(): void {
    document.documentElement.dataset.web2apiContentScript = "ready";
    void reportContentReady();
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
    if (!isChatGPTLoggedIn(document)) {
      throw new Error("chatgpt_login_required");
    }
    if (message.payload.model !== "chatgpt/default") {
      await selectModel(document, message.payload.model.slice("chatgpt/".length));
    }
    if (message.payload.reasoning_effort !== undefined) {
      await selectReasoningEffort(document, message.payload.reasoning_effort);
    }
    if (message.payload.images !== undefined) {
      await uploadImages(document, message.payload.images.map(toImagePayload));
    }
    const previousMessageCount: number = getAssistantMessageCount(document);
    await submitPrompt(document, message.payload.input);
    const conversationId: string = await waitForConversationId();
    const bound: ExtensionToDaemonMessage = { version: 1, type: "job.conversation_bound", request_id: message.request_id, worker_id: message.worker_id, conversation_id: conversationId };
    await browser.runtime.sendMessage(bound);
    if (message.payload.generate_image === true) {
      const image: Uint8Array = await waitForGeneratedImage(document, previousMessageCount);
      const completedImage: ExtensionToDaemonMessage = { version: 1, type: "job.image.completed", request_id: message.request_id, worker_id: message.worker_id, media_type: "image/png", data: encodeBase64(image) };
      await browser.runtime.sendMessage(completedImage);
    } else {
      let sequence: number = 0;
      await streamAssistantText(document, previousMessageCount, async (textDelta: string): Promise<void> => {
        sequence += 1;
        const delta: ExtensionToDaemonMessage = { version: 1, type: "job.output_text.delta", request_id: message.request_id, worker_id: message.worker_id, sequence, delta: textDelta };
        await browser.runtime.sendMessage(delta);
      });
    }
    const completed: ExtensionToDaemonMessage = { version: 1, type: "job.completed", request_id: message.request_id, worker_id: message.worker_id };
    await browser.runtime.sendMessage(completed);
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    const code: string = errorMessage === "chatgpt_login_required" ? errorMessage : "chatgpt_adapter_error";
    const failure: ExtensionToDaemonMessage = { version: 1, type: "job.failed", request_id: message.request_id, worker_id: message.worker_id, code, message: errorMessage };
    await browser.runtime.sendMessage(failure);
  }
}

async function reportContentReady(): Promise<void> {
  await browser.runtime.sendMessage({
    type: "web2api:content-ready",
    url: window.location.href,
    loggedIn: isChatGPTLoggedIn(document),
    capabilities: { models: ["chatgpt/default"], reasoning_efforts: [] }
  });
  const capabilities: { models: string[]; reasoningEfforts: string[] } = await getCapabilities(document);
  await browser.runtime.sendMessage({
    type: "web2api:content-ready",
    url: window.location.href,
    loggedIn: isChatGPTLoggedIn(document),
    capabilities: toProtocolCapabilities(capabilities)
  });
}

function toProtocolCapabilities(capabilities: { models: string[]; reasoningEfforts: string[] }): Capabilities {
  return {
    models: ["chatgpt/default", ...capabilities.models.map((model: string): string => model.startsWith("chatgpt/") ? model : `chatgpt/${model}`)],
    reasoning_efforts: capabilities.reasoningEfforts
  };
}

function toImagePayload(image: { data: string; media_type: string; name: string }): ImagePayload {
  const binary: string = atob(image.data);
  const bytes: Uint8Array = new Uint8Array(binary.length);
  for (let index: number = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { bytes, mediaType: image.media_type, name: image.name };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary: string = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
