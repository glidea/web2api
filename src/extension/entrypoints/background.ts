import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

type ContentReadyMessage = {
  type: "web2api:content-ready";
  url: string;
};

type PopupStatusMessage = {
  type: "web2api:popup-status";
};

type PopupStatus = {
  contentScriptReady: boolean;
};

let contentScriptReady: boolean = false;

export default defineBackground((): void => {
  browser.runtime.onMessage.addListener((message: unknown): Promise<PopupStatus | undefined> => {
    if (isContentReadyMessage(message)) {
      contentScriptReady = true;
      return Promise.resolve(undefined);
    }

    if (isPopupStatusMessage(message)) {
      return Promise.resolve({ contentScriptReady });
    }

    return Promise.resolve(undefined);
  });
});

function isContentReadyMessage(message: unknown): message is ContentReadyMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "web2api:content-ready" && typeof value["url"] === "string";
}

function isPopupStatusMessage(message: unknown): message is PopupStatusMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const value: Record<string, unknown> = message as Record<string, unknown>;
  return value["type"] === "web2api:popup-status";
}
