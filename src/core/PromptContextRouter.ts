import type { LLMProvider } from "../addon";

export type PromptContextRoute =
  | "none"
  | "metadata"
  | "single_paper"
  | "filtered_papers"
  | "all_papers";

export type PromptContextRouteDecision = {
  route: PromptContextRoute;
  reason: string;
  confidence?: number;
  itemID?: number;
  itemIDs?: number[];
  tag?: string;
  property?: "title" | "firstCreator" | "year" | "itemType" | "tag";
  value?: string;
  requestedFields?: Array<
    "title" | "firstCreator" | "year" | "itemType" | "tags"
  >;
};

type MetadataField = NonNullable<
  PromptContextRouteDecision["requestedFields"]
>[number];

const DEFAULT_REQUESTED_FIELDS: MetadataField[] = [
  "title",
  "firstCreator",
  "year",
  "itemType",
  "tags",
];

export type PromptContextRouterCandidate = {
  itemID: number;
  title: string;
  firstCreator: string;
  year: string;
  itemType: string;
  tags: string[];
  libraryName: string;
};

export type PromptContextRouterOptions = {
  provider: LLMProvider;
  model: string;
  prompt: string;
  candidates: PromptContextRouterCandidate[];
  chat: (
    messages: RouterMessage[],
    options: {
      providerId: LLMProvider;
      model: string;
      temperature: number;
      maxTokens: number;
    },
  ) => Promise<{ content?: unknown }>;
};

type RouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const ROUTER_SYSTEM_PROMPT = [
  "Du bist ein Routing-Modul fuer einen Zotero-Wissenschaftsassistenten.",
  "Du beantwortest NICHT die Nutzerfrage.",
  "Du entscheidest ausschliesslich, welcher Kontext fuer die eigentliche Antwort benoetigt wird.",
  "Bewerte NUR den aktuellen Nutzerprompt in dieser Anfrage.",
  "Ignoriere jede moegliche vorherige Unterhaltung. Es gibt keinen Chatverlauf fuer diese Entscheidung.",
  "Nutze Paper-Metadaten nur zur Identifikation von passenden Paper-IDs, Tags oder Eigenschaften, nicht als Antwortgrundlage.",
  "Gib ausschliesslich valides JSON ohne Markdown zurueck.",
  "",
  "Erlaubte routes:",
  "- none: Keine Bibliotheksdaten noetig; Prompt kann direkt beantwortet werden. Nur fuer allgemeine Fragen ohne Bezug auf Paper/Bibliothek.",
  "- metadata: Der Nutzer fragt nach Titeln, Autoren, Jahren, Tags, Paperlisten oder Auswahl/Vergleich anhand von Metadaten; nur Metadaten aller Paper mitschicken.",
  "- single_paper: Ein einzelnes konkretes Paper wird benoetigt; gib itemID oder itemIDs mit genau einem Eintrag an.",
  "- filtered_papers: Alle Paper mit bestimmtem Tag oder bestimmter Metadaten-Eigenschaft werden benoetigt; gib tag oder property/value an.",
  "- all_papers: Der Nutzer verlangt explizit alle Paper bzw. eine Gesamtanalyse der ganzen Bibliothek.",
  "",
  "Pflichtregeln:",
  "- Wenn der aktuelle Prompt 'alle Paper', 'alle Dokumente', 'meine Paper', 'die Bibliothek' oder eine Zusammenfassung/Analyse ueber mehrere Paper verlangt, waehle all_papers.",
  "- Wenn der aktuelle Prompt nur Titel, Autoren, Jahre, Tags oder eine Liste der Paper verlangt, waehle metadata.",
  "- Wenn der aktuelle Prompt 'Zusammenfassung aller Paper' oder 'fasse alle Paper zusammen' enthaelt, waehle immer all_papers.",
  "- Waehle none niemals, wenn der aktuelle Prompt Paper, Zotero, Bibliothek, Dokumente, Quellen oder Metadaten erwaehnt.",
  "",
  "Beispiele:",
  'Prompt: "Gib mir die Titel der Paper" -> {"route":"metadata","reason":"Titel sind Metadaten","requestedFields":["title"]}',
  'Prompt: "Gib mir eine Zusammenfassung aller Paper" -> {"route":"all_papers","reason":"Zusammenfassung aller Paper braucht Textauszuege aus allen Papern"}',
  'Prompt: "Fasse das Paper von Smith 2020 zusammen" -> {"route":"single_paper","reason":"Ein konkretes Paper wird angefragt"}',
  "",
  "Schema:",
  '{"route":"none|metadata|single_paper|filtered_papers|all_papers","reason":"kurz","confidence":0.0,"itemID":123,"itemIDs":[123],"tag":"...","property":"title|firstCreator|year|itemType|tag","value":"...","requestedFields":["title","firstCreator","year","itemType","tags"]}',
].join("\n");

export async function decidePromptContextRoute({
  provider,
  model,
  prompt,
  candidates,
  chat,
}: PromptContextRouterOptions): Promise<PromptContextRouteDecision> {
  const messages: RouterMessage[] = [
    {
      role: "system",
      content: ROUTER_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        "AKTUELLER_NUTZERPROMPT_START",
        prompt,
        "AKTUELLER_NUTZERPROMPT_ENDE",
        "",
        "Verfuegbare Paper-Metadaten:",
        formatCandidates(candidates),
      ].join("\n"),
    },
  ];

  const result = await chat(messages, {
    providerId: provider,
    model,
    temperature: 0,
    maxTokens: 500,
  });

  const content = typeof result?.content === "string" ? result.content : "";
  return normalizeDecision(parseDecision(content));
}

function formatCandidates(candidates: PromptContextRouterCandidate[]) {
  if (!candidates.length) return "Keine Paper-Metadaten verfuegbar.";

  return candidates
    .map((candidate) =>
      [
        `- itemID=${candidate.itemID}`,
        `title="${candidate.title}"`,
        `author="${candidate.firstCreator}"`,
        candidate.year ? `year="${candidate.year}"` : "",
        `type="${candidate.itemType}"`,
        candidate.tags.length ? `tags="${candidate.tags.join(", ")}"` : "",
        `library="${candidate.libraryName}"`,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

function parseDecision(content: string) {
  const json = extractJson(content);
  if (!json) throw new Error("Router returned no JSON decision.");
  return JSON.parse(json) as PromptContextRouteDecision;
}

function extractJson(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return "";
}

function normalizeDecision(
  decision: PromptContextRouteDecision,
): PromptContextRouteDecision {
  const route = normalizeRoute(decision.route);
  return {
    ...decision,
    route,
    reason: typeof decision.reason === "string" ? decision.reason : "",
    itemIDs: Array.isArray(decision.itemIDs)
      ? decision.itemIDs.filter((id) => Number.isFinite(id))
      : undefined,
    requestedFields: normalizeRequestedFields(decision.requestedFields),
  };
}

function normalizeRoute(value: unknown): PromptContextRoute {
  if (
    value === "none" ||
    value === "metadata" ||
    value === "single_paper" ||
    value === "filtered_papers" ||
    value === "all_papers"
  ) {
    return value;
  }
  return "metadata";
}

function normalizeRequestedFields(
  fields: PromptContextRouteDecision["requestedFields"],
) {
  const allowed = new Set([
    "title",
    "firstCreator",
    "year",
    "itemType",
    "tags",
  ]);
  const normalized = Array.isArray(fields)
    ? fields.filter((field) => allowed.has(field))
    : [];
  return normalized.length ? normalized : DEFAULT_REQUESTED_FIELDS;
}
