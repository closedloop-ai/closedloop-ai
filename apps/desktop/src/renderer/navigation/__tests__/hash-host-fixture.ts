import type { DesktopHashHost } from "../desktop-adapter";

export type FakeHashHost = DesktopHashHost & {
  /** Simulate an external hash change (user-typed, main-process, legacy). */
  externallySetHash: (rawHash: string) => void;
  getWrites: () => readonly string[];
};

export type QueuedFakeHashHost = FakeHashHost & {
  flushHashChanges: () => void;
};

export function createFakeHashHost(initialHash = ""): FakeHashHost {
  let hash = initialHash;
  const writes: string[] = [];
  const listeners = new Set<(rawHash?: string) => void>();
  return {
    getHash: () => hash,
    setHash: (href) => {
      if (hash.slice(1) === href) {
        return;
      }
      hash = `#${href}`;
      writes.push(href);
      globalThis.history.pushState(null, "", hash);
      for (const listener of listeners) {
        listener(hash);
      }
    },
    onHashChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    externallySetHash: (rawHash) => {
      hash = rawHash;
      for (const listener of listeners) {
        listener(hash);
      }
    },
    getWrites: () => [...writes],
  };
}

export function createQueuedHashHost(initialHash = ""): QueuedFakeHashHost {
  let hash = initialHash;
  const writes: string[] = [];
  const pendingHashes: string[] = [];
  const listeners = new Set<(rawHash?: string) => void>();
  return {
    getHash: () => hash,
    setHash: (href) => {
      if (hash.slice(1) === href) {
        return;
      }
      hash = `#${href}`;
      writes.push(href);
      globalThis.history.pushState(null, "", hash);
      pendingHashes.push(hash);
    },
    onHashChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    externallySetHash: (rawHash) => {
      hash = rawHash;
      pendingHashes.push(rawHash);
    },
    getWrites: () => [...writes],
    flushHashChanges: () => {
      for (const rawHash of pendingHashes.splice(0)) {
        for (const listener of listeners) {
          listener(rawHash);
        }
      }
    },
  };
}
