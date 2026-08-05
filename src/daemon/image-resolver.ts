export type ResolvedImage = {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
};

const maxImageBytes: number = 16 * 1024 * 1024;

export async function resolveImage(source: string): Promise<ResolvedImage> {
  if (source.startsWith("data:")) {
    return decodeDataUrl(source);
  }
  const url: URL = new URL(source);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("image_url_not_supported");
  }
  const response: Response = await fetch(url);
  if (!response.ok) {
    throw new Error("image_download_failed");
  }
  const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
  assertImageSize(bytes);
  const mediaType: string = response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
  if (!mediaType.startsWith("image/")) {
    throw new Error("image_media_type_invalid");
  }
  const name: string = url.pathname.split("/").pop() || "image";
  return { bytes, mediaType, name };
}

function decodeDataUrl(source: string): ResolvedImage {
  const match: RegExpMatchArray | null = source.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("image_data_url_invalid");
  }
  const bytes: Uint8Array = new Uint8Array(Buffer.from(match[2], "base64"));
  assertImageSize(bytes);
  return { bytes, mediaType: match[1], name: `image.${match[1].slice("image/".length)}` };
}

function assertImageSize(bytes: Uint8Array): void {
  if (bytes.byteLength > maxImageBytes) {
    throw new Error("image_too_large");
  }
}
