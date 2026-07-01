declare module "stopwords-iso/stopwords-iso.json" {
  const stopwords: Record<string, string[]> & {
    de: string[];
  };

  export default stopwords;
}
