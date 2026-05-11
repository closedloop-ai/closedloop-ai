"use client";

import { bytesToBase64 } from "./crypto-utils";

const DB_NAME = "closedloop-command-signing";
const DB_VERSION = 1;
const STORE_NAME = "signing-keys";
const DEFAULT_KEY_ID = "default";
const BASE64_PADDING_REGEX = /=+$/;

export type BrowserSigningKey =
  | {
      ok: true;
      keyPair: CryptoKeyPair;
      publicKeyBase64: string;
      fingerprint: string;
    }
  | {
      ok: false;
      reason:
        | "indexeddb_unavailable"
        | "webcrypto_unavailable"
        | "key_unavailable";
    };

export type BrowserSigningKeyMetadata =
  | {
      ok: true;
      publicKeyBase64: string;
      fingerprint: string;
    }
  | {
      ok: false;
      reason: "indexeddb_unavailable" | "key_unavailable" | "not_found";
    };

export type StoredBrowserSigningKey =
  | Extract<BrowserSigningKey, { ok: true }>
  | {
      ok: false;
      reason: Extract<BrowserSigningKey, { ok: false }>["reason"] | "not_found";
    };

type StoredSigningKey = {
  id: string;
  keyPair: CryptoKeyPair;
  publicKeyBase64: string;
  fingerprint: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(BASE64_PADDING_REGEX, "");
}

async function fingerprintRawPublicKey(
  rawPublicKey: ArrayBuffer
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawPublicKey);
  return `cl:${bytesToBase64Url(new Uint8Array(digest)).slice(0, 22)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error ?? new Error("open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function readStoredKey(db: IDBDatabase): Promise<StoredSigningKey | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(DEFAULT_KEY_ID);
    request.onerror = () => reject(request.error ?? new Error("read failed"));
    request.onsuccess = () =>
      resolve((request.result as StoredSigningKey) ?? null);
  });
}

function writeStoredKey(db: IDBDatabase, key: StoredSigningKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put(key);
    request.onerror = () => reject(request.error ?? new Error("write failed"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("write failed"));
  });
}

function deleteStoredKey(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).delete(DEFAULT_KEY_ID);
    request.onerror = () => reject(request.error ?? new Error("delete failed"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("delete failed"));
  });
}

function hasStoredSigningKeyMaterial(
  key: StoredSigningKey | null
): key is StoredSigningKey {
  return Boolean(key?.keyPair?.privateKey && key.keyPair.publicKey);
}

async function generateSigningKey(): Promise<StoredSigningKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto unavailable");
  }
  const keyPair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    id: DEFAULT_KEY_ID,
    keyPair,
    publicKeyBase64: bytesToBase64(new Uint8Array(rawPublicKey)),
    fingerprint: await fingerprintRawPublicKey(rawPublicKey),
  };
}

/**
 * Reads the browser-held command-signing public key metadata without creating a
 * key. Use this for UI state so rendering settings does not enroll a browser.
 */
export async function getStoredBrowserSigningKeyMetadata(): Promise<BrowserSigningKeyMetadata> {
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch {
    return { ok: false, reason: "indexeddb_unavailable" };
  }

  try {
    const existing = await readStoredKey(db);
    if (!hasStoredSigningKeyMaterial(existing)) {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: true,
      publicKeyBase64: existing.publicKeyBase64,
      fingerprint: existing.fingerprint,
    };
  } catch {
    return { ok: false, reason: "key_unavailable" };
  } finally {
    db.close();
  }
}

/**
 * Reads the browser-held command-signing key without creating a replacement.
 * Use this for command signing so unregistering a browser remains durable.
 */
export async function getStoredBrowserSigningKey(): Promise<StoredBrowserSigningKey> {
  if (!globalThis.crypto?.subtle) {
    return { ok: false, reason: "webcrypto_unavailable" };
  }

  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch {
    return { ok: false, reason: "indexeddb_unavailable" };
  }

  try {
    const existing = await readStoredKey(db);
    if (!hasStoredSigningKeyMaterial(existing)) {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: true,
      keyPair: existing.keyPair,
      publicKeyBase64: existing.publicKeyBase64,
      fingerprint: existing.fingerprint,
    };
  } catch {
    return { ok: false, reason: "key_unavailable" };
  } finally {
    db.close();
  }
}

/**
 * Removes the browser-held command-signing key. The next registration creates
 * a fresh non-exportable keypair.
 */
export async function deleteBrowserSigningKey(): Promise<{
  ok: boolean;
  reason?: "indexeddb_unavailable" | "key_unavailable";
}> {
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch {
    return { ok: false, reason: "indexeddb_unavailable" };
  }

  try {
    await deleteStoredKey(db);
    return { ok: true };
  } catch {
    return { ok: false, reason: "key_unavailable" };
  } finally {
    db.close();
  }
}

/**
 * Returns the browser-held command-signing key, creating a non-exportable
 * Ed25519 keypair on first use. No private key material is exported.
 */
export async function getOrCreateBrowserSigningKey(): Promise<BrowserSigningKey> {
  if (!globalThis.crypto?.subtle) {
    return { ok: false, reason: "webcrypto_unavailable" };
  }

  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch {
    return { ok: false, reason: "indexeddb_unavailable" };
  }

  try {
    const existing = await readStoredKey(db);
    if (hasStoredSigningKeyMaterial(existing)) {
      return {
        ok: true,
        keyPair: existing.keyPair,
        publicKeyBase64: existing.publicKeyBase64,
        fingerprint: existing.fingerprint,
      };
    }

    const generated = await generateSigningKey();
    await writeStoredKey(db, generated);
    return {
      ok: true,
      keyPair: generated.keyPair,
      publicKeyBase64: generated.publicKeyBase64,
      fingerprint: generated.fingerprint,
    };
  } catch {
    return { ok: false, reason: "key_unavailable" };
  } finally {
    db.close();
  }
}
