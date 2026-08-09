import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cancelGeneration, detectImageMediaType, enableImageGeneration, getAssistantMessageCount, getCapabilities, isGeminiLoggedIn, isGeminiUsable, parseConversationId, selectModel, selectReasoningEffort, streamAssistantText, submitPrompt, uploadImages, waitForGeneratedImage, type ImagePayload } from "../lib/gemini-adapter";
import type { Capabilities, ExtensionToDaemonMessage, JobCancelMessage, JobStartMessage } from "../../shared/protocol";

export default defineContentScript({
  matches: ["https://gemini.google.com/*"],
  main(): void {
    document.documentElement.dataset.web2apiContentScript = "ready";
    void reportContentReady();
    browser.runtime.onMessage.addListener((message: unknown): Promise<void> => {
      if (isJobStartMessage(message)) {
        void runJob(message);
      }
      if (isJobCancelMessage(message)) {
        cancelGeneration(document);
      }
      return Promise.resolve();
    });
  }
});

async function runJob(message: JobStartMessage): Promise<void> {
  try {
    if (!isGeminiUsable(document)) {
      throw new Error("gemini_unavailable");
    }
    if (message.payload.model !== "gemini/default") {
      await selectModel(document, message.payload.model.slice("gemini/".length));
    }
    if (message.payload.reasoning_effort !== undefined) {
      await selectReasoningEffort(document, message.payload.reasoning_effort);
    }
    if (message.payload.generate_image === true) {
      await enableImageGeneration(document);
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
      const completedImage: ExtensionToDaemonMessage = { version: 1, type: "job.image.completed", request_id: message.request_id, worker_id: message.worker_id, media_type: detectImageMediaType(image), data: encodeBase64(image) };
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
    const failure: ExtensionToDaemonMessage = { version: 1, type: "job.failed", request_id: message.request_id, worker_id: message.worker_id, code: "adapter_error", message: errorMessage };
    await browser.runtime.sendMessage(failure);
  }
}

async function reportContentReady(): Promise<void> {
  const deadline: number = Date.now() + 30_000;
  while (!isGeminiUsable(document)) {
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  const loggedIn: boolean = isGeminiLoggedIn(document);
  const capabilities: { models: string[]; reasoningEfforts: string[] } = await getCapabilities(document);
  await browser.runtime.sendMessage({
    type: "web2api:content-ready",
    provider: "gemini",
    url: window.location.href,
    loggedIn,
    capabilities: toProtocolCapabilities(capabilities)
  });
}

function toProtocolCapabilities(capabilities: { models: string[]; reasoningEfforts: string[] }): Capabilities {
  return {
    models: ["gemini/default", ...capabilities.models.map((model: string): string => `gemini/${model}`)],
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
  const deadline: number = Date.now() + 120_000;
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
  return value["type"] === "job.start" && value["provider"] === "gemini";
}

function isJobCancelMessage(message: unknown): message is JobCancelMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "job.cancel";
}
