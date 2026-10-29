/**
 * ISS-11283: branch coverage for `component-sync-source.ts` over a REAL
 * migrated store — the legacy/sparse `agent_components` row shapes (NULL
 * component_key, NULL dates, an out-of-enum resolved_state, bad metadata
 * text, no primary content hash), variant rows with NULL format and dates, a
 * component already over the per-component byte ceiling on its own, and the
 * empty-id short-circuit of the usage loader.
 */
import {
  SYNCED_COMPONENT_MAX_SERIALIZED_BYTES,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSyncedComponentRows,
  selectComponentUsageRows,
} from "../src/main/database/component-sync-source.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type ComponentSeed = {
  id: string;
  componentKind: string;
  externalId: string;
  componentKey: string | null;
  description?: string | null;
  metadata?: string | null;
  content?: string | null;
  contentHash?: string | null;
  resolvedState: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

type VersionSeed = {
  componentKind: string;
  componentKey: string;
  contentHash: string;
  content: string;
  format: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

const TRIM_NOT_A_FUNCTION_RE = /value\.trim is not a function/;

let opened: OpenTestPrisma;

beforeEach(async () => {
  opened = await openTestPrisma();
});

afterEach(async () => {
  await opened.close();
});

async function seedComponent(seed: ComponentSeed): Promise<void> {
  await opened.db.query(
    `INSERT INTO agent_components (
       id, component_kind, external_id, component_key, description, metadata,
       content, content_hash, resolved_state, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.id,
      seed.componentKind,
      seed.externalId,
      seed.componentKey,
      seed.description ?? null,
      seed.metadata ?? null,
      seed.content ?? null,
      seed.contentHash ?? null,
      seed.resolvedState,
      seed.firstSeenAt,
      seed.lastSeenAt,
    ]
  );
}

async function seedVersion(seed: VersionSeed): Promise<void> {
  await opened.db.query(
    `INSERT INTO agent_component_versions (
       id, component_kind, component_key, source, content_hash, content,
       format, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
    [
      `${seed.componentKind}:${seed.componentKey}:${seed.contentHash}`,
      seed.componentKind,
      seed.componentKey,
      seed.contentHash,
      seed.content,
      seed.format,
      seed.firstSeenAt,
      seed.lastSeenAt,
    ]
  );
}

describe("loadSyncedComponentRows over sparse legacy rows", () => {
  it("maps NULL key/dates/hash and non-object metadata to null, coerces an unknown resolved_state, and keys the variant family by externalId", async () => {
    await seedComponent({
      id: "cmp-legacy",
      componentKind: "skill",
      externalId: "deploy-helper",
      componentKey: null,
      metadata: '"PreToolUse"',
      content: "LEGACY BODY",
      contentHash: null,
      resolvedState: "half-resolved",
      firstSeenAt: null,
      lastSeenAt: null,
    });
    await seedVersion({
      componentKind: "skill",
      componentKey: "deploy-helper",
      contentHash: "hash-older",
      content: "OLDER BODY",
      format: null,
      firstSeenAt: null,
      lastSeenAt: null,
    });

    const [component] = await loadSyncedComponentRows(opened.prisma, [
      "cmp-legacy",
    ]);

    expect(component).toEqual({
      externalId: "deploy-helper",
      componentKind: "skill",
      harness: null,
      name: null,
      componentKey: null,
      version: null,
      description: null,
      sourceUrl: null,
      installPath: null,
      packId: null,
      scope: null,
      projectPath: null,
      // A JSON string is not an object, so the wire field degrades to null.
      metadata: null,
      content: "LEGACY BODY",
      contentHash: null,
      resolvedState: "unresolved",
      firstSeenAt: null,
      lastSeenAt: null,
      uninstalledAt: null,
      variantsTruncated: false,
      variants: [
        {
          contentHash: "hash-older",
          content: "OLDER BODY",
          format: null,
          firstSeenAt: null,
          lastSeenAt: null,
        },
      ],
    });
    // No primary hash means no primary revision to take a first-seen date from.
    expect(Object.hasOwn(component ?? {}, "contentFirstSeenAt")).toBe(false);
  });

  it("rejects when a row carries a JSON-object metadata value", async () => {
    // pins current behavior; looks odd because the libSQL adapter decodes the
    // JSONB `metadata` column to an object, and `parseJsonObjectText` then calls
    // `.trim()` on it. No production writer sets agent_components.metadata today.
    await seedComponent({
      id: "cmp-object-meta",
      componentKind: "hook",
      externalId: "pre-bash",
      componentKey: "pre-bash",
      metadata: '{"event":"PreToolUse"}',
      resolvedState: "resolved",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      loadSyncedComponentRows(opened.prisma, ["cmp-object-meta"])
    ).rejects.toThrow(TRIM_NOT_A_FUNCTION_RE);
  });
});

describe("loadSyncedComponentRows over an already-oversized component", () => {
  it("ships no variants and reports the byte budget when the component alone exceeds the ceiling", async () => {
    await seedComponent({
      id: "cmp-fat",
      componentKind: "agent",
      externalId: "reviewer",
      componentKey: "reviewer",
      description: "d".repeat(SYNCED_COMPONENT_MAX_SERIALIZED_BYTES),
      content: "PRIMARY BODY",
      contentHash: "hash-primary",
      resolvedState: "resolved",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    });
    await seedVersion({
      componentKind: "agent",
      componentKey: "reviewer",
      contentHash: "hash-primary",
      content: "PRIMARY BODY",
      format: "md",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    });
    await seedVersion({
      componentKind: "agent",
      componentKey: "reviewer",
      contentHash: "hash-small",
      content: "x",
      format: "md",
      firstSeenAt: "2025-12-01T00:00:00.000Z",
      lastSeenAt: "2025-12-02T00:00:00.000Z",
    });

    const [component] = await loadSyncedComponentRows(opened.prisma, [
      "cmp-fat",
    ]);

    expect(Object.hasOwn(component ?? {}, "variants")).toBe(false);
    expect(component?.variantsTruncated).toBe(true);
    expect(component?.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.ByteBudget
    );
    expect(component?.contentFirstSeenAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("selectComponentUsageRows", () => {
  it("returns an empty map without querying when no session ids are given", async () => {
    const result = await opened.prisma.read(async (reader) => {
      const query = vi.spyOn(reader, "$queryRawUnsafe");
      const grouped = await selectComponentUsageRows(reader, []);
      return { grouped, calls: query.mock.calls.length };
    });

    expect(result.grouped.size).toBe(0);
    expect(result.calls).toBe(0);
  });
});
