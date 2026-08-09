import type { Provider } from "../shared/protocol";

export type ResponseReference = {
  provider: Provider;
  conversationId: string;
  turnId: string;
};

export function encodeResponseId(provider: Provider, conversationId: string, turnId: string): string {
  if (conversationId.length === 0 || turnId.length === 0 || conversationId.includes("\n") || turnId.includes("\n")) {
    throw new Error("Invalid response id parts");
  }
  return `resp_${provider}_${conversationId}_${turnId}`;
}

export function decodeResponseId(responseId: string): ResponseReference {
  if (!responseId.startsWith("resp_")) {
    throw new Error("Invalid response id");
  }
  const value: string = responseId.slice("resp_".length);
  const providerSeparator: number = value.indexOf("_");
  const turnSeparator: number = value.lastIndexOf("_");
  if (providerSeparator <= 0 || turnSeparator <= providerSeparator + 1 || turnSeparator === value.length - 1) {
    throw new Error("Invalid response id");
  }
  const providerValue: string = value.slice(0, providerSeparator);
  let provider: Provider;
  switch (providerValue) {
    case "chatgpt":
    case "gemini":
      provider = providerValue;
      break;
    default:
      throw new Error("Invalid response id");
  }
  return {
    provider,
    conversationId: value.slice(providerSeparator + 1, turnSeparator),
    turnId: value.slice(turnSeparator + 1)
  };
}
