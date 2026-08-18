/**
 * FEA-3982 — org-level fingerprint identity + version-keyed usage attribution.
 *
 * These exercise `mergeComponentRows` (the org dedup), `foldFkUsageIntoMerged`
 * (the FK-linked usage fold), and `foldOrphanUsageIntoMerged` (the null-FK usage
 * fold) directly, and assert the bucketing BEHAVIOR the version-by-fingerprint
 * identity change is responsible for:
 *  - two same-named components with DIFFERENT `contentHash` produce TWO distinct
 *    merged rows carrying distinct fingerprints (they do NOT collide);
 *  - two rows with the SAME name + SAME `contentHash` (e.g. the same version
 *    observed on two devices) dedupe to ONE row that folds both compute targets;
 *  - a hash-less legacy/event-minted row still renders exactly ONCE under the
 *    name-only identity (version-skew safe), with no fingerprint to badge;
 *  - (wongk decision) usage — FK-linked OR orphaned — carrying a
 *    `componentVersionHash` attributes to the MATCHING version bucket, NOT to the
 *    inventory row that currently holds the FK and NOT to a catch-all unversioned
 *    bucket. A device that moved hash A→B keeps its historical A sessions on A;
 *  - usage that carries NO resolvable version hash stays on the name-level bucket
 *    (skew-safe);
 *  - the linked `definitionHash` is preferred over the coarse `componentVersionHash`
 *    so usage and inventory bucket on the same exact fingerprint once linked;
 *  - the derived Source label + short fingerprint helpers behave.
 */

import {
  AgentComponentKind,
  SourceType,
} from "@repo/api/src/types/agent-component";
import {
  encodeComponentSlug,
  fingerprintIdentityKey,
  resolveVersionFingerprint,
  shortFingerprint,
  usageVersionIdentityKey,
} from "@repo/api/src/types/agent-component-analytics";
import { describe, expect, it } from "vitest";
import {
  buildInventorySlugById,
  displaySource,
  foldFkUsageIntoMerged,
  foldOrphanUsageIntoMerged,
  mergeComponentRows,
  type OrphanUsageRow,
  resolveDetailSourceProjection,
  resolveDetailSourceType,
  resolveMergedSource,
  resolveMergedSourceType,
  resolveOrphanSourceType,
  type UsageGroupRow,
} from "../identity";
import { inventoryRow, MAX_ROWS, orphanUsage } from "./identity-test-fixtures";

const HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// An exact provenance-free fingerprint (definitionHash) HASH_A links to.
const DEF_A =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function usageGroup(overrides: Partial<UsageGroupRow>): UsageGroupRow {
  return {
    agentComponentId: overrides.agentComponentId ?? "row-1",
    // ISS-4630: the usage row's own identity. Defaults to null so cases that
    // don't set it exercise the FK'd-inventory-row slug fallback (`slugById`);
    // cases that set it exercise the own-`(kind, key)` attribution.
    componentKind: overrides.componentKind ?? null,
    componentKey: overrides.componentKey ?? null,
    agentSessionId: overrides.agentSessionId ?? "session-1",
    gitBranch: overrides.gitBranch ?? "",
    harness: overrides.harness ?? "claude",
    componentVersionHash: overrides.componentVersionHash ?? null,
    definitionHash: overrides.definitionHash ?? null,
    _sum: overrides._sum ?? { invocationCount: 1, errorCount: 0 },
    _max: overrides._max ?? {
      lastInvokedAt: new Date("2026-01-06T00:00:00.000Z"),
    },
  };
}

const SLUG = encodeComponentSlug("skill", "code-review", "code-review");

describe("fingerprintIdentityKey", () => {
  it("appends the fingerprint when present and stays name-only when absent", () => {
    expect(fingerprintIdentityKey("skill::code-review", HASH_A)).toBe(
      `skill::code-review@${HASH_A}`
    );
    expect(fingerprintIdentityKey("skill::code-review", null)).toBe(
      "skill::code-review"
    );
  });
});

describe("resolveVersionFingerprint", () => {
  it("prefers the linked definitionHash over the coarse contentHash", () => {
    expect(resolveVersionFingerprint(HASH_A, HASH_B)).toBe(HASH_B);
    expect(resolveVersionFingerprint(HASH_A, null)).toBe(HASH_A);
    expect(resolveVersionFingerprint(null, null)).toBeNull();
  });
});

describe("usageVersionIdentityKey", () => {
  it("keys usage on the linked definitionHash, else the coarse hash, else name-only", () => {
    // Linked → exact fingerprint bucket.
    expect(usageVersionIdentityKey(SLUG, HASH_A, DEF_A)).toBe(
      fingerprintIdentityKey(SLUG, DEF_A)
    );
    // Unlinked → coarse componentVersionHash bucket.
    expect(usageVersionIdentityKey(SLUG, HASH_A, null)).toBe(
      fingerprintIdentityKey(SLUG, HASH_A)
    );
    // Neither → name-level bucket (skew-safe).
    expect(usageVersionIdentityKey(SLUG, null, null)).toBe(SLUG);
  });
});

describe("shortFingerprint", () => {
  it("returns the first 8 hex chars, or null for a hash-less row", () => {
    expect(shortFingerprint(HASH_A)).toBe("aaaaaaaa");
    expect(shortFingerprint(null)).toBeNull();
  });
});

describe("mergeComponentRows — fingerprint identity", () => {
  it("splits two same-named components with different content hashes into two versioned rows", () => {
    const rows = [
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
      inventoryRow({
        id: "row-b",
        contentHash: HASH_B,
        computeTargetId: "target-2",
      }),
    ];

    const merged = mergeComponentRows(rows);

    expect(merged.size).toBe(2);
    const entryA = merged.get(fingerprintIdentityKey(SLUG, HASH_A));
    const entryB = merged.get(fingerprintIdentityKey(SLUG, HASH_B));
    expect(entryA?.versionFingerprint).toBe(HASH_A);
    expect(entryB?.versionFingerprint).toBe(HASH_B);
    // Same name/slug, distinct fingerprints — the surface can tell them apart.
    expect(entryA?.slug).toBe(entryB?.slug);
    expect(entryA?.versionFingerprint).not.toBe(entryB?.versionFingerprint);
    // FEA-4335: the routable detail key is content-hash-based, so two
    // same-named-different-bytes components get DISTINCT detail URIs even though
    // they share the name-level `slug`.
    expect(entryA?.routableKey).toBe(`skill::${HASH_A}`);
    expect(entryB?.routableKey).toBe(`skill::${HASH_B}`);
    expect(entryA?.routableKey).not.toBe(entryB?.routableKey);
  });

  it("FEA-4335: a hash-less row falls the routable key back to the name-level slug (skew-safe)", () => {
    const merged = mergeComponentRows([
      inventoryRow({ id: "row-a", contentHash: null }),
    ]);
    const [entry] = [...merged.values()];
    expect(entry.versionFingerprint).toBeNull();
    // No content fingerprint → name-level slug so legacy links still resolve.
    expect(entry.routableKey).toBe(SLUG);
  });

  it("seeds the bucket on the linked definitionHash, preferring it over contentHash", () => {
    const rows = [
      inventoryRow({ id: "row-a", contentHash: HASH_A, definitionHash: DEF_A }),
    ];

    const merged = mergeComponentRows(rows);

    expect(merged.size).toBe(1);
    // Bucketed on the exact fingerprint, not the coarse contentHash.
    expect(merged.get(fingerprintIdentityKey(SLUG, DEF_A))).toBeDefined();
    expect(merged.get(fingerprintIdentityKey(SLUG, HASH_A))).toBeUndefined();
    const [entry] = [...merged.values()];
    expect(entry.versionFingerprint).toBe(DEF_A);
  });

  it("dedupes the same version observed on two devices into one row folding both compute targets", () => {
    const rows = [
      inventoryRow({ id: "row-a", contentHash: HASH_A, computeTargetId: "t1" }),
      inventoryRow({ id: "row-b", contentHash: HASH_A, computeTargetId: "t2" }),
    ];

    const merged = mergeComponentRows(rows);

    expect(merged.size).toBe(1);
    const [entry] = [...merged.values()];
    expect(entry.versionFingerprint).toBe(HASH_A);
    expect([...entry.computeTargetIds].sort()).toEqual(["t1", "t2"]);
  });

  it("FEA-4247: tracks the observing user id for a normal row (owner-fallback source)", () => {
    const rows = [
      inventoryRow({
        id: "row-a",
        contentHash: null,
        computeTarget: { id: "t1", userId: "user-42" },
      }),
    ];

    const merged = mergeComponentRows(rows);

    const [entry] = [...merged.values()];
    expect(entry.computeTargetUserIds).toEqual(["user-42"]);
  });

  it("FEA-4247: excludes a cloud-authored (sentinel-owned) row's user from the owner fallback", () => {
    // The sentinel's userId is the org's earliest active user, NOT the creator,
    // so a cloud-authored row must not seed the owner fallback with it.
    const rows = [
      inventoryRow({
        id: "row-cloud",
        contentHash: null,
        computeTargetId: "sentinel-org-1",
        metadata: { cloudAuthored: true, source: "org_custom" },
        computeTarget: { id: "sentinel-org-1", userId: "sentinel-owner" },
      }),
    ];

    const merged = mergeComponentRows(rows);

    const [entry] = [...merged.values()];
    // No fallback user tracked — the row surfaces an honest-empty author set.
    expect(entry.computeTargetUserIds).toEqual([]);
    // The device provenance is still recorded (unchanged behavior).
    expect(entry.computeTargetIds).toEqual(["sentinel-org-1"]);
  });

  it("renders a hash-less legacy row exactly once under the name-only identity (skew-safe), with no fingerprint", () => {
    const rows = [
      inventoryRow({ id: "row-a", contentHash: null, computeTargetId: "t1" }),
      inventoryRow({ id: "row-b", contentHash: null, computeTargetId: "t2" }),
    ];

    const merged = mergeComponentRows(rows);

    expect(merged.size).toBe(1);
    const entry = merged.get(fingerprintIdentityKey(SLUG, null));
    expect(entry?.versionFingerprint).toBeNull();
    expect([...(entry?.computeTargetIds ?? [])].sort()).toEqual(["t1", "t2"]);
  });

  it("keeps a hash-less row separate from a fingerprinted row of the same name", () => {
    const rows = [
      inventoryRow({ id: "row-legacy", contentHash: null }),
      inventoryRow({ id: "row-hashed", contentHash: HASH_A }),
    ];

    const merged = mergeComponentRows(rows);

    // One name-only bucket + one fingerprinted bucket = two rows.
    expect(merged.size).toBe(2);
  });
});

describe("buildInventorySlugById", () => {
  it("maps each inventory row id to its name-level slug", () => {
    const slugById = buildInventorySlugById([
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
      inventoryRow({ id: "row-b", contentHash: HASH_B }),
    ]);
    expect(slugById.get("row-a")).toBe(SLUG);
    expect(slugById.get("row-b")).toBe(SLUG);
  });
});

describe("foldFkUsageIntoMerged — version-keyed FK attribution (wongk)", () => {
  it("attributes FK usage by its OWN carried hash, not the inventory row currently holding the FK", () => {
    // One shared inventory row that now reads HASH_B, but historical usage on it
    // carried HASH_A. The A usage must land on the A bucket, not B.
    const rows = [
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
      inventoryRow({
        id: "row-b",
        contentHash: HASH_B,
        computeTargetId: "t2",
      }),
    ];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);

    // The device moved to HASH_B (row-b holds the current FK), but the session
    // that ran BEFORE the move carried HASH_A.
    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-b",
        [
          usageGroup({
            agentComponentId: "row-b",
            agentSessionId: "old-session",
            componentVersionHash: HASH_A,
            _sum: { invocationCount: 5, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    // The A bucket got the historical A session; the current B bucket did NOT.
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_A))?.totalInvocations
    ).toBe(5);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_B))?.totalInvocations
    ).toBe(0);
  });

  it("prefers the linked definitionHash so FK usage lands in the same bucket inventory seeded", () => {
    const rows = [
      inventoryRow({ id: "row-a", contentHash: HASH_A, definitionHash: DEF_A }),
    ];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);

    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-a",
        [
          usageGroup({
            agentComponentId: "row-a",
            componentVersionHash: HASH_A,
            definitionHash: DEF_A,
            _sum: { invocationCount: 4, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    // Both seeded on DEF_A → the usage folds into the single seeded bucket.
    expect(merged.size).toBe(1);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, DEF_A))?.totalInvocations
    ).toBe(4);
  });

  it("folds hash-less FK usage into the name-level bucket (skew-safe)", () => {
    const rows = [inventoryRow({ id: "row-a", contentHash: null })];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);

    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-a",
        [
          usageGroup({
            agentComponentId: "row-a",
            componentVersionHash: null,
            _sum: { invocationCount: 2, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    expect(merged.size).toBe(1);
    expect(merged.get(SLUG)?.totalInvocations).toBe(2);
  });

  it("ISS-4630: attributes FK usage by its OWN (kind, key), not the FK'd inventory row's slug", () => {
    // The usage is FK-linked to `row-a` (a `code-review` skill), but the usage
    // row's OWN identity is a DIFFERENT skill (`other-skill`) — the divergence the
    // detail read never got wrong (it attributes by the usage row's own key). The
    // fold must credit `other-skill`, not `code-review`.
    const rows = [inventoryRow({ id: "row-a", contentHash: null })];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);
    const otherSlug = encodeComponentSlug(
      "skill",
      "other-skill",
      "other-skill"
    );

    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-a",
        [
          usageGroup({
            agentComponentId: "row-a",
            componentKind: "skill",
            componentKey: "other-skill",
            componentVersionHash: null,
            _sum: { invocationCount: 6, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    // The usage landed on its OWN identity, NOT the FK'd inventory row's slug.
    expect(merged.get(otherSlug)?.totalInvocations).toBe(6);
    // `code-review` (the FK'd inventory row) was NOT credited the mismatched usage.
    expect(merged.get(SLUG)?.totalInvocations ?? 0).toBe(0);
  });

  it("ISS-4630: attributes FK usage whose inventory row is OUTSIDE the working set (no slugById entry) by its own (kind, key)", () => {
    // The usage's FK'd inventory row (`row-uninstalled`) is not in the merged/
    // slugById working set (uninstalled or dropped tail). Before the fix this
    // usage was skipped (no slug) and the list under-counted to 0 while detail —
    // reading by the usage row's own (kind, key) — still counted it. Now the fold
    // recovers it via the usage row's own identity.
    const rows = [inventoryRow({ id: "row-a", contentHash: null })];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);

    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-uninstalled",
        [
          usageGroup({
            agentComponentId: "row-uninstalled",
            componentKind: "skill",
            componentKey: "code-review",
            componentVersionHash: null,
            _sum: { invocationCount: 3, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    // Recovered onto the `code-review` family even though its FK'd inventory row
    // was outside the working set.
    expect(merged.get(SLUG)?.totalInvocations).toBe(3);
  });

  it("ISS-4630: falls back to the FK'd inventory row's slug when the usage group carries no own (kind, key)", () => {
    // A legacy group shape with no own identity (componentKind/componentKey null).
    // The fold must still credit it via the FK'd inventory row's slug (`slugById`).
    const rows = [inventoryRow({ id: "row-a", contentHash: null })];
    const merged = mergeComponentRows(rows);
    const slugById = buildInventorySlugById(rows);

    const usageByComponentId = new Map<string, UsageGroupRow[]>([
      [
        "row-a",
        [
          usageGroup({
            agentComponentId: "row-a",
            componentKind: null,
            componentKey: null,
            componentVersionHash: null,
            _sum: { invocationCount: 4, errorCount: 0 },
          }),
        ],
      ],
    ]);

    foldFkUsageIntoMerged(merged, slugById, usageByComponentId, MAX_ROWS);

    expect(merged.get(SLUG)?.totalInvocations).toBe(4);
  });
});

describe("foldOrphanUsageIntoMerged — version-keyed orphan attribution (wongk)", () => {
  it("folds orphan usage carrying a hash into the MATCHING version bucket, not an arbitrary or unversioned one", () => {
    // A name owns two fingerprinted inventory rows. Orphan (null-FK) usage that
    // carried HASH_A must land ON the HASH_A bucket — the version it ran against.
    const merged = mergeComponentRows([
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
      inventoryRow({
        id: "row-b",
        contentHash: HASH_B,
        computeTargetId: "target-2",
      }),
    ]);
    expect(merged.size).toBe(2);

    foldOrphanUsageIntoMerged(
      merged,
      [orphanUsage({ invocationCount: 3, componentVersionHash: HASH_A })],
      MAX_ROWS
    );

    // No new bucket — it folded into the existing HASH_A version bucket.
    expect(merged.size).toBe(2);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_A))?.totalInvocations
    ).toBe(3);
    // HASH_B's counts did NOT move.
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_B))?.totalInvocations
    ).toBe(0);
  });

  it("prefers the orphan's linked definitionHash over its coarse hash", () => {
    const merged = mergeComponentRows([
      inventoryRow({ id: "row-a", contentHash: HASH_A, definitionHash: DEF_A }),
    ]);

    foldOrphanUsageIntoMerged(
      merged,
      [
        orphanUsage({
          invocationCount: 2,
          componentVersionHash: HASH_A,
          definitionHash: DEF_A,
        }),
      ],
      MAX_ROWS
    );

    expect(merged.size).toBe(1);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, DEF_A))?.totalInvocations
    ).toBe(2);
  });

  it("keeps hash-less orphan usage on the name-level bucket (skew-safe), deterministic regardless of inventory ordering", () => {
    // Same inputs, opposite inventory order. A version-agnostic (hash-less) orphan
    // always lands in the same name-level bucket — never drifts between versions.
    const forward = mergeComponentRows([
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
      inventoryRow({ id: "row-b", contentHash: HASH_B, computeTargetId: "t2" }),
    ]);
    const reverse = mergeComponentRows([
      inventoryRow({ id: "row-b", contentHash: HASH_B, computeTargetId: "t2" }),
      inventoryRow({ id: "row-a", contentHash: HASH_A }),
    ]);
    foldOrphanUsageIntoMerged(
      forward,
      [orphanUsage({ invocationCount: 3, componentVersionHash: null })],
      MAX_ROWS
    );
    foldOrphanUsageIntoMerged(
      reverse,
      [orphanUsage({ invocationCount: 3, componentVersionHash: null })],
      MAX_ROWS
    );

    // Neither versioned bucket moved; the name-level bucket carries the usage.
    expect(forward.get(SLUG)?.totalInvocations).toBe(3);
    expect(reverse.get(SLUG)?.totalInvocations).toBe(3);
    expect(
      forward.get(fingerprintIdentityKey(SLUG, HASH_A))?.totalInvocations
    ).toBe(0);
    expect(
      reverse.get(fingerprintIdentityKey(SLUG, HASH_A))?.totalInvocations
    ).toBe(0);
  });

  it("synthesizes a versioned usage-only entry when no inventory bucket exists for the carried hash", () => {
    // No inventory at all — the orphan's carried hash seeds a synthetic entry
    // badged with that version.
    const merged = mergeComponentRows([]);
    foldOrphanUsageIntoMerged(
      merged,
      [
        orphanUsage({
          agentSessionId: "s1",
          invocationCount: 2,
          componentVersionHash: HASH_A,
        }),
        orphanUsage({
          agentSessionId: "s2",
          invocationCount: 4,
          componentVersionHash: HASH_A,
        }),
      ],
      MAX_ROWS
    );
    // Both orphan rows for the same name+hash collapse into ONE synthetic entry.
    expect(merged.size).toBe(1);
    const entry = merged.get(fingerprintIdentityKey(SLUG, HASH_A));
    expect(entry?.versionFingerprint).toBe(HASH_A);
    expect(entry?.totalInvocations).toBe(6);
    expect(entry?.sessionIds.size).toBe(2);
  });

  it("splits orphan usage of the same name across the versions it actually ran against", () => {
    const merged = mergeComponentRows([]);
    foldOrphanUsageIntoMerged(
      merged,
      [
        orphanUsage({
          agentSessionId: "s1",
          invocationCount: 2,
          componentVersionHash: HASH_A,
        }),
        orphanUsage({
          agentSessionId: "s2",
          invocationCount: 4,
          componentVersionHash: HASH_B,
        }),
      ],
      MAX_ROWS
    );
    expect(merged.size).toBe(2);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_A))?.totalInvocations
    ).toBe(2);
    expect(
      merged.get(fingerprintIdentityKey(SLUG, HASH_B))?.totalInvocations
    ).toBe(4);
  });
});

describe("version-identity keys-covered guard", () => {
  it("names every UsageGroupRow + OrphanUsageRow field so a new version field is a compile error, not a silent drop", () => {
    // FEA-3982 (wongk): the version fold routes on `componentVersionHash` +
    // `definitionHash`. If a new version-identity field is added to either usage
    // type but not to the fold, this typed keys map fails `tsc` (a missing key is
    // a type error) — surfacing it at compile time rather than as silently
    // mis-bucketed usage in production.
    const usageGroupKeys: Record<keyof UsageGroupRow, true> = {
      agentComponentId: true,
      // ISS-4630: the usage row's own (kind, key) identity the FK fold attributes
      // by (mirroring the detail read); a new identity field is a compile error.
      componentKind: true,
      componentKey: true,
      agentSessionId: true,
      gitBranch: true,
      harness: true,
      componentVersionHash: true,
      definitionHash: true,
      _sum: true,
      _max: true,
    };
    const orphanKeys: Record<keyof OrphanUsageRow, true> = {
      agentSessionId: true,
      componentKind: true,
      componentKey: true,
      harness: true,
      invocationCount: true,
      errorCount: true,
      firstInvokedAt: true,
      lastInvokedAt: true,
      componentVersionHash: true,
      definitionHash: true,
    };
    // Both version-identity fields are present on both usage contracts.
    expect(usageGroupKeys.componentVersionHash).toBe(true);
    expect(usageGroupKeys.definitionHash).toBe(true);
    expect(orphanKeys.componentVersionHash).toBe(true);
    expect(orphanKeys.definitionHash).toBe(true);
  });
});

describe("displaySource", () => {
  it("prefers sourceUrl, else the identity key (unchanged pre-FEA-3982 behavior)", () => {
    const [withUrl] = [
      ...mergeComponentRows([
        inventoryRow({ sourceUrl: "github.com/acme/repo" }),
      ]).values(),
    ];
    expect(displaySource(withUrl)).toBe("github.com/acme/repo");

    const [withoutUrl] = [
      ...mergeComponentRows([inventoryRow({ sourceUrl: null })]).values(),
    ];
    expect(displaySource(withoutUrl)).toBe("code-review");
  });
});

/**
 * FEA-4374: the cloud detail read hardcoded `sourceType: SourceType.Repo`, so a
 * pack-sourced component's detail always reported Repo and the web Install
 * action (gated on `isLocallyInstallable`, which needs Pack) never rendered.
 * These pin the derivation that fixed it, keeping it in parity with the
 * desktop-local reader's `toSourceType`.
 */
describe("resolveDetailSourceType", () => {
  const baseRow = {
    componentKind: AgentComponentKind.Skill,
    packId: null as string | null,
    scope: null as string | null,
    projectPath: null as string | null,
  };

  it("resolves Pack when the row carries a pack id — the installable case", () => {
    expect(resolveDetailSourceType({ ...baseRow, packId: "acme-pack" })).toBe(
      SourceType.Pack
    );
  });

  it("resolves Server for MCP tools regardless of pack id", () => {
    expect(
      resolveDetailSourceType({
        ...baseRow,
        componentKind: AgentComponentKind.Mcp,
        packId: "acme-pack",
      })
    ).toBe(SourceType.Server);
  });

  it("resolves Repo for a project-scoped / project-path row", () => {
    expect(resolveDetailSourceType({ ...baseRow, scope: "project" })).toBe(
      SourceType.Repo
    );
    expect(
      resolveDetailSourceType({ ...baseRow, projectPath: "/repo/.claude" })
    ).toBe(SourceType.Repo);
  });

  it("falls back to Local when no pack/repo provenance resolves", () => {
    expect(resolveDetailSourceType(baseRow)).toBe(SourceType.Local);
  });
});

describe("resolveMergedSourceType", () => {
  it("resolves Pack when any folded inventory version carried a pack id", () => {
    const [entry] = [
      ...mergeComponentRows([inventoryRow({ packId: "acme-pack" })]).values(),
    ];
    expect(resolveMergedSourceType(entry)).toBe(SourceType.Pack);
  });

  it("resolves Server for MCP-kind merged rows", () => {
    const [entry] = [
      ...mergeComponentRows([
        inventoryRow({ componentKind: AgentComponentKind.Mcp }),
      ]).values(),
    ];
    expect(resolveMergedSourceType(entry)).toBe(SourceType.Server);
  });

  it("keeps the pre-fix Repo default for a pack-less list row (no scope data folded)", () => {
    const [entry] = [
      ...mergeComponentRows([inventoryRow({ packId: null })]).values(),
    ];
    expect(resolveMergedSourceType(entry)).toBe(SourceType.Repo);
  });
});

/**
 * FEA-4374: `source` must be derived from the SAME selected pack id as
 * `sourceType`, mirroring the desktop-local reader's `pack_id`-first
 * `displaySource`. When the row is Pack-typed the web/desktop Install action
 * resolves the pack from `component.source` via `normalizePackId`, so a
 * Pack-typed row whose `source` is the repository URL (what the plain
 * `displaySource` prefers) would resolve the WRONG pack — these pin the fix.
 */
describe("resolveDetailSourceProjection", () => {
  const baseRow = {
    componentKind: AgentComponentKind.Skill,
    packId: null as string | null,
    scope: null as string | null,
    projectPath: null as string | null,
    sourceUrl: null as string | null,
  };

  it("returns Pack + the pack id (not the repo URL) for a pack-sourced row", () => {
    const { sourceType, source } = resolveDetailSourceProjection(
      [{ ...baseRow, packId: "acme-pack", sourceUrl: "github.com/acme/repo" }],
      "code-review"
    );
    expect(sourceType).toBe(SourceType.Pack);
    expect(source).toBe("acme-pack");
  });

  it("unions the pack id across version rows (canonical row lost provenance)", () => {
    // canonical (first) row is pack-less; an older sibling carries the pack id
    const { sourceType, source } = resolveDetailSourceProjection(
      [
        { ...baseRow, packId: null, sourceUrl: "github.com/acme/repo" },
        { ...baseRow, packId: "acme-pack" },
      ],
      "code-review"
    );
    expect(sourceType).toBe(SourceType.Pack);
    expect(source).toBe("acme-pack");
  });

  it("keeps Repo + sourceUrl for a project-scoped (pack-less) row", () => {
    const { sourceType, source } = resolveDetailSourceProjection(
      [{ ...baseRow, scope: "project", sourceUrl: "github.com/acme/repo" }],
      "code-review"
    );
    expect(sourceType).toBe(SourceType.Repo);
    expect(source).toBe("github.com/acme/repo");
  });

  it("falls back to the component key when a non-pack row has no sourceUrl", () => {
    const { source } = resolveDetailSourceProjection(
      [{ ...baseRow, scope: "project" }],
      "code-review"
    );
    expect(source).toBe("code-review");
  });
});

describe("resolveMergedSource", () => {
  it("returns the folded pack id (not the repo URL) for a Pack list row", () => {
    const [entry] = [
      ...mergeComponentRows([
        inventoryRow({
          packId: "acme-pack",
          sourceUrl: "github.com/acme/repo",
        }),
      ]).values(),
    ];
    expect(resolveMergedSource(entry)).toBe("acme-pack");
  });

  it("keeps the displaySource value (sourceUrl/key) for a pack-less list row", () => {
    const [entry] = [
      ...mergeComponentRows([
        inventoryRow({ packId: null, sourceUrl: "github.com/acme/repo" }),
      ]).values(),
    ];
    expect(resolveMergedSource(entry)).toBe("github.com/acme/repo");
  });
});

/**
 * FEA-4374: an orphan-only identity (usage rows, no inventory row —
 * `buildOrphanOnlyDetail`) previously hardcoded Repo, so an orphan MCP tool read
 * Server in the list but Repo in detail. `resolveOrphanSourceType` closes that
 * gap: MCP -> Server (parity with the list), everything else keeps Repo.
 */
describe("resolveOrphanSourceType", () => {
  it("resolves Server for an orphan MCP tool (list/detail taxonomy parity)", () => {
    expect(resolveOrphanSourceType(AgentComponentKind.Mcp)).toBe(
      SourceType.Server
    );
  });

  it("keeps the Repo default for a non-MCP orphan (no inventory provenance)", () => {
    expect(resolveOrphanSourceType(AgentComponentKind.Skill)).toBe(
      SourceType.Repo
    );
  });
});
