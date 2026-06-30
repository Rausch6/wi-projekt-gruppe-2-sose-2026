export type MetadataFieldSelectionPreset =
  | "title"
  | "title_author"
  | "title_date"
  | "title_author_date"
  | "title_tags";

export type MetadataFieldSelection =
  | "title"
  | "creators"
  | "publicationDate"
  | "tags";

export const DEFAULT_METADATA_FIELD_SELECTION: MetadataFieldSelectionPreset =
  "title_author_date";

export const METADATA_FIELD_SELECTION_OPTIONS: Array<{
  value: MetadataFieldSelectionPreset;
  label: string;
}> = [
  { value: "title", label: "Nur Titel" },
  { value: "title_author", label: "Titel + Autor" },
  { value: "title_date", label: "Titel + Veröffentlichungsdatum" },
  {
    value: "title_author_date",
    label: "Titel + Autor + Veröffentlichungsdatum",
  },
  { value: "title_tags", label: "Titel + Tags" },
];

export function normalizeMetadataFieldSelectionPreset(
  value: unknown,
): MetadataFieldSelectionPreset {
  return METADATA_FIELD_SELECTION_OPTIONS.some(
    (option) => option.value === value,
  )
    ? (value as MetadataFieldSelectionPreset)
    : DEFAULT_METADATA_FIELD_SELECTION;
}

export function getMetadataFieldsForPreset(
  preset: unknown,
): MetadataFieldSelection[] {
  switch (normalizeMetadataFieldSelectionPreset(preset)) {
    case "title":
      return ["title"];
    case "title_author":
      return ["title", "creators"];
    case "title_date":
      return ["title", "publicationDate"];
    case "title_tags":
      return ["title", "tags"];
    case "title_author_date":
    default:
      return ["title", "creators", "publicationDate"];
  }
}
