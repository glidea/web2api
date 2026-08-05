export type ResponseReference = {
  conversationId: string;
  turnId: string;
};

export function encodeResponseId(conversationId: string, turnId: string): string {
  if (conversationId.length === 0 || turnId.length === 0 || conversationId.includes("\n") || turnId.includes("\n")) {
    throw new Error("Invalid response id parts");
  }
  return `resp_${conversationId}_${turnId}`;
}

export function decodeResponseId(responseId: string): ResponseReference {
  if (!responseId.startsWith("resp_")) {
    throw new Error("Invalid response id");
  }
  const value: string = responseId.slice("resp_".length);
  const separator: number = value.lastIndexOf("_");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Invalid response id");
  }
  return { conversationId: value.slice(0, separator), turnId: value.slice(separator + 1) };
}
