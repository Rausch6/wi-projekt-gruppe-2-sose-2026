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
  | "ollama-service"
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
 * Chat and embeddings share one local Ollama installation and service. The
 * installation and the running service are separate milestones so setup can
 * install the signed desktop app without also downloading models. Once the
 * service is reachable, the model milestones only check their own model.
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

  let ollamaServiceState: SetupMilestoneState | null = null;
  if (needsOllama) {
    const ollamaStates = getOllamaStates(
      provider === "ollama" ? providerConnection : undefined,
      embeddingConnection,
    );
    ollamaServiceState = ollamaStates.service;
    milestones.push(
      { id: "ollama-installation", state: ollamaStates.installation },
      { id: "ollama-service", state: ollamaStates.service },
    );
  }

  if (provider === "ollama") {
    milestones.push({
      id: "local-model",
      state:
        ollamaServiceState === "complete"
          ? getProviderMilestoneState(providerConnection)
          : "pending",
    });
  }

  if (embeddingRequired) {
    milestones.push({
      id: "embedding",
      state:
        ollamaServiceState === "complete"
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

function getOllamaStates(
  providerConnection: ProviderConnectionResult | undefined,
  embeddingConnection: EmbeddingConnectionResult,
): {
  installation: SetupMilestoneState;
  service: SetupMilestoneState;
} {
  const connections = [providerConnection, embeddingConnection];

  // A reachable API proves both that Ollama exists and that its service runs.
  if (
    connections.some(
      (connection) =>
        connection?.status === "ready" ||
        connection?.status === "missing-model",
    )
  ) {
    return { installation: "complete", service: "complete" };
  }

  if (
    connections.some(
      (connection) => connection?.issue === "ollama-not-installed",
    )
  ) {
    return { installation: "action", service: "pending" };
  }

  if (
    connections.some((connection) => connection?.issue === "ollama-not-running")
  ) {
    return { installation: "complete", service: "action" };
  }

  if (
    connections.some(
      (connection) =>
        connection?.issue === "ollama-start-failed" ||
        connection?.issue === "ollama-startup-timeout",
    )
  ) {
    return { installation: "complete", service: "error" };
  }

  if (connections.some((connection) => connection?.status === "checking")) {
    return { installation: "checking", service: "checking" };
  }

  if (
    connections.some((connection) => connection?.status === "missing-config")
  ) {
    return { installation: "action", service: "pending" };
  }

  if (connections.every((connection) => isConnectionPending(connection))) {
    return { installation: "pending", service: "pending" };
  }

  return { installation: "error", service: "error" };
}

function isConnectionPending(
  connection: ProviderConnectionResult | EmbeddingConnectionResult | undefined,
): boolean {
  if (!connection) return true;
  return connection.status === "unknown" || connection.status === "disabled";
}
