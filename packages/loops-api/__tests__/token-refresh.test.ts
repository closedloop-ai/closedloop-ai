import { describe, expect, it } from "vitest";

import {
  HeartbeatErrorCode,
  HeartbeatErrorCodeSchema,
  HeartbeatResponseDataSchema,
  HeartbeatResultSchema,
  RefreshErrorSchema,
  RefreshResultSchema,
  RefreshSuccessSchema,
  RefreshTokenErrorCode,
  RefreshTokenErrorCodeSchema,
} from "../src/token-refresh";

const REVIVAL_TOKEN_FIELDS = {
  token: "runner-token-abc",
  expiresAt: new Date("2026-05-26T00:00:00.000Z"),
  jti: "jti-revive-1",
};

describe("RefreshTokenErrorCodeSchema", () => {
  it("accepts every RefreshTokenErrorCode value", () => {
    for (const value of Object.values(RefreshTokenErrorCode)) {
      const result = RefreshTokenErrorCodeSchema.safeParse(value);
      expect(result.success, `expected to accept ${value}`).toBe(true);
      if (result.success) {
        expect(result.data).toBe(value);
      }
    }
  });

  it("rejects unknown refresh token error codes", () => {
    expect(RefreshTokenErrorCodeSchema.safeParse("UNKNOWN_CODE").success).toBe(
      false
    );
  });
});

describe("HeartbeatErrorCodeSchema", () => {
  it("accepts every HeartbeatErrorCode value", () => {
    for (const value of Object.values(HeartbeatErrorCode)) {
      const result = HeartbeatErrorCodeSchema.safeParse(value);
      expect(result.success, `expected to accept ${value}`).toBe(true);
      if (result.success) {
        expect(result.data).toBe(value);
      }
    }
  });
});

describe("RefreshResultSchema", () => {
  it("parses success JSON, coerces expiresAt to Date, and preserves ISO value", () => {
    const data = RefreshResultSchema.parse({
      ok: true,
      token: "tok_abc",
      expiresAt: "2026-01-01T00:00:00Z",
      jti: "jti_xyz",
    });
    expect(data.ok).toBe(true);
    if (!data.ok) {
      return;
    }
    expect(data.token).toBe("tok_abc");
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(data.expiresAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(data.jti).toBe("jti_xyz");
  });

  it("parses error JSON and code matches RefreshTokenErrorCode const", () => {
    const data = RefreshResultSchema.parse({
      ok: false,
      code: "JTI_MISMATCH",
      message: "JTI mismatch error",
    });
    expect(data.ok).toBe(false);
    if (data.ok) {
      return;
    }
    expect(data.code).toBe(RefreshTokenErrorCode.JtiMismatch);
    expect(data.message).toBe("JTI mismatch error");
  });

  it("rejects ok:false payload missing required code field", () => {
    const result = RefreshResultSchema.safeParse({
      ok: false,
      message: "missing code",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ok:true payload with malformed expiresAt date string", () => {
    const result = RefreshResultSchema.safeParse({
      ok: true,
      token: "t",
      expiresAt: "not-a-date",
      jti: "j",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ok:false payload with invalid code string", () => {
    const result = RefreshResultSchema.safeParse({
      ok: false,
      code: "UNKNOWN_CODE",
      message: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("RefreshSuccessSchema rejections and stripping", () => {
  it("rejects missing token field", () => {
    const result = RefreshSuccessSchema.safeParse({
      ok: true,
      expiresAt: "2026-01-01T00:00:00Z",
      jti: "jti_xyz",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong discriminator (ok: false)", () => {
    const result = RefreshSuccessSchema.safeParse({
      ok: false,
      token: "tok_abc",
      expiresAt: "2026-01-01T00:00:00Z",
      jti: "jti_xyz",
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown extra fields silently", () => {
    const data = RefreshSuccessSchema.parse({
      ok: true,
      token: "tok_abc",
      expiresAt: "2026-01-01T00:00:00Z",
      jti: "jti_xyz",
      extraField: "should-be-stripped",
    });
    expect(Object.hasOwn(data, "extraField")).toBe(false);
  });

  it("rejects missing jti field", () => {
    const result = RefreshSuccessSchema.safeParse({
      ok: true,
      token: "t",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("RefreshErrorSchema", () => {
  it("rejects payload missing required message field", () => {
    const result = RefreshErrorSchema.safeParse({
      ok: false,
      code: "JTI_MISMATCH",
    });
    expect(result.success).toBe(false);
  });
});

describe("HeartbeatResultSchema", () => {
  it("parses success result { ok: true, bumped: true }", () => {
    const data = HeartbeatResultSchema.parse({ ok: true, bumped: true });
    expect(data.ok).toBe(true);
    if (!data.ok) {
      return;
    }
    expect(data.bumped).toBe(true);
  });

  it("parses error result and code matches HeartbeatErrorCode const", () => {
    const data = HeartbeatResultSchema.parse({
      ok: false,
      code: "LOOP_NOT_FOUND",
    });
    expect(data.ok).toBe(false);
    if (data.ok) {
      return;
    }
    expect(data.code).toBe(HeartbeatErrorCode.LoopNotFound);
  });

  it("rejects error result with unknown code", () => {
    const result = HeartbeatResultSchema.safeParse({
      ok: false,
      code: "INVALID_CODE",
    });
    expect(result.success).toBe(false);
  });

  it("parses success result { ok: true, bumped: false }", () => {
    const result = HeartbeatResultSchema.safeParse({ ok: true, bumped: false });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.ok).toBe(true);
    if (!result.data.ok) {
      return;
    }
    expect(result.data.bumped).toBe(false);
  });

  it("rejects ok:true payload missing bumped field", () => {
    const result = HeartbeatResultSchema.safeParse({ ok: true });
    expect(result.success).toBe(false);
  });

  it("parses a revived success carrying the full minted token", () => {
    const result = HeartbeatResultSchema.safeParse({
      ok: true,
      bumped: true,
      revived: true,
      ...REVIVAL_TOKEN_FIELDS,
    });
    expect(result.success).toBe(true);
  });

  it("rejects revived:true without the token fields", () => {
    const result = HeartbeatResultSchema.safeParse({
      ok: true,
      bumped: true,
      revived: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects token fields on a non-revived heartbeat", () => {
    const result = HeartbeatResultSchema.safeParse({
      ok: true,
      bumped: true,
      token: "runner-token-abc",
    });
    expect(result.success).toBe(false);
  });
});

describe("HeartbeatResponseDataSchema (wire body, no ok)", () => {
  it("parses a normal heartbeat body { bumped }", () => {
    const result = HeartbeatResponseDataSchema.safeParse({ bumped: true });
    expect(result.success).toBe(true);
  });

  it("parses a revived body with the full minted token", () => {
    const result = HeartbeatResponseDataSchema.safeParse({
      bumped: true,
      revived: true,
      ...REVIVAL_TOKEN_FIELDS,
    });
    expect(result.success).toBe(true);
  });

  it("rejects revived:true without the token fields", () => {
    const result = HeartbeatResponseDataSchema.safeParse({
      bumped: true,
      revived: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an ok field — the wire body omits the service discriminant", () => {
    const result = HeartbeatResponseDataSchema.safeParse({
      ok: true,
      bumped: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("cross-schema contamination", () => {
  it("HeartbeatErrorCodeSchema rejects RATE_LIMITED which is only a RefreshTokenErrorCode member", () => {
    expect(RefreshTokenErrorCodeSchema.safeParse("RATE_LIMITED").success).toBe(
      true
    );
    expect(HeartbeatErrorCodeSchema.safeParse("RATE_LIMITED").success).toBe(
      false
    );
  });
});
