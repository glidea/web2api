export type ImagePayload = {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
};

export type GrokCapabilities = {
  models: string[];
  reasoningEfforts: string[];
};

type Composer = HTMLTextAreaElement | HTMLElement;

export function parseConversationId(url: string): string | undefined {
  const parsedUrl: URL = new URL(url);
  const match: RegExpMatchArray | null = parsedUrl.pathname.match(/^\/c\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

export function isGrokLoggedIn(documentRoot: Document): boolean {
  return !Array.from(documentRoot.querySelectorAll("button, a")).some((element: Element): boolean => /^(Log in|Sign in|登录)$/.test((element.textContent ?? "").trim()));
}

export function isGrokUsable(documentRoot: Document): boolean {
  return findComposer(documentRoot) !== null;
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

export function getGeneratedImageCount(documentRoot: Document): number {
  return getGeneratedImages(documentRoot).length;
}

export async function getCapabilities(documentRoot: Document): Promise<GrokCapabilities> {
  const openedMenu: boolean = await openModelMenu(documentRoot);
  const items: HTMLElement[] = getModelMenuItems(documentRoot);
  const models: Set<string> = new Set<string>();
  const reasoningEfforts: string[] = [];
  for (const item of items) {
    const label: string = firstLine(item);
    const effort: string = normalizeMode(label);
    if (effort.length > 0) {
      reasoningEfforts.push(effort);
    }
    const text: string = item.textContent ?? "";
    for (const match of text.matchAll(/Grok\s+([0-9]+(?:\.[0-9]+)*)/gi)) {
      const model: string | undefined = match[1];
      if (model !== undefined) {
        models.add(model);
      }
    }
  }
  if (openedMenu) {
    const menuButton: HTMLButtonElement | null = findModelMenuButton(documentRoot);
    if (menuButton !== null) {
      activateControl(menuButton);
    }
  }
  return { models: Array.from(models), reasoningEfforts };
}

export async function selectModel(documentRoot: Document, model: string): Promise<void> {
  await openModelMenu(documentRoot);
  const option: HTMLElement | undefined = getModelMenuItems(documentRoot).find((item: HTMLElement): boolean => {
    const text: string = item.textContent ?? "";
    return new RegExp(`Grok\\s+${escapeRegExp(model)}(?:\\s|$)`, "i").test(text);
  });
  if (option === undefined) {
    throw new Error("model_not_available");
  }
  activateControl(option);
}

export async function selectReasoningEffort(documentRoot: Document, effort: string): Promise<void> {
  await openModelMenu(documentRoot);
  const option: HTMLElement | undefined = getModelMenuItems(documentRoot).find((item: HTMLElement): boolean => normalizeMode(firstLine(item)) === effort);
  if (option === undefined) {
    throw new Error("unsupported_reasoning_effort");
  }
  activateControl(option);
}

export async function submitPrompt(documentRoot: Document, prompt: string): Promise<void> {
  if (findComposer(documentRoot) === null) {
    throw new Error("composer_not_found");
  }
  let preparedComposer: Composer | undefined;
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const composer: Composer | null = findComposer(documentRoot);
    if (composer !== null && composer !== preparedComposer) {
      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        const valueSetter: ((this: HTMLTextAreaElement, value: string) => void) | undefined = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (valueSetter === undefined) {
          throw new Error("textarea_value_setter_not_found");
        }
        valueSetter.call(composer, prompt);
      } else {
        composer.textContent = prompt;
      }
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      preparedComposer = composer;
      await delay(25);
      continue;
    }
    const submitButton: HTMLButtonElement | null = findSubmitButton(documentRoot);
    if (composer === preparedComposer && submitButton !== null && !submitButton.disabled && submitButton.getAttribute("aria-disabled") !== "true") {
      submitButton.click();
      return;
    }
    await delay(25);
  }
  throw new Error("submit_button_not_found");
}

export async function uploadImages(documentRoot: Document, images: ImagePayload[]): Promise<void> {
  if (images.length === 0) {
    return;
  }
  let input: HTMLInputElement | null = documentRoot.querySelector<HTMLInputElement>('input[type="file"][name="files"]');
  if (input === null) {
    documentRoot.querySelector<HTMLButtonElement>('button[data-testid="attach-button"]')?.click();
    const inputDeadline: number = Date.now() + 2_000;
    while (input === null && Date.now() < inputDeadline) {
      await delay(25);
      input = documentRoot.querySelector<HTMLInputElement>('input[type="file"][name="files"]');
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
  const expectedCount: number = previousPreviewCount + images.length;
  const deadline: number = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (getAttachmentPreviewCount(documentRoot) >= expectedCount) {
      return;
    }
    await delay(50);
  }
  throw new Error("attachment_upload_timeout");
}

export async function enableImageGeneration(documentRoot: Document): Promise<void> {
  const imagineLink: HTMLAnchorElement | null = documentRoot.querySelector<HTMLAnchorElement>('a[href^="/imagine"]');
  if (imagineLink === null) {
    throw new Error("image_generation_not_available");
  }
  if (window.location.pathname === "/imagine" && isImagineReady(documentRoot)) {
    return;
  }
  if (documentRoot.querySelector('[role="textbox"][contenteditable="true"]') === null) {
    return;
  }
  activateControl(imagineLink);
  const deadline: number = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (window.location.pathname === "/imagine" && isImagineReady(documentRoot)) {
      return;
    }
    await delay(50);
  }
  throw new Error("image_generation_navigation_timeout");
}

function isImagineReady(documentRoot: Document): boolean {
  return findComposer(documentRoot) !== null
    && documentRoot.querySelector('button[aria-label="上传"], button[aria-label="Upload"]') !== null;
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

export async function waitForGeneratedImage(documentRoot: Document, previousGeneratedImageCount: number, downloadImage: (url: string) => Promise<Uint8Array> = readImage): Promise<Uint8Array> {
  const deadline: number = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const bodyText: string = documentRoot.body?.innerText ?? "";
    if (/升级到 SuperGrok Heavy|Upgrade to SuperGrok Heavy|Highest usage/.test(bodyText)) {
      throw new Error("image_generation_unavailable");
    }
    const assistant: HTMLElement | undefined = getAssistantMessages(documentRoot)[previousGeneratedImageCount];
    const generatedImages: HTMLImageElement[] = getGeneratedImages(documentRoot);
    const image: HTMLImageElement | null = assistant?.querySelector<HTMLImageElement>("img[src]")
      ?? generatedImages[previousGeneratedImageCount]
      ?? null;
    if (image !== null && findStopButton(documentRoot) === null) {
      return await downloadImage(image.src);
    }
    const responseText: string = assistant === undefined ? "" : getAssistantTextNode(assistant)?.textContent?.trim() ?? "";
    if (responseText.length > 0 && findStopButton(documentRoot) === null) {
      throw new Error("image_generation_failed");
    }
    await delay(100);
  }
  throw new Error("generated_image_timeout");
}

function findComposer(documentRoot: Document): Composer | null {
  return documentRoot.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
    ?? documentRoot.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])');
}

function findSubmitButton(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector<HTMLButtonElement>('button[type="submit"][data-testid="chat-submit"], button[type="submit"][aria-label="Submit"], button[type="submit"][aria-label="提交"]');
}

function findModelMenuButton(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector<HTMLButtonElement>('#model-select-trigger, button[data-testid="model-selector"]');
}

async function openModelMenu(documentRoot: Document): Promise<boolean> {
  if (getModelMenuItems(documentRoot).length > 0) {
    return false;
  }
  const button: HTMLButtonElement | null = findModelMenuButton(documentRoot);
  if (button === null) {
    throw new Error("model_selector_not_found");
  }
  activateControl(button);
  const deadline: number = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (getModelMenuItems(documentRoot).length > 0) {
      return true;
    }
    await delay(25);
  }
  throw new Error("model_selector_not_found");
}

function getModelMenuItems(documentRoot: Document): HTMLElement[] {
  return Array.from(documentRoot.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((item: HTMLElement): boolean => normalizeMode(firstLine(item)).length > 0);
}

function activateControl(control: HTMLElement): void {
  control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
  control.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

function firstLine(item: HTMLElement): string {
  return (item.innerText || item.textContent || "").trim();
}

function normalizeMode(label: string): string {
  const normalizedLabel: string = label.trim().toLowerCase();
  for (const mode of ["fast", "auto", "expert", "heavy"] as const) {
    if (normalizedLabel === mode || normalizedLabel.startsWith(`${mode}\n`) || normalizedLabel.startsWith(`${mode}\r`) || normalizedLabel.startsWith(`${mode} `) || normalizedLabel.startsWith(mode)) {
      return mode;
    }
  }
  return "";
}

function getAssistantMessages(documentRoot: Document): HTMLElement[] {
  const messages: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>('[data-testid="assistant-message"], [data-message-author-role="assistant"]'));
  if (messages.length > 0) {
    return messages;
  }
  return Array.from(documentRoot.querySelectorAll<HTMLElement>(".response-content-markdown"));
}

function getGeneratedImages(documentRoot: Document): HTMLImageElement[] {
  return Array.from(documentRoot.querySelectorAll<HTMLImageElement>('img[src*="/generated/"], img.absolute.inset-0.size-full.object-cover[src^="data:image/"]'));
}

function getAssistantTextNode(assistant: HTMLElement): HTMLElement | undefined {
  if (assistant.matches(".response-content-markdown")) {
    return assistant;
  }
  return assistant.querySelector<HTMLElement>('.response-content-markdown, [data-testid="assistant-message-content"]') ?? assistant;
}

function findStopButton(documentRoot: Document): HTMLButtonElement | null {
  return documentRoot.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label="停止生成"]');
}

function getAttachmentPreviewCount(documentRoot: Document): number {
  return documentRoot.querySelectorAll(
    '[data-testid="attachment"], [data-testid*="attachment-preview"], button[aria-label="移除此附件"], button[aria-label="Remove attachment"]',
  ).length;
}

async function readImage(url: string): Promise<Uint8Array> {
  const response: Response = await fetch(url);
  if (!response.ok) {
    throw new Error("generated_image_download_failed");
  }
  return new Uint8Array(await response.arrayBuffer());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}
