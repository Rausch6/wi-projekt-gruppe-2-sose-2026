export type EmbeddingConnectionStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "disabled"
  | "missing-config"
  | "unreachable"
  | "missing-model"
  | "error";

export type EmbeddingConnectionIssue =
  | "base-url-missing"
  | "model-missing"
  | "model-not-installed"
  | "provider-unreachable"
  | "invalid-response"
  | "ollama-not-installed"
  | "ollama-not-running"
  | "ollama-start-failed"
  | "ollama-startup-timeout"
  | "unknown-error";

export type EmbeddingConnectionResult = {
  status: EmbeddingConnectionStatus;
  ok: boolean;
  checkedAt: string;
  message?: string;
  issue?: EmbeddingConnectionIssue;
  model?: string;
  baseUrl?: string;
  error?: string;
};

export function createEmbeddingConnectionResult(
  status: EmbeddingConnectionStatus,
  details: Omit<EmbeddingConnectionResult, "status" | "ok" | "checkedAt"> = {},
): EmbeddingConnectionResult {
  return {
    status,
    ok: status === "ready" || status === "disabled",
    checkedAt: new Date().toISOString(),
    ...details,
  };
}

export function createCheckingEmbeddingConnectionResult() {
  return createEmbeddingConnectionResult("checking");
}
