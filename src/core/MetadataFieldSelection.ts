export type MetadataFieldSelection =
  | "title"
  | "creators"
  | "publicationDate"
  | "tags";

export type MetadataFieldSelectionValue = string;

export const METADATA_FIELD_SELECTION_OPTIONS: Array<{
  value: MetadataFieldSelection;
  label: string;
}> = [
  { value: "title", label: "Titel" },
  { value: "creators", label: "Autor" },
  { value: "publicationDate", label: "Veröffentlichungsdatum" },
  { value: "tags", label: "Tags" },
];

const DEFAULT_METADATA_FIELDS: MetadataFieldSelection[] = [
  "title",
  "creators",
  "publicationDate",
];

export const DEFAULT_METADATA_FIELD_SELECTION = serializeMetadataFields(
  DEFAULT_METADATA_FIELDS,
);

const LEGACY_METADATA_FIELD_SELECTION_PRESETS: Record<
  string,
  MetadataFieldSelection[]
> = {
  title: ["title"],
  title_author: ["title", "creators"],
  title_date: ["title", "publicationDate"],
  title_author_date: ["title", "creators", "publicationDate"],
  title_tags: ["title", "tags"],
};

export function normalizeMetadataFieldSelection(
  value: unknown,
): MetadataFieldSelectionValue {
  return serializeMetadataFields(getMetadataFieldsForSelection(value));
}

export function getMetadataFieldsForSelection(
  value: unknown,
): MetadataFieldSelection[] {
  if (typeof value !== "string") return [...DEFAULT_METADATA_FIELDS];

  const trimmedValue = value.trim();
  const legacyFields = LEGACY_METADATA_FIELD_SELECTION_PRESETS[trimmedValue];
  if (legacyFields) return [...legacyFields];

  const selectedFields = trimmedValue
    .split(",")
    .map((field) => field.trim())
    .filter(isMetadataFieldSelection);

  return selectedFields.length
    ? dedupeMetadataFields(selectedFields)
    : ["title"];
}

export function isMetadataFieldSelected(
  selection: unknown,
  field: MetadataFieldSelection,
) {
  return getMetadataFieldsForSelection(selection).includes(field);
}

export function getMetadataFieldSelectionLabel(selection: unknown) {
  const fields = getMetadataFieldsForSelection(selection);
  if (fields.length === METADATA_FIELD_SELECTION_OPTIONS.length) {
    return "Alle Metadaten";
  }

  return METADATA_FIELD_SELECTION_OPTIONS.filter((option) =>
    fields.includes(option.value),
  )
    .map((option) => option.label)
    .join(", ");
}

function serializeMetadataFields(fields: MetadataFieldSelection[]) {
  return dedupeMetadataFields(fields).join(",");
}

function dedupeMetadataFields(fields: MetadataFieldSelection[]) {
  const allowedFields = METADATA_FIELD_SELECTION_OPTIONS.map(
    (option) => option.value,
  );
  return allowedFields.filter((field) => fields.includes(field));
}

function isMetadataFieldSelection(
  value: string,
): value is MetadataFieldSelection {
  return METADATA_FIELD_SELECTION_OPTIONS.some(
    (option) => option.value === value,
  );
}
