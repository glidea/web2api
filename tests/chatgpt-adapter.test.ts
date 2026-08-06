import { describe, expect, it } from "vitest";
import {
  AssistantTextReader,
  extractGeneratedImage,
  getCapabilities,
  isChatGPTLoggedIn,
  parseConversationId,
  selectModel,
  selectReasoningEffort,
  streamAssistantText,
  submitPrompt,
  cancelGeneration,
  uploadImages,
  waitForFinalAssistantText,
  type ImagePayload
} from "../src/extension/lib/chatgpt-adapter";

function createPage(markup: string): void {
  document.body.innerHTML = markup;
}

describe("ChatGPT adapter", (): void => {
  it("detects a logged-out ChatGPT page", (): void => {
    createPage('<button data-testid="login-button">Log in</button>');
    expect(isChatGPTLoggedIn(document)).toBe(false);
    createPage('<div id="prompt-textarea" contenteditable="true"></div>');
    expect(isChatGPTLoggedIn(document)).toBe(true);
  });

  it("reads a conversation id from a ChatGPT URL", (): void => {
    expect(parseConversationId("https://chatgpt.com/c/conv-123")) .toBe("conv-123");
    expect(parseConversationId("https://chatgpt.com/")) .toBeUndefined();
  });

  it("emits only assistant text appended to the previous DOM text", (): void => {
    const node: HTMLElement = document.createElement("div");
    const reader: AssistantTextReader = new AssistantTextReader(node);
    node.textContent = "Hel";
    expect(reader.readDelta()).toBe("Hel");
    node.textContent = "Hello";
    expect(reader.readDelta()).toBe("lo");
    node.textContent = "He";
    expect(reader.readDelta()).toBe("");
    node.textContent = "Hello!";
    expect(reader.readDelta()).toBe("!");
  });

  it("uploads image files in request order", async (): Promise<void> => {
    createPage('<input data-testid="upload-photos-input" type="file" multiple />');
    const first: ImagePayload = { bytes: new Uint8Array([1, 2]), mediaType: "image/png", name: "first.png" };
    const second: ImagePayload = { bytes: new Uint8Array([3, 4]), mediaType: "image/jpeg", name: "second.jpg" };
    const input: HTMLInputElement = document.querySelector("[data-testid=upload-photos-input]") as HTMLInputElement;
    await uploadImages(document, [first, second]);
    expect(input.files).toHaveLength(2);
    expect(input.files?.[0]?.name).toBe("first.png");
    expect(input.files?.[1]?.name).toBe("second.jpg");
  });

  it("scans and selects models from the real ChatGPT menu structure", async (): Promise<void> => {
    createPage(`
      <button data-testid="model-switcher-dropdown-button">ChatGPT</button>
      <div role="menu">
        <div role="menuitemradio"><span>GPT-5.2 Instant</span><div>Fast responses</div></div>
        <div role="menuitemradio"><span>GPT-5.2 Thinking</span><div>Deeper reasoning</div></div>
      </div>
      <button data-testid="reasoning-selector">
        <span data-effort="low">Low</span>
        <span data-effort="high">High</span>
      </button>
    `);
    expect(await getCapabilities(document)).toEqual({ models: ["gpt-5.2-instant", "gpt-5.2-thinking"], reasoningEfforts: ["low", "high"] });
    await selectModel(document, "gpt-5.2-thinking");
    expect(document.querySelector('[role=menuitemradio]:nth-child(2)')?.getAttribute("data-selected")).toBe("true");
    await selectReasoningEffort(document, "high");
    expect(document.querySelector("[data-testid=reasoning-selector]")?.getAttribute("data-selected-effort")).toBe("high");
    await expect(selectModel(document, "unknown")).rejects.toThrowError("model_not_available");
    await expect(selectReasoningEffort(document, "max")).rejects.toThrowError("unsupported_reasoning_effort");
  });

  it("submits prompt through the page composer", async (): Promise<void> => {
    createPage('<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button"></button>');
    const button: HTMLButtonElement = document.querySelector("[data-testid=send-button]") as HTMLButtonElement;
    const composer: HTMLElement = document.querySelector("#prompt-textarea") as HTMLElement;
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

  it("clicks the page stop button when generation is cancelled", (): void => {
    createPage('<button data-testid="stop-button"></button>');
    const button: HTMLButtonElement = document.querySelector("[data-testid=stop-button]") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    cancelGeneration(document);
    expect(clicks).toBe(1);
  });

  it("reads the newest assistant message", async (): Promise<void> => {
    createPage(`
      <div data-message-author-role="assistant">old answer</div>
      <div data-message-author-role="assistant">new answer</div>
    `);
    await expect(waitForFinalAssistantText(document)).resolves.toBe("new answer");
  });

  it("streams only the assistant message created after submission", async (): Promise<void> => {
    createPage('<div data-message-author-role="assistant">old answer</div>');
    const deltas: string[] = [];
    setTimeout((): void => {
      const answer: HTMLDivElement = document.createElement("div");
      answer.dataset.messageAuthorRole = "assistant";
      answer.textContent = "Hel";
      document.body.append(answer);
    }, 10);
    setTimeout((): void => {
      const answers: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role=assistant]"));
      const answer: HTMLElement = answers.at(-1) as HTMLElement;
      answer.textContent = "Hello";
    }, 80);
    const text: string = await streamAssistantText(document, 1, (delta: string): void => {
      deltas.push(delta);
    });
    expect(text).toBe("Hello");
    expect(deltas.join("")).toBe("Hello");
  });

  it("returns bytes from the final generated image", async (): Promise<void> => {
    createPage('<div data-message-author-role="assistant"><img src="data:image/png;base64,AQID" /></div>');
    const image: Uint8Array | undefined = await extractGeneratedImage(document);
    expect(image).toEqual(new Uint8Array([1, 2, 3]));
  });
});
