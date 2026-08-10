import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  manifest: {
    name: "Web2API",
    version: "0.1.0",
    description: "Expose browser AI sessions as a local API",
    permissions: ["tabs", "nativeMessaging"],
    host_permissions: ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://grok.com/*", "https://assets.grok.com/*"]
  }
});
