import { z } from 'zod';
export const LIBRARY_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  textCharacters: 200_000,
  documents: 200,
  totalBytes: 100 * 1024 * 1024,
  queryCharacters: 2000,
  retrievedCharacters: 9000,
  retrievedChunks: 6,
});
export const librarySourceSchema = z.object({
  conversationId: z.string().max(200),
  messageId: z.string().max(200),
  conversationTitle: z.string().max(200),
  attachmentIndex: z.number().int().nonnegative().optional(),
});
export const documentPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    favorite: z.boolean().optional(),
    enabled: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
export interface LibraryDocument {
  id: string;
  title: string;
  format: string;
  text: string;
  hash: string;
  characters: number;
  chunks: number;
  source?: z.infer<typeof librarySourceSchema>;
  favorite: boolean;
  enabled: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export type LibrarySummary = Omit<LibraryDocument, 'text'>;
export const citationSchema = z.object({
  label: z.string().max(10),
  documentId: z.string().uuid(),
  title: z.string().max(200),
  hash: z.string().max(64),
  chunkIndex: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string().max(1800),
});
export type Citation = z.infer<typeof citationSchema>;
export type LibraryQuery =
  | { action: 'list' }
  | { action: 'get'; id: string }
  | { action: 'download'; id: string }
  | {
      action: 'create';
      title: string;
      text: string;
      format: string;
      original?: Uint8Array;
      source?: LibraryDocument['source'];
    }
  | { action: 'patch'; id: string; patch: z.infer<typeof documentPatchSchema> }
  | { action: 'search'; query: string; documentIds?: string[] };
