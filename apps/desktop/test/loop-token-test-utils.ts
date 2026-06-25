import {
  type LoopTokenMeta,
  LoopTokenStore,
  type SafeStorageLike,
} from "../src/main/loop-token-store.js";

export function createTestLoopTokenSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string) {
      return Buffer.from(`stub:${plainText}`, "utf-8");
    },
    decryptString(encrypted: Buffer) {
      const s = encrypted.toString("utf-8");
      return s.startsWith("stub:") ? s.slice(5) : s;
    },
  };
}

/**
 * Returns a fully-populated {@link LoopTokenMeta} fixture suitable for unit
 * tests. Callers may pass partial overrides to customize individual fields.
 */
export function createTestLoopTokenMeta(
  overrides?: Partial<LoopTokenMeta>
): LoopTokenMeta {
  return {
    token: "test-runner-token",
    expiresAt: 1_700_000_000_000,
    jti: "test-jti-abc123",
    lastIdempotencyKey: "test-idempotency-key-xyz",
    ...overrides,
  };
}

/**
 * Creates a fresh {@link LoopTokenStore} backed by a temp directory and the
 * standard stub safeStorage. Shared across unit-test files so the constructor
 * signature has a single call site.
 */
export function createTestLoopTokenStore(
  tempRoot: string,
  name: string
): LoopTokenStore {
  return new LoopTokenStore({
    cwd: tempRoot,
    name,
    safeStorage: createTestLoopTokenSafeStorage(),
  });
}

/**
 * Builds a minimal unsigned JWT (base64url header + payload + fake signature).
 * Not cryptographically valid — only used to satisfy `parseJwtExpiry` and
 * similar structural decoders in tests.
 */
export function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

/**
 * Awaits pending microtasks/macrotasks so async callbacks scheduled by
 * `mock.timers.tick()` or fire-and-forget Promises can complete before
 * assertions run.
 */
export async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
