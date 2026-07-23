import type { PageTextChunk } from "./PdfExtractor";
import type { LibraryScope, RagItemCandidate } from "./LibraryScopeManager";
import type { TextChunk } from "./TextChunker";

/**
 * Identifies a Zotero attachment that belongs to a RAG source document.
 */
export interface RagDocumentReference {
  /**
   * Zotero library ID that owns the referenced item.
   */
  libraryID: number;

  /**
   * Zotero item key of the parent or source item.
   */
  itemKey: string;

  /**
   * Zotero item ID of the attachment used as the text source.
   */
  attachmentID: number;
}

/**
 * Contains the extracted source material and metadata for a RAG-indexable document.
 */
export interface RagSourceDocument {
  /**
   * Stable reference to the Zotero attachment behind the source document.
   */
  reference: RagDocumentReference;

  /**
   * Library scope in which the source document was found.
   */
  library: LibraryScope;

  /**
   * Metadata candidate that represents the Zotero item.
   */
  candidate: RagItemCandidate;

  /**
   * Extracted page text chunks from the PDF attachment.
   */
  pages: PageTextChunk[];
}

/**
 * Represents a text chunk enriched with Zotero reference metadata for retrieval.
 */
export interface RagTextChunk extends TextChunk {
  /**
   * Stable reference to the source attachment.
   */
  reference: RagDocumentReference;

  /**
   * Zotero library ID duplicated for efficient lookup and filtering.
   */
  libraryID: number;

  /**
   * Zotero item key duplicated for efficient lookup and filtering.
   */
  itemKey: string;
}

/**
 * Stores an embedding vector together with the RAG chunk it represents.
 */
export interface RagEmbeddingRecord {
  /**
   * Stable embedding record identifier.
   */
  id: string;

  /**
   * Text chunk represented by the embedding vector.
   */
  chunk: RagTextChunk;

  /**
   * Numeric embedding vector produced by the configured embedding model.
   */
  embedding: number[];

  /**
   * Embedding model that produced the vector.
   */
  model: string;

  /**
   * ISO timestamp of the last embedding update.
   */
  updatedAt: string;
}
