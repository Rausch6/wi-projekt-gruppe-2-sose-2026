// `natural` exposes this internal stop-word list without shipping a declaration
// for the subpath. This shim gives TextChunker a typed named export.
declare module "natural/lib/natural/util/stopwords.js" {
  /** English stop words bundled with the natural package. */
  export const words: string[];
}
