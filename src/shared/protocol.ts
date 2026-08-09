export type Provider = "chatgpt" | "gemini";

export type Capabilities = {
  models: string[];
  reasoning_efforts: string[];
};

export type ExtensionHelloMessage = {
  version: 1;
  type: "extension.hello";
  extension_version: string;
  chrome_version: string;
};

export type WorkerReadyMessage = {
  version: 1;
  type: "worker.ready";
  provider: Provider;
  worker_id: string;
  capabilities: Capabilities;
};

export type WorkerUnhealthyMessage = {
  version: 1;
  type: "worker.unhealthy";
  worker_id: string;
  code: string;
};

export type CapabilitiesUpdatedMessage = {
  version: 1;
  type: "capabilities.updated";
  worker_id: string;
  capabilities: Capabilities;
};

export type HeartbeatMessage = {
  version: 1;
  type: "heartbeat";
  timestamp: number;
};

export type JobStartMessage = {
  version: 1;
  type: "job.start";
  provider: Provider;
  request_id: string;
  worker_id: string;
  payload: {
    model: string;
    input: string;
    conversation_id?: string;
    reasoning_effort?: string;
    images?: Array<{ data: string; media_type: string; name: string }>;
    generate_image?: boolean;
  };
};

export type JobCancelMessage = {
  version: 1;
  type: "job.cancel";
  request_id: string;
  worker_id: string;
};

export type JobConversationBoundMessage = {
  version: 1;
  type: "job.conversation_bound";
  request_id: string;
  worker_id: string;
  conversation_id: string;
};

export type JobOutputTextDeltaMessage = {
  version: 1;
  type: "job.output_text.delta";
  request_id: string;
  worker_id: string;
  sequence: number;
  delta: string;
};

export type JobImageCompletedMessage = {
  version: 1;
  type: "job.image.completed";
  request_id: string;
  worker_id: string;
  media_type: string;
  data: string;
};

export type JobCompletedMessage = {
  version: 1;
  type: "job.completed";
  request_id: string;
  worker_id: string;
};

export type JobFailedMessage = {
  version: 1;
  type: "job.failed";
  request_id: string;
  worker_id: string;
  code: string;
  message: string;
};

export type ExtensionToDaemonMessage = ExtensionHelloMessage | WorkerReadyMessage | WorkerUnhealthyMessage | CapabilitiesUpdatedMessage | HeartbeatMessage | JobConversationBoundMessage | JobOutputTextDeltaMessage | JobImageCompletedMessage | JobCompletedMessage | JobFailedMessage;

export type ExtensionConfigureMessage = {
  version: 1;
  type: "extension.configure";
  chatgpt_tabs: number;
  gemini_tabs: number;
};

export type DaemonToExtensionMessage = ExtensionConfigureMessage | HeartbeatMessage | JobStartMessage | JobCancelMessage;

export function parseExtensionMessage(value: unknown): ExtensionToDaemonMessage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (record["version"] !== 1 || typeof record["type"] !== "string") {
    return undefined;
  }
  return value as ExtensionToDaemonMessage;
}

export function providerFromModel(model: string): Provider | undefined {
  const separator: number = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return undefined;
  }
  switch (model.slice(0, separator)) {
    case "chatgpt":
      return "chatgpt";
    case "gemini":
      return "gemini";
    default:
      return undefined;
  }
}
