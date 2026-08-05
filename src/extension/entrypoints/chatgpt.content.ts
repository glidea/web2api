import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  main(): void {
    document.documentElement.dataset.web2apiContentScript = "ready";
    void browser.runtime.sendMessage({
      type: "web2api:content-ready",
      url: window.location.href
    });
  }
});
