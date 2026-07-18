import type { LLMProvider } from "../addon";
import type { MetadataFieldSelection } from "./MetadataFieldSelection";

/**
 * Beschreibt, welcher Kontext fuer die finale KI-Antwort benoetigt wird.
 */
export type PromptContextRoute =
  | "none"
  | "metadata"
  | "single_paper"
  | "filtered_papers"
  | "all_papers";

/**
 * Strukturierte Entscheidung der Router-KI inklusive optionaler Filter.
 */
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

/**
 * Fallback-Felder fuer alte Router-Entscheidungen mit requestedFields.
 */
const DEFAULT_REQUESTED_FIELDS: MetadataField[] = [
  "title",
  "firstCreator",
  "year",
  "itemType",
  "tags",
];

/**
 * Kompakte Paper-Metadaten, die der Router-KI als Kandidatenliste dienen.
 */
export type PromptContextRouterCandidate = {
  itemID: number;
  title: string;
  firstCreator: string;
  year: string;
  publicationDate: string;
  publicationTitle: string;
  publisher: string;
  doi: string;
  isbn: string;
  url: string;
  abstractNote: string;
  dateAdded: string;
  dateModified: string;
  itemType: string;
  tags: string[];
  libraryName: string;
};

/**
 * Eingaben und Chat-Adapter fuer eine Router-Entscheidung.
 */
export type PromptContextRouterOptions = {
  provider: LLMProvider;
  model: string;
  prompt: string;
  candidates: PromptContextRouterCandidate[];
  metadataFields?: MetadataFieldSelection[];
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

/**
 * Minimalformat fuer Nachrichten an das Router-Modell.
 */
type RouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Systemprompt, der die Router-KI auf reine Kontextentscheidung begrenzt.
 */
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
  "- Waehle single_paper nur, wenn der aktuelle Prompt eindeutig ein einzelnes konkretes Paper meint, z.B. 'dieses Paper', 'das ausgewaehlte Paper', einen konkreten Titel oder Autor/Jahr. Eine aktive Zotero-Auswahl allein ist kein Grund fuer single_paper.",
  "- Wenn der aktuelle Prompt eine Zusammenfassung eines eindeutig ausgewaehlten, genannten oder konkreten Papers verlangt, waehle single_paper und contentFocus='abstracts'.",
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

/**
 * Erzeugt per Router-KI und Heuristiken die finale Kontext-Route.
 *
 * @param options.provider Provider, der die Router-Entscheidung ausfuehrt.
 * @param options.model Modellname fuer die Router-KI.
 * @param options.prompt Aktueller Nutzerprompt ohne Chatverlauf.
 * @param options.candidates Verfuegbare Paper-Kandidaten aus Zotero.
 * @param options.metadataFields Metadatenfelder, die an den Router gehen.
 * @param options.chat Chat-Adapter fuer den konkreten KI-Provider.
 * @returns Normalisierte und heuristisch abgesicherte Router-Entscheidung.
 */
export async function decidePromptContextRoute({
  provider,
  model,
  prompt,
  candidates,
  metadataFields,
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
        formatCandidates(candidates, metadataFields),
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
  let decision: PromptContextRouteDecision;
  try {
    decision = normalizeDecision(parseDecision(content));
  } catch (error) {
    decision = buildHeuristicDecision(prompt, error);
  }

  return applyPromptHeuristics(decision, prompt);
}

/**
 * Formatiert verfuegbare Paper-Kandidaten fuer den Router-Prompt.
 *
 * @param candidates Paper-Kandidaten, die der Router sehen darf.
 * @param fields Metadatenfelder, die pro Kandidat ausgegeben werden.
 * @returns Kompakter Textblock fuer den Router-Prompt.
 */
function formatCandidates(
  candidates: PromptContextRouterCandidate[],
  fields: MetadataFieldSelection[] = ["title", "creators", "publicationDate"],
) {
  if (!candidates.length) return "Keine Paper-Metadaten verfuegbar.";

  return candidates
    .map((candidate) =>
      [
        `- itemID=${candidate.itemID}`,
        `title="${candidate.title}"`,
        fields.includes("creators") ? `author="${candidate.firstCreator}"` : "",
        fields.includes("publicationDate") && candidate.publicationDate
          ? `publicationDate="${candidate.publicationDate}"`
          : "",
        fields.includes("tags") && candidate.tags.length
          ? `tags="${candidate.tags.join(", ")}"`
          : "",
        `library="${candidate.libraryName}"`,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

/**
 * Extrahiert und parsed die JSON-Entscheidung aus der Router-Antwort.
 *
 * @param content Rohe Textantwort der Router-KI.
 * @returns Geparste Router-Entscheidung.
 * @throws Error, wenn kein JSON gefunden wird oder JSON.parse fehlschlaegt.
 */
function parseDecision(content: string) {
  const json = extractJson(content);
  if (!json) throw new Error("Router returned no JSON decision.");
  return JSON.parse(json) as PromptContextRouteDecision;
}

/**
 * Findet JSON in rohem Text oder Markdown-Codebloecken.
 *
 * @param content Rohe Textantwort der Router-KI.
 * @returns JSON-String oder leerer String, wenn nichts gefunden wurde.
 */
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

/**
 * Normalisiert unsichere Router-Ausgaben auf erlaubte Werte.
 *
 * @param decision Ungepruefte Entscheidung der Router-KI.
 * @returns Entscheidung mit erlaubter Route, Fokus und requestedFields.
 */
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

/**
 * Beschraenkt unbekannte Routen auf einen sicheren Metadata-Fallback.
 *
 * @param value Beliebiger Route-Wert aus der Router-Antwort.
 * @returns Erlaubte Route oder metadata als Fallback.
 */
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

/**
 * Normalisiert den Fokus der spaeteren Vektorsuche.
 *
 * @param value Fokuswert aus der Router-Antwort.
 * @returns abstracts oder relevant_chunks.
 */
function normalizeContentFocus(
  value: PromptContextRouteDecision["contentFocus"],
) {
  return value === "abstracts" ? "abstracts" : "relevant_chunks";
}

/**
 * Ueberschreibt schwache Router-Entscheidungen mit deterministischen Regeln.
 *
 * @param decision Normalisierte Router-Entscheidung.
 * @param prompt Aktueller Nutzerprompt.
 * @returns Endgueltige Entscheidung nach Heuristikpruefung.
 */
function applyPromptHeuristics(
  decision: PromptContextRouteDecision,
  prompt: string,
): PromptContextRouteDecision {
  const normalizedPrompt = normalizePromptText(prompt);
  const hasSinglePaperIntent = isSpecificSinglePaperPrompt(normalizedPrompt);

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
      itemID: undefined,
      itemIDs: undefined,
    };
  }

  if (isSummaryPrompt(normalizedPrompt)) {
    const route =
      (decision.route === "single_paper" && hasSinglePaperIntent) ||
      decision.route === "filtered_papers"
        ? decision.route
        : "all_papers";

    return {
      ...decision,
      route,
      reason: appendReason(
        decision.reason,
        "Heuristik: Zusammenfassung soll Abstract-orientierten Kontext nutzen.",
      ),
      contentFocus: "abstracts",
      itemID: route === "single_paper" ? decision.itemID : undefined,
      itemIDs: route === "single_paper" ? decision.itemIDs : undefined,
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
      itemID: undefined,
      itemIDs: undefined,
    };
  }

  if (decision.route === "single_paper" && !hasSinglePaperIntent) {
    return {
      ...decision,
      route: mentionsPaperContext(normalizedPrompt) ? "all_papers" : "none",
      reason: appendReason(
        decision.reason,
        "Heuristik: single_paper verworfen, weil der aktuelle Prompt kein einzelnes konkretes Paper referenziert.",
      ),
      itemID: undefined,
      itemIDs: undefined,
    };
  }

  return decision;
}

/**
 * Baut eine Entscheidung, wenn das Router-Modell kein valides JSON liefert.
 *
 * @param prompt Aktueller Nutzerprompt.
 * @param error Fehler beim Parsen oder Auswerten der Router-Antwort.
 * @returns Heuristische Ersatzentscheidung.
 */
function buildHeuristicDecision(
  prompt: string,
  error: unknown,
): PromptContextRouteDecision {
  const normalizedPrompt = normalizePromptText(prompt);

  if (isMetadataOnlyPrompt(normalizedPrompt)) {
    return normalizeDecision({
      route: "metadata",
      reason: `Router lieferte kein valides JSON; Heuristik nutzt Metadaten. ${String(error)}`,
      confidence: 0.7,
      requestedFields: inferMetadataFields(normalizedPrompt),
    });
  }

  if (
    isSummaryPrompt(normalizedPrompt) ||
    isLibrarySearchPrompt(normalizedPrompt)
  ) {
    return normalizeDecision({
      route: "all_papers",
      reason: `Router lieferte kein valides JSON; Heuristik nutzt Abstract-orientierte Bibliothekssuche. ${String(error)}`,
      confidence: 0.7,
      contentFocus: "abstracts",
    });
  }

  return normalizeDecision({
    route: mentionsPaperContext(normalizedPrompt) ? "all_papers" : "none",
    reason: `Router lieferte kein valides JSON; Heuristik-Fallback. ${String(error)}`,
    confidence: 0.4,
    contentFocus: mentionsPaperContext(normalizedPrompt)
      ? "abstracts"
      : "relevant_chunks",
  });
}

/**
 * Vereinheitlicht Prompt-Text fuer Regex-basierte Heuristiken.
 *
 * @param prompt Urspruenglicher Nutzerprompt.
 * @returns Normalisierter, klein geschriebener Prompt.
 */
function normalizePromptText(prompt: string) {
  return prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Erkennt Fragen, die allein mit Metadaten beantwortet werden koennen.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns true, wenn keine PDF-/Chunk-Inhalte noetig sind.
 */
function isMetadataOnlyPrompt(prompt: string) {
  if (isSummaryPrompt(prompt) || isLibrarySearchPrompt(prompt)) return false;
  return /\b(wie viele|anzahl|count|titel|title|autor|author|jahr|year|tag|tags|alteste|aelteste|oldest|neueste|newest|liste|list)\b/.test(
    prompt,
  );
}

/**
 * Erkennt Zusammenfassungs- und Ueberblicksanfragen.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns true, wenn Abstract-/Zusammenfassungskontext sinnvoll ist.
 */
function isSummaryPrompt(prompt: string) {
  return /\b(zusammenfassung|zusammenfassen|fasse zusammen|fass zusammen|summary|summarize|abstract|ueberblick|uberblick)\b/.test(
    prompt,
  );
}

/**
 * Erkennt bibliotheksweite Suchen nach vorhandenen passenden Papern.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns true, wenn die Bibliothek nach passenden Papern durchsucht werden soll.
 */
function isLibrarySearchPrompt(prompt: string) {
  const asksForExistingPapers =
    /\b(suche|finde|welche paper|welche artikel|paper.*zu|artikel.*zu|welches paper|welcher artikel|am ehesten passen|passen wurde|passen wuerde|passend|geeignet|papers.*about|find papers|search papers)\b/.test(
      prompt,
    );
  const mentionsLibrary =
    /\b(bibliothek|library|meine paper|meinen papern|vorhanden|bestehend|zotero)\b/.test(
      prompt,
    );
  const asksForPaperRecommendation =
    /\b(welches paper|welcher artikel|welche paper|welche artikel|paper.*passen|artikel.*passen|am ehesten passen|passend|geeignet)\b/.test(
      prompt,
    );
  return (
    asksForExistingPapers && (mentionsLibrary || asksForPaperRecommendation)
  );
}

/**
 * Erkennt, ob der Prompt eindeutig ein einzelnes konkretes Paper meint.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns true, wenn single_paper fachlich gerechtfertigt ist.
 */
function isSpecificSinglePaperPrompt(prompt: string) {
  return (
    /\b(dieses|diese|diesem|diesen)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      prompt,
    ) ||
    /\b(ausgewaehlte[ns]?|ausgewahlte[ns]?|markierte[ns]?|aktuelle[ns]?)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      prompt,
    ) ||
    /\b(in|aus|zu)\s+(diesem|dieser|dieses|dem|der)\s+(paper|artikel|dokument|quelle|publikation)\b/.test(
      prompt,
    ) ||
    /\b(paper|artikel|publikation)\s+(von|mit dem titel|namens)\b/.test(
      prompt,
    ) ||
    /["'„“][^"'„“]{8,}["'„“]/.test(prompt) ||
    /\b[a-z][a-z-]+ \d{4}\b/.test(prompt)
  );
}

/**
 * Erkennt allgemeinen Bezug auf Paper, Zotero oder die Bibliothek.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns true, wenn irgendein Bibliothekskontext erwaehnt wird.
 */
function mentionsPaperContext(prompt: string) {
  return /\b(paper|artikel|dokument|quelle|bibliothek|library|zotero|publication|publikation)\b/.test(
    prompt,
  );
}

/**
 * Leitet Legacy-requestedFields aus einfachen Metadatenfragen ab.
 *
 * @param prompt Normalisierter Nutzerprompt.
 * @returns Abgeleitete Legacy-Metadatenfelder.
 */
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

/**
 * Ergaenzt eine Begruendung, ohne vorhandene Router-Gruende zu ersetzen.
 *
 * @param reason Bestehende Begruendung.
 * @param addition Zusaetzliche Heuristik-Begruendung.
 * @returns Kombinierte Begruendung.
 */
function appendReason(reason: string, addition: string) {
  return reason ? `${reason} ${addition}` : addition;
}

/**
 * Filtert requestedFields auf bekannte Legacy-Metadatenfelder.
 *
 * @param fields Ungepruefte requestedFields aus der Router-Antwort.
 * @returns Gueltige Legacy-Felder oder Default-Felder.
 */
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
