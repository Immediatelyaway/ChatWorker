import type { LibraryQuery } from '../contracts/library.js';
import type { DraftRepository } from '../contracts/drafts.js';
import type { State } from '../shared/types.js';

export interface StateRepository extends DraftRepository {
  library?(query: LibraryQuery): Promise<unknown>;
  readonly storeId: string;
  load(): Promise<unknown>;
  save(state: State): Promise<void>;
  close(): Promise<void>;
}
