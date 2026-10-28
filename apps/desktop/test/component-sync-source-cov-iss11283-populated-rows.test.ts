/**
 * ISS-11283: the populated-row counterparts of the sparse-row suite for
 * `component-sync-source.ts`, over a REAL migrated store — every column
 * forwarded verbatim, the primary revision excluded from `variants` and used
 * as the `contentFirstSeenAt` source even when a newer revision exists, the
 * 64 KiB variants budget binding before the per-component ceiling, a NULL
 * content body, and per-session usage grouping.
 */
import {
  SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSyncedComponentRows,
  selectComponentUsageRows,
} from "../src/main/database/component-sync-source.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

/** A variant body sized so exactly two fit the variants budget. */
const VARIANT_BODY_CHARS = Math.floor(
  (SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES - 2000) / 2
);

let opened: OpenTestPrisma;

beforeEach(async () => {
  opened = await openTestPrisma();
});

afterEach(async () => {
  await opened.close();
});

async function seedVersion(
  componentKey: string,
  contentHash: string,
  content: string,
  format: string,
  firstSeenAt: string,
  lastSeenAt: string
): Promise<void> {
  await opened.db.query(
    `INSERT INTO agent_component_versions (
       id, component_kind, component_key, source, content_hash, content,
       format, first_seen_at, last_seen_at
     ) VALUES (?, 'agent', ?, '', ?, ?, ?, ?, ?)`,
    [
      `agent:${componentKey}:${contentHash}`,
      componentKey,
      contentHash,
      content,
      format,
      firstSeenAt,
      lastSeenAt,
    ]
  );
}

async function seedMinimalComponent(
  id: string,
  externalId: string,
  content: string | null,
  contentHash: string | null
): Promise<void> {
  await opened.db.query(
    `INSERT INTO agent_components (
       id, component_kind, external_id, component_key, content, content_hash,
       resolved_state, last_seen_at
     ) VALUES (?, 'agent', ?, ?, ?, ?, 'resolved', '2026-01-02T00:00:00.000Z')`,
    [id, externalId, externalId, content, contentHash]
  );
}

describe("loadSyncedComponentRows over a fully populated row", () => {
  it("forwards every column and excludes the primary revision even when a newer one exists", async () => {
    await opened.db.query(
      `INSERT INTO agent_components (
         id, component_kind, external_id, component_key, name, version, harness,
         description, source_url, install_path, pack_id, scope, project_path,
         metadata, content, content_hash, resolved_state, first_seen_at,
         last_seen_at, uninstalled_at
       ) VALUES (?, 'agent', 'reviewer', 'reviewer', 'Reviewer', '1.2.0', 'claude',
         'reviews diffs', 'https://example.test/reviewer', 'agents/reviewer.md',
         'pack-1', 'project', 'repo/app', ?, 'PRIMARY', 'hash-primary',
         'inaccessible', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
         '2026-02-01T00:00:00.000Z')`,
      ["cmp-full", JSON.stringify(JSON.stringify({ model: "opus" }))]
    );
    await seedVersion(
      "reviewer",
      "hash-primary",
      "PRIMARY",
      "md",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z"
    );
    await seedVersion(
      "reviewer",
      "hash-new",
      "NEWER",
      "md",
      "2026-01-05T00:00:00.000Z",
      "2026-01-06T00:00:00.000Z"
    );
    await seedVersion(
      "reviewer",
      "hash-old",
      "OLDER",
      "txt",
      "2025-12-01T00:00:00.000Z",
      "2025-12-02T00:00:00.000Z"
    );

    const [component] = await loadSyncedComponentRows(opened.prisma, [
      "cmp-full",
    ]);

    expect(component).toEqual({
      externalId: "reviewer",
      componentKind: "agent",
      harness: "claude",
      name: "Reviewer",
      componentKey: "reviewer",
      version: "1.2.0",
      description: "reviews diffs",
      sourceUrl: "https://example.test/reviewer",
      installPath: "agents/reviewer.md",
      packId: "pack-1",
      scope: "project",
      projectPath: "repo/app",
      metadata: { model: "opus" },
      content: "PRIMARY",
      contentHash: "hash-primary",
      resolvedState: "inaccessible",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      uninstalledAt: "2026-02-01T00:00:00.000Z",
      contentFirstSeenAt: "2026-01-01T00:00:00.000Z",
      variantsTruncated: false,
      variants: [
        {
          contentHash: "hash-new",
          content: "NEWER",
          format: "md",
          firstSeenAt: "2026-01-05T00:00:00.000Z",
          lastSeenAt: "2026-01-06T00:00:00.000Z",
        },
        {
          contentHash: "hash-old",
          content: "OLDER",
          format: "txt",
          firstSeenAt: "2025-12-01T00:00:00.000Z",
          lastSeenAt: "2025-12-02T00:00:00.000Z",
        },
      ],
    });
  });

  it("stops at the variants byte budget before the per-component ceiling", async () => {
    await seedMinimalComponent("cmp-budget", "budgeted", "PRIMARY", "hash-p");
    for (const [hash, day] of [
      ["hash-a", "05"],
      ["hash-b", "04"],
      ["hash-c", "03"],
    ] as const) {
      await seedVersion(
        "budgeted",
        hash,
        "v".repeat(VARIANT_BODY_CHARS),
        "md",
        `2026-01-${day}T00:00:00.000Z`,
        `2026-01-${day}T00:00:00.000Z`
      );
    }

    const [component] = await loadSyncedComponentRows(opened.prisma, [
      "cmp-budget",
    ]);

    expect(component?.variants?.map((v) => v.contentHash)).toEqual([
      "hash-a",
      "hash-b",
    ]);
    expect(component?.variantsTruncated).toBe(true);
    expect(component?.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.ByteBudget
    );
  });

  it("maps a NULL content body to null", async () => {
    await seedMinimalComponent("cmp-empty", "empty", null, null);

    const [component] = await loadSyncedComponentRows(opened.prisma, [
      "cmp-empty",
    ]);

    expect(component?.content).toBeNull();
    expect(component?.contentHash).toBeNull();
    expect(component?.variantsTruncated).toBe(false);
  });
});

describe("selectComponentUsageRows", () => {
  it("groups usage rows by session in key order", async () => {
    const insert = `INSERT INTO agent_component_session_usage (
        session_id, component_kind, component_key, git_branch, invocations, error_count
      ) VALUES (?, ?, ?, '', ?, 0)`;
    await opened.db.query(insert, ["s-1", "skill", "beta", 2]);
    await opened.db.query(insert, ["s-1", "skill", "alpha", 1]);
    await opened.db.query(insert, ["s-2", "mcp", "github", 5]);
    await opened.db.query(insert, ["s-3", "mcp", "unrelated", 9]);

    const grouped = await opened.prisma.read((reader) =>
      selectComponentUsageRows(reader, ["s-1", "s-2"])
    );

    expect([...grouped.keys()].sort()).toEqual(["s-1", "s-2"]);
    expect(grouped.get("s-1")?.map((row) => row.component_key)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(grouped.get("s-2")?.map((row) => row.invocations)).toEqual([5]);
  });
});
