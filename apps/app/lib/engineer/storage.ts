"use client";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function getStorageItem(key: string): string | null {
  const storage = getBrowserStorage();
  if (!storage) {
    return null;
  }
  return storage.getItem(key);
}

export function setStorageItem(key: string, value: string): void {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  storage.setItem(key, value);
}

export function removeStorageItem(key: string): void {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  storage.removeItem(key);
}

function getBrowserStorage(): StorageLike | null {
  if (globalThis.window === undefined) {
    return null;
  }

  const browserStorage = globalThis.localStorage;
  if (!isStorageLike(browserStorage)) {
    return null;
  }

  return browserStorage;
}

function isStorageLike(value: unknown): value is StorageLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<StorageLike>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}
