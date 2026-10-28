/** FEA-2923: Unit coverage for desktopComponentsSyncService. */
import { Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@/app/compute-targets/service", async () => {
  const { computeTargetsModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return computeTargetsModuleMock();
});

vi.mock("@repo/observability/log", async () => {
  const { logModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return logModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return telemetryModuleMock();
});

vi.mock("@/app/agent-sessions/service/component-invocations", async () => {
  const { componentInvocationsModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return componentInvocationsModuleMock();
});

vi.mock("@/app/definition-registry/service", async () => {
  const { definitionRegistryModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return definitionRegistryModuleMock();
});

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const { searchIndexModuleMock } = await import(
    "@/__tests__/support/desktop/components/sync/service.test-mocks"
  );
  return searchIndexModuleMock(
    await importOriginal<typeof import("@/app/search/search-index-service")>()
  );
});

import {
  buildComponent,
  buildInput,
  CLERK_USER_ID,
  COMPUTE_TARGET_ID,
  installOwnedTarget,
  ORG_ID,
  USER_ID,
} from "@/__tests__/support/desktop/components/sync/service.test-harness";
import { mocks } from "@/__tests__/support/desktop/components/sync/service.test-mocks";
import { agentComponentProjection } from "@/app/search/search-index-service";
import {
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTED_METRIC,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { componentIndexKeyProjectionGate } from "./component-index-key-telemetry";
import { desktopComponentsSyncService } from "./service";

describe("desktopComponentsSyncService.sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    componentIndexKeyProjectionGate.clear();
  });

  it("returns Result.err(Status.Forbidden) when the compute target is not owned (gate before any write)", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Numeric 403 — matches the route's `result.error === Status.Forbidden`
      // check and the reference agent-sessions sync service.
      expect(result.error).toBe(Status.Forbidden);
    }
    // No DB access should occur when the ownership gate fails.
    expect(mocks.withDb).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.relinkActiveForComputeTarget).not.toHaveBeenCalled();
  });

  it("passes the ownership gate args (id, org, user, clerkUser) straight through", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    expect(mocks.findOwnedById).toHaveBeenCalledWith(
      COMPUTE_TARGET_ID,
      ORG_ID,
      USER_ID,
      CLERK_USER_ID
    );
  });

  it("upserts each component keyed by (computeTargetId, componentKind, externalComponentId)", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const args = mocks.upsert.mock.calls[0]?.[0];
    expect(args?.where).toEqual({
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "skill",
        externalComponentId: "skill::my-skill",
      },
    });
  });

  it("maps the create payload fields and parses ISO dates into Date instances", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    const create = mocks.upsert.mock.calls[0]?.[0]?.create;
    expect(create).toMatchObject({
      organizationId: ORG_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      componentKind: "skill",
      externalComponentId: "skill::my-skill",
      harness: "claude",
      name: "My Skill",
      componentKey: "my-skill",
    });
    expect(create?.firstSeenAt).toBeInstanceOf(Date);
    expect(create?.firstSeenAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(create?.lastSeenAt).toBeInstanceOf(Date);
    expect(create?.lastSeenAt?.toISOString()).toBe("2026-01-10T00:00:00.000Z");
    // Absent/null dates parse to null.
    expect(create?.uninstalledAt).toBeNull();
  });

  it("AC-007: create defaults resolvedState to 'unresolved'; update omits it when the desktop does not send one", async () => {
    installOwnedTarget();

    // A label-minted component that carries no resolvedState (stale desktop, or
    // a brand-new label-only row) → create defaults to unresolved; update is a
    // no-op (undefined) so a resolved cloud row is never demoted.
    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const call = mocks.upsert.mock.calls[0]?.[0];
    expect(call?.create?.resolvedState).toBe("unresolved");
    expect(call?.update).toBeDefined();
    expect(call?.update?.resolvedState).toBeUndefined();
  });

  it("AC-007: a desktop-sent resolvedState is written on both create and update", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ resolvedState: "resolved" })])
    );
    const call = mocks.upsert.mock.calls[0]?.[0];
    expect(call?.create?.resolvedState).toBe("resolved");
    expect(call?.update?.resolvedState).toBe("resolved");
  });

  it("parses a null/undefined date field to null (parseDateField)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ firstSeenAt: null, lastSeenAt: undefined })])
    );

    const create = mocks.upsert.mock.calls[0]?.[0]?.create;
    expect(create?.firstSeenAt).toBeNull();
    expect(create?.lastSeenAt).toBeNull();
  });

  it("never puts organizationId or computeTargetId in the update payload (identity is fixed at create)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update).toBeDefined();
    expect(update).not.toHaveProperty("organizationId");
    expect(update).not.toHaveProperty("computeTargetId");
    // But it does refresh mutable fields like lastSeenAt.
    expect(update?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("leaves uninstalledAt untouched on the update path when the field is omitted (preserves a tombstone)", async () => {
    installOwnedTarget();

    // An older Desktop omits `uninstalledAt`. The update must be a no-op
    // (undefined), NOT a clear (null) — clearing would resurrect a removed
    // component in search on the next re-index. (FEA-4011 review.)
    const { uninstalledAt: _omit, ...withoutUninstalled } = buildComponent();
    await desktopComponentsSyncService.sync(
      buildInput([withoutUninstalled as never])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update).toBeDefined();
    expect(update?.uninstalledAt).toBeUndefined();
  });

  it("clears uninstalledAt on the update path only for an explicit null", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ uninstalledAt: null })])
    );

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update?.uninstalledAt).toBeNull();
  });

  it("sets uninstalledAt on the update path for an explicit date (tombstone)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ uninstalledAt: "2026-03-01T00:00:00.000Z" }),
      ])
    );

    const update = mocks.upsert.mock.calls[0]?.[0]?.update;
    expect(update?.uninstalledAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("issues one upsert per component in the batch", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ externalId: "skill::a", componentKey: "a" }),
        buildComponent({
          externalId: "command::b",
          componentKind: "command",
          componentKey: "b",
        }),
        buildComponent({
          externalId: "mcp::c",
          componentKind: "mcp",
          componentKey: "c",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    const kinds = mocks.upsert.mock.calls.map(
      (call) =>
        call[0]?.where?.computeTargetId_componentKind_externalComponentId
          ?.componentKind
    );
    expect(kinds).toEqual(["skill", "command", "mcp"]);
  });

  // FEA-2923: device rows must remain isolated from cloud sentinel rows by the
  // ownership-verified computeTargetId in the compound upsert key.
  it("keys every upsert on the ownership-verified device target, isolating it from cloud-sentinel rows", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        // A subagent whose external id would collide with a backfilled cloud
        // agent IF they shared a compute target — they must not.
        buildComponent({
          externalId: "cloud:agent:legacy-1",
          componentKind: "subagent",
          componentKey: "reviewer",
        }),
      ])
    );

    const key =
      mocks.upsert.mock.calls[0]?.[0]?.where
        ?.computeTargetId_componentKind_externalComponentId;
    // Device upsert uses the real device target id from the authenticated
    // request, not any sentinel — so a matching external id lands on a
    // different row than the cloud-owned one.
    expect(key?.computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(mocks.upsert.mock.calls[0]?.[0]?.create?.computeTargetId).toBe(
      COMPUTE_TARGET_ID
    );
  });

  // FEA-3321: infer format from installPath so non-Markdown definitions are not
  // mislabeled by the read path's `format ?? "md"` fallback.
  it("infers the version row's format from installPath (real extension wins)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: "hook",
          installPath: ".claude/hooks/guard.sh",
          content: "#!/bin/bash\necho hi",
          contentHash: "hash-hook-1",
        }),
      ])
    );

    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.create?.format).toBe("sh");
  });

  it("falls back to the kind's conventional format when installPath carries no extension", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: "mcp",
          installPath: null,
          content: '{"mcpServers":{}}',
          contentHash: "hash-mcp-1",
        }),
      ])
    );

    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.create?.format).toBe("json");
  });

  // The revision identity includes its content hash, so a row's format is fixed
  // at first observation — the update path only refreshes lastSeenAt, mirroring
  // the desktop collector's `ON CONFLICT DO UPDATE SET last_seen_at`.
  it("sets format on create only, never on the version update payload", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# My Skill",
          contentHash: "hash-skill-1",
        }),
      ])
    );

    // ISS-4662: the update payload is now EMPTY entirely — the observation
    // window is widened monotonically after the upsert so a stale observation
    // from one desktop cannot move an org-global row's window backward.
    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.update).not.toHaveProperty(
      "format"
    );
    expect(mocks.versionUpsert.mock.calls[0]?.[0]?.update).toEqual({});
  });

  // Keep large-inventory upserts bounded so they cannot drain the pg pool.
  it("bounds concurrent upserts so a large inventory can't exhaust the connection pool", async () => {
    mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });

    let inFlight = 0;
    let peakInFlight = 0;
    mocks.upsert.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield twice so overlapping upserts within a batch are observed as
      // concurrent before any of them settles.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return {};
    });
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ agentComponent: { upsert: mocks.upsert } })
    );

    // Sized off the bound, not hardcoded: the payload must always exceed
    // DB_FANOUT_MAX_CONCURRENCY or the assertion below would hold against an
    // unbounded fan-out too.
    const componentCount = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;
    const components = Array.from({ length: componentCount }, (_, i) =>
      buildComponent({ externalId: `skill::c${i}`, componentKey: `c${i}` })
    );

    await desktopComponentsSyncService.sync(buildInput(components));

    // Every component is still upserted...
    expect(mocks.upsert).toHaveBeenCalledTimes(componentCount);
    // ...but never more than DB_FANOUT_MAX_CONCURRENCY at once. An unbounded
    // fan-out would peak at componentCount.
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
  });

  // FEA-3290: exact DefinitionVersion registration and linkage.

  it("registers a DefinitionVersion for a content-bearing component and stamps definitionVersionId onto the version row", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# My Skill",
          contentHash: "hash-skill-1",
          installPath: ".claude/skills/my-skill/SKILL.md",
          scannedAt: "2026-01-11T00:00:00.000Z",
        }),
      ])
    );

    // The registry writer was called with the authenticated org + target, the
    // whole-file content, and the scan timestamp (never from the payload's org).
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledTimes(1);
    const [tx, regArgs] = mocks.registerDefinitionVersion.mock.calls[0] ?? [];
    expect(tx).toBeDefined(); // ran inside the withDb tx client
    expect(regArgs).toMatchObject({
      organizationId: ORG_ID,
      componentKind: "skill",
      content: "# My Skill",
      computeTargetId: COMPUTE_TARGET_ID,
      editorUserId: USER_ID,
      installPath: ".claude/skills/my-skill/SKILL.md",
      accessState: "accessible",
    });
    expect(regArgs?.observedAt).toBeInstanceOf(Date);
    expect(regArgs?.observedAt?.toISOString()).toBe("2026-01-11T00:00:00.000Z");

    // The returned id is stamped onto the coarse AgentComponentVersion row via
    // its natural key (org-scoped, "" source sentinel, componentKey fallback).
    expect(mocks.versionUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = mocks.versionUpdate.mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId: ORG_ID,
        componentKind: "skill",
        componentKey: "my-skill",
        source: "",
        contentHash: "hash-skill-1",
      },
    });
    expect(updateArgs?.data).toEqual({
      definitionVersionId: "definition-version-1",
    });
  });

  // ISS-8201 (codex P2 + whitlockk review, PR #7220). `definitionHash` folds the
  // kind and IS the version identity, so projecting the kind INTO the hash
  // rekeys every version already registered under a raw over-long kind — a
  // resync misses the row, duplicates the version, and moves the
  // `AgentComponentVersion` link — and splits provenance against a producer that
  // registers the same bytes with no projection at all. Two arguments, not one:
  // the RAW kind is the fingerprint input, the PROJECTED one is the column.
  it("fingerprints an over-long kind RAW while storing it projected", async () => {
    installOwnedTarget();
    const overLongKind = `skill-${"k".repeat(1024)}`;

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: overLongKind,
          content: "# My Skill",
          contentHash: "hash-skill-1",
        }),
      ])
    );

    const regArgs = mocks.registerDefinitionVersion.mock.calls[0]?.[1];
    expect(regArgs?.componentKind).toBe(overLongKind);
    // The column still takes a bounded spelling — the second btree this string
    // lands in is what removing the wire cap exposed.
    expect(regArgs?.storedComponentKind).not.toBe(overLongKind);
    expect(
      Buffer.byteLength(regArgs?.storedComponentKind ?? "", "utf8")
    ).toBeLessThanOrEqual(INDEX_KEY_MAX_BYTES);
  });

  // The opposite state on the same subject: a kind inside the budget is NOT
  // split into two spellings, so the separation above is a projection and not a
  // second value invented for every component.
  it("passes one spelling for a kind that fits", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ content: "# My Skill", contentHash: "hash-skill-1" }),
      ])
    );

    const regArgs = mocks.registerDefinitionVersion.mock.calls[0]?.[1];
    expect(regArgs?.componentKind).toBe("skill");
    expect(regArgs?.storedComponentKind).toBe("skill");
  });

  /**
   * ISS-8285 (review — codex, whitlockk): the F1 stamp must address the row the
   * version upsert just wrote.
   *
   * Once the version upsert adopted a legacy raw component's STORED identity,
   * the stamp still rebuilt its `where` by re-projecting the payload, so for
   * such a component the two statements named different tuples. The update then
   * raised P2025 after the component and version writes had already landed —
   * a partial sync whose retry replays the same failure forever.
   *
   * Asserted as "the stamp equals the upsert's own key" rather than against a
   * hardcoded string, so the pair cannot drift apart in either direction.
   */
  it("stamps the F1 link on the tuple the version upsert wrote, for a component stored under a legacy RAW identity", async () => {
    installOwnedTarget();
    const overBudgetKind = "k".repeat(INDEX_KEY_MAX_BYTES + 1);
    // The legacy row is sitting under its RAW kind, so the identity probe finds
    // it there and the version upsert is keyed on that value.
    mocks.componentFindUnique.mockImplementation(
      (args: {
        where: {
          computeTargetId_componentKind_externalComponentId: {
            componentKind: string;
          };
        };
      }) =>
        Promise.resolve(
          args.where.computeTargetId_componentKind_externalComponentId
            .componentKind === overBudgetKind
            ? {
                componentKind: overBudgetKind,
                externalComponentId: "skill::my-skill",
                componentKey: "my-skill",
              }
            : null
        )
    );

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: overBudgetKind,
          content: "# My Skill",
          contentHash: "hash-skill-1",
        }),
      ])
    );

    const upsertWhere =
      mocks.versionUpsert.mock.calls[0]?.[0]?.where
        .organizationId_componentKind_componentKey_source_contentHash;
    const updateWhere =
      mocks.versionUpdate.mock.calls[0]?.[0]?.where
        .organizationId_componentKind_componentKey_source_contentHash;

    // Both statements ran at all — an absent call would satisfy a bare equality
    // of two undefineds.
    expect(mocks.versionUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.versionUpdate).toHaveBeenCalledTimes(1);
    expect(updateWhere).toEqual(upsertWhere);
    expect(updateWhere?.componentKind).toBe(overBudgetKind);
    // Not vacuous: the projected form the stamp used to rebuild really is a
    // different string, so an equal pair could not have happened by accident.
    expect(projectIndexKey(overBudgetKind).value).not.toBe(overBudgetKind);
  });

  it("forwards an inaccessible accessState from the payload to the registry writer (AC-5)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: "# Private",
          contentHash: "hash-priv-1",
          accessState: "inaccessible",
        }),
      ])
    );

    expect(mocks.registerDefinitionVersion.mock.calls[0]?.[1]).toMatchObject({
      accessState: "inaccessible",
    });
  });

  // AC-018 / older-client contract: a component without content (older desktop,
  // or an event-driven label with no definition) must NOT register a version and
  // must NOT stamp a link — the inventory row stays unresolved (Slice 4).
  it("does NOT register a version or stamp a link for a content-less component (older client stays unresolved)", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ content: null, contentHash: null })])
    );

    expect(mocks.registerDefinitionVersion).not.toHaveBeenCalled();
    expect(mocks.versionUpdate).not.toHaveBeenCalled();
    // The component existence row is still upserted (inventory is unaffected).
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("keys the stamp on componentKey, falling back to externalId when componentKey is absent", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::fallback",
          componentKey: null,
          content: "# Fallback",
          contentHash: "hash-fallback-1",
        }),
      ])
    );

    const key =
      mocks.versionUpdate.mock.calls[0]?.[0]?.where
        ?.organizationId_componentKind_componentKey_source_contentHash;
    expect(key?.componentKey).toBe("skill::fallback");
  });

  it("runs one set-based late-arrival invocation relink after inventory is durable", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result.ok).toBe(true);
    expect(mocks.relinkActiveForComputeTarget).toHaveBeenCalledTimes(1);
    expect(mocks.relinkActiveForComputeTarget).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });
  });

  it("keeps authoritative inventory sync successful when late relink fails", async () => {
    installOwnedTarget();
    mocks.relinkActiveForComputeTarget.mockRejectedValueOnce(
      new Error("relink unavailable")
    );

    const result = await desktopComponentsSyncService.sync(
      buildInput([buildComponent()])
    );

    expect(result).toEqual({ ok: true, value: { synced: true } });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "Late agent component invocation relink failed",
      expect.objectContaining({
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      })
    );
  });

  // FEA-4011: post-commit, fail-open search projection sync.

  it("indexes each installed component into unified search after the upsert commits", async () => {
    installOwnedTarget();

    const result = await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::my-skill",
          componentKind: "skill",
          name: "My Skill",
          componentKey: "my-skill",
          description: "does a thing",
          contentHash:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }),
      ])
    );

    expect(result.ok).toBe(true);
    // Asserted AFTER the sync ran, from the test body — one BATCH upsert
    // carrying the upserted row's id + literal routable content-hash slug.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledWith([]);
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([
      agentComponentProjection({
        id: "ac-1",
        organizationId: ORG_ID,
        componentKind: "skill",
        name: "My Skill",
        componentKey: "my-skill",
        externalComponentId: "skill::my-skill",
        description: "does a thing",
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
        contentHash:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    ]);
    expect(mocks.indexManyAfterCommit.mock.calls[0]?.[0]?.[0]?.slug).toBe(
      "skill::0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  it("removes an uninstalled component from unified search instead of indexing it", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::gone",
          componentKind: "skill",
          uninstalledAt: "2026-02-02T00:00:00.000Z",
        }),
      ])
    );

    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([]);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledWith([
      {
        organizationId: ORG_ID,
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-1",
      },
    ]);
  });

  it("indexes only the installed components in a mixed install/uninstall batch", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::older",
          componentKey: "shared",
          name: "older",
        }),
        buildComponent({
          externalId: "skill::b",
          componentKey: "b",
          name: "b",
          uninstalledAt: "2026-02-02T00:00:00.000Z",
        }),
        buildComponent({
          externalId: "skill::newer",
          componentKey: "shared",
          name: "newer",
        }),
      ])
    );

    // One BATCH index carrying the live "older"/"newer" rows and one BATCH
    // remove carrying the uninstalled "b". The fail-open guarantee of the hook
    // itself is covered in the index-service test — production swallows its own
    // errors.
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledTimes(1);
    expect(mocks.removeManyAfterCommit).toHaveBeenCalledTimes(1);
    const indexedBatch = mocks.indexManyAfterCommit.mock.calls[0][0] as Array<{
      title: string;
    }>;
    const removedBatch = mocks.removeManyAfterCommit.mock.calls[0][0] as Array<{
      entityType: string;
    }>;
    // The two live rows share a slug, so only the later one is indexed; the
    // uninstalled row is removed independently.
    expect(indexedBatch).toHaveLength(1);
    expect(indexedBatch[0]).toMatchObject({
      entityId: "ac-3",
      title: "newer",
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    expect(removedBatch).toHaveLength(1);
    expect(removedBatch[0].entityType).toBe(SearchEntityType.AgentComponent);
  });

  // -------------------------------------------------------------------------
  // ISS-4778 — skew guard: a stale Desktop still emitting the phantom `command`
  // component for a slash-invoked SKILL must not re-pollute the inventory after
  // the one-time backfill migration.
  // -------------------------------------------------------------------------

  it("drops a skewed client's phantom command when a resolved skill sibling is already stored", async () => {
    installOwnedTarget();
    mocks.componentFindMany.mockResolvedValue([{ componentKey: "review" }]);

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "/review",
          componentKind: "command",
          componentKey: "/review",
          name: "/review",
          content: null,
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.componentFindMany).toHaveBeenCalledWith({
      where: {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: "skill",
        resolvedState: "resolved",
        componentKey: { in: ["review"] },
      },
      select: { componentKey: true },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.indexManyAfterCommit).toHaveBeenCalledWith([]);
  });

  it("drops the phantom command when its resolved skill sibling rides in the same payload", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "skill::review",
          componentKind: "skill",
          componentKey: "review",
          name: "review",
          resolvedState: "resolved",
        }),
        buildComponent({
          externalId: "/review",
          componentKind: "command",
          componentKey: "/review",
          name: "/review",
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(
      mocks.upsert.mock.calls[0][0].where
        .computeTargetId_componentKind_externalComponentId.externalComponentId
    ).toBe("skill::review");
  });

  it("ingests a genuine command with no skill sibling untouched", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          externalId: "/deploy",
          componentKind: "command",
          componentKey: "/deploy",
          name: "/deploy",
          resolvedState: "unresolved",
        }),
      ])
    );

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(
      mocks.upsert.mock.calls[0][0].where
        .computeTargetId_componentKind_externalComponentId.externalComponentId
    ).toBe("/deploy");
  });

  it("skips the guard's lookup entirely when the payload carries no slash-keyed unresolved command", async () => {
    installOwnedTarget();

    await desktopComponentsSyncService.sync(buildInput([buildComponent()]));

    expect(mocks.componentFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("desktopComponentsSyncService.sync — projected index keys (ISS-8069)", () => {
  /**
   * High-entropy so it is a faithful stand-in for the value that trips the
   * engine: an index tuple can be compressed inline, so a repeated character
   * past 2704 bytes is accepted by Postgres and would make this a false green.
   * The DB-backed proof is
   * `__tests__/integration/index-key-poison-batch.integration.test.ts`; this
   * case pins the REPORT, which that suite does not assert.
   */
  const OVER_LIMIT_HASH = Array.from(
    { length: 128 },
    (_, index) => `${index.toString(36)}f3a91c7e5b2d08`
  ).join("");

  // `emitTelemetryMetric` is file-scoped and nothing resets mocks between
  // describe blocks here, so without this the silence case below would read the
  // PREVIOUS case's emission and fail — the same trap
  // `status-fold-telemetry.test.ts` records. `clearAllMocks` also drops the db
  // fake, so the owned-target install has to be replayed.
  //
  // The gate is cleared BY NAME (#7213 review, tamsinb): it is a module-level
  // latch that `clearAllMocks` cannot reach, and every case here shares one
  // (ORG_ID, COMPUTE_TARGET_ID), so the second projection below would be
  // suppressed by the first case's occurrence and fail for a reason that has
  // nothing to do with the code under test. `vi.resetModules()` would NOT do
  // it — the top-level import above keeps pointing at the primed instance.
  beforeEach(() => {
    vi.clearAllMocks();
    componentIndexKeyProjectionGate.clear();
    installOwnedTarget();
  });

  it("reports the bound keys once for the request rather than absorbing them", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({ contentHash: OVER_LIMIT_HASH, content: "# body" }),
      ])
    );

    const emissions = mocks.emitTelemetryMetric.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);

    expect(emissions).toEqual([
      {
        metric: INDEX_KEY_PROJECTED_METRIC,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        count: 1,
      },
    ]);
  });

  /**
   * The SECOND projection in this block, and the case the reset above exists
   * for (#7213 review, tamsinb). It shares (ORG_ID, COMPUTE_TARGET_ID) with
   * the case before it, so a gate carried over from that case suppresses this
   * emission — and the failure reads as "the service stopped reporting
   * projections" when nothing about the service changed.
   */
  it("reports a later batch's bound keys rather than inheriting the previous case's window", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          contentHash: `${OVER_LIMIT_HASH}5e0d7a2b91c4f6`,
          content: "# body",
        }),
      ])
    );

    const emissions = mocks.emitTelemetryMetric.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);

    expect(emissions).toEqual([
      {
        metric: INDEX_KEY_PROJECTED_METRIC,
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        count: 1,
      },
    ]);
  });

  it("stays silent for an inventory whose keys all fit", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ contentHash: "abc123", content: "# body" })])
    );

    expect(
      mocks.emitTelemetryMetric.mock.calls
        .map(([arg]) => arg)
        .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC)
    ).toEqual([]);
  });
});
