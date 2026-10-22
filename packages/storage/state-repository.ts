import type { State } from '../shared/types.js';

export interface StateRepository {
  readonly storeId: string;
  load(): Promise<unknown>;
  save(state: State): Promise<void>;
  close(): Promise<void>;
}
