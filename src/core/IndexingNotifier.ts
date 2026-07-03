/**
 * IndexingNotifier: Lauscht auf den IndexingEventBus und zeigt
 * Zotero-native ProgressWindow-Popups für Start und Ende der Indizierung.
 *
 * Regeln:
 * - Gesamt-Indexierung (full): Popup bei Start + bei Abschluss.
 * - Einzel-Indexierung (single): Popup bei Abschluss (singleDone).
 * - Fehler: kurzes Fehler-Popup.
 */

import { indexingEvents } from "./IndexingEventBus";

const ADDON_NAME = "ZAIA";

export function initIndexingNotifier() {
  // --- Gesamt-Indexierung: Start-Popup ---
  indexingEvents.on("started", ({ mode }) => {
    if (mode !== "full") return;
    try {
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 5000,
      })
        .createLine({
          text: "📚 Bibliotheks-Indexierung gestartet…",
          type: "default",
          progress: 0,
        })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing start popup: ${e}`); }
  });

  // --- Gesamt-Indexierung: Abschluss-Popup ---
  indexingEvents.on("finished", ({ mode, indexed, newlyIndexed, total }) => {
    if (mode !== "full") return;
    try {
      const totalCount = indexed ?? 0;
      const newCount = newlyIndexed ?? 0;
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 6000,
      })
        .createLine({
          text: `✅ Bibliotheks-Indexierung abgeschlossen (${totalCount} von ${total ?? "?"} Papern im Index, ${newCount} neu hinzugefügt).`,
          type: "success",
          progress: 100,
        })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing finished popup: ${e}`); }
  });

  // --- Einzel-Indexierung: Start-Popup ---
  indexingEvents.on("singleStarted", ({ paperTitle }) => {
    try {
      const label = paperTitle
        ? `📚 Indexierung für "${paperTitle}" gestartet…`
        : "📚 Indexierung gestartet…";
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 4000,
      })
        .createLine({ text: label, type: "default", progress: 0 })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing singleStarted popup: ${e}`); }
  });

  // --- Einzel-Indexierung: Abschluss-Popup ---
  indexingEvents.on("singleDone", ({ paperTitle }) => {
    try {
      const label = paperTitle
        ? `📄 "${paperTitle}" wurde erfolgreich indexiert.`
        : "📄 Paper wurde erfolgreich indexiert.";
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 4000,
      })
        .createLine({ text: label, type: "success", progress: 100 })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing singleDone popup: ${e}`); }
  });

  // --- Einzel-Entfernung: Abschluss-Popup ---
  indexingEvents.on("deleted", ({ paperTitle }) => {
    try {
      const label = paperTitle
        ? `🗑️ "${paperTitle}" wurde aus dem Index entfernt.`
        : "🗑️ Paper wurde aus dem Index entfernt.";
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 4000,
      })
        .createLine({ text: label, type: "success", progress: 100 })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing deleted popup: ${e}`); }
  });

  // --- Fehler-Popup ---
  indexingEvents.on("error", ({ paperTitle }) => {
    try {
      const label = paperTitle
        ? `⚠️ Fehler beim Indexieren: "${paperTitle}"`
        : "⚠️ Fehler bei der Indexierung.";
      new addon.data.ztoolkit.ProgressWindow(ADDON_NAME, {
        closeOnClick: true,
        closeTime: 6000,
      })
        .createLine({ text: label, type: "fail" })
        .show();
    } catch (e) { Zotero.debug(`[Notifier] Error showing error popup: ${e}`); }
  });
}
