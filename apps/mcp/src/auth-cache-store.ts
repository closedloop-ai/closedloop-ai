import type { Redis } from "@repo/redis";
import type { VerifiedApiKeyContext } from "./api-key-contract.js";

type SerializedMcpAuth = {
  plaintextKey: string;
  context: VerifiedApiKeyContext;
  grantedScopes: string[];
  createdAt: number;
};

// Encrypts/decrypts the bearer API key before it touches Redis. Injected by the
// MCP server so the store reuses the same AES-256-GCM OAuth signing keys the
// rest of the server uses, without this module depending on key material.
type AuthKeyCipher = {
  encrypt(plaintext: string): { ciphertext: string; kid: string };
  decrypt(ciphertext: string, kid: string): string | null;
};

// The shape actually persisted to Redis. The plaintext API key is never stored;
// only its AES-256-GCM ciphertext plus the key id needed to decrypt it. A Redis
// dump, backup, or read-only compromise therefore yields no reusable sk_*
// credential.
type StoredMcpAuth = {
  apiKeyCiphertext: string;
  kid: string;
  context: VerifiedApiKeyContext;
  grantedScopes: string[];
  createdAt: number;
};

type AuthCacheStore = {
  get(sessionId: string): Promise<SerializedMcpAuth | null>;
  set(sessionId: string, auth: SerializedMcpAuth, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
};

class RedisAuthCacheStore implements AuthCacheStore {
  private readonly redis: Redis;
  private readonly cipher: AuthKeyCipher;

  constructor(redis: Redis, cipher: AuthKeyCipher) {
    this.redis = redis;
    this.cipher = cipher;
  }

  async get(sessionId: string): Promise<SerializedMcpAuth | null> {
    try {
      const data = await this.redis.get(`auth:${sessionId}`);
      if (!data) {
        return null;
      }
      const stored = JSON.parse(data) as StoredMcpAuth;
      const plaintextKey = this.cipher.decrypt(
        stored.apiKeyCiphertext,
        stored.kid
      );
      if (!plaintextKey) {
        // Undecryptable (key rotated out, corrupted, or tampered) — treat as a
        // miss so the request falls back to full API-key verification.
        return null;
      }
      return {
        plaintextKey,
        context: stored.context,
        grantedScopes: stored.grantedScopes,
        createdAt: stored.createdAt,
      };
    } catch {
      return null;
    }
  }

  async set(
    sessionId: string,
    auth: SerializedMcpAuth,
    ttlMs: number
  ): Promise<void> {
    try {
      const { ciphertext, kid } = this.cipher.encrypt(auth.plaintextKey);
      const stored: StoredMcpAuth = {
        apiKeyCiphertext: ciphertext,
        kid,
        context: auth.context,
        grantedScopes: auth.grantedScopes,
        createdAt: auth.createdAt,
      };
      await this.redis.set(
        `auth:${sessionId}`,
        JSON.stringify(stored),
        "PX",
        ttlMs
      );
    } catch {
      // Graceful degradation — Redis failure doesn't break session creation
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.redis.del(`auth:${sessionId}`);
    } catch {
      // Graceful degradation
    }
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    try {
      await this.redis.pexpire(`auth:${sessionId}`, ttlMs);
    } catch {
      // Fire-and-forget TTL refresh
    }
  }
}

export type { AuthCacheStore, AuthKeyCipher, SerializedMcpAuth, StoredMcpAuth };
export { RedisAuthCacheStore };
