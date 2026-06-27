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
  contentFocus?: "relevant_chunks" | "abstracts";
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
  "- metadata: Der Nutzer fragt nach Anzahl, Titeln, Autoren, Jahren, Tags, aeltestem/neuestem Paper, Paperlisten oder Auswahl/Vergleich anhand von Metadaten; nur Metadaten aller Paper mitschicken.",
  "- single_paper: Ein einzelnes konkretes Paper wird benoetigt; gib itemID oder itemIDs mit genau einem Eintrag an.",
  "- filtered_papers: Alle Paper mit bestimmtem Tag oder bestimmter Metadaten-Eigenschaft werden benoetigt; gib tag oder property/value an.",
  "- all_papers: Der Nutzer verlangt explizit alle Paper bzw. eine Gesamtanalyse der ganzen Bibliothek.",
  "",
  "contentFocus:",
  '- "relevant_chunks": normale inhaltliche Frage; suche passende Textstellen.',
  '- "abstracts": der Nutzer will Zusammenfassungen, Abstracts, Ueberblicke oder sucht nach bestehenden Papern zu einem Thema; die Vektorsuche soll bevorzugt Abstract-/Einleitungsstellen liefern.',
  "",
  "Pflichtregeln:",
  "- Wenn der aktuelle Prompt nach Anzahl der Paper, aeltestem/neuestem Paper, Titeln, Autoren, Jahren, Tags oder einer reinen Paperliste fragt, waehle metadata.",
  "- Wenn der aktuelle Prompt 'alle Paper', 'alle Dokumente', 'meine Paper', 'die Bibliothek' oder eine Zusammenfassung/Analyse ueber mehrere Paper verlangt, waehle all_papers und contentFocus='abstracts'.",
  "- Wenn der aktuelle Prompt eine Zusammenfassung eines ausgewaehlten, genannten oder konkreten Papers verlangt, waehle single_paper und contentFocus='abstracts'.",
  "- Wenn der aktuelle Prompt nach bereits vorhandenen Papern in der Bibliothek zu einem Thema/Inhalt sucht, waehle all_papers und contentFocus='abstracts'.",
  "- Wenn der aktuelle Prompt 'Zusammenfassung aller Paper' oder 'fasse alle Paper zusammen' enthaelt, waehle immer all_papers.",
  "- Waehle none niemals, wenn der aktuelle Prompt Paper, Zotero, Bibliothek, Dokumente, Quellen oder Metadaten erwaehnt.",
  "",
  "Beispiele:",
  'Prompt: "Gib mir die Titel der Paper" -> {"route":"metadata","reason":"Titel sind Metadaten","requestedFields":["title"]}',
  'Prompt: "Wie viele Paper habe ich?" -> {"route":"metadata","reason":"Anzahl kann aus Metadaten bestimmt werden","requestedFields":["title"]}',
  'Prompt: "Welches ist das aelteste Paper?" -> {"route":"metadata","reason":"Alter kann aus Jahres-Metadaten bestimmt werden","requestedFields":["title","firstCreator","year"]}',
  'Prompt: "Gib mir eine Zusammenfassung aller Paper" -> {"route":"all_papers","reason":"Zusammenfassung aller Paper braucht Abstracts aus allen Papern","contentFocus":"abstracts"}',
  'Prompt: "Fasse das Paper von Smith 2020 zusammen" -> {"route":"single_paper","reason":"Ein konkretes Paper wird angefragt","contentFocus":"abstracts"}',
  'Prompt: "Welche Paper habe ich zu RAG?" -> {"route":"all_papers","reason":"Bibliothekssuche nach vorhandenen Papern zu einem Thema","contentFocus":"abstracts"}',
  "",
  "Schema:",
  '{"route":"none|metadata|single_paper|filtered_papers|all_papers","reason":"kurz","confidence":0.0,"contentFocus":"relevant_chunks|abstracts","itemID":123,"itemIDs":[123],"tag":"...","property":"title|firstCreator|year|itemType|tag","value":"...","requestedFields":["title","firstCreator","year","itemType","tags"]}',
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
  return applyPromptHeuristics(
    normalizeDecision(parseDecision(content)),
    prompt,
  );
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
    contentFocus: normalizeContentFocus(decision.contentFocus),
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

function normalizeContentFocus(
  value: PromptContextRouteDecision["contentFocus"],
) {
  return value === "abstracts" ? "abstracts" : "relevant_chunks";
}

function applyPromptHeuristics(
  decision: PromptContextRouteDecision,
  prompt: string,
): PromptContextRouteDecision {
  const normalizedPrompt = normalizePromptText(prompt);

  if (isMetadataOnlyPrompt(normalizedPrompt)) {
    return {
      ...decision,
      route: "metadata",
      reason: appendReason(
        decision.reason,
        "Heuristik: Anfrage ist mit Metadaten loesbar.",
      ),
      contentFocus: "relevant_chunks",
      requestedFields: inferMetadataFields(normalizedPrompt),
    };
  }

  if (isSummaryPrompt(normalizedPrompt)) {
    return {
      ...decision,
      route:
        decision.route === "single_paper" ||
        decision.route === "filtered_papers"
          ? decision.route
          : "all_papers",
      reason: appendReason(
        decision.reason,
        "Heuristik: Zusammenfassung soll Abstract-orientierten Kontext nutzen.",
      ),
      contentFocus: "abstracts",
    };
  }

  if (isLibrarySearchPrompt(normalizedPrompt)) {
    return {
      ...decision,
      route:
        decision.route === "filtered_papers" ? "filtered_papers" : "all_papers",
      reason: appendReason(
        decision.reason,
        "Heuristik: Bibliothekssuche soll Abstract-orientierten Kontext nutzen.",
      ),
      contentFocus: "abstracts",
    };
  }

  return decision;
}

function normalizePromptText(prompt: string) {
  return prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetadataOnlyPrompt(prompt: string) {
  if (isSummaryPrompt(prompt) || isLibrarySearchPrompt(prompt)) return false;
  return /\b(wie viele|anzahl|count|titel|title|autor|author|jahr|year|tag|tags|alteste|aelteste|oldest|neueste|newest|liste|list)\b/.test(
    prompt,
  );
}

function isSummaryPrompt(prompt: string) {
  return /\b(zusammenfassung|zusammenfassen|fasse zusammen|fass zusammen|summary|summarize|abstract|ueberblick|uberblick)\b/.test(
    prompt,
  );
}

function isLibrarySearchPrompt(prompt: string) {
  const asksForExistingPapers =
    /\b(suche|finde|welche paper|welche artikel|paper.*zu|artikel.*zu|papers.*about|find papers|search papers)\b/.test(
      prompt,
    );
  const mentionsLibrary =
    /\b(bibliothek|library|meine paper|meinen papern|vorhanden|bestehend|zotero)\b/.test(
      prompt,
    );
  return asksForExistingPapers && mentionsLibrary;
}

function inferMetadataFields(prompt: string): MetadataField[] {
  const fields = new Set<MetadataField>();
  if (/\b(titel|title|liste|list|anzahl|count|wie viele)\b/.test(prompt)) {
    fields.add("title");
  }
  if (/\b(autor|author)\b/.test(prompt)) fields.add("firstCreator");
  if (/\b(jahr|year|alteste|aelteste|oldest|neueste|newest)\b/.test(prompt)) {
    fields.add("year");
    fields.add("title");
    fields.add("firstCreator");
  }
  if (/\b(tag|tags)\b/.test(prompt)) fields.add("tags");
  return fields.size ? [...fields] : DEFAULT_REQUESTED_FIELDS;
}

function appendReason(reason: string, addition: string) {
  return reason ? `${reason} ${addition}` : addition;
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
