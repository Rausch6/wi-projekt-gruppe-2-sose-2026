import type Addon from "../src/addon";
import type { createZToolkit } from "../src/utils/ztoolkit";

declare global {
  type ZToolkit = ReturnType<typeof createZToolkit>;

  const __env__: "development" | "production";
  const rootURI: string;
  const addon: Addon;
  const ztoolkit: ZToolkit;
  const _globalThis: typeof globalThis & {
    addon: Addon;
  };
}

export {};
