/**
 * Describes the current availability state of the embedding provider.
 */
export type EmbeddingConnectionStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "disabled"
  | "missing-config"
  | "unreachable"
  | "missing-model"
  | "error";

/**
 * Describes a concrete reason why the embedding provider is not usable.
 */
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

/**
 * Contains the normalized result of an embedding provider connection check.
 */
export type EmbeddingConnectionResult = {
  /**
   * Current connection status derived from configuration and provider checks.
   */
  status: EmbeddingConnectionStatus;

  /**
   * Indicates whether the embedding connection is acceptable for the current setup.
   */
  ok: boolean;

  /**
   * ISO timestamp at which the connection result was created.
   */
  checkedAt: string;

  /**
   * Optional human-readable status or error message.
   */
  message?: string;

  /**
   * Optional machine-readable issue code for failed or incomplete checks.
   */
  issue?: EmbeddingConnectionIssue;

  /**
   * Optional embedding model name that was checked.
   */
  model?: string;

  /**
   * Optional base URL of the embedding provider endpoint that was checked.
   */
  baseUrl?: string;

  /**
   * Optional raw error details captured during the check.
   */
  error?: string;
};

/**
 * Creates a normalized embedding connection result with automatic success and timestamp fields.
 *
 * @param status - Connection status to store in the result.
 * @param details - Optional additional metadata about the connection check.
 * @returns A complete embedding connection result object.
 */
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

/**
 * Creates the default result used while an embedding connection check is still running.
 *
 * @returns An embedding connection result with the status set to "checking".
 */
export function createCheckingEmbeddingConnectionResult() {
  return createEmbeddingConnectionResult("checking");
}
