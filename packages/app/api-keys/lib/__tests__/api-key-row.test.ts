import type { ApiKey } from "@repo/api/src/types/api-key";
import { describe, expect, it } from "vitest";
import {
  ApiKeyStatus,
  describeApiKeyStatus,
  formatApiKeyDate,
  isApiKeyActive,
} from "../api-key-row";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-1",
    organizationId: "org-1",
    userId: "user-1",
    name: "CI pipeline",
    keyPrefix: "sk_live_abc",
    expiresAt: null,
    scopes: [],
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

describe("describeApiKeyStatus", () => {
  it("returns Revoked for a revoked key", () => {
    const key = makeKey({ revokedAt: new Date("2026-06-01T00:00:00.000Z") });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Revoked);
  });

  it("returns Expired for a key whose expiry is in the past", () => {
    const key = makeKey({ expiresAt: new Date("2026-06-14T00:00:00.000Z") });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Expired);
  });

  it("returns Active for a key with no revocation and no expiry", () => {
    const key = makeKey();
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Active);
  });

  it("returns Active for a key with a future expiry", () => {
    const key = makeKey({ expiresAt: new Date("2026-06-16T00:00:00.000Z") });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Active);
  });

  it("prefers Revoked over Expired when a key is both revoked and past its expiry", () => {
    const key = makeKey({
      revokedAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-14T00:00:00.000Z"),
    });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Revoked);
  });

  it("treats a null expiresAt as never expiring", () => {
    const key = makeKey({ expiresAt: null });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Active);
  });

  it("treats an expiry exactly at `now` as already expired", () => {
    // Pinning current behavior: the comparison is `<=`, so the exact expiry
    // instant reads as expired rather than as the last still-active moment.
    const key = makeKey({ expiresAt: new Date(NOW.getTime()) });
    expect(describeApiKeyStatus(key, NOW)).toBe(ApiKeyStatus.Expired);
  });
});

describe("isApiKeyActive", () => {
  it("returns true for an active key", () => {
    expect(isApiKeyActive(makeKey(), NOW)).toBe(true);
  });

  it("returns false for a revoked key", () => {
    const key = makeKey({ revokedAt: new Date("2026-06-01T00:00:00.000Z") });
    expect(isApiKeyActive(key, NOW)).toBe(false);
  });

  it("returns false for an expired key", () => {
    const key = makeKey({ expiresAt: new Date("2026-06-14T00:00:00.000Z") });
    expect(isApiKeyActive(key, NOW)).toBe(false);
  });
});

describe("formatApiKeyDate", () => {
  it("renders an em dash for a null date", () => {
    expect(formatApiKeyDate(null)).toBe("—");
  });

  it("formats a Date object using the shared date formatter", () => {
    // Built from local date-time components, not a UTC ISO string, so the
    // expectation does not depend on the test runner's time zone.
    const date = new Date(2026, 0, 14, 15, 30);
    expect(formatApiKeyDate(date)).toBe("Jan 14, 2026");
  });
});
