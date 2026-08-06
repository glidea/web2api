export type ImagePayload = {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
};

export type ChatGPTCapabilities = {
  models: string[];
  reasoningEfforts: string[];
};

export function parseConversationId(url: string): string | undefined {
  const parsedUrl: URL = new URL(url);
  const match: RegExpMatchArray | null = parsedUrl.pathname.match(/^\/c\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

export class AssistantTextReader {
  private readonly node: HTMLElement;
  private previousText: string = "";

  public constructor(node: HTMLElement) {
    this.node = node;
  }

  public readDelta(): string {
    const currentText: string = this.node.textContent ?? "";
    if (currentText.length < this.previousText.length) {
      return "";
    }
    if (!currentText.startsWith(this.previousText)) {
      throw new Error("assistant_text_rewritten");
    }
    const delta: string = currentText.slice(this.previousText.length);
    this.previousText = currentText;
    return delta;
  }
}

export function getAssistantMessageCount(documentRoot: Document): number {
  return documentRoot.querySelectorAll("[data-message-author-role=assistant]").length;
}

export function getCapabilities(documentRoot: Document): ChatGPTCapabilities {
  const models: string[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-testid=model-selector] [data-model-id]"))
    .map((element: HTMLElement): string => element.dataset.modelId as string);
  const reasoningEfforts: string[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-testid=reasoning-selector] [data-effort]"))
    .map((element: HTMLElement): string => element.dataset.effort as string);
  return { models, reasoningEfforts };
}

export function selectModel(documentRoot: Document, model: string): void {
  const selector: HTMLElement = documentRoot.querySelector("[data-testid=model-selector]") as HTMLElement;
  const option: HTMLElement | null = selector.querySelector(`[data-model-id="${CSS.escape(model)}"]`);
  if (option === null) {
    throw new Error("model_not_available");
  }
  selector.setAttribute("data-selected-model", model);
  option.click();
}

export function selectReasoningEffort(documentRoot: Document, effort: string): void {
  const selector: HTMLElement = documentRoot.querySelector("[data-testid=reasoning-selector]") as HTMLElement;
  const option: HTMLElement | null = selector.querySelector(`[data-effort="${CSS.escape(effort)}"]`);
  if (option === null) {
    throw new Error("unsupported_reasoning_effort");
  }
  selector.setAttribute("data-selected-effort", effort);
  option.click();
}

export async function uploadImages(documentRoot: Document, images: ImagePayload[]): Promise<void> {
  const input: HTMLInputElement | null = documentRoot.querySelector("input[data-testid=upload-photos-input], input[data-testid=upload-input]");
  if (input === null) {
    throw new Error("upload_input_not_found");
  }
  const transfer: DataTransfer = new DataTransfer();
  for (const image of images) {
    const blob: Blob = new Blob([image.bytes.buffer as ArrayBuffer], { type: image.mediaType });
    transfer.items.add(new File([blob], image.name, { type: image.mediaType }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function submitPrompt(documentRoot: Document, prompt: string): Promise<void> {
  const composer: HTMLElement | null = documentRoot.querySelector("#prompt-textarea, textarea[data-testid=composer]");
  if (composer === null) {
    throw new Error("composer_not_found");
  }
  if (composer instanceof HTMLTextAreaElement) {
    composer.value = prompt;
  } else {
    composer.textContent = prompt;
  }
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  const sendButton: HTMLButtonElement = await waitForElement<HTMLButtonElement>(documentRoot, "button[data-testid=send-button]", 2_000);
  sendButton.click();
}

export function cancelGeneration(documentRoot: Document): void {
  const stopButton: HTMLButtonElement | null = documentRoot.querySelector("button[data-testid=stop-button]");
  stopButton?.click();
}

export async function waitForFinalAssistantText(documentRoot: Document): Promise<string> {
  let stableText: string = "";
  let stableReads: number = 0;
  const deadline: number = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const assistants: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-message-author-role=assistant]"));
    const currentText: string = assistants.at(-1)?.textContent ?? "";
    if (currentText.length > 0 && currentText === stableText) {
      stableReads += 1;
    } else {
      stableText = currentText;
      stableReads = 0;
    }
    const stopButton: HTMLElement | null = documentRoot.querySelector("[data-testid=stop-button]");
    if (stableText.length > 0 && stableReads >= 2 && stopButton === null) {
      return stableText;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("assistant_text_timeout");
}

export async function streamAssistantText(documentRoot: Document, previousMessageCount: number, onDelta: (delta: string) => void | Promise<void>): Promise<string> {
  let reader: AssistantTextReader | undefined;
  let assistant: HTMLElement | undefined;
  let stableText: string = "";
  let stableReads: number = 0;
  const deadline: number = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const assistants: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-message-author-role=assistant]"));
    const currentAssistant: HTMLElement | undefined = assistants[previousMessageCount];
    if (currentAssistant !== undefined && currentAssistant !== assistant) {
      assistant = currentAssistant;
      reader = new AssistantTextReader(currentAssistant);
    }
    const delta: string = reader?.readDelta() ?? "";
    if (delta.length > 0) {
      await onDelta(delta);
    }
    const currentText: string = assistant?.textContent ?? "";
    if (currentText.length > 0 && currentText === stableText) {
      stableReads += 1;
    } else {
      stableText = currentText;
      stableReads = 0;
    }
    const stopButton: HTMLElement | null = documentRoot.querySelector("[data-testid=stop-button]");
    if (stableText.length > 0 && stableReads >= 2 && stopButton === null) {
      return stableText;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("assistant_text_timeout");
}

export async function extractGeneratedImage(documentRoot: Document): Promise<Uint8Array | undefined> {
  const images: HTMLImageElement[] = Array.from(documentRoot.querySelectorAll<HTMLImageElement>("img[data-generated-image], [data-message-author-role=assistant] img[src]"));
  const image: HTMLImageElement | undefined = images.at(-1);
  if (image === undefined) {
    return undefined;
  }
  const source: string = image.currentSrc || image.src;
  if (source.startsWith("data:")) {
    return decodeDataUrl(source);
  }
  const response: Response = await fetch(source);
  return new Uint8Array(await response.arrayBuffer());
}

async function waitForElement<T extends Element>(documentRoot: Document, selector: string, timeout: number): Promise<T> {
  const deadline: number = Date.now() + timeout;
  while (Date.now() < deadline) {
    const element: T | null = documentRoot.querySelector<T>(selector);
    if (element !== null) {
      return element;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("send_button_not_found");
}

function decodeDataUrl(source: string): Uint8Array {
  const separator: number = source.indexOf(",");
  const metadata: string = source.slice(0, separator);
  const data: string = source.slice(separator + 1);
  if (metadata.endsWith(";base64")) {
    const binary: string = atob(data);
    const bytes: Uint8Array = new Uint8Array(binary.length);
    for (let index: number = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(data));
}
