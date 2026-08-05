import { describe, expect, it } from "vitest";
import {
  AssistantTextReader,
  extractGeneratedImage,
  getCapabilities,
  parseConversationId,
  selectModel,
  selectReasoningEffort,
  submitPrompt,
  cancelGeneration,
  uploadImages,
  type ImagePayload
} from "../src/extension/lib/chatgpt-adapter";

function createPage(markup: string): void {
  document.body.innerHTML = markup;
}

describe("ChatGPT adapter", (): void => {
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
    createPage('<input data-testid="upload-input" type="file" multiple />');
    const first: ImagePayload = { bytes: new Uint8Array([1, 2]), mediaType: "image/png", name: "first.png" };
    const second: ImagePayload = { bytes: new Uint8Array([3, 4]), mediaType: "image/jpeg", name: "second.jpg" };
    const input: HTMLInputElement = document.querySelector("[data-testid=upload-input]") as HTMLInputElement;
    await uploadImages(document, [first, second]);
    expect(input.files).toHaveLength(2);
    expect(input.files?.[0]?.name).toBe("first.png");
    expect(input.files?.[1]?.name).toBe("second.jpg");
  });

  it("scans capabilities and rejects unsupported model or effort", (): void => {
    createPage(`
      <button data-testid="model-selector">
        <span data-model-id="gpt-4o">GPT-4o</span>
        <span data-model-id="o3">o3</span>
      </button>
      <button data-testid="reasoning-selector">
        <span data-effort="low">Low</span>
        <span data-effort="high">High</span>
      </button>
    `);
    expect(getCapabilities(document)).toEqual({ models: ["gpt-4o", "o3"], reasoningEfforts: ["low", "high"] });
    selectModel(document, "o3");
    expect(document.querySelector("[data-testid=model-selector]")?.getAttribute("data-selected-model")).toBe("o3");
    selectReasoningEffort(document, "high");
    expect(document.querySelector("[data-testid=reasoning-selector]")?.getAttribute("data-selected-effort")).toBe("high");
    expect((): void => selectModel(document, "unknown")).toThrowError("model_not_available");
    expect((): void => selectReasoningEffort(document, "max")).toThrowError("unsupported_reasoning_effort");
  });

  it("submits prompt through the page composer", (): void => {
    createPage('<textarea data-testid="composer"></textarea><button data-testid="send-button"></button>');
    const button: HTMLButtonElement = document.querySelector("[data-testid=send-button]") as HTMLButtonElement;
    let clicks: number = 0;
    button.addEventListener("click", (): void => {
      clicks += 1;
    });
    submitPrompt(document, "hello");
    expect((document.querySelector("[data-testid=composer]") as HTMLTextAreaElement).value).toBe("hello");
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

  it("returns bytes from the final generated image", async (): Promise<void> => {
    createPage('<img data-generated-image src="data:image/png;base64,AQID" />');
    const image: Uint8Array | undefined = await extractGeneratedImage(document);
    expect(image).toEqual(new Uint8Array([1, 2, 3]));
  });
});
