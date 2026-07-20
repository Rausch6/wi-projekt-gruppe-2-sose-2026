// Ambient counterparts for source files that consume Zotero's injected values
// without using module-level global augmentation.
type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

/** Current build environment supplied by the add-on scaffold. */
declare const __env__: "development" | "production";

/** Base URI for resources packaged with the extension. */
declare const rootURI: string;

/** Globally available ZAIA add-on singleton. */
declare const addon: import("../src/addon").default;

/** Globally available Zotero helper toolkit. */
declare const ztoolkit: ZToolkit;

// Zotero's sandbox may expose additional runtime-specific properties, so the
// bridge keeps an index signature while strongly typing the add-on singleton.
declare const _globalThis: {
  addon: import("../src/addon").default;
  [key: string]: any;
};
