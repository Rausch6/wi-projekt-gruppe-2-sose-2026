export type PaperContextIndexReference = {
  itemID?: number;
};

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

export function getUnindexedPaperContextWarning(count: number): string {
  return count === 1
    ? "Das Paper im Kontext ist noch nicht indexiert."
    : `${count} Paper im Kontext sind noch nicht indexiert.`;
}
