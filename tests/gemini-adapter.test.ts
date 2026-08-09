import { describe, expect, it, vi } from "vitest";
import {
  cancelGeneration,
  detectImageMediaType,
  enableImageGeneration,
  getAssistantMessageCount,
  getCapabilities,
  isGeminiLoggedIn,
  isGeminiUsable,
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

  it("treats the guest composer as usable without claiming account login", (): void => {
    createPage(`
      <button data-test-id="bard-mode-menu-button">Flash</button>
      <div role="textbox" contenteditable="true"></div>
    `);
    expect(isGeminiLoggedIn(document)).toBe(false);
    expect(isGeminiUsable(document)).toBe(true);
  });

  it("reads a conversation id from a Gemini URL", (): void => {
    expect(parseConversationId("https://gemini.google.com/app/conversation-123?hl=en")).toBe("conversation-123");
    expect(parseConversationId("https://gemini.google.com/app")).toBeUndefined();
    expect(parseConversationId("https://gemini.google.com/app/conversation-123/extra")).toBeUndefined();
  });

  it("detects the generated image media type from its bytes", (): void => {
    expect(detectImageMediaType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(detectImageMediaType(new Uint8Array([255, 216, 255, 224]))).toBe("image/jpeg");
  });

  it("rejects unsupported generated image bytes", (): void => {
    expect((): string => detectImageMediaType(new Uint8Array([1, 2, 3]))).toThrowError("unsupported_generated_image");
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

  it("submits through the current Gemini send control", async (): Promise<void> => {
    createPage(`
      <div role="textbox" contenteditable="true"></div>
      <button aria-label="Send message"><mat-icon fonticon="arrow_upward"></mat-icon></button>
    `);
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });

    await submitPrompt(document, "hello");
    expect(clicks).toBe(1);
  });

  it("waits until the send button is enabled", async (): Promise<void> => {
    createPage(`
      <div role="textbox" contenteditable="true"></div>
      <button disabled aria-disabled="true"><span data-mat-icon-name="send"></span></button>
    `);
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    setTimeout((): void => {
      button.disabled = false;
      button.setAttribute("aria-disabled", "false");
    }, 50);
    await submitPrompt(document, "hello");
    expect(clicks).toBe(1);
  });

  it("waits for composer input processing when an attachment already enables send", async (): Promise<void> => {
    createPage(`
      <div role="textbox" contenteditable="true"></div>
      <button aria-label="Send message"></button>
    `);
    const composer: HTMLElement = document.querySelector('[role="textbox"]') as HTMLElement;
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let processedText: string = "";
    let submittedText: string = "";
    composer.addEventListener("input", (): void => {
      setTimeout((): void => {
        processedText = composer.textContent ?? "";
      }, 0);
    });
    button.addEventListener("click", (): void => {
      submittedText = processedText;
    });

    await submitPrompt(document, "hello");
    expect(submittedText).toBe("hello");
  });

  it("waits for the send button after a slow model transition", async (): Promise<void> => {
    createPage('<div role="textbox" contenteditable="true"></div>');
    let clicks: number = 0;
    setTimeout((): void => {
      const button: HTMLButtonElement = document.createElement("button");
      button.innerHTML = '<span data-mat-icon-name="send"></span>';
      button.addEventListener("click", (): void => {
        clicks += 1;
      });
      document.body.append(button);
    }, 2_100);

    await submitPrompt(document, "hello");
    expect(clicks).toBe(1);
  });

  it("reapplies the prompt when a model transition replaces the composer", async (): Promise<void> => {
    createPage('<div role="textbox" contenteditable="true"></div>');
    let submittedText: string = "";
    setTimeout((): void => {
      document.body.innerHTML = `
        <div role="textbox" contenteditable="true"></div>
        <button><span data-mat-icon-name="send"></span></button>
      `;
      const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
      button.addEventListener("click", (): void => {
        submittedText = document.querySelector('[role="textbox"]')?.textContent ?? "";
      });
    }, 50);

    await submitPrompt(document, "hello");
    expect(submittedText).toBe("hello");
  });

  it("rejects submission when the composer is unavailable", async (): Promise<void> => {
    createPage(`
      <button><span data-mat-icon-name="send"></span></button>
    `);
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    await expect(submitPrompt(document, "hello")).rejects.toThrowError("composer_not_found");
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

  it("opens the upload menu before selecting images", async (): Promise<void> => {
    createPage('<button aria-label="上传和工具"></button><div id="previews"></div>');
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    button.addEventListener("click", (): void => {
      const input: HTMLInputElement = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.className = "hidden-file-input";
      input.addEventListener("change", (): void => {
        const preview: HTMLElement = document.createElement("uploader-file-preview");
        document.querySelector("#previews")?.append(preview);
      });
      document.body.append(input);
    });
    await uploadImages(document, [{ bytes: new Uint8Array([1, 2]), mediaType: "image/png", name: "image.png" }]);
    const input: HTMLInputElement = document.querySelector("input") as HTMLInputElement;
    expect(Array.from(input.files ?? []).map((file: File): string => file.name)).toEqual(["image.png"]);
  });

  it("opens the current Gemini upload menu", async (): Promise<void> => {
    createPage('<button aria-label="Upload &amp; tools"></button><div id="previews"></div>');
    const button: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    button.addEventListener("click", (): void => {
      const input: HTMLInputElement = document.createElement("input");
      input.type = "file";
      input.className = "hidden-file-input";
      input.addEventListener("change", (): void => {
        document.querySelector("#previews")?.append(document.createElement("uploader-file-preview"));
      });
      document.body.append(input);
    });

    await uploadImages(document, [{ bytes: new Uint8Array([1]), mediaType: "image/png", name: "image.png" }]);
    expect(document.querySelectorAll("uploader-file-preview")).toHaveLength(1);
  });

  it("enables the current Gemini image generation tool", async (): Promise<void> => {
    createPage('<button aria-label="Upload &amp; tools"></button>');
    const menuButton: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let selections: number = 0;
    menuButton.addEventListener("click", (): void => {
      const imageTool: HTMLButtonElement = document.createElement("button");
      imageTool.setAttribute("role", "menuitemcheckbox");
      imageTool.setAttribute("aria-checked", "false");
      imageTool.innerHTML = '<mat-icon fonticon="image_create"></mat-icon><span>Create images</span>';
      imageTool.addEventListener("click", (): void => {
        selections += 1;
        imageTool.setAttribute("aria-checked", "true");
      });
      document.body.append(imageTool);
    });

    await enableImageGeneration(document);
    expect(selections).toBe(1);
  });

  it("ignores stale image icons before the current image tool", async (): Promise<void> => {
    createPage(`
      <mat-icon fonticon="image_create"></mat-icon>
      <button role="menuitemcheckbox" aria-checked="false">
        <mat-icon fonticon="image_create"></mat-icon>
      </button>
    `);
    const imageTool: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    let selections: number = 0;
    imageTool.addEventListener("click", (): void => {
      selections += 1;
      imageTool.setAttribute("aria-checked", "true");
    });

    await enableImageGeneration(document);
    expect(selections).toBe(1);
  });

  it("accepts the current Gemini selected image chip", async (): Promise<void> => {
    createPage(`
      <button role="menuitemcheckbox" aria-checked="false">
        <mat-icon fonticon="image_create"></mat-icon>
      </button>
    `);
    const imageTool: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    imageTool.addEventListener("click", (): void => {
      document.body.innerHTML = `
        <button aria-label="取消选择“图片”">
          <mat-icon fonticon="image_create"></mat-icon>
        </button>
      `;
    });

    await enableImageGeneration(document);
    expect(document.querySelector('button[aria-label="取消选择“图片”"]')).not.toBeNull();
  });

  it("rejects a disabled image generation tool", async (): Promise<void> => {
    createPage(`
      <button role="menuitemcheckbox" aria-checked="false" aria-disabled="true" disabled>
        <mat-icon fonticon="image_create"></mat-icon>
      </button>
    `);
    await expect(enableImageGeneration(document)).rejects.toThrowError("image_generation_not_available");
  });

  it("reopens image tools after a model transition replaces the menu", async (): Promise<void> => {
    createPage('<button aria-label="Upload &amp; tools" aria-expanded="false"></button>');
    const firstMenuButton: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
    firstMenuButton.addEventListener("click", (): void => {
      firstMenuButton.setAttribute("aria-expanded", "true");
    });
    setTimeout((): void => {
      document.body.innerHTML = '<button aria-label="Upload &amp; tools" aria-expanded="false"></button>';
      const currentMenuButton: HTMLButtonElement = document.querySelector("button") as HTMLButtonElement;
      currentMenuButton.addEventListener("click", (): void => {
        currentMenuButton.setAttribute("aria-expanded", "true");
        const imageTool: HTMLButtonElement = document.createElement("button");
        imageTool.setAttribute("role", "menuitemcheckbox");
        imageTool.setAttribute("aria-checked", "false");
        imageTool.innerHTML = '<mat-icon fonticon="image_create"></mat-icon>';
        imageTool.addEventListener("click", (): void => {
          imageTool.setAttribute("aria-checked", "true");
        });
        document.body.append(imageTool);
      });
    }, 100);

    await enableImageGeneration(document);
    expect(document.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
  });

  it("rejects unavailable Gemini image generation", async (): Promise<void> => {
    createPage('<button aria-label="Upload &amp; tools"></button>');
    await expect(enableImageGeneration(document)).rejects.toThrowError("image_generation_not_available");
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

  it("ignores changing response chrome around stable markdown", async (): Promise<void> => {
    createPage('<button id="stop"><span data-mat-icon-name="stop"></span></button>');
    setTimeout((): void => {
      const response: HTMLElement = document.createElement("model-response");
      response.innerHTML = '<div class="model-response-text"><span id="status">Working</span><div class="markdown">Hel</div></div>';
      document.body.append(response);
    }, 10);
    setTimeout((): void => {
      document.querySelector("#status")?.remove();
      const markdown: HTMLElement = document.querySelector(".markdown") as HTMLElement;
      markdown.textContent = "Hello";
      document.querySelector("#stop")?.remove();
    }, 250);

    const deltas: string[] = [];
    const text: string = await streamAssistantText(document, 0, (delta: string): void => {
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

  it("fails when image generation completes with text instead of an image", async (): Promise<void> => {
    vi.useFakeTimers();
    createPage('<model-response><div class="markdown">I encountered an error doing what you asked.</div></model-response>');
    const result: Promise<Uint8Array> = waitForGeneratedImage(document, 0);
    const expectation: Promise<void> = expect(result).rejects.toThrowError("image_generation_failed");
    await vi.advanceTimersByTimeAsync(240_000);
    await expectation;
    vi.useRealTimers();
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
