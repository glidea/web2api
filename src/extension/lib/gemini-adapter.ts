export type ImagePayload = {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
};

export type GeminiCapabilities = {
  models: string[];
  reasoningEfforts: string[];
};

export function parseConversationId(url: string): string | undefined {
  const parsedUrl: URL = new URL(url);
  const match: RegExpMatchArray | null = parsedUrl.pathname.match(/^\/app\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

export function isGeminiLoggedIn(documentRoot: Document): boolean {
  return documentRoot.querySelector('a[href*="accounts.google.com/SignOutOptions"]') !== null;
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
  return getAssistantMessages(documentRoot).length;
}

export async function getCapabilities(documentRoot: Document): Promise<GeminiCapabilities> {
  const openedMenu: boolean = await openModelMenu(documentRoot);
  const options: HTMLElement[] = getModelMenuItems(documentRoot);
  const models: string[] = options
    .filter((option: HTMLElement): boolean => option.dataset.modeId !== undefined)
    .map(modelIdFromMenuItem)
    .filter((model: string): boolean => model.length > 0);
  const reasoningEfforts: string[] = options
    .filter((option: HTMLElement): boolean => option.dataset.modeId === undefined)
    .map(reasoningEffortFromMenuItem)
    .filter((effort: string): boolean => effort.length > 0);
  if (openedMenu) {
    findModelMenuButton(documentRoot)?.click();
  }
  return { models, reasoningEfforts };
}

export async function selectModel(documentRoot: Document, model: string): Promise<void> {
  await openModelMenu(documentRoot);
  const option: HTMLElement | undefined = getModelMenuItems(documentRoot)
    .filter((item: HTMLElement): boolean => item.dataset.modeId !== undefined)
    .find((item: HTMLElement): boolean => modelIdFromMenuItem(item) === model);
  if (option === undefined) {
    throw new Error("model_not_available");
  }
  option.click();
}

export async function selectReasoningEffort(documentRoot: Document, effort: string): Promise<void> {
  await openModelMenu(documentRoot);
  const option: HTMLElement | undefined = getModelMenuItems(documentRoot)
    .filter((item: HTMLElement): boolean => item.dataset.modeId === undefined)
    .find((item: HTMLElement): boolean => reasoningEffortFromMenuItem(item) === effort);
  if (option === undefined) {
    throw new Error("unsupported_reasoning_effort");
  }
  option.click();
}

export async function submitPrompt(documentRoot: Document, prompt: string): Promise<void> {
  if (!isGeminiLoggedIn(documentRoot)) {
    throw new Error("login_required");
  }
  const composer: HTMLElement | null = documentRoot.querySelector('[role="textbox"][contenteditable="true"]');
  if (composer === null) {
    throw new Error("composer_not_found");
  }
  composer.focus();
  composer.textContent = prompt;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  const sendButton: HTMLButtonElement = await waitForButton(documentRoot, findSendButton, 2_000, "send_button_not_found");
  sendButton.click();
}

export async function uploadImages(documentRoot: Document, images: ImagePayload[]): Promise<void> {
  if (images.length === 0) {
    return;
  }
  const input: HTMLInputElement | null = documentRoot.querySelector('input[type="file"].hidden-file-input, input[type="file"][data-test-id="local-image-upload-input"]');
  if (input === null) {
    throw new Error("upload_input_not_found");
  }
  const previousPreviewCount: number = getAttachmentPreviewCount(documentRoot);
  const transfer: DataTransfer = new DataTransfer();
  for (const image of images) {
    const blob: Blob = new Blob([image.bytes.buffer as ArrayBuffer], { type: image.mediaType });
    transfer.items.add(new File([blob], image.name, { type: image.mediaType }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForAttachmentPreviews(documentRoot, previousPreviewCount + images.length);
}

export function cancelGeneration(documentRoot: Document): void {
  findStopButton(documentRoot)?.click();
}

export async function streamAssistantText(documentRoot: Document, previousMessageCount: number, onDelta: (delta: string) => void | Promise<void>): Promise<string> {
  let assistant: HTMLElement | undefined;
  let textNode: HTMLElement | undefined;
  let reader: AssistantTextReader | undefined;
  let stableText: string = "";
  let stableReads: number = 0;
  const deadline: number = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const currentAssistant: HTMLElement | undefined = getAssistantMessages(documentRoot)[previousMessageCount];
    if (currentAssistant !== undefined && currentAssistant !== assistant) {
      assistant = currentAssistant;
      textNode = undefined;
      reader = undefined;
    }
    const currentTextNode: HTMLElement | undefined = assistant === undefined ? undefined : getAssistantTextNode(assistant);
    if (currentTextNode !== undefined && currentTextNode !== textNode) {
      textNode = currentTextNode;
      reader = new AssistantTextReader(currentTextNode);
    }
    const delta: string = reader?.readDelta() ?? "";
    if (delta.length > 0) {
      await onDelta(delta);
    }
    const currentText: string = textNode?.textContent ?? "";
    if (currentText.length > 0 && currentText === stableText) {
      stableReads += 1;
    } else {
      stableText = currentText;
      stableReads = 0;
    }
    if (stableText.length > 0 && stableReads >= 2 && findStopButton(documentRoot) === null) {
      return stableText;
    }
    await delay(100);
  }
  throw new Error("assistant_text_timeout");
}

export async function waitForGeneratedImage(documentRoot: Document, previousMessageCount: number): Promise<Uint8Array> {
  const deadline: number = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const assistant: HTMLElement | undefined = getAssistantMessages(documentRoot)[previousMessageCount];
    const image: HTMLImageElement | null = assistant?.querySelector<HTMLImageElement>("img[src]") ?? null;
    if (image !== null && findStopButton(documentRoot) === null) {
      return await readImage(image);
    }
    await delay(100);
  }
  throw new Error("generated_image_timeout");
}

async function openModelMenu(documentRoot: Document): Promise<boolean> {
  if (getModelMenuItems(documentRoot).length > 0) {
    return false;
  }
  const button: HTMLButtonElement | null = findModelMenuButton(documentRoot);
  if (button === null) {
    throw new Error("model_selector_not_found");
  }
  button.click();
  const deadline: number = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (getModelMenuItems(documentRoot).length > 0) {
      return true;
    }
    await delay(25);
  }
  throw new Error("model_selector_not_found");
}

function findModelMenuButton(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector<HTMLButtonElement>('button[data-test-id="bard-mode-menu-button"]');
}

function getModelMenuItems(documentRoot: Document): HTMLElement[] {
  return Array.from(documentRoot.querySelectorAll<HTMLElement>('gem-menu-item[role="menuitem"]'));
}

function modelIdFromMenuItem(option: HTMLElement): string {
  return normalizedLabel(option.querySelector(".label")?.textContent ?? "");
}

function reasoningEffortFromMenuItem(option: HTMLElement): string {
  const label: string = option.querySelector(".label")?.textContent?.trim().toLowerCase() ?? "";
  switch (label) {
    case "extended thinking":
    case "扩展思考":
      return "extended";
    default:
      return "";
  }
}

function normalizedLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
}

function findSendButton(documentRoot: Document): HTMLButtonElement | null {
  const labeledButton: HTMLButtonElement | null = documentRoot.querySelector<HTMLButtonElement>('button[aria-label="Send"], button[aria-label="发送"]');
  if (labeledButton !== null) {
    return labeledButton;
  }
  return documentRoot.querySelector<HTMLElement>('[data-mat-icon-name="send"], mat-icon[fonticon="send"]')?.closest<HTMLButtonElement>("button") ?? null;
}

function findStopButton(documentRoot: Document): HTMLButtonElement | null {
  const labeledButton: HTMLButtonElement | null = documentRoot.querySelector<HTMLButtonElement>('button[aria-label="Stop response"], button[aria-label="停止生成"]');
  if (labeledButton !== null) {
    return labeledButton;
  }
  return documentRoot.querySelector<HTMLElement>('[data-mat-icon-name="stop"], mat-icon[fonticon="stop"]')?.closest<HTMLButtonElement>("button") ?? null;
}

async function waitForButton(documentRoot: Document, finder: (documentRoot: Document) => HTMLButtonElement | null, timeout: number, errorCode: string): Promise<HTMLButtonElement> {
  const deadline: number = Date.now() + timeout;
  while (Date.now() < deadline) {
    const button: HTMLButtonElement | null = finder(documentRoot);
    if (button !== null) {
      return button;
    }
    await delay(25);
  }
  throw new Error(errorCode);
}

function getAttachmentPreviewCount(documentRoot: Document): number {
  return documentRoot.querySelectorAll('file-preview, [data-test-id="attachment"], [data-test-id="uploaded-file"], [data-test-id="file-preview"]').length;
}

async function waitForAttachmentPreviews(documentRoot: Document, expectedCount: number): Promise<void> {
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (getAttachmentPreviewCount(documentRoot) >= expectedCount) {
      return;
    }
    await delay(50);
  }
  throw new Error("attachment_upload_timeout");
}

function getAssistantMessages(documentRoot: Document): HTMLElement[] {
  return Array.from(documentRoot.querySelectorAll<HTMLElement>("model-response"));
}

function getAssistantTextNode(assistant: HTMLElement): HTMLElement | undefined {
  return assistant.querySelector<HTMLElement>("message-content, .model-response-text, .markdown") ?? undefined;
}

async function readImage(image: HTMLImageElement): Promise<Uint8Array> {
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}
