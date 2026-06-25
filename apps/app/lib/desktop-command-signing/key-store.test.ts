import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_SIGNING_DB_NAME,
  COMMAND_SIGNING_DB_VERSION,
  COMMAND_SIGNING_STORE_NAME,
  DEFAULT_COMMAND_SIGNING_KEY_ID,
  deleteBrowserSigningKey,
  getOrCreateBrowserSigningKey,
  getStoredBrowserSigningKey,
  getStoredBrowserSigningKeyMetadata,
} from "./key-store";

type StoredRecord = {
  id: string;
  keyPair: CryptoKeyPair;
  publicKeyBase64: string;
  fingerprint: string;
};

type FakeIndexedDbOptions = {
  failOpen?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
  failDelete?: boolean;
};

type FakeRequest<T> = {
  error: Error | null;
  result: T;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

type FakeTransaction = {
  error: Error | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  objectStore(name: string): FakeObjectStore;
};

type FakeObjectStore = {
  get(key: string): FakeRequest<StoredRecord | null>;
  put(record: StoredRecord): FakeRequest<StoredRecord>;
  delete(key: string): FakeRequest<undefined>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser command signing key store", () => {
  it("opens the compatible IndexedDB database, store, and default key id", async () => {
    const indexedDb = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.api);

    await expect(getOrCreateBrowserSigningKey()).resolves.toMatchObject({
      ok: true,
    });

    expect(indexedDb.openCalls).toEqual([
      {
        name: COMMAND_SIGNING_DB_NAME,
        version: COMMAND_SIGNING_DB_VERSION,
      },
    ]);
    expect(indexedDb.createdStores).toEqual([
      {
        name: COMMAND_SIGNING_STORE_NAME,
        options: { keyPath: "id" },
      },
    ]);
    expect(indexedDb.operations).toEqual([
      {
        method: "get",
        storeName: COMMAND_SIGNING_STORE_NAME,
        key: DEFAULT_COMMAND_SIGNING_KEY_ID,
      },
      {
        method: "put",
        storeName: COMMAND_SIGNING_STORE_NAME,
        key: DEFAULT_COMMAND_SIGNING_KEY_ID,
      },
    ]);
  });

  it("get-or-create creates one non-exportable key and reuses it", async () => {
    const indexedDb = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.api);

    const first = await getOrCreateBrowserSigningKey();
    const second = await getOrCreateBrowserSigningKey();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      throw new Error("expected stored keys");
    }
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.publicKeyBase64).toBe(second.publicKeyBase64);
    expect(first.keyPair.privateKey.extractable).toBe(false);
    expect(
      indexedDb.operations.filter((operation) => operation.method === "put")
    ).toHaveLength(1);
  });

  it("reads metadata without creating a key", async () => {
    const indexedDb = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.api);

    await expect(getStoredBrowserSigningKeyMetadata()).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      indexedDb.operations.filter((operation) => operation.method === "put")
    ).toHaveLength(0);
  });

  it("reads metadata for an existing key without exposing private material", async () => {
    const indexedDb = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.api);
    const created = await getOrCreateBrowserSigningKey();
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected created key");
    }

    await expect(getStoredBrowserSigningKeyMetadata()).resolves.toEqual({
      ok: true,
      publicKeyBase64: created.publicKeyBase64,
      fingerprint: created.fingerprint,
    });
  });

  it("deletes the default key and leaves signing reads in not_found state", async () => {
    const indexedDb = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.api);
    await expect(getOrCreateBrowserSigningKey()).resolves.toMatchObject({
      ok: true,
    });

    await expect(deleteBrowserSigningKey()).resolves.toEqual({ ok: true });
    await expect(getStoredBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(indexedDb.operations).toContainEqual({
      method: "delete",
      storeName: COMMAND_SIGNING_STORE_NAME,
      key: DEFAULT_COMMAND_SIGNING_KEY_ID,
    });
  });

  it("reports explicit failure reasons for unavailable storage and crypto", async () => {
    vi.stubGlobal("indexedDB", createFakeIndexedDb({ failOpen: true }).api);
    await expect(getOrCreateBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "indexeddb_unavailable",
    });
    await expect(getStoredBrowserSigningKeyMetadata()).resolves.toEqual({
      ok: false,
      reason: "indexeddb_unavailable",
    });
    await expect(deleteBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "indexeddb_unavailable",
    });

    vi.unstubAllGlobals();
    vi.stubGlobal("crypto", {});
    await expect(getOrCreateBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "webcrypto_unavailable",
    });
    await expect(getStoredBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "webcrypto_unavailable",
    });
  });

  it("reports key_unavailable when stored key operations fail", async () => {
    vi.stubGlobal("indexedDB", createFakeIndexedDb({ failRead: true }).api);
    await expect(getStoredBrowserSigningKeyMetadata()).resolves.toEqual({
      ok: false,
      reason: "key_unavailable",
    });
    await expect(getStoredBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "key_unavailable",
    });

    vi.stubGlobal("indexedDB", createFakeIndexedDb({ failWrite: true }).api);
    await expect(getOrCreateBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "key_unavailable",
    });

    vi.stubGlobal("indexedDB", createFakeIndexedDb({ failDelete: true }).api);
    await expect(deleteBrowserSigningKey()).resolves.toEqual({
      ok: false,
      reason: "key_unavailable",
    });
  });
});

function createFakeIndexedDb(options: FakeIndexedDbOptions = {}) {
  const records = new Map<string, StoredRecord>();
  const openCalls: Array<{ name: string; version?: number }> = [];
  const createdStores: Array<{
    name: string;
    options?: IDBObjectStoreParameters;
  }> = [];
  const operations: Array<{
    method: "delete" | "get" | "put";
    storeName: string;
    key: string;
  }> = [];

  const api = {
    open(name: string, version?: number): FakeRequest<FakeDatabase> {
      openCalls.push({ name, version });
      const database = new FakeDatabase(
        records,
        createdStores,
        operations,
        options
      );
      const request = createRequest(database);
      queueMicrotask(() => {
        if (options.failOpen) {
          failRequest(request, new Error("open failed"));
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  return { api, createdStores, openCalls, operations };
}

class FakeDatabase {
  private readonly records: Map<string, StoredRecord>;
  private readonly createdStores: Array<{
    name: string;
    options?: IDBObjectStoreParameters;
  }>;
  private readonly operations: Array<{
    method: "delete" | "get" | "put";
    storeName: string;
    key: string;
  }>;
  private readonly options: FakeIndexedDbOptions;

  constructor(
    records: Map<string, StoredRecord>,
    createdStores: Array<{
      name: string;
      options?: IDBObjectStoreParameters;
    }>,
    operations: Array<{
      method: "delete" | "get" | "put";
      storeName: string;
      key: string;
    }>,
    options: FakeIndexedDbOptions
  ) {
    this.records = records;
    this.createdStores = createdStores;
    this.operations = operations;
    this.options = options;
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters) {
    this.createdStores.push({ name, options });
  }

  transaction(storeName: string): FakeTransaction {
    return new FakeStoreTransaction(
      storeName,
      this.records,
      this.operations,
      this.options
    );
  }

  close() {}
}

class FakeStoreTransaction implements FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly _storeName: string;
  private readonly records: Map<string, StoredRecord>;
  private readonly operations: Array<{
    method: "delete" | "get" | "put";
    storeName: string;
    key: string;
  }>;
  private readonly options: FakeIndexedDbOptions;

  constructor(
    _storeName: string,
    records: Map<string, StoredRecord>,
    operations: Array<{
      method: "delete" | "get" | "put";
      storeName: string;
      key: string;
    }>,
    options: FakeIndexedDbOptions
  ) {
    this._storeName = _storeName;
    this.records = records;
    this.operations = operations;
    this.options = options;
  }

  objectStore(name: string): FakeObjectStore {
    return new FakeStore(
      name,
      this.records,
      this.operations,
      this.options,
      this
    );
  }

  complete() {
    this.oncomplete?.();
  }

  fail(error: Error) {
    this.error = error;
    this.onerror?.();
  }
}

class FakeStore implements FakeObjectStore {
  private readonly storeName: string;
  private readonly records: Map<string, StoredRecord>;
  private readonly operations: Array<{
    method: "delete" | "get" | "put";
    storeName: string;
    key: string;
  }>;
  private readonly options: FakeIndexedDbOptions;
  private readonly transaction: FakeStoreTransaction;

  constructor(
    storeName: string,
    records: Map<string, StoredRecord>,
    operations: Array<{
      method: "delete" | "get" | "put";
      storeName: string;
      key: string;
    }>,
    options: FakeIndexedDbOptions,
    transaction: FakeStoreTransaction
  ) {
    this.storeName = storeName;
    this.records = records;
    this.operations = operations;
    this.options = options;
    this.transaction = transaction;
  }

  get(key: string): FakeRequest<StoredRecord | null> {
    this.operations.push({ method: "get", storeName: this.storeName, key });
    const request = createRequest<StoredRecord | null>(null);
    queueMicrotask(() => {
      if (this.options.failRead) {
        failRequest(request, new Error("read failed"));
        return;
      }
      request.result = this.records.get(key) ?? null;
      request.onsuccess?.();
    });
    return request;
  }

  put(record: StoredRecord): FakeRequest<StoredRecord> {
    this.operations.push({
      method: "put",
      storeName: this.storeName,
      key: record.id,
    });
    const request = createRequest(record);
    queueMicrotask(() => {
      if (this.options.failWrite) {
        failRequest(request, new Error("write failed"));
        this.transaction.fail(request.error ?? new Error("write failed"));
        return;
      }
      this.records.set(record.id, record);
      request.onsuccess?.();
      this.transaction.complete();
    });
    return request;
  }

  delete(key: string): FakeRequest<undefined> {
    this.operations.push({ method: "delete", storeName: this.storeName, key });
    const request = createRequest<undefined>(undefined);
    queueMicrotask(() => {
      if (this.options.failDelete) {
        failRequest(request, new Error("delete failed"));
        this.transaction.fail(request.error ?? new Error("delete failed"));
        return;
      }
      this.records.delete(key);
      request.onsuccess?.();
      this.transaction.complete();
    });
    return request;
  }
}

function createRequest<T>(result: T): FakeRequest<T> {
  return {
    error: null,
    result,
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
  };
}

function failRequest<T>(request: FakeRequest<T>, error: Error) {
  request.error = error;
  request.onerror?.();
}
