import type { ConfirmationAction } from "@app/contracts";

export interface LocalAgentConfirmationDelivery {
  confirmationId: string;
  action: ConfirmationAction;
  executionId: string;
  configVersion: number;
  token: string;
  expiresAt: string;
}

export interface LocalAgentBridgeConnection {
  connected: boolean;
  agentId: string | null;
  sessionId: string | null;
  executionId: string | null;
}

export interface LocalAgentBridge {
  getConnection(): LocalAgentBridgeConnection;
  subscribe(listener: () => void): () => void;
  deliverConfirmation(
    confirmation: LocalAgentConfirmationDelivery
  ): Promise<{ acknowledged: true }>;
}

declare global {
  interface Window {
    baiduOneClickLocalAgentBridge?: LocalAgentBridge;
  }
}

export function resolveLocalAgentBridge(): LocalAgentBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.baiduOneClickLocalAgentBridge;
  return bridge &&
    typeof bridge.getConnection === "function" &&
    typeof bridge.subscribe === "function" &&
    typeof bridge.deliverConfirmation === "function"
    ? bridge
    : null;
}
