import type { LLMProvider } from "../addon";

/**
 * Beschreibt den technischen Zustand einer Provider-Verbindung.
 */
export type ProviderConnectionStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "missing-config"
  | "unreachable"
  | "missing-model"
  | "error";

/**
 * Beschreibt die konkrete Ursache eines Provider-Verbindungsproblems.
 */
export type ProviderConnectionIssue =
  | "api-key-missing"
  | "base-url-missing"
  | "model-missing"
  | "model-not-available"
  | "model-not-installed"
  | "provider-unreachable"
  | "invalid-response"
  | "ollama-not-installed"
  | "ollama-not-running"
  | "ollama-start-failed"
  | "ollama-startup-timeout"
  | "unknown-error";

/**
 * Ergebnis einer Provider-Verbindungspruefung.
 */
export type ProviderConnectionResult = {
  provider: LLMProvider;
  status: ProviderConnectionStatus;
  ok: boolean;
  checkedAt: string;
  message?: string;
  issue?: ProviderConnectionIssue;
  model?: string;
  baseUrl?: string;
  error?: string;
};

export type ProviderConnectionState = Partial<
  Record<LLMProvider, ProviderConnectionResult>
>;

/**
 * Erstellt ein normalisiertes Ergebnis fuer eine Provider-Verbindungspruefung.
 *
 * @param provider - Provider, fuer den der Status gilt.
 * @param status - Technischer Verbindungsstatus.
 * @param details - Optionale Details wie Issue, Modell, Base-URL oder Fehlermeldung.
 * @returns Normalisiertes Verbindungsergebnis mit Zeitstempel.
 */
export function createProviderConnectionResult(
  provider: LLMProvider,
  status: ProviderConnectionStatus,
  details: Omit<
    ProviderConnectionResult,
    "provider" | "status" | "ok" | "checkedAt"
  > = {},
): ProviderConnectionResult {
  return {
    provider,
    status,
    ok: status === "ready",
    checkedAt: new Date().toISOString(),
    ...details,
  };
}

/**
 * Erstellt einen Status fuer eine laufende Provider-Verbindungspruefung.
 *
 * @param provider - Provider, dessen Verbindung gerade geprueft wird.
 * @returns Verbindungsergebnis mit Status "checking".
 */
export function createCheckingProviderConnectionResult(
  provider: LLMProvider,
): ProviderConnectionResult {
  return createProviderConnectionResult(provider, "checking");
}
