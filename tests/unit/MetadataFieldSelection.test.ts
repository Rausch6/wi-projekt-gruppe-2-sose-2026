import { describe, expect, it } from "vitest";
import {
  DEFAULT_METADATA_FIELD_SELECTION,
  getMetadataFieldSelectionLabel,
  getMetadataFieldsForSelection,
  isMetadataFieldSelected,
  normalizeMetadataFieldSelection,
} from "../../src/core/MetadataFieldSelection";

describe("MetadataFieldSelection", () => {
  it("uses the default metadata fields for invalid values", () => {
    expect(getMetadataFieldsForSelection(undefined)).toEqual([
      "title",
      "creators",
      "publicationDate",
    ]);
    expect(normalizeMetadataFieldSelection(undefined)).toBe(
      DEFAULT_METADATA_FIELD_SELECTION,
    );
  });

  it("supports legacy dropdown presets", () => {
    expect(getMetadataFieldsForSelection("title_author")).toEqual([
      "title",
      "creators",
    ]);
    expect(getMetadataFieldsForSelection("title_tags")).toEqual([
      "title",
      "tags",
    ]);
  });

  it("normalizes comma separated selections and removes duplicates", () => {
    expect(
      normalizeMetadataFieldSelection("tags,title,tags,unknown,creators"),
    ).toBe("title,creators,tags");
  });

  it("falls back to title when a string contains no valid fields", () => {
    expect(getMetadataFieldsForSelection("unknown,invalid")).toEqual(["title"]);
  });

  it("checks selected fields and creates human-readable labels", () => {
    const selection = "title,tags";

    expect(isMetadataFieldSelected(selection, "title")).toBe(true);
    expect(isMetadataFieldSelected(selection, "creators")).toBe(false);
    expect(getMetadataFieldSelectionLabel(selection)).toBe("Titel, Tags");
  });
});
