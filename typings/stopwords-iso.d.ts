// The package exposes its language lists through a JSON subpath but does not
// provide a sufficiently specific TypeScript declaration for that import.
declare module "stopwords-iso/stopwords-iso.json" {
  // All language codes map to word lists; German is required by TextChunker and
  // therefore declared explicitly as always present.
  const stopwords: Record<string, string[]> & {
    de: string[];
  };

  /** Complete ISO-language stop-word collection from the JSON module. */
  export default stopwords;
}
