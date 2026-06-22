import type { LLMProvider } from "../addon";

export type ProviderConnectionStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "missing-config"
  | "unreachable"
  | "missing-model"
  | "error";

export type ProviderConnectionIssue =
  | "api-key-missing"
  | "base-url-missing"
  | "model-missing"
  | "model-not-available"
  | "model-not-installed"
  | "provider-unreachable"
  | "invalid-response"
  | "unknown-error";

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

export function createCheckingProviderConnectionResult(
  provider: LLMProvider,
): ProviderConnectionResult {
  return createProviderConnectionResult(provider, "checking");
}
