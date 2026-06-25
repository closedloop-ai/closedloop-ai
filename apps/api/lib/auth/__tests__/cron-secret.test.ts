/**
 * Unit tests for validateCronSecret (PR #1206 review fix #5).
 *
 * Coverage: missing env, wrong-length token, wrong-value-correct-length token,
 * correct token. Exercises the length pre-check that guards timingSafeEqual
 * against the runtime exception it throws on unequal-length inputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/route-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-utils")>();
  return {
    ...actual,
    scheduleLogFlush: vi.fn(),
  };
});

import { validateCronSecret } from "../cron-secret";

const LOG_TAG = "[unit-test]";
const SECRET = "correct-horse-battery-staple";

function makeRequest(authHeader?: string): Request {
  return new Request("http://localhost/cron/whatever", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("validateCronSecret", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("returns 500 when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(500);
  });

  it("returns 401 when the Authorization header is missing", () => {
    const response = validateCronSecret(makeRequest(), LOG_TAG);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the token has the wrong length (length pre-check, not timingSafeEqual)", () => {
    // Differing-length input would throw inside timingSafeEqual; the length
    // pre-check must short-circuit before reaching it.
    const response = validateCronSecret(
      makeRequest("Bearer too-short"),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns 401 when the token is the correct length but the wrong value", () => {
    const wrongSameLength = "X".repeat(SECRET.length);
    const response = validateCronSecret(
      makeRequest(`Bearer ${wrongSameLength}`),
      LOG_TAG
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
  });

  it("returns null when the Authorization header matches the configured secret", () => {
    const response = validateCronSecret(
      makeRequest(`Bearer ${SECRET}`),
      LOG_TAG
    );
    expect(response).toBeNull();
  });
});
