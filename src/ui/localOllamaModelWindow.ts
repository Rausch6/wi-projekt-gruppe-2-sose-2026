import { config } from "../../package.json";
import { LOCAL_OLLAMA_MODEL_CATALOG } from "./localOllamaModels";

export const LOCAL_OLLAMA_MODEL_INSTALLED_EVENT =
  "zai-local-ollama-model-installed";

const LOCAL_MODEL_WINDOW_ROOT_ID = `${config.addonRef}-local-ollama-model-window-root`;
const LOCAL_MODEL_WINDOW_WIDTH = 420;
const LOCAL_MODEL_WINDOW_HEIGHT = 380;
const HTML_NS = "http://www.w3.org/1999/xhtml";

type LocalModelWindowState = {
  window: Window;
};

type LocalModelWindowContext = {
  owner: _ZoteroTypes.MainWindow;
  window: Window;
};

const localModelWindows = new WeakMap<Window, LocalModelWindowState>();

export function openLocalOllamaModelWindow(owner: _ZoteroTypes.MainWindow) {
  const existing = getLiveLocalModelWindow(owner);
  if (existing) {
    existing.window.focus();
    return existing.window;
  }

  const features = [
    "chrome",
    "centerscreen",
    "dialog=no",
    "resizable=yes",
    `width=${LOCAL_MODEL_WINDOW_WIDTH}`,
    `height=${LOCAL_MODEL_WINDOW_HEIGHT}`,
    `minwidth=${LOCAL_MODEL_WINDOW_WIDTH}`,
    `minheight=${LOCAL_MODEL_WINDOW_HEIGHT}`,
  ].join(",");

  const openedWindow = owner.openDialog(
    `chrome://${config.addonRef}/content/localOllamaModelWindow.xhtml`,
    `${config.addonRef}-local-ollama-model-${Date.now()}`,
    features,
    {
      addonInstance: config.addonInstance,
      owner,
    },
  ) as Window | null;

  if (!openedWindow) return null;

  localModelWindows.set(owner, { window: openedWindow });
  return openedWindow;
}

export function initializeLocalOllamaModelWindow(
  modelWindow: Window,
  owner: _ZoteroTypes.MainWindow,
) {
  localModelWindows.set(owner, { window: modelWindow });

  const doc = modelWindow.document;
  const root = doc.getElementById(
    LOCAL_MODEL_WINDOW_ROOT_ID,
  ) as HTMLElement | null;
  if (!root) return;

  root.replaceChildren(createWindowContent({ owner, window: modelWindow }));
}

export function handleLocalOllamaModelWindowUnload(
  modelWindow: Window,
  owner: Window,
) {
  const state = localModelWindows.get(owner);
  if (state?.window === modelWindow) {
    localModelWindows.delete(owner);
  }
}

function getLiveLocalModelWindow(owner: Window) {
  const state = localModelWindows.get(owner);
  if (!state || state.window.closed) {
    if (state) localModelWindows.delete(owner);
    return null;
  }

  return state;
}

function createWindowContent(context: LocalModelWindowContext) {
  const doc = context.window.document;
  const fragment = doc.createDocumentFragment();
  const header = createHtmlElement(
    doc,
    "header",
    "zai-local-model-window-header",
  );
  const title = createHtmlElement(doc, "h1", "zai-local-model-window-title");
  const description = createHtmlElement(
    doc,
    "p",
    "zai-local-model-window-description",
  );
  const content = createHtmlElement(
    doc,
    "section",
    "zai-local-model-window-content",
  );
  const footer = createHtmlElement(
    doc,
    "footer",
    "zai-local-model-window-footer",
  );
  const libraryLink = createHtmlElement(
    doc,
    "a",
    "zai-local-model-library-link",
    "Weitere Modelle in der Ollama Library ansehen",
  ) as HTMLAnchorElement;

  title.textContent = "Lokales Modell hinzufügen";
  description.textContent =
    "Wähle ein zusätzliches Ollama-Modell aus. Der Download kann je nach Modellgröße mehrere Minuten dauern.";
  content.append(
    ...LOCAL_OLLAMA_MODEL_CATALOG.map((model) =>
      createModelRow(context, model),
    ),
  );
  libraryLink.href = "https://ollama.com/library";
  libraryLink.addEventListener("click", (event) => {
    event.preventDefault();
    Zotero.launchURL(libraryLink.href);
  });
  footer.append(libraryLink);

  header.append(title, description);
  fragment.append(header, content, footer);
  return fragment;
}

function createModelRow(
  context: LocalModelWindowContext,
  model: (typeof LOCAL_OLLAMA_MODEL_CATALOG)[number],
) {
  const doc = context.window.document;
  const row = createHtmlElement(doc, "article", "zai-local-model-row");
  const meta = createHtmlElement(doc, "div", "zai-local-model-meta");
  const name = createHtmlElement(doc, "strong", "zai-local-model-name");
  const size = createHtmlElement(doc, "span", "zai-local-model-size");
  const actions = createHtmlElement(doc, "div", "zai-local-model-actions");
  const button = createHtmlElement(
    doc,
    "div",
    "zai-local-model-download-button",
    "Download",
  );
  const status = createHtmlElement(doc, "p", "zai-local-model-status");

  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute(
    "aria-label",
    `${model.id} herunterladen, ${model.size}`,
  );
  button.title = `${model.id} herunterladen (${model.size})`;
  name.textContent = model.id;
  size.textContent = model.size;
  status.hidden = true;
  applyModelRowStyles(row, meta, name, size, actions, button, status);
  applyDownloadButtonStyle(button, "idle");

  const startDownload = () => {
    void downloadModel(context, model.id, button, status);
  };
  button.addEventListener("click", startDownload);
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    startDownload();
  });

  meta.append(name, size);
  actions.append(button, status);
  row.append(meta, actions);
  return row;
}

async function downloadModel(
  context: LocalModelWindowContext,
  model: string,
  button: HTMLElement,
  status: HTMLElement,
) {
  if (button.dataset.disabled === "true") return;

  button.dataset.disabled = "true";
  button.setAttribute("aria-disabled", "true");
  button.textContent = "Lädt...";
  button.classList.remove("zai-local-model-download-button-installed");
  applyDownloadButtonStyle(button, "loading");
  setStatus(status, `${model} wird installiert...`);

  try {
    const provider = addon.api.ai.getProvider("ollama");
    if (typeof provider.pullModel !== "function") {
      throw new Error("Ollama unterstützt keine Modelldownloads.");
    }

    await provider.pullModel(model);
    notifyModelInstalled(context, model);
    setStatus(status, `${model} ist installiert und ausgewählt.`);
    button.textContent = "Installiert";
    button.classList.add("zai-local-model-download-button-installed");
    applyDownloadButtonStyle(button, "installed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(status, `Download fehlgeschlagen: ${message}`);
    button.dataset.disabled = "false";
    button.setAttribute("aria-disabled", "false");
    button.textContent = "Erneut versuchen";
    applyDownloadButtonStyle(button, "idle");
  }
}

function applyModelRowStyles(
  row: HTMLElement,
  meta: HTMLElement,
  name: HTMLElement,
  size: HTMLElement,
  actions: HTMLElement,
  button: HTMLElement,
  status: HTMLElement,
) {
  Object.assign(row.style, {
    alignItems: "center",
    background: "#f7f9fc",
    border: "1px solid #d8dee8",
    borderRadius: "10px",
    boxSizing: "border-box",
    display: "grid",
    gap: "18px",
    gridTemplateColumns: "minmax(0, 1fr) 138px",
    marginBottom: "16px",
    minWidth: "0",
    padding: "14px",
  });
  Object.assign(meta.style, {
    alignItems: "baseline",
    display: "flex",
    gap: "14px",
    minWidth: "0",
  });
  Object.assign(name.style, {
    display: "block",
    fontSize: "13px",
    fontWeight: "650",
    lineHeight: "1.25",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  Object.assign(size.style, {
    color: "#5f6b7a",
    display: "block",
    flex: "0 0 auto",
    fontSize: "12px",
    lineHeight: "1.25",
  });
  Object.assign(actions.style, {
    alignItems: "end",
    display: "grid",
    gap: "5px",
    justifyItems: "stretch",
    minWidth: "0",
  });
  Object.assign(button.style, {
    alignItems: "center",
    borderRadius: "8px",
    boxSizing: "border-box",
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: "13px",
    fontWeight: "750",
    justifyContent: "center",
    lineHeight: "1.2",
    minHeight: "38px",
    padding: "10px 12px",
    textAlign: "center",
    width: "100%",
  });
  Object.assign(status.style, {
    color: "#5f6b7a",
    fontSize: "11px",
    lineHeight: "1.25",
    margin: "0",
    maxWidth: "138px",
    textAlign: "right",
  });
}

function applyDownloadButtonStyle(
  button: HTMLElement,
  state: "idle" | "loading" | "installed",
) {
  const styles =
    state === "installed"
      ? {
          background: "#e8eef7",
          border: "1px solid #cdd6e4",
          color: "#243244",
          cursor: "default",
          opacity: "1",
        }
      : {
          background: "#006dff",
          border: "1px solid #0057d6",
          color: "#fff",
          cursor: state === "loading" ? "wait" : "pointer",
          opacity: state === "loading" ? "0.78" : "1",
        };

  Object.assign(button.style, styles);
}

function notifyModelInstalled(context: LocalModelWindowContext, model: string) {
  context.owner.dispatchEvent(
    new context.owner.CustomEvent(LOCAL_OLLAMA_MODEL_INSTALLED_EVENT, {
      detail: { model },
    }),
  );
}

function setStatus(element: HTMLElement, text: string) {
  element.textContent = text;
  element.hidden = false;
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  className?: string,
  text?: string,
) {
  const element = doc.createElementNS(HTML_NS, tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
