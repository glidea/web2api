import type { Provider } from "../../shared/protocol";

export type PopupProviderStatus = {
  contentScriptReady: boolean;
  workerReady: boolean;
  loggedIn?: boolean;
  models: string[];
  reasoningEfforts: string[];
  tabs?: number;
};

export type PopupStatus = {
  nativeHostInstalled: boolean;
  nativeHostError?: string;
  daemonRunning: boolean;
  daemonConnected: boolean;
  baseUrl?: string;
  apiKey?: string;
  providers: Record<Provider, PopupProviderStatus>;
  installCommand: string;
};

export type PopupRequest =
  | { type: "web2api:popup"; action: "status" }
  | { type: "web2api:popup"; action: "start" }
  | { type: "web2api:popup"; action: "stop" }
  | { type: "web2api:popup"; action: "restart" }
  | { type: "web2api:popup"; action: "configure"; chatGptTabs: number; geminiTabs: number; grokTabs: number };
