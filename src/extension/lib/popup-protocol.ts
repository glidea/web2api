export type PopupStatus = {
  nativeHostInstalled: boolean;
  nativeHostError?: string;
  daemonRunning: boolean;
  daemonConnected: boolean;
  workerReady: boolean;
  contentScriptReady: boolean;
  baseUrl?: string;
  apiKey?: string;
  maxTabs?: number;
  installCommand: string;
};

export type PopupRequest =
  | { type: "web2api:popup"; action: "status" }
  | { type: "web2api:popup"; action: "start" }
  | { type: "web2api:popup"; action: "stop" }
  | { type: "web2api:popup"; action: "restart" }
  | { type: "web2api:popup"; action: "configure"; maxTabs: number };
