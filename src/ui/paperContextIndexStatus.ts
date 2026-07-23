/**
 * Minimal paper-context reference needed to compare against the vector index.
 */
export type PaperContextIndexReference = {
  itemID?: number;
};

/**
 * Counts distinct context papers that have not been added to the vector index.
 *
 * @param references - Paper references currently attached to the chat context.
 * @param indexedItemIDs - Zotero item IDs currently present in the index.
 * @returns Number of distinct, valid context items missing from the index.
 */
export function getUnindexedPaperContextCount(
  references: PaperContextIndexReference[],
  indexedItemIDs: ReadonlySet<string>,
): number {
  const contextItemIDs = new Set(
    references
      .map((reference) => reference.itemID)
      .filter((itemID): itemID is number => Number.isFinite(itemID)),
  );

  let count = 0;
  for (const itemID of contextItemIDs) {
    if (!indexedItemIDs.has(String(itemID))) count += 1;
  }
  return count;
}

/**
 * Formats the missing-index warning with the correct singular or plural form.
 *
 * @param count - Number of context papers missing from the index.
 * @returns German warning text for the sidebar.
 */
export function getUnindexedPaperContextWarning(count: number): string {
  return count === 1
    ? "Das Paper im Kontext ist noch nicht indexiert."
    : `${count} Paper im Kontext sind noch nicht indexiert.`;
}
