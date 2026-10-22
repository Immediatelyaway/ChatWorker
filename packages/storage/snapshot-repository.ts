/** Transitional boundary for the existing whole-state store, not a relational schema. */
export interface SnapshotRepository<T> {
  /** Missing storage returns undefined; malformed data must throw, never reset itself. */
  load(): unknown | undefined;
  /** Returns only after persistence succeeds; errors must reach the caller. */
  save(value: T): void;
}
