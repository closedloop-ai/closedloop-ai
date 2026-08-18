import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillAgentComponentSlug,
  branchSearchBody,
  uuidV7,
} from "./search-backfill-values";

/*
 * These three were unreachable from a test while they lived inside
 * backfill-search-documents.ts, whose every other helper needs a Postgres
 * transaction. They are also the parts most likely to be silently wrong: a
 * malformed UUID still inserts, and a slug that collapses two distinct
 * components still renders -- both fail quietly rather than loudly.
 */

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.useRealTimers();
});

describe("uuidV7", () => {
  it("emits the canonical 8-4-4-4-12 hyphenated form", () => {
    expect(uuidV7()).toMatch(UUID_SHAPE);
  });

  it("sets the version nibble to 7", () => {
    // Position 14 is the first nibble of the third group -- the version field.
    // A v4 here would still insert into a uuid column, so nothing downstream
    // would fail loudly if this regressed.
    for (let i = 0; i < 32; i++) {
      expect(uuidV7()[14]).toBe("7");
    }
  });

  it("sets the RFC-4122 variant bits to 10xx", () => {
    // Position 19 is the first nibble of the fourth group -- the variant field,
    // which must be one of 8/9/a/b.
    for (let i = 0; i < 32; i++) {
      expect("89ab").toContain(uuidV7()[19]);
    }
  });

  it("encodes the clock as a big-endian 48-bit prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const expected = Date.now().toString(16).padStart(12, "0");

    const id = uuidV7();

    // First 48 bits = first 12 hex chars = groups one and two.
    expect(id.slice(0, 8) + id.slice(9, 13)).toBe(expected);
  });

  it("stays time-ordered as the clock advances", () => {
    // The whole reason for v7 over v4: a time-ordered prefix keeps the
    // primary-key B-tree append-mostly as the projection grows.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const earlier = uuidV7();
    vi.setSystemTime(new Date("2026-08-08T12:00:01.000Z"));
    const later = uuidV7();

    expect(earlier < later).toBe(true);
  });

  it("handles a timestamp above 32 bits without truncating", () => {
    // Date.now() exceeded 2^32 ms in 1970+49 days; the loop uses division and
    // modulo rather than bitwise ops precisely so this does not wrap.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2286-11-20T17:46:40.000Z"));

    const id = uuidV7();

    expect(id).toMatch(UUID_SHAPE);
    expect(id.slice(0, 8) + id.slice(9, 13)).toBe(
      Date.now().toString(16).padStart(12, "0")
    );
  });

  it("does not repeat within a single millisecond", () => {
    // 74 random bits carry uniqueness when the timestamp prefix is identical.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));

    const ids = new Set(Array.from({ length: 500 }, () => uuidV7()));

    expect(ids.size).toBe(500);
  });
});

describe("branchSearchBody", () => {
  it("joins the repo and base branch with a space", () => {
    expect(branchSearchBody("acme/widgets", "main")).toBe("acme/widgets main");
  });

  it("keeps the repo alone when there is no base branch", () => {
    expect(branchSearchBody("acme/widgets", null)).toBe("acme/widgets");
  });

  it("drops an empty base branch rather than leaving a trailing space", () => {
    expect(branchSearchBody("acme/widgets", "")).toBe("acme/widgets");
  });

  it("returns null -- not an empty string -- when nothing is searchable", () => {
    // The projection must store SQL NULL here. An empty string would be an
    // indexed, matchable body that means nothing.
    expect(branchSearchBody("", null)).toBeNull();
    expect(branchSearchBody("", "")).toBeNull();
  });
});

describe("backfillAgentComponentSlug", () => {
  it("keys on the content hash so same-named components stay DISTINCT", () => {
    // FEA-4335: identity is the content byte hash. Two components that share a
    // name but differ in bytes must resolve to different detail pages;
    // collapsing them is the bug this branch exists to prevent.
    const first = backfillAgentComponentSlug(
      "skill",
      "deploy",
      "Deploy",
      "hash-aaa"
    );
    const second = backfillAgentComponentSlug(
      "skill",
      "deploy",
      "Deploy",
      "hash-bbb"
    );

    expect(first).toBe("skill::hash-aaa");
    expect(second).toBe("skill::hash-bbb");
    expect(first).not.toBe(second);
  });

  it("gives byte-identical components the SAME slug regardless of name", () => {
    // The converse half of the same rule: same hash ⇒ one tracked component,
    // even when installed under a different name or key.
    expect(
      backfillAgentComponentSlug("skill", "deploy", "Deploy", "hash-aaa")
    ).toBe(backfillAgentComponentSlug("skill", "other", "Other", "hash-aaa"));
  });

  it("falls back to the name-level slug for a hash-less legacy row", () => {
    const slug = backfillAgentComponentSlug("skill", "deploy", "Deploy", null);

    expect(slug).not.toBeNull();
    expect(slug).not.toContain("hash");
    // Legacy rows collapse under the name-only identity so they still render
    // exactly once.
    expect(slug).toBe(
      backfillAgentComponentSlug("skill", "deploy", "Deploy", null)
    );
  });

  it("returns null for a legacy row with no usable identity", () => {
    // A null slug renders as a non-link rather than a broken detail route.
    expect(backfillAgentComponentSlug("skill", null, null, null)).toBeNull();
  });

  it("prefers the hash even when the name-level identity is empty", () => {
    // Without the hash this row would be a non-link; with it, it routes.
    expect(backfillAgentComponentSlug("skill", null, null, "hash-ccc")).toBe(
      "skill::hash-ccc"
    );
  });
});
