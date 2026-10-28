import { vi } from "vitest";
import type { DocumentStorage } from "../../storage/document-storage";

/** An in-memory `DocumentStorage` whose rows the test can seed and read; `store` is a spy. */
export function memoryStorage(seed: Iterable<[string, Uint8Array]> = []): {
  storage: DocumentStorage;
  rows: Map<string, Uint8Array>;
} {
  const rows = new Map(seed);
  const storage: DocumentStorage = {
    fetch: (name) => Promise.resolve(rows.get(name) ?? null),
    store: vi.fn((name: string, state: Uint8Array) => {
      rows.set(name, state);
      return Promise.resolve();
    }),
    exists: (name) => Promise.resolve(rows.has(name)),
    delete: (name) => Promise.resolve(rows.delete(name)),
    listNames: (after, limit) =>
      Promise.resolve(
        [...rows.keys()]
          .sort()
          .filter((name) => after === undefined || name > after)
          .slice(0, limit)
      ),
    close: () => Promise.resolve(),
    ping: () => Promise.resolve(),
  };
  return { storage, rows };
}
