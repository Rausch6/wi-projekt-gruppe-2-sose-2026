import type Addon from "../src/addon";
import type { createZToolkit } from "../src/utils/ztoolkit";

// Augments TypeScript's global scope with values injected by the Zotero add-on
// runtime. Keeping these declarations here avoids repeated imports in modules
// that run inside Zotero's sandbox.
declare global {
  /** Concrete toolkit type inferred from the project's factory function. */
  type ZToolkit = ReturnType<typeof createZToolkit>;

  /** Build mode replaced by the scaffold during bundling. */
  const __env__: "development" | "production";

  /** Root URI used to resolve resources bundled with the add-on. */
  const rootURI: string;

  /** Singleton containing add-on state, settings, and public APIs. */
  const addon: Addon;

  /** Shared helper toolkit for Zotero UI and platform operations. */
  const ztoolkit: ZToolkit;

  /** Typed bridge to globals exposed inside Zotero's sandbox. */
  const _globalThis: typeof globalThis & {
    addon: Addon;
  };
}

// The export turns this file into a module so `declare global` is valid without
// exporting a runtime value.
export {};
