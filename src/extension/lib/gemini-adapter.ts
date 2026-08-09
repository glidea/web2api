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

export function isGeminiUsable(documentRoot: Document): boolean {
  const composer: HTMLElement | null = documentRoot.querySelector('[role="textbox"][contenteditable="true"]');
  return composer !== null && findModelMenuButton(documentRoot) !== null;
}

export function detectImageMediaType(bytes: Uint8Array): string {
  const isPng: boolean = bytes.length >= 8
    && bytes[0] === 137
    && bytes[1] === 80
    && bytes[2] === 78
    && bytes[3] === 71
    && bytes[4] === 13
    && bytes[5] === 10
    && bytes[6] === 26
    && bytes[7] === 10;
  if (isPng) {
    return "image/png";
  }
  const isJpeg: boolean = bytes.length >= 3
    && bytes[0] === 255
    && bytes[1] === 216
    && bytes[2] === 255;
  if (isJpeg) {
    return "image/jpeg";
  }
  throw new Error("unsupported_generated_image");
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
  if (documentRoot.querySelector('[role="textbox"][contenteditable="true"]') === null) {
    throw new Error("composer_not_found");
  }
  let preparedComposer: HTMLElement | undefined;
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const composer: HTMLElement | null = documentRoot.querySelector('[role="textbox"][contenteditable="true"]');
    if (composer !== null && composer !== preparedComposer) {
      composer.focus();
      composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      preparedComposer = composer;
      await delay(25);
      continue;
    }
    const sendButton: HTMLButtonElement | null = findSendButton(documentRoot);
    if (composer === preparedComposer && sendButton !== null && !sendButton.disabled && sendButton.getAttribute("aria-disabled") !== "true") {
      sendButton.click();
      return;
    }
    await delay(25);
  }
  throw new Error("send_button_not_found");
}

export async function uploadImages(documentRoot: Document, images: ImagePayload[]): Promise<void> {
  if (images.length === 0) {
    return;
  }
  let input: HTMLInputElement | null = findUploadInput(documentRoot);
  if (input === null) {
    const uploadMenuButton: HTMLButtonElement | null = findUploadMenuButton(documentRoot);
    uploadMenuButton?.click();
    const deadline: number = Date.now() + 2_000;
    while (input === null && Date.now() < deadline) {
      await delay(25);
      input = findUploadInput(documentRoot);
    }
  }
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

export async function enableImageGeneration(documentRoot: Document): Promise<void> {
  let imageTool: HTMLButtonElement | null = findImageGenerationTool(documentRoot);
  const deadline: number = Date.now() + 3_000;
  while (imageTool === null && Date.now() < deadline) {
    const uploadMenuButton: HTMLButtonElement | null = findUploadMenuButton(documentRoot);
    if (uploadMenuButton !== null && uploadMenuButton.getAttribute("aria-expanded") !== "true") {
      uploadMenuButton.click();
    }
    await delay(25);
    imageTool = findImageGenerationTool(documentRoot);
  }
  if (imageTool === null) {
    throw new Error("image_generation_not_available");
  }
  if (imageTool.getAttribute("aria-checked") !== "true") {
    imageTool.click();
    await delay(25);
  }
}

function findUploadInput(documentRoot: Document): HTMLInputElement | null {
  return documentRoot.querySelector('input[type="file"].hidden-file-input, input[type="file"][data-test-id="local-image-upload-input"]');
}

function findUploadMenuButton(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector('button[aria-label="Upload and tools"], button[aria-label="Upload & tools"], button[aria-label="上传和工具"]');
}

function findImageGenerationTool(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector<HTMLElement>('[data-mat-icon-name="image_create"], mat-icon[fonticon="image_create"]')?.closest<HTMLButtonElement>('button[role="menuitemcheckbox"]') ?? null;
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
  const labeledButton: HTMLButtonElement | null = documentRoot.querySelector<HTMLButtonElement>('button[aria-label="Send"], button[aria-label="Send message"], button[aria-label="发送"], button[aria-label="发送消息"]');
  if (labeledButton !== null) {
    return labeledButton;
  }
  return documentRoot.querySelector<HTMLElement>('[data-mat-icon-name="send"], [data-mat-icon-name="arrow_upward"], mat-icon[fonticon="send"], mat-icon[fonticon="arrow_upward"]')?.closest<HTMLButtonElement>("button") ?? null;
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
    if (button !== null && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
      return button;
    }
    await delay(25);
  }
  throw new Error(errorCode);
}

function getAttachmentPreviewCount(documentRoot: Document): number {
  return documentRoot.querySelectorAll('uploader-file-preview, file-preview, [data-test-id="attachment"], [data-test-id="uploaded-file"], [data-test-id="file-preview"]').length;
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
  return assistant.querySelector<HTMLElement>(".markdown")
    ?? assistant.querySelector<HTMLElement>("message-content")
    ?? assistant.querySelector<HTMLElement>(".model-response-text")
    ?? undefined;
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
