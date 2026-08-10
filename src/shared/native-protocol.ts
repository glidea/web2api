export type NativeHostRequest =
  | { type: "ensure"; protocol_version: 1 }
  | { type: "status"; protocol_version: 1 }
  | { type: "stop"; protocol_version: 1 }
  | { type: "configure"; protocol_version: 1; chatgpt_tabs: number; gemini_tabs: number; grok_tabs: number };

export type NativeHostStatus = {
  ok: true;
  protocol_version: 1;
  daemon: "running" | "stopped";
  base_url: string;
  api_key: string;
  chatgpt_tabs: number;
  gemini_tabs: number;
  grok_tabs: number;
};

export type NativeHostResponse = NativeHostStatus | {
  ok: false;
  protocol_version: 1;
  code: string;
  message: string;
};
