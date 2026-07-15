import { describe, expect, it } from "vitest";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
  sanitizePostgresText,
} from "../agent-sessions-text-sanitizer";

// Built via char codes so no literal NUL / surrogate byte lives in this source.
const NUL = String.fromCharCode(0);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_3d);
const LONE_LOW_SURROGATE = String.fromCharCode(0xde_00);
const REPLACEMENT = String.fromCharCode(0xff_fd);
const EMOJI = String.fromCodePoint(0x1_f6_00); // a valid high+low surrogate pair

describe("sanitizePostgresText", () => {
  it("removes NUL bytes", () => {
    expect(sanitizePostgresText(`a${NUL}b${NUL}`)).toBe("ab");
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    expect(sanitizePostgresText(`x${LONE_HIGH_SURROGATE}y`)).toBe(
      `x${REPLACEMENT}y`
    );
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    expect(sanitizePostgresText(`x${LONE_LOW_SURROGATE}y`)).toBe(
      `x${REPLACEMENT}y`
    );
  });

  it("preserves a valid surrogate pair (real emoji)", () => {
    expect(sanitizePostgresText(`hi ${EMOJI} there`)).toBe(`hi ${EMOJI} there`);
  });

  it("leaves clean text untouched", () => {
    expect(sanitizePostgresText("plain ascii + café")).toBe(
      "plain ascii + café"
    );
  });
});

describe("sanitizePostgresJson", () => {
  it("deep-sanitizes strings, array items, and object keys while preserving shape", () => {
    const dirty = {
      name: `session${NUL}`,
      [`key${NUL}withNul`]: "value",
      events: [
        { data: `out${NUL}put`, ok: true },
        { data: `tail${LONE_HIGH_SURROGATE}`, count: 3 },
      ],
      nested: { deep: { s: `${NUL}x` } },
      keptNumber: 42,
      keptNull: null,
      keptBool: false,
    };

    const clean = sanitizePostgresJson(dirty);

    expect(clean.name).toBe("session");
    expect(Object.keys(clean)).toContain("keywithNul");
    expect((clean as Record<string, unknown>).keywithNul).toBe("value");
    expect(clean.events[0].data).toBe("output");
    expect(clean.events[0].ok).toBe(true);
    expect(clean.events[1].data).toBe(`tail${REPLACEMENT}`);
    expect(clean.events[1].count).toBe(3);
    expect(clean.nested.deep.s).toBe("x");
    expect(clean.keptNumber).toBe(42);
    expect(clean.keptNull).toBeNull();
    expect(clean.keptBool).toBe(false);
  });

  it("returns primitives unchanged", () => {
    expect(sanitizePostgresJson(7)).toBe(7);
    expect(sanitizePostgresJson(null)).toBeNull();
    expect(sanitizePostgresJson(true)).toBe(true);
  });

  it("preserves a literal __proto__ key as an own data property", () => {
    // JSON.parse creates `__proto__` as a real own property (unlike an object
    // literal, whose `__proto__:` sets the prototype). This mirrors how a
    // synced tool-output blob carrying that key arrives over the wire. A plain
    // assignment into `{}` would hit Object.prototype's setter and drop it.
    const dirty: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"safe":"v"}'
    );
    const clean = sanitizePostgresJson(dirty) as Record<string, unknown>;

    expect(Object.hasOwn(clean, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(clean, "__proto__")?.value).toEqual({
      polluted: true,
    });
    // The sanitized object's prototype is untouched — the key is data, not a
    // prototype mutation.
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    expect(clean.safe).toBe("v");
  });

  it("throws PostgresJsonKeyCollisionError when two keys collapse to one via NUL (rejectKeyCollisions)", () => {
    // Two distinct keys that differ only by a NUL sanitize to the same key.
    // Without collision detection the later assignment silently overwrites the
    // earlier one, dropping a field before persistence.
    const dirty = {
      [`a${NUL}b`]: 1,
      ab: 2,
    };
    expect(() =>
      sanitizePostgresJson(dirty, { rejectKeyCollisions: true })
    ).toThrow(PostgresJsonKeyCollisionError);
  });

  it("throws PostgresJsonKeyCollisionError when keys differ only by a lone surrogate (rejectKeyCollisions)", () => {
    const dirty = {
      [`k${LONE_HIGH_SURROGATE}`]: 1,
      [`k${LONE_LOW_SURROGATE}`]: 2,
    };
    // Both keys sanitize to `k${REPLACEMENT}`, so they collide.
    expect(() =>
      sanitizePostgresJson(dirty, { rejectKeyCollisions: true })
    ).toThrow(PostgresJsonKeyCollisionError);
  });

  it("throws PostgresJsonKeyCollisionError on a collision in a nested object (rejectKeyCollisions)", () => {
    const dirty = {
      outer: {
        [`dup${NUL}`]: "first",
        dup: "second",
      },
    };
    expect(() =>
      sanitizePostgresJson(dirty, { rejectKeyCollisions: true })
    ).toThrow(PostgresJsonKeyCollisionError);
  });

  it("does NOT reject sanitized-key collisions by default (silent last-write-wins)", () => {
    // Default behavior is opt-out of collision rejection so the whole-payload
    // pass never rejects on a to-be-stripped field. The later value wins.
    const clean = sanitizePostgresJson({
      [`a${NUL}b`]: 1,
      ab: 2,
    }) as Record<string, unknown>;
    expect(clean).toEqual({ ab: 2 });
  });

  it("keeps distinct sanitized keys that do not collide (rejectKeyCollisions)", () => {
    const clean = sanitizePostgresJson(
      {
        [`a${NUL}`]: 1,
        [`b${NUL}`]: 2,
      },
      { rejectKeyCollisions: true }
    ) as Record<string, unknown>;
    expect(clean).toEqual({ a: 1, b: 2 });
  });

  it("throws PostgresJsonDepthExceededError on pathologically deep values", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 250; i += 1) {
      deep = { n: deep };
    }
    expect(() => sanitizePostgresJson(deep)).toThrow(
      PostgresJsonDepthExceededError
    );
  });

  it("sanitizes nested values up to the depth bound without throwing", () => {
    let deep: unknown = `leaf${NUL}`;
    for (let i = 0; i < 50; i += 1) {
      deep = { n: deep };
    }
    expect(() => sanitizePostgresJson(deep)).not.toThrow();
  });
});
