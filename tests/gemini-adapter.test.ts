import { describe, expect, it } from "vitest";
import {
  cancelGeneration,
  getAssistantMessageCount,
  getCapabilities,
  isGeminiLoggedIn,
  parseConversationId,
  selectModel,
  selectReasoningEffort,
  streamAssistantText,
  submitPrompt,
  uploadImages,
  waitForGeneratedImage,
  type ImagePayload
} from "../src/extension/lib/gemini-adapter";

function createPage(markup: string): void {
  document.body.innerHTML = markup;
}

function createModelMenu(): string {
  return `
    <button data-test-id="bard-mode-menu-button" aria-expanded="true">Flash</button>
    <div role="menu">
      <gem-menu-item role="menuitem" data-mode-id="flash-lite">
        <span class="label">3.5 Flash-Lite</span>
        <div class="sublabel">Fast answers</div>
      </gem-menu-item>
      <gem-menu-item role="menuitem" data-mode-id="flash" class="selected">
        <span class="label">3.6 Flash</span>
        <div class="sublabel">Everyday help</div>
      </gem-menu-item>
      <gem-menu-item role="menuitem" data-mode-id="pro">
        <span class="label">3.1 Pro</span>
        <div class="sublabel">Advanced math and code</div>
      </gem-menu-item>
      <gem-menu-item role="menuitem">
        <span class="label">Extended thinking</span>
        <div class="sublabel">Solves complex problems</div>
      </gem-menu-item>
    </div>
  `;
}

describe("Gemini adapter", (): void => {
  it("requires the Google account control for a logged-in page", (): void => {
    createPage('<div role="textbox" contenteditable="true"></div>');
    expect(isGeminiLoggedIn(document)).toBe(false);
    createPage('<a href="https://accounts.google.com/SignOutOptions?continue=https://gemini.google.com/app">Account</a>');
    expect(isGeminiLoggedIn(document)).toBe(true);
  });

  it("reads a conversation id from a Gemini URL", (): void => {
    expect(parseConversationId("https://gemini.google.com/app/conversation-123?hl=en")).toBe("conversation-123");
    expect(parseConversationId("https://gemini.google.com/app")).toBeUndefined();
    expect(parseConversationId("https://gemini.google.com/app/conversation-123/extra")).toBeUndefined();
  });

  it("scans and strictly selects visible models and reasoning modes", async (): Promise<void> => {
    createPage(createModelMenu());
    const selected: string[] = [];
    for (const option of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      option.addEventListener("click", (): void => {
        selected.push(option.querySelector(".label")?.textContent?.trim() ?? "");
      });
    }

    expect(await getCapabilities(document)).toEqual({
      models: ["3.5-flash-lite", "3.6-flash", "3.1-pro"],
      reasoningEfforts: ["extended"]
    });
    await selectModel(document, "3.1-pro");
    await selectReasoningEffort(document, "extended");
    expect(selected).toEqual(["3.1 Pro", "Extended thinking"]);
    await expect(selectModel(document, "unknown")).rejects.toThrowError("model_not_available");
    await expect(selectReasoningEffort(document, "high")).rejects.toThrowError("unsupported_reasoning_effort");
  });

  it("opens the real model menu before scanning", async (): Promise<void> => {
    createPage('<button data-test-id="bard-mode-menu-button" aria-expanded="false">Flash</button>');
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    button.addEventListener("click", (): void => {
      button.setAttribute("aria-expanded", "true");
      document.body.insertAdjacentHTML("beforeend", createModelMenu());
    });
    expect(await getCapabilities(document)).toEqual({
      models: ["3.5-flash-lite", "3.6-flash", "3.1-pro"],
      reasoningEfforts: ["extended"]
    });
  });

  it("submits a prompt through the contenteditable composer", async (): Promise<void> => {
    createPage(`
      <a href="https://accounts.google.com/SignOutOptions">Account</a>
      <div class="ql-editor" role="textbox" contenteditable="true"></div>
      <button><span data-mat-icon-name="send"></span></button>
    `);
    const composer: HTMLElement = document.querySelector('[role="textbox"]') as HTMLElement;
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let inputEvents: number = 0;
    let clicks: number = 0;
    composer.addEventListener("input", (): void => {
      inputEvents += 1;
    });
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    await submitPrompt(document, "hello");
    expect(composer.textContent).toBe("hello");
    expect(inputEvents).toBe(1);
    expect(clicks).toBe(1);
  });

  it("rejects submission before touching a logged-out page", async (): Promise<void> => {
    createPage(`
      <div role="textbox" contenteditable="true"></div>
      <button><span data-mat-icon-name="send"></span></button>
    `);
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    await expect(submitPrompt(document, "hello")).rejects.toThrowError("login_required");
    expect(clicks).toBe(0);
  });

  it("uploads images in request order and waits for attachment previews", async (): Promise<void> => {
    createPage('<input class="hidden-file-input" type="file" multiple /><div id="previews"></div>');
    const input: HTMLInputElement = document.querySelector("input") as HTMLInputElement;
    input.addEventListener("change", (): void => {
      for (const file of Array.from(input.files ?? [])) {
        const preview: HTMLElement = document.createElement("file-preview");
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
    expect(Array.from(document.querySelectorAll("file-preview")).map((preview: Element): string | undefined => (preview as HTMLElement).dataset.fileName)).toEqual(["first.png", "second.jpg"]);
  });

  it("streams only text from the newly created Gemini response", async (): Promise<void> => {
    createPage('<model-response><div class="model-response-text">old answer</div></model-response><button id="stop"><span data-mat-icon-name="stop"></span></button>');
    const deltas: string[] = [];
    setTimeout((): void => {
      const response: HTMLElement = document.createElement("model-response");
      response.innerHTML = '<div class="model-response-text">Hel</div>';
      document.body.append(response);
    }, 10);
    setTimeout((): void => {
      const responses: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>("model-response"));
      const text: HTMLElement = responses[1]?.querySelector(".model-response-text") as HTMLElement;
      text.textContent = "Hello";
      document.querySelector("#stop")?.remove();
    }, 100);
    expect(getAssistantMessageCount(document)).toBe(1);
    const text: string = await streamAssistantText(document, 1, (delta: string): void => {
      deltas.push(delta);
    });
    expect(text).toBe("Hello");
    expect(deltas.join("")).toBe("Hello");
  });

  it("decodes an image from the newly created Gemini response", async (): Promise<void> => {
    createPage('<model-response><img src="data:image/png;base64,AQID" /></model-response>');
    setTimeout((): void => {
      const response: HTMLElement = document.createElement("model-response");
      response.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgo=" />';
      document.body.append(response);
    }, 10);
    await expect(waitForGeneratedImage(document, 1)).resolves.toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("clicks the structural stop control", (): void => {
    createPage('<button><span data-mat-icon-name="stop"></span></button>');
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    cancelGeneration(document);
    expect(clicks).toBe(1);
  });
});
