type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const __env__: "development" | "production";
declare const rootURI: string;
declare const addon: import("../src/addon").default;
declare const ztoolkit: ZToolkit;
declare const _globalThis: {
  addon: import("../src/addon").default;
  [key: string]: any;
};
