import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { cancelGeneration, detectImageMediaType, enableImageGeneration, getAssistantMessageCount, getCapabilities, getGeneratedImageCount, isGrokLoggedIn, isGrokUsable, parseConversationId, selectModel, selectReasoningEffort, streamAssistantText, submitPrompt, uploadImages, waitForGeneratedImage, type ImagePayload } from "../lib/grok-adapter";
import type { Capabilities, ExtensionToDaemonMessage, JobCancelMessage, JobStartMessage } from "../../shared/protocol";

export default defineContentScript({
  matches: ["https://grok.com/*"],
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
    if (!isGrokLoggedIn(document)) {
      throw new Error("login_required");
    }
    if (!isGrokUsable(document)) {
      throw new Error("grok_unavailable");
    }
    if (message.payload.model !== "grok/default") {
      await selectModel(document, message.payload.model.slice("grok/".length));
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
    const previousGeneratedImageCount: number = getGeneratedImageCount(document);
    await submitPrompt(document, message.payload.input);
    const conversationId: string = message.payload.generate_image === true
      ? message.payload.conversation_id ?? `imagine-${crypto.randomUUID()}`
      : await waitForConversationId();
    const bound: ExtensionToDaemonMessage = { version: 1, type: "job.conversation_bound", request_id: message.request_id, worker_id: message.worker_id, conversation_id: conversationId };
    await browser.runtime.sendMessage(bound);
    if (message.payload.generate_image === true) {
      const image: Uint8Array = await waitForGeneratedImage(document, previousGeneratedImageCount, downloadGeneratedImage);
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
    const code: "login_required" | "adapter_error" = errorMessage === "login_required" ? "login_required" : "adapter_error";
    const failure: ExtensionToDaemonMessage = { version: 1, type: "job.failed", request_id: message.request_id, worker_id: message.worker_id, code, message: errorMessage };
    await browser.runtime.sendMessage(failure);
  }
}

async function reportContentReady(): Promise<void> {
  const deadline: number = Date.now() + 30_000;
  while (!isGrokUsable(document)) {
    if (Date.now() >= deadline) {
      return;
    }
    await delay(100);
  }
  const loggedIn: boolean = isGrokLoggedIn(document);
  const capabilities: { models: string[]; reasoningEfforts: string[] } = await getCapabilities(document);
  await browser.runtime.sendMessage({
    type: "web2api:content-ready",
    provider: "grok",
    url: window.location.href,
    loggedIn,
    capabilities: toProtocolCapabilities(capabilities)
  });
}

function toProtocolCapabilities(capabilities: { models: string[]; reasoningEfforts: string[] }): Capabilities {
  return {
    models: ["grok/default", ...capabilities.models.map((model: string): string => `grok/${model}`)],
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

async function downloadGeneratedImage(url: string): Promise<Uint8Array> {
  const response: unknown = await browser.runtime.sendMessage({ type: "web2api:download-image", url });
  if (typeof response !== "object" || response === null) {
    throw new Error("generated_image_download_failed");
  }
  const value: Record<string, unknown> = response as Record<string, unknown>;
  const data: unknown = value["data"];
  if (typeof data !== "string") {
    throw new Error("generated_image_download_failed");
  }
  const binary: string = atob(data);
  const bytes: Uint8Array = new Uint8Array(binary.length);
  for (let index: number = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function waitForConversationId(): Promise<string> {
  const deadline: number = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const conversationId: string | undefined = parseConversationId(window.location.href);
    if (conversationId !== undefined) {
      return conversationId;
    }
    await delay(100);
  }
  throw new Error("conversation_id_not_found");
}

function isJobStartMessage(message: unknown): message is JobStartMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "job.start" && value["provider"] === "grok";
}

function isJobCancelMessage(message: unknown): message is JobCancelMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "job.cancel";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}
