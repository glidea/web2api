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
  if (match?.[1] === undefined) {
    return undefined;
  }
  const conversationId: string = decodeURIComponent(match[1]);
  return conversationId.startsWith("WEB:") ? undefined : conversationId;
}

export function isChatGPTLoggedIn(documentRoot: Document): boolean {
  return documentRoot.querySelector('[data-testid="login-button"]') === null;
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

export async function getCapabilities(documentRoot: Document): Promise<ChatGPTCapabilities> {
  const openedModelMenu: boolean = await openModelMenu(documentRoot);
  const legacyModels: string[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-testid=model-selector] [data-model-id]"))
    .map((element: HTMLElement): string => element.dataset.modelId as string);
  let menuModels: string[] = [];
  let pickerEfforts: string[] = [];
  if (documentRoot.querySelector("[data-testid=composer-intelligence-picker-content]") !== null) {
    await openAdvancedPickerOptions(documentRoot);
    const modelOptions: HTMLElement[] = await openPickerSubmenu(documentRoot, 0);
    menuModels = modelOptions.map(modelIdFromMenuItem).filter((model: string): boolean => model.length > 0 && model !== "chatgpt");
    const effortOptions: HTMLElement[] = await openPickerSubmenu(documentRoot, 1);
    pickerEfforts = effortOptions.map(reasoningEffortFromMenuItem).filter((effort: string): boolean => effort.length > 0);
  } else {
    menuModels = Array.from(documentRoot.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .map(modelIdFromMenuItem)
      .filter((model: string): boolean => model.length > 0 && model !== "chatgpt");
  }
  const legacyEfforts: string[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-testid=reasoning-selector] [data-effort]"))
    .map((element: HTMLElement): string => element.dataset.effort as string);
  if (openedModelMenu) {
    const menuButton: HTMLElement | null = findModelMenuButton(documentRoot);
    if (menuButton !== null) {
      clickElement(menuButton);
    }
  }
  return { models: menuModels.length > 0 ? menuModels : legacyModels, reasoningEfforts: pickerEfforts.length > 0 ? pickerEfforts : legacyEfforts };
}

export async function selectModel(documentRoot: Document, model: string): Promise<void> {
  const legacySelector: HTMLElement | null = documentRoot.querySelector("[data-testid=model-selector]");
  const legacyOption: HTMLElement | null = legacySelector?.querySelector(`[data-model-id="${CSS.escape(model)}"]`) ?? null;
  if (legacyOption !== null) {
    legacySelector?.setAttribute("data-selected-model", model);
    clickElement(legacyOption);
    return;
  }
  await openModelMenu(documentRoot);
  await openAdvancedPickerOptions(documentRoot);
  const options: HTMLElement[] = documentRoot.querySelector("[data-testid=composer-intelligence-picker-content]") === null
    ? Array.from(documentRoot.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    : await openPickerSubmenu(documentRoot, 0);
  const option: HTMLElement | undefined = options.find((element: HTMLElement): boolean => modelIdFromMenuItem(element) === model);
  if (option === undefined) {
    throw new Error("model_not_available");
  }
  option.setAttribute("data-selected", "true");
  clickElement(option);
}

export async function selectReasoningEffort(documentRoot: Document, effort: string): Promise<void> {
  const selector: HTMLElement | null = documentRoot.querySelector("[data-testid=reasoning-selector]");
  const option: HTMLElement | null = selector?.querySelector(`[data-effort="${CSS.escape(effort)}"]`) ?? null;
  if (option !== null && selector !== null) {
    selector.setAttribute("data-selected-effort", effort);
    clickElement(option);
    return;
  }
  await openModelMenu(documentRoot);
  await openAdvancedPickerOptions(documentRoot);
  const options: HTMLElement[] = await openPickerSubmenu(documentRoot, 1);
  const pickerOption: HTMLElement | undefined = options.find((element: HTMLElement): boolean => reasoningEffortFromMenuItem(element) === effort);
  if (pickerOption === undefined) {
    throw new Error("unsupported_reasoning_effort");
  }
  clickElement(pickerOption);
}

async function openModelMenu(documentRoot: Document): Promise<boolean> {
  if (documentRoot.querySelector('[role="menuitemradio"], [data-testid=composer-intelligence-picker-content]') !== null) {
    return false;
  }
  const deadline: number = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (documentRoot.querySelector('[role="menuitemradio"], [data-testid=composer-intelligence-picker-content]') !== null) {
      return true;
    }
    const button: HTMLElement | null = findModelMenuButton(documentRoot);
    if (button !== null) {
      clickElement(button);
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  return false;
}

async function openAdvancedPickerOptions(documentRoot: Document): Promise<void> {
  const toggle: HTMLElement | null = documentRoot.querySelector('[data-testid=composer-intelligence-picker-content] [role="menuitem"][aria-expanded="false"]:not([data-has-submenu])');
  if (toggle === null) {
    return;
  }
  clickElement(toggle);
  const deadline: number = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (toggle.getAttribute("aria-expanded") === "true") {
      return;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 25);
    });
  }
}

function findModelMenuButton(documentRoot: Document): HTMLElement | null {
  const legacyButton: HTMLElement | null = documentRoot.querySelector("[data-testid=model-switcher-dropdown-button]");
  if (legacyButton !== null) {
    return legacyButton;
  }
  return documentRoot.querySelector<HTMLElement>("[data-animated-slider-trigger]")?.closest<HTMLElement>("button") ?? null;
}

async function openPickerSubmenu(documentRoot: Document, index: number): Promise<HTMLElement[]> {
  const submenuItems: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>('[data-testid=composer-intelligence-picker-content] [role="menuitem"][data-has-submenu]'));
  const submenuItem: HTMLElement | undefined = submenuItems[index];
  if (submenuItem === undefined) {
    return [];
  }
  const previousOptions: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  clickElement(submenuItem);
  const deadline: number = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const options: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    if (options.length > 0 && (previousOptions.length === 0 || options[0] !== previousOptions[0])) {
      return options;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 25);
    });
  }
  return [];
}

function clickElement(element: HTMLElement): void {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, button: 0 }));
}

function modelIdFromMenuItem(element: HTMLElement): string {
  const label: string = element.querySelector(".truncate")?.textContent?.trim()
    ?? element.querySelector("span")?.textContent?.trim()
    ?? element.textContent?.trim()
    ?? "";
  return label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
}

function reasoningEffortFromMenuItem(element: HTMLElement): string {
  const label: string = element.textContent?.trim().toLowerCase() ?? "";
  switch (label) {
    case "fast":
    case "instant":
    case "极速":
      return "fast";
    case "medium":
    case "中":
      return "medium";
    case "high":
    case "高":
      return "high";
    case "xhigh":
    case "very high":
    case "极高":
      return "xhigh";
    case "pro":
      return "pro";
    default:
      return label.replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  }
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
  const sendButton: HTMLButtonElement = await waitForElement<HTMLButtonElement>(documentRoot, "button[data-testid=send-button]", 2_000, "send_button_not_found");
  sendButton.click();
}

export function cancelGeneration(documentRoot: Document): void {
  const stopButton: HTMLButtonElement | null = documentRoot.querySelector("button[data-testid=stop-button]");
  stopButton?.click();
}

export async function streamAssistantText(documentRoot: Document, previousMessageCount: number, onDelta: (delta: string) => void | Promise<void>): Promise<string> {
  let reader: AssistantTextReader | undefined;
  let assistant: HTMLElement | undefined;
  let textNode: HTMLElement | undefined;
  let stableText: string = "";
  let stableReads: number = 0;
  const deadline: number = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const assistants: HTMLElement[] = getAssistantMessages(documentRoot);
    const currentAssistant: HTMLElement | undefined = assistants[previousMessageCount];
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

function getAssistantTextNode(assistant: HTMLElement): HTMLElement | undefined {
  const markdown: HTMLElement | null = assistant.querySelector<HTMLElement>(".markdown");
  if (markdown !== null) {
    return markdown;
  }
  return assistant.children.length === 0 ? assistant : undefined;
}

function getAssistantMessages(documentRoot: Document): HTMLElement[] {
  const turns: HTMLElement[] = Array.from(documentRoot.querySelectorAll<HTMLElement>("section[data-turn=assistant]"));
  if (turns.length > 0) {
    return turns;
  }
  return Array.from(documentRoot.querySelectorAll<HTMLElement>("[data-message-author-role=assistant]"));
}

export async function waitForGeneratedImage(documentRoot: Document, previousMessageCount: number): Promise<Uint8Array> {
  const deadline: number = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const assistant: HTMLElement | undefined = getAssistantMessages(documentRoot)[previousMessageCount];
    const image: HTMLImageElement | null = assistant?.querySelector<HTMLImageElement>("img[src]") ?? null;
    const stopButton: HTMLElement | null = documentRoot.querySelector("[data-testid=stop-button]");
    if (image !== null && stopButton === null) {
      return await readImage(image);
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("generated_image_timeout");
}

async function readImage(image: HTMLImageElement): Promise<Uint8Array> {
  const source: string = image.currentSrc || image.src;
  if (source.startsWith("data:")) {
    return decodeDataUrl(source);
  }
  const response: Response = await fetch(source);
  return new Uint8Array(await response.arrayBuffer());
}

async function waitForElement<T extends Element>(documentRoot: Document, selector: string, timeout: number, errorCode: string): Promise<T> {
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
  throw new Error(errorCode);
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
