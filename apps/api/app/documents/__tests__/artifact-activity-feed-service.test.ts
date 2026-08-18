/**
 * Unit tests for artifactActivityFeedService (FEA-3864 / FEA-3535 Slice 3).
 *
 * The database is mocked via vi.mock("@repo/database"): withDb is wired to a
 * client whose five delegate reads (artifactActivityEvent, documentVersion,
 * artifactLink, loop, artifactEvaluation) return per-source rows. Tests verify:
 *  - the merged stream is newest-first across all sources;
 *  - actors are normalized (store user/agent/system, version author→human,
 *    loop→agent, derivation/eval→system);
 *  - cursor pagination trims a lookahead and round-trips the opaque cursor;
 *  - KEYSET: each source applies the full `(createdAt, id)` predicate so rows
 *    tied at the cursor's timestamp are never truncated (P2 regression);
 *  - ORG-SCOPE: every underlying query filters on organizationId (no leak);
 *  - comments are never projected (no double-count).
 */
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => {
  const withDbFn = vi.fn();
  return {
    Prisma: { JsonNull: "JsonNull", DbNull: "DbNull" },
    LinkType: {
      PRODUCES: "PRODUCES",
      BLOCKS: "BLOCKS",
      RELATES_TO: "RELATES_TO",
    },
    withDb: Object.assign(withDbFn, { tx: vi.fn() }),
  };
});

import { withDb } from "@repo/database";
import { artifactActivityFeedService } from "../artifact-activity-feed-service";

const mockWithDb = withDb as unknown as Mock;

const ORG = "org-1";
const ARTIFACT = "artifact-1";

type SourceRows = {
  events?: unknown[];
  versions?: unknown[];
  links?: unknown[];
  loops?: unknown[];
  evaluations?: unknown[];
};

/** Captured `where` clause per delegate, for org-scope assertions. */
type CapturedWheres = {
  events?: Record<string, unknown>;
  versions?: Record<string, unknown>;
  links?: Record<string, unknown>;
  loops?: Record<string, unknown>;
  evaluations?: Record<string, unknown>;
};

/**
 * Wire withDb so each of the five source queries resolves against the supplied
 * rows. The service issues them via Promise.all, each as its own withDb call;
 * we route by which delegate the callback touches.
 */
function mockSources(rows: SourceRows): CapturedWheres {
  const captured: CapturedWheres = {};
  const client = {
    artifactActivityEvent: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        captured.events = args.where;
        return Promise.resolve(rows.events ?? []);
      }),
    },
    documentVersion: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        captured.versions = args.where;
        return Promise.resolve(rows.versions ?? []);
      }),
    },
    artifactLink: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        captured.links = args.where;
        return Promise.resolve(rows.links ?? []);
      }),
    },
    loop: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        captured.loops = args.where;
        return Promise.resolve(rows.loops ?? []);
      }),
    },
    artifactEvaluation: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        captured.evaluations = args.where;
        return Promise.resolve(rows.evaluations ?? []);
      }),
    },
  };
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) => fn(client));
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDb.mockReset();
});

describe("artifactActivityFeedService.listActivityFeed", () => {
  it("merges every source newest-first with normalized actors", async () => {
    mockSources({
      events: [
        {
          id: "e1",
          organizationId: ORG,
          artifactId: ARTIFACT,
          actorType: "agent",
          actorId: "key-1",
          action: "status_change",
          before: "DRAFT",
          after: "IN_REVIEW",
          createdAt: new Date("2026-07-22T05:00:00.000Z"),
        },
      ],
      versions: [
        {
          id: "v1",
          version: 2,
          createdById: "user-9",
          createdAt: new Date("2026-07-22T04:00:00.000Z"),
        },
      ],
      links: [
        {
          id: "l1",
          sourceId: ARTIFACT,
          targetId: "other-artifact",
          createdAt: new Date("2026-07-22T03:00:00.000Z"),
        },
      ],
      loops: [
        {
          id: "loop-1",
          userId: "user-3",
          status: "COMPLETED",
          command: "code",
          createdAt: new Date("2026-07-22T02:00:00.000Z"),
        },
      ],
      evaluations: [
        {
          id: "eval-1",
          loopId: "loop-1",
          reportType: "PLAN",
          createdAt: new Date("2026-07-22T01:00:00.000Z"),
        },
      ],
    });

    const result = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      limit: 50,
    });

    // Newest-first across sources.
    expect(result.items.map((i) => i.source)).toEqual([
      ActivityFeedItemSource.Event,
      ActivityFeedItemSource.VersionCreated,
      ActivityFeedItemSource.Derivation,
      ActivityFeedItemSource.Loop,
      ActivityFeedItemSource.Evaluation,
    ]);
    expect(result.nextCursor).toBeNull();

    // Normalized actors.
    const byId = Object.fromEntries(result.items.map((i) => [i.source, i]));
    expect(byId[ActivityFeedItemSource.Event].actor).toEqual({
      kind: ActivityFeedActorKind.Agent,
      id: "key-1",
    });
    expect(byId[ActivityFeedItemSource.VersionCreated].actor).toEqual({
      kind: ActivityFeedActorKind.Human,
      id: "user-9",
    });
    expect(byId[ActivityFeedItemSource.Loop].actor).toEqual({
      kind: ActivityFeedActorKind.Agent,
      id: "user-3",
    });
    expect(byId[ActivityFeedItemSource.Derivation].actor.kind).toBe(
      ActivityFeedActorKind.System
    );
    expect(byId[ActivityFeedItemSource.Evaluation].actor.kind).toBe(
      ActivityFeedActorKind.System
    );

    // Derivation direction + payload.
    expect(byId[ActivityFeedItemSource.Derivation].payload).toEqual({
      direction: "produced",
      relatedArtifactId: "other-artifact",
    });
  });

  it("ORG-SCOPE: every source query filters on organizationId (no leak)", async () => {
    const captured = mockSources({});
    await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
    });

    expect(captured.events?.organizationId).toBe(ORG);
    expect(captured.loops?.organizationId).toBe(ORG);
    expect(captured.links?.organizationId).toBe(ORG);
    expect(captured.evaluations?.organizationId).toBe(ORG);
    // document_versions org-scopes through the parent artifact relation.
    expect(captured.versions?.documentDetail).toEqual({
      artifact: { organizationId: ORG },
    });
  });

  it("paginates: trims the lookahead and emits an opaque nextCursor", async () => {
    mockSources({
      events: [
        {
          id: "e1",
          actorType: "user",
          actorId: "u1",
          action: "status_change",
          before: null,
          after: null,
          createdAt: new Date("2026-07-22T05:00:00.000Z"),
        },
        {
          id: "e2",
          actorType: "user",
          actorId: "u1",
          action: "field_change",
          before: null,
          after: null,
          createdAt: new Date("2026-07-22T04:00:00.000Z"),
        },
        {
          id: "e3",
          actorType: "user",
          actorId: "u1",
          action: "field_change",
          before: null,
          after: null,
          createdAt: new Date("2026-07-22T03:00:00.000Z"),
        },
      ],
    });

    const page1 = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      limit: 2,
    });

    expect(page1.items.map((i) => i.id)).toEqual(["event:e1", "event:e2"]);
    expect(page1.nextCursor).not.toBeNull();
    // Opaque cursor decodes to the last returned item's (createdAt,id).
    const decoded = Buffer.from(
      page1.nextCursor as string,
      "base64url"
    ).toString("utf8");
    expect(decoded).toBe(
      `${new Date("2026-07-22T04:00:00.000Z").getTime()}:event:e2`
    );
  });

  it("second page skips the cursor row using the encoded keyset", async () => {
    // The DB returns only rows that already sort AFTER the cursor (the new
    // per-source keyset predicate is applied in the query). e3 is the only such
    // row here; e2 (the cursor row) is excluded by the predicate.
    const captured = mockSources({
      events: [
        {
          id: "e3",
          actorType: "user",
          actorId: "u1",
          action: "field_change",
          before: null,
          after: null,
          createdAt: new Date("2026-07-22T03:00:00.000Z"),
        },
      ],
    });

    const cursorTime = new Date("2026-07-22T04:00:00.000Z");
    const cursor = Buffer.from(
      `${cursorTime.getTime()}:event:e2`,
      "utf8"
    ).toString("base64url");

    const page2 = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      cursor,
      limit: 2,
    });

    expect(page2.items.map((i) => i.id)).toEqual(["event:e3"]);
    expect(page2.nextCursor).toBeNull();
    // The event source (same prefix as the cursor) applies the full keyset:
    // `createdAt < cursorTime` OR `createdAt == cursorTime AND id < cursorRaw`.
    // This is NOT a coarse `createdAt <= cursorTime` bound that would re-fetch
    // the cursor row and its ties.
    expect(captured.events?.createdAt).toBeUndefined();
    expect(captured.events?.AND).toEqual([
      {
        OR: [
          { createdAt: { lt: cursorTime } },
          { createdAt: cursorTime, id: { lt: "e2" } },
        ],
      },
    ]);
  });

  it("KEYSET TIE: paginates past >limit rows sharing the cursor timestamp", async () => {
    // Regression for the P2 truncation bug: when many rows in one source share
    // the cursor's exact millisecond, a coarse `createdAt <= cursorTime` fetch
    // of only `limit + 1` rows filtered in memory could under-fill the page,
    // null the cursor, and lose the remaining tied rows. With the per-source
    // keyset predicate applied in the query, the DB only returns rows that sort
    // after the cursor, so the tied tail keeps paginating.
    const tiedTime = new Date("2026-07-22T04:00:00.000Z");
    // Page 1: three rows all at the same ms; limit 2 → returns e5,e4 and a
    // non-null cursor pointing at e4.
    mockSources({
      events: ["e5", "e4", "e3"].map((id) => ({
        id,
        actorType: "user",
        actorId: "u1",
        action: "field_change",
        before: null,
        after: null,
        createdAt: tiedTime,
      })),
    });

    const page1 = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      limit: 2,
    });
    expect(page1.items.map((i) => i.id)).toEqual(["event:e5", "event:e4"]);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2: the keyset predicate at the same ms is `id < "e4"`, so the DB
    // returns only e3 — the previously-lost tail row.
    const captured = mockSources({
      events: [
        {
          id: "e3",
          actorType: "user",
          actorId: "u1",
          action: "field_change",
          before: null,
          after: null,
          createdAt: tiedTime,
        },
      ],
    });
    const page2 = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["event:e3"]);
    expect(captured.events?.AND).toEqual([
      {
        OR: [
          { createdAt: { lt: tiedTime } },
          { createdAt: tiedTime, id: { lt: "e4" } },
        ],
      },
    ]);
  });

  it("KEYSET cross-source: a different source contributes all its boundary rows or none by prefix", async () => {
    // Cursor is on the `loop` source at the tied ms. For the `event` source
    // (prefix "event" < "loop"), all its boundary-ms rows sort AFTER the cursor,
    // so the fragment includes them (`createdAt == boundary`, no id bound). For
    // the `version` source (prefix "version" > "loop"), none do, so only
    // `createdAt < boundary`.
    const boundary = new Date("2026-07-22T04:00:00.000Z");
    const captured = mockSources({});
    const cursor = Buffer.from(
      `${boundary.getTime()}:loop:loop-9`,
      "utf8"
    ).toString("base64url");

    await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
      cursor,
      limit: 5,
    });

    expect(captured.events?.AND).toEqual([
      { OR: [{ createdAt: { lt: boundary } }, { createdAt: boundary }] },
    ]);
    expect(captured.versions?.AND).toEqual([{ createdAt: { lt: boundary } }]);
    // The cursor's own source uses the raw-id tiebreak at the boundary.
    expect(captured.loops?.AND).toEqual([
      {
        OR: [
          { createdAt: { lt: boundary } },
          { createdAt: boundary, id: { lt: "loop-9" } },
        ],
      },
    ]);
  });

  it("unwraps the Prisma.JsonNull sentinel on an event's before/after", async () => {
    // Prisma can surface a JSON `null` column as the JsonNull sentinel rather
    // than plain null; the projected feed item must normalize it (parity with
    // the store service's fromJsonColumn) so consumers never see the sentinel.
    mockSources({
      events: [
        {
          id: "e1",
          actorType: "user",
          actorId: "u1",
          action: "assignment",
          before: "JsonNull", // matches the mocked Prisma.JsonNull sentinel
          after: "JsonNull",
          createdAt: new Date("2026-07-22T05:00:00.000Z"),
        },
      ],
    });

    const result = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
    });

    expect(result.items[0].before).toBeNull();
    expect(result.items[0].after).toBeNull();
  });

  it("returns an empty page (no error) when nothing exists", async () => {
    mockSources({});
    const result = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG,
      artifactId: ARTIFACT,
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects a missing organizationId before touching the DB", async () => {
    mockSources({});
    await expect(
      artifactActivityFeedService.listActivityFeed({
        organizationId: "",
        artifactId: ARTIFACT,
      })
    ).rejects.toThrow();
    expect(mockWithDb).not.toHaveBeenCalled();
  });
});
