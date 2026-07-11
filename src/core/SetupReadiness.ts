import type { EmbeddingConnectionResult } from "../ai/embeddingConnectionStatus";
import type { ProviderConnectionResult } from "../ai/providerConnectionStatus";
import type { LLMProvider, PluginSettings } from "../addon";

export type SetupMilestoneState =
  | "checking"
  | "complete"
  | "action"
  | "error"
  | "pending";

export type SetupMilestoneId =
  | "cloud-connection"
  | "ollama-installation"
  | "local-model"
  | "embedding";

export type SetupMilestone = {
  id: SetupMilestoneId;
  state: SetupMilestoneState;
};

export type SetupReadiness = {
  provider: LLMProvider;
  embeddingRequired: boolean;
  providerReady: boolean;
  embeddingReady: boolean;
  ready: boolean;
  milestones: SetupMilestone[];
};

/**
 * Chat and embeddings share a single local Ollama installation now (one
 * base URL for both), so "is Ollama itself reachable" is modelled as one
 * shared milestone instead of being re-derived separately for the chat
 * model and for embeddings. It shows up whenever either the active chat
 * provider is local Ollama, or semantic search needs Ollama for
 * embeddings (which applies to cloud chat too) - and once it is complete,
 * the chat-model and embedding-model milestones just check their specific
 * model, without re-verifying the connection.
 */
export function deriveSetupReadiness(
  settings: Pick<
    PluginSettings,
    "provider" | "apiKey" | "embeddingSearchEnabled"
  >,
  providerConnection: ProviderConnectionResult | undefined,
  embeddingConnection: EmbeddingConnectionResult,
): SetupReadiness {
  const provider = settings.provider === "ollama" ? "ollama" : "kisski";
  const embeddingRequired = settings.embeddingSearchEnabled;
  const providerReady = providerConnection?.status === "ready";
  const embeddingReady =
    !embeddingRequired || embeddingConnection.status === "ready";
  const ready = providerReady && embeddingReady;
  const needsOllama = provider === "ollama" || embeddingRequired;

  const milestones: SetupMilestone[] = [];

  if (provider === "kisski") {
    milestones.push({
      id: "cloud-connection",
      state: settings.apiKey.trim()
        ? getProviderMilestoneState(providerConnection)
        : "action",
    });
  }

  let ollamaState: SetupMilestoneState | null = null;
  if (needsOllama) {
    ollamaState = getOllamaInstallationState(
      provider === "ollama" ? providerConnection : undefined,
      embeddingConnection,
    );
    milestones.push({ id: "ollama-installation", state: ollamaState });
  }

  if (provider === "ollama") {
    milestones.push({
      id: "local-model",
      state:
        ollamaState === "complete"
          ? getProviderMilestoneState(providerConnection)
          : "pending",
    });
  }

  if (embeddingRequired) {
    milestones.push({
      id: "embedding",
      state:
        ollamaState === "complete"
          ? getEmbeddingModelState(embeddingConnection)
          : "pending",
    });
  }

  return {
    provider,
    embeddingRequired,
    providerReady,
    embeddingReady,
    ready,
    milestones,
  };
}

function getProviderMilestoneState(
  connection: ProviderConnectionResult | undefined,
): SetupMilestoneState {
  if (!connection || connection.status === "unknown") return "pending";
  if (connection.status === "checking") return "checking";
  if (connection.status === "ready") return "complete";
  if (
    connection.status === "missing-config" ||
    connection.status === "missing-model"
  ) {
    return "action";
  }
  return "error";
}

/**
 * Only judges whether the embedding *model* is installed. Whether Ollama
 * itself is reachable is the "ollama-installation" milestone's job - this
 * is only evaluated once that milestone is already "complete".
 */
function getEmbeddingModelState(
  connection: EmbeddingConnectionResult,
): SetupMilestoneState {
  if (connection.status === "unknown") return "pending";
  if (connection.status === "checking") return "checking";
  if (connection.status === "ready") return "complete";
  if (connection.status === "missing-model") return "action";
  return "error";
}

function getOllamaInstallationState(
  providerConnection: ProviderConnectionResult | undefined,
  embeddingConnection: EmbeddingConnectionResult,
): SetupMilestoneState {
  const connections = [providerConnection, embeddingConnection];
  if (
    connections.some(
      (connection) =>
        connection?.issue === "ollama-not-installed" ||
        connection?.issue === "ollama-not-running",
    )
  ) {
    return "action";
  }
  if (
    connections.some(
      (connection) =>
        connection?.issue === "ollama-start-failed" ||
        connection?.issue === "ollama-startup-timeout",
    )
  ) {
    return "error";
  }
  if (connections.some((connection) => connection?.status === "checking")) {
    return "checking";
  }
  if (
    connections.some(
      (connection) =>
        connection?.status === "ready" ||
        connection?.status === "missing-model",
    )
  ) {
    return "complete";
  }
  if (
    connections.some((connection) => connection?.status === "missing-config")
  ) {
    return "action";
  }
  if (connections.every((connection) => isConnectionPending(connection))) {
    return "pending";
  }
  return "error";
}

function isConnectionPending(
  connection: ProviderConnectionResult | EmbeddingConnectionResult | undefined,
): boolean {
  if (!connection) return true;
  return connection.status === "unknown" || connection.status === "disabled";
}
