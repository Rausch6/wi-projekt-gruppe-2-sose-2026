/**
 * Enumerates the metadata fields that can be included in prompt context.
 */
export type MetadataFieldSelection =
  | "title"
  | "creators"
  | "publicationDate"
  | "tags";

/**
 * Stores a serialized metadata field selection.
 */
export type MetadataFieldSelectionValue = string;

/**
 * Provides the selectable metadata fields with their persisted values and UI labels.
 */
export const METADATA_FIELD_SELECTION_OPTIONS: Array<{
  /**
   * Persisted field identifier.
   */
  value: MetadataFieldSelection;

  /**
   * Human-readable label shown in the UI.
   */
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

/**
 * Serialized default metadata field selection used when no valid user selection exists.
 */
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

/**
 * Converts any stored or incoming value to the canonical serialized metadata selection.
 *
 * @param value - Stored metadata selection value or legacy preset.
 * @returns Canonical comma-separated metadata field selection.
 */
export function normalizeMetadataFieldSelection(
  value: unknown,
): MetadataFieldSelectionValue {
  return serializeMetadataFields(getMetadataFieldsForSelection(value));
}

/**
 * Resolves a stored metadata selection into a validated list of metadata fields.
 *
 * @param value - Stored metadata selection value or legacy preset.
 * @returns Ordered list of selected metadata fields.
 */
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

/**
 * Checks whether a metadata field is enabled in the given selection.
 *
 * @param selection - Stored metadata selection value or legacy preset.
 * @param field - Metadata field to check.
 * @returns True when the field is part of the resolved selection.
 */
export function isMetadataFieldSelected(
  selection: unknown,
  field: MetadataFieldSelection,
) {
  return getMetadataFieldsForSelection(selection).includes(field);
}

/**
 * Builds the display label for a metadata field selection.
 *
 * @param selection - Stored metadata selection value or legacy preset.
 * @returns Human-readable label for the selected metadata fields.
 */
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

/**
 * Serializes metadata fields into the canonical storage format.
 *
 * @param fields - Metadata fields to serialize.
 * @returns Comma-separated metadata field selection without duplicates.
 */
function serializeMetadataFields(fields: MetadataFieldSelection[]) {
  return dedupeMetadataFields(fields).join(",");
}

/**
 * Removes duplicates and invalid ordering from metadata fields by applying the configured option order.
 *
 * @param fields - Metadata fields to normalize.
 * @returns Deduplicated metadata fields in display order.
 */
function dedupeMetadataFields(fields: MetadataFieldSelection[]) {
  const allowedFields = METADATA_FIELD_SELECTION_OPTIONS.map(
    (option) => option.value,
  );
  return allowedFields.filter((field) => fields.includes(field));
}

/**
 * Determines whether a string is a supported metadata field identifier.
 *
 * @param value - Field identifier to validate.
 * @returns True when the value is a supported metadata field selection.
 */
function isMetadataFieldSelection(
  value: string,
): value is MetadataFieldSelection {
  return METADATA_FIELD_SELECTION_OPTIONS.some(
    (option) => option.value === value,
  );
}
