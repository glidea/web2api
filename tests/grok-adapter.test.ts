import { describe, expect, it } from "vitest";
import {
  AssistantTextReader,
  cancelGeneration,
  detectImageMediaType,
  enableImageGeneration,
  getAssistantMessageCount,
  getCapabilities,
  getGeneratedImageCount,
  isGrokLoggedIn,
  isGrokUsable,
  parseConversationId,
  selectModel,
  selectReasoningEffort,
  streamAssistantText,
  submitPrompt,
  uploadImages,
  waitForGeneratedImage,
  type ImagePayload
} from "../src/extension/lib/grok-adapter";

function createPage(markup: string): void {
  document.body.innerHTML = markup;
}

function createModelMenu(): string {
  return `
    <button id="model-select-trigger" aria-expanded="true">Fast</button>
    <div role="menu">
      <div role="menuitem"><span>Fast</span><span>Quick responses · Grok 4.5</span></div>
      <div role="menuitem"><span>Auto</span><span>Chooses Fast or Expert</span></div>
      <div role="menuitem"><span>Expert</span><span>Thinks hard · Grok 4.5</span></div>
      <div role="menuitem"><span>Heavy</span><span>Team of Experts · Grok 4.5</span></div>
    </div>
  `;
}

describe("Grok adapter", (): void => {
  it("detects authentication by the absence of the sign-in control", (): void => {
    createPage('<button>登录</button><textarea></textarea>');
    expect(isGrokLoggedIn(document)).toBe(false);
    createPage('<div role="textbox" contenteditable="true" aria-label="Ask Grok anything"></div>');
    expect(isGrokLoggedIn(document)).toBe(true);
  });

  it("requires a visible composer", (): void => {
    createPage('<textarea aria-label="Ask Grok anything"></textarea>');
    expect(isGrokUsable(document)).toBe(true);
    createPage('<textarea aria-hidden="true"></textarea>');
    expect(isGrokUsable(document)).toBe(false);
  });

  it("recognizes the logged-in contenteditable composer", (): void => {
    createPage('<div role="textbox" contenteditable="true" aria-label="Ask Grok anything"></div>');
    expect(isGrokUsable(document)).toBe(true);
  });

  it("reads a conversation id from a Grok URL", (): void => {
    expect(parseConversationId("https://grok.com/c/conversation-123?referrer=website")).toBe("conversation-123");
    expect(parseConversationId("https://grok.com/")).toBeUndefined();
    expect(parseConversationId("https://grok.com/c/conversation-123/extra")).toBeUndefined();
  });

  it("detects generated image media types", (): void => {
    expect(detectImageMediaType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(detectImageMediaType(new Uint8Array([255, 216, 255, 224]))).toBe("image/jpeg");
    expect((): string => detectImageMediaType(new Uint8Array([1, 2, 3]))).toThrowError("unsupported_generated_image");
  });

  it("discovers the model and reasoning modes from the real picker labels", async (): Promise<void> => {
    createPage(createModelMenu());

    expect(await getCapabilities(document)).toEqual({
      models: ["4.5"],
      reasoningEfforts: ["fast", "auto", "expert", "heavy"]
    });
  });

  it("opens a picker that handles pointer activation", async (): Promise<void> => {
    createPage('<button id="model-select-trigger" aria-expanded="false">Fast</button>');
    const trigger: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    trigger.addEventListener("pointerdown", (): void => {
      trigger.setAttribute("aria-expanded", "true");
      document.body.insertAdjacentHTML("beforeend", createModelMenu());
    });

    expect(await getCapabilities(document)).toEqual({
      models: ["4.5"],
      reasoningEfforts: ["fast", "auto", "expert", "heavy"]
    });
  });

  it("opens the picker and selects model and reasoning explicitly", async (): Promise<void> => {
    createPage('<button id="model-select-trigger" aria-expanded="false">Fast</button>');
    const trigger: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    const selected: string[] = [];
    trigger.addEventListener("click", (): void => {
      trigger.setAttribute("aria-expanded", "true");
      document.body.insertAdjacentHTML("beforeend", createModelMenu());
      for (const item of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
        item.addEventListener("click", (): void => {
          selected.push(item.querySelector("span")?.textContent?.trim() ?? "");
        });
      }
    });

    await selectModel(document, "4.5");
    await selectReasoningEffort(document, "expert");
    expect(selected).toEqual(["Fast", "Expert"]);
    await expect(selectModel(document, "unknown")).rejects.toThrowError("model_not_available");
    await expect(selectReasoningEffort(document, "unknown")).rejects.toThrowError("unsupported_reasoning_effort");
  });

  it("submits through the real textarea and submit button", async (): Promise<void> => {
    createPage('<textarea aria-label="向 Grok 提任何问题"></textarea><button type="submit" data-testid="chat-submit" disabled></button>');
    const textarea: HTMLTextAreaElement = document.querySelector("textarea") as HTMLTextAreaElement;
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    const valueDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (valueDescriptor?.get === undefined || valueDescriptor.set === undefined) {
      throw new Error("textarea value descriptor is unavailable");
    }
    let trackedValue: string = "";
    Object.defineProperty(textarea, "value", {
      configurable: true,
      get(): string {
        return valueDescriptor.get?.call(textarea) as string;
      },
      set(value: string): void {
        trackedValue = value;
        valueDescriptor.set?.call(textarea, value);
      }
    });
    let submitted: string = "";
    textarea.addEventListener("input", (): void => {
      const currentValue: string = valueDescriptor.get?.call(textarea) as string;
      if (currentValue !== trackedValue) {
        button.disabled = false;
      }
      trackedValue = currentValue;
    });
    button.addEventListener("click", (): void => {
      submitted = textarea.value;
    });

    await submitPrompt(document, "hello");
    expect(submitted).toBe("hello");
  });

  it("submits through the logged-in contenteditable composer", async (): Promise<void> => {
    createPage('<div role="textbox" contenteditable="true" aria-label="Ask Grok anything"></div><button type="submit" data-testid="chat-submit" disabled></button>');
    const composer: HTMLElement = document.querySelector('[role="textbox"][contenteditable="true"]') as HTMLElement;
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let submitted: string = "";
    composer.addEventListener("input", (): void => {
      button.disabled = composer.textContent?.trim() !== "hello";
    });
    button.addEventListener("click", (): void => {
      submitted = composer.textContent ?? "";
    });

    await submitPrompt(document, "hello");
    expect(submitted).toBe("hello");
  });

  it("uploads images through the hidden Grok file input", async (): Promise<void> => {
    createPage('<input class="hidden" multiple type="file" name="files"><div id="previews"></div>');
    const input: HTMLInputElement = document.querySelector("input") as HTMLInputElement;
    input.addEventListener("change", (): void => {
      for (const file of Array.from(input.files ?? [])) {
        const preview: HTMLButtonElement = document.createElement("button");
        preview.setAttribute("aria-label", "移除此附件");
        preview.dataset.fileName = file.name;
        document.querySelector("#previews")?.append(preview);
      }
    });
    const images: ImagePayload[] = [
      { bytes: new Uint8Array([1, 2]), mediaType: "image/png", name: "first.png" },
      { bytes: new Uint8Array([3, 4]), mediaType: "image/jpeg", name: "second.jpg" }
    ];

    await uploadImages(document, images);
    expect(Array.from(input.files ?? []).map((file: File): string => file.name)).toEqual(["first.png", "second.jpg"]);
  });

  it("requires the Imagine capability before image generation", async (): Promise<void> => {
    createPage('<a href="/imagine">Imagine</a>');
    await expect(enableImageGeneration(document)).resolves.toBeUndefined();
    createPage("");
    await expect(enableImageGeneration(document)).rejects.toThrowError("image_generation_not_available");
  });

  it("streams monotonic assistant text and cancels through the stop control", async (): Promise<void> => {
    createPage(`
      <div data-testid="assistant-message"><div class="response-content-markdown">A</div></div>
      <button aria-label="Stop generating"></button>
    `);
    const stop: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let cancelled: boolean = false;
    stop.addEventListener("click", (): void => {
      cancelled = true;
    });
    cancelGeneration(document);
    expect(cancelled).toBe(true);

    stop.remove();
    const deltas: string[] = [];
    expect(await streamAssistantText(document, 0, (delta: string): void => {
      deltas.push(delta);
    })).toBe("A");
    expect(deltas.join("")).toBe("A");
  });

  it("reads assistant deltas and rejects rewritten text", (): void => {
    createPage('<div id="assistant">Hello</div>');
    const node: HTMLElement = document.querySelector("#assistant") as HTMLElement;
    const reader: AssistantTextReader = new AssistantTextReader(node);
    expect(reader.readDelta()).toBe("Hello");
    node.textContent = "Hello world";
    expect(reader.readDelta()).toBe(" world");
    node.textContent = "Different text entirely";
    expect((): string => reader.readDelta()).toThrowError("assistant_text_rewritten");
  });

  it("counts assistant messages and returns generated image bytes", async (): Promise<void> => {
    createPage(`
      <div data-testid="assistant-message"><img src="data:image/png;base64,iVBORw0KGgo=" /></div>
    `);
    expect(getAssistantMessageCount(document)).toBe(1);
    expect(await waitForGeneratedImage(document, 0)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("returns a newly generated Imagine image", async (): Promise<void> => {
    createPage(`
      <img class="absolute inset-0 size-full object-cover" src="https://storage.googleapis.com/imagine-public.x.ai/agent-skills/photo_edit/photo_edit_cover.jpg" />
      <img class="absolute inset-0 size-full object-cover" src="https://assets.grok.com/users/test/generated/new/image.jpg" />
    `);
    expect(getGeneratedImageCount(document)).toBe(1);
    const downloaded: Uint8Array = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(await waitForGeneratedImage(document, 0, async (): Promise<Uint8Array> => downloaded)).toEqual(downloaded);
  });

  it("reports an Imagine usage gate immediately", async (): Promise<void> => {
    createPage("<div>升级到 SuperGrok Heavy</div>");
    await expect(waitForGeneratedImage(document, 0)).rejects.toThrowError("image_generation_unavailable");
  });
});
