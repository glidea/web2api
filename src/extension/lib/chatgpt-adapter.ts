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
  return match?.[1];
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
  const input: HTMLInputElement = documentRoot.querySelector("input[data-testid=upload-input]") as HTMLInputElement;
  const transfer: DataTransfer = new DataTransfer();
  for (const image of images) {
    const blob: Blob = new Blob([image.bytes.buffer as ArrayBuffer], { type: image.mediaType });
    transfer.items.add(new File([blob], image.name, { type: image.mediaType }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function submitPrompt(documentRoot: Document, prompt: string): void {
  const composer: HTMLTextAreaElement = documentRoot.querySelector("textarea[data-testid=composer]") as HTMLTextAreaElement;
  composer.value = prompt;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  const sendButton: HTMLButtonElement = documentRoot.querySelector("button[data-testid=send-button]") as HTMLButtonElement;
  sendButton.click();
}

export async function extractGeneratedImage(documentRoot: Document): Promise<Uint8Array | undefined> {
  const image: HTMLImageElement | null = documentRoot.querySelector("img[data-generated-image]");
  if (image === null) {
    return undefined;
  }
  const source: string = image.currentSrc || image.src;
  if (source.startsWith("data:")) {
    return decodeDataUrl(source);
  }
  const response: Response = await fetch(source);
  return new Uint8Array(await response.arrayBuffer());
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
