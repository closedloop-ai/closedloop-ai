/**
 * Subscribe to the cross-document `storage` event for ONE localStorage key.
 *
 * The browser fires `storage` on every OTHER same-origin document when a key
 * changes, never on the document that wrote it — so this is how a second tab
 * learns about a write (ISS-9568). Shared by `useLocalStorageState` and the two
 * persisted-view hooks so the key filter and the teardown live in one place.
 * A `storage` event whose `key` is `null` is `localStorage.clear()` in the other
 * document, which took this key with it, so it is forwarded too (its `newValue`
 * is `null`, the same shape as a removal). Returns the unsubscribe; a runtime
 * with no `addEventListener` (SSR) gets a no-op so callers need not branch on it.
 */
export function subscribeToStorageKey(
  key: string,
  onEvent: (event: StorageEvent) => void
): () => void {
  if (typeof globalThis.addEventListener !== "function") {
    return () => {};
  }
  const handler = (event: StorageEvent) => {
    // A `storage` event is fired for BOTH areas, so the key alone does not say
    // which one moved: a same-origin document sharing this tab's session (an
    // iframe) writing `sessionStorage` under the same key would otherwise be
    // adopted as a persisted view, and its `sessionStorage.clear()` forwarded
    // as a removal, while `localStorage` never changed. `storageArea` is what
    // tells them apart. An event carrying NONE is not attributable to the wrong
    // area — that is a synthetic dispatch (jsdom, and `useLocalStorageState`'s
    // same-window notify wherever `defineProperty` is refused) — so it still
    // goes through, which is the pre-extraction behaviour of every caller.
    if (event.storageArea && event.storageArea !== localStorage) {
      return;
    }
    if (event.key === key || event.key === null) {
      onEvent(event);
    }
  };
  globalThis.addEventListener("storage", handler);
  return () => globalThis.removeEventListener("storage", handler);
}

/**
 * Decode a raw localStorage string through a feature parser, fail-soft: an
 * absent value, non-JSON bytes, a parser that rejects, or a parser that throws
 * all yield `null`. This is the one decode boundary the persisted-view hooks
 * use for BOTH the mount-time restore and a cross-tab `storage` event, so the
 * two paths cannot accept different bytes.
 */
export function decodeStoredJson<T>(
  raw: string | null,
  parse: (value: unknown) => T | null
): T | null {
  return decodeStoredRecord(raw, parse)?.parsed ?? null;
}

/**
 * Read one localStorage key and decode it through {@link decodeStoredJson}.
 * Fail-soft end to end: no `localStorage` (SSR) and a `getItem` that throws
 * (storage disabled, private mode) both yield `null`, so a caller restoring a
 * persisted view never has to branch on the runtime.
 */
export function readStoredJson<T>(
  key: string,
  parse: (value: unknown) => T | null
): T | null {
  return readStoredRecord(key, parse)?.parsed ?? null;
}

/**
 * A decoded stored record: what the feature parser made of it, beside the JSON
 * it was made from.
 *
 * The raw half exists because a parser is a `z.object` and therefore STRIPS
 * every field it does not declare. A caller that re-serializes what it restored
 * — which is every persisted-view hook — needs the difference between the two
 * to carry a newer build's field back out instead of deleting it (ISS-9450).
 */
export type StoredRecord<T> = { parsed: T; raw: unknown };

/**
 * {@link decodeStoredJson}, keeping the decoded JSON beside the parsed view.
 * Same fail-soft contract: any of an absent value, non-JSON bytes, a rejecting
 * parser, or a throwing parser yields `null`.
 */
export function decodeStoredRecord<T>(
  raw: string | null,
  parse: (value: unknown) => T | null
): StoredRecord<T> | null {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    const parsed = parse(decoded);
    return parsed === null ? null : { parsed, raw: decoded };
  } catch {
    return null;
  }
}

/** {@link readStoredJson}, keeping the decoded JSON beside the parsed view. */
export function readStoredRecord<T>(
  key: string,
  parse: (value: unknown) => T | null
): StoredRecord<T> | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    return decodeStoredRecord(localStorage.getItem(key), parse);
  } catch {
    return null;
  }
}

/** Read the first decodable record from an ordered localStorage fallback list. */
export function readFallbackStoredRecord<T>(
  storageKeys: readonly string[],
  parse: (value: unknown) => T | null
): StoredRecord<T> | null {
  for (const storageKey of storageKeys) {
    const saved = readStoredRecord(storageKey, parse);
    if (saved) {
      return saved;
    }
  }
  return null;
}
