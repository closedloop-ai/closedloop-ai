/**
 * Unit tests for the tamper-evident audit ledger core (FEA-3856).
 *
 * These are pure/in-memory: they exercise the hashing, canonical-JSON, and
 * chain-verification primitives without a database. The DB-backed
 * `verifyChain(orgId)` read and the append-only trigger are proven separately
 * in the integration suite (__tests__/integration/audit-ledger.test.ts).
 *
 * Coverage:
 *   - canonical-JSON determinism (key-order independence, nesting, arrays)
 *   - genesis hash (prevHash = 32 zero bytes) is stable and deterministic
 *   - verifyChainRows passes on a hand-built valid chain
 *   - tamper detection: mutating a historic row's detail/action/actor is caught
 *   - broken-link and sequence-gap detection
 */
import { randomUUID } from "node:crypto";
import {
  AUDIT_GENESIS_PREV_HASH,
  AuditActorType,
} from "@repo/api/src/types/audit";
import { describe, expect, it } from "vitest";
import {
  type AuditEntryRow,
  auditLedgerService,
  canonicalJson,
  computeHash,
  VerifyBreakReason,
  verifyChainRows,
} from "../audit-ledger-service";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

type SeedEntry = {
  action: string;
  actorType: AuditActorType;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: unknown;
  createdAt: Date;
};

/**
 * Build a valid chain in memory, mirroring the Slice 1b append path: monotonic
 * `seq` from 1, each `prevHash` = predecessor's `hash`, genesis for the first.
 */
function buildChain(
  organizationId: string,
  entries: readonly SeedEntry[]
): AuditEntryRow[] {
  const rows: AuditEntryRow[] = [];
  let seq = 1n;
  let prevHash = AUDIT_GENESIS_PREV_HASH;
  for (const entry of entries) {
    const hash = computeHash({
      organizationId,
      seq,
      createdAt: entry.createdAt,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId,
      objectType: entry.objectType,
      objectId: entry.objectId,
      detail: entry.detail,
      prevHash,
    });
    rows.push({
      organizationId,
      seq,
      hash,
      prevHash,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId,
      objectType: entry.objectType,
      objectId: entry.objectId,
      detail: entry.detail,
      createdAt: entry.createdAt,
    });
    seq += 1n;
    prevHash = hash;
  }
  return rows;
}

function sampleEntries(): SeedEntry[] {
  const userId = randomUUID();
  return [
    {
      action: "document.created",
      actorType: AuditActorType.User,
      actorId: userId,
      objectType: "document",
      objectId: randomUUID(),
      detail: { status: "DRAFT", title: "PRD" },
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
    },
    {
      action: "document.status_changed",
      actorType: AuditActorType.User,
      actorId: userId,
      objectType: "document",
      objectId: randomUUID(),
      detail: { from: "DRAFT", to: "IN_REVIEW" },
      createdAt: new Date("2026-07-22T10:05:00.000Z"),
    },
    {
      action: "loop.completed",
      actorType: AuditActorType.System,
      actorId: null,
      objectType: "loop",
      objectId: randomUUID(),
      detail: { outcome: "success", nested: { a: 1, b: [3, 2, 1] } },
      createdAt: new Date("2026-07-22T10:10:00.000Z"),
    },
  ];
}

describe("canonicalJson", () => {
  it("is independent of key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts keys recursively in nested objects", () => {
    const a = canonicalJson({ outer: { z: 1, y: { d: 4, c: 3 } }, alpha: 1 });
    const b = canonicalJson({ alpha: 1, outer: { y: { c: 3, d: 4 }, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"alpha":1,"outer":{"y":{"c":3,"d":4},"z":1}}');
  });

  it("preserves array order (arrays are ordered, not sorted)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ list: [{ b: 1, a: 2 }] })).toBe(
      '{"list":[{"a":2,"b":1}]}'
    );
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });

  it("preserves an own-enumerable __proto__ key (no collision)", () => {
    // JSON.parse produces `__proto__` as an own enumerable key. A serializer
    // that rebuilds objects via `result[key] = …` would silently drop it (the
    // bracket assignment targets the prototype slot), collapsing distinct
    // payloads to the same string and defeating tamper detection.
    const withProto = JSON.parse('{"__proto__":{"a":1},"b":2}');
    const without = { b: 2 };
    expect(canonicalJson(withProto)).not.toBe(canonicalJson(without));
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"a":1},"b":2}');
  });
});

describe("computeHash", () => {
  const base = {
    organizationId: ORG_ID,
    seq: 1n,
    createdAt: new Date("2026-07-22T10:00:00.000Z"),
    action: "document.created",
    actorType: AuditActorType.User,
    actorId: "22222222-2222-4222-8222-222222222222",
    objectType: "document",
    objectId: "33333333-3333-4333-8333-333333333333",
    detail: { a: 1, b: 2 },
    prevHash: AUDIT_GENESIS_PREV_HASH,
  };

  it("is a 64-char lowercase hex SHA-256 digest", () => {
    const hash = computeHash(base);
    expect(hash).toMatch(SHA256_HEX_PATTERN);
  });

  it("is deterministic for identical input", () => {
    expect(computeHash(base)).toBe(computeHash({ ...base }));
  });

  it("is independent of detail key order (via canonical JSON)", () => {
    const reordered = { ...base, detail: { b: 2, a: 1 } };
    expect(computeHash(base)).toBe(computeHash(reordered));
  });

  it("changes when any hashed field changes", () => {
    const original = computeHash(base);
    expect(computeHash({ ...base, seq: 2n })).not.toBe(original);
    expect(computeHash({ ...base, action: "document.deleted" })).not.toBe(
      original
    );
    expect(computeHash({ ...base, actorType: AuditActorType.System })).not.toBe(
      original
    );
    expect(computeHash({ ...base, actorId: null })).not.toBe(original);
    expect(computeHash({ ...base, objectType: "loop" })).not.toBe(original);
    expect(computeHash({ ...base, objectId: randomUUID() })).not.toBe(original);
    expect(computeHash({ ...base, detail: { a: 1, b: 3 } })).not.toBe(original);
    expect(computeHash({ ...base, prevHash: "f".repeat(64) })).not.toBe(
      original
    );
    expect(
      computeHash({ ...base, createdAt: new Date("2026-07-22T10:00:01.000Z") })
    ).not.toBe(original);
  });

  it("cannot be forged by shifting a field boundary", () => {
    // ("ab","c") vs ("a","bc") for adjacent fields must not collide.
    const left = computeHash({ ...base, action: "ab", objectId: "c" });
    const right = computeHash({ ...base, action: "a", objectId: "bc" });
    expect(left).not.toBe(right);
  });
});

describe("genesis entry", () => {
  it("uses the 32-zero-byte prevHash sentinel", () => {
    expect(AUDIT_GENESIS_PREV_HASH).toBe("0".repeat(64));
    expect(AUDIT_GENESIS_PREV_HASH).toHaveLength(64);
  });

  it("produces a deterministic genesis hash and verifies as a one-row chain", () => {
    const [row] = buildChain(ORG_ID, sampleEntries().slice(0, 1));
    expect(row.seq).toBe(1n);
    expect(row.prevHash).toBe(AUDIT_GENESIS_PREV_HASH);
    expect(verifyChainRows([row])).toEqual({ ok: true });
  });

  it("verifies an empty chain trivially", () => {
    expect(verifyChainRows([])).toEqual({ ok: true });
  });
});

describe("verifyChainRows — happy path", () => {
  it("passes on a valid multi-row chain", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    expect(verifyChainRows(rows)).toEqual({ ok: true });
  });

  it("is exposed on the service object", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    expect(auditLedgerService.verifyChainRows(rows)).toEqual({ ok: true });
  });
});

describe("verifyChainRows — tamper detection", () => {
  it("detects a mutated historic detail (hash mismatch at that row)", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    // Mutate row 2's detail without recomputing its hash — exactly what a
    // direct SQL UPDATE (bypassing the append-only trigger) would do.
    const tampered = rows.map((row, index) =>
      index === 1 ? { ...row, detail: { from: "DRAFT", to: "APPROVED" } } : row
    );
    expect(verifyChainRows(tampered)).toEqual({
      ok: false,
      brokenAtSeq: 2n,
      reason: VerifyBreakReason.HashMismatch,
    });
  });

  it("detects a mutated action on the genesis row", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    const tampered = rows.map((row, index) =>
      index === 0 ? { ...row, action: "document.deleted" } : row
    );
    expect(verifyChainRows(tampered)).toEqual({
      ok: false,
      brokenAtSeq: 1n,
      reason: VerifyBreakReason.HashMismatch,
    });
  });

  it("detects a re-attributed actor", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    const tampered = rows.map((row, index) =>
      index === 2 ? { ...row, actorId: randomUUID() } : row
    );
    expect(verifyChainRows(tampered)).toEqual({
      ok: false,
      brokenAtSeq: 3n,
      reason: VerifyBreakReason.HashMismatch,
    });
  });

  it("detects a re-attributed actorType (system → user) without recomputed hash", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    // seq=3 was authored by System (actorId null); flipping it to User leaves
    // the stored hash stale now that actorType participates in the digest.
    const tampered = rows.map((row, index) =>
      index === 2 ? { ...row, actorType: AuditActorType.User } : row
    );
    expect(verifyChainRows(tampered)).toEqual({
      ok: false,
      brokenAtSeq: 3n,
      reason: VerifyBreakReason.HashMismatch,
    });
  });

  it("detects a re-targeted objectType without recomputed hash", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    const tampered = rows.map((row, index) =>
      index === 0 ? { ...row, objectType: "loop" } : row
    );
    expect(verifyChainRows(tampered)).toEqual({
      ok: false,
      brokenAtSeq: 1n,
      reason: VerifyBreakReason.HashMismatch,
    });
  });

  it("detects a broken link when a row's prevHash is rewritten", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    const tampered = rows.map((row, index) =>
      index === 1 ? { ...row, prevHash: "a".repeat(64) } : row
    );
    const result = verifyChainRows(tampered);
    expect(result).toEqual({
      ok: false,
      brokenAtSeq: 2n,
      reason: VerifyBreakReason.BrokenLink,
    });
  });

  it("detects a deleted middle row as a sequence gap", () => {
    const rows = buildChain(ORG_ID, sampleEntries());
    // Drop seq=2 → the row now at index 1 has seq=3, breaking contiguity.
    const withGap = [rows[0], rows[2]];
    expect(verifyChainRows(withGap)).toEqual({
      ok: false,
      brokenAtSeq: 3n,
      reason: VerifyBreakReason.SequenceGap,
    });
  });
});
