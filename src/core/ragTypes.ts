import type { PageTextChunk } from "./PdfExtractor";
import type { LibraryScope, RagItemCandidate } from "./LibraryScopeManager";
import type { TextChunk } from "./TextChunker";

export interface RagDocumentReference {
  libraryID: number;
  itemKey: string;
  attachmentID: number;
}

export interface RagSourceDocument {
  reference: RagDocumentReference;
  library: LibraryScope;
  candidate: RagItemCandidate;
  pages: PageTextChunk[];
}

export interface RagTextChunk extends TextChunk {
  reference: RagDocumentReference;
  libraryID: number;
  itemKey: string;
}

export interface RagEmbeddingRecord {
  id: string;
  chunk: RagTextChunk;
  embedding: number[];
  model: string;
  updatedAt: string;
}
