/**
 * ISS-8200: resolving a trace comment's SESSION target under any key that
 * session could be stored under.
 *
 * `target.id` arrives as a raw wire `externalSessionId`, but the ingest stores
 * that column projected (ISS-8069) or under a preserved legacy raw value. An
 * equality match on the wire value resolved neither, so a comment on exactly the
 * sessions ISS-8069 re-keyed reported its target as not found.
 */
import { CommentTargetType } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { sessionDetail: { findFirst: vi.fn() } };
  return {
    db,
    withDb: vi.fn((fn: (client: typeof db) => unknown) => fn(db)),
    findOwnedById: vi.fn(),
  };
});

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  ArtifactType: { SESSION: "SESSION" },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));

import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { resolveSessionTraceCommentTarget } from "./trace-comment-target-lookup";

const ORGANIZATION_ID = "org-trace-1";
const USER_ID = "user-trace-1";
const COMPUTE_TARGET_ID = "target-trace-1";
const LEGACY_RAW_SESSION_ID = "s".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED_SESSION_ID = projectIndexKey(LEGACY_RAW_SESSION_ID).value;
const SESSION_ARTIFACT_ID = "0199d0f8-1d4a-7c3e-9b2a-5f6e7d8c9b0a";

/** Every `artifactId` the resolver probed, in order. */
function probedArtifactIds(): string[] {
  return mocks.db.sessionDetail.findFirst.mock.calls
    .map((call) => call[0].where.artifactId)
    .filter((value: unknown): value is string => typeof value === "string");
}

/** Every `externalSessionId` the resolver asked for, in order. */
function probedSessionIds(): string[] {
  return mocks.db.sessionDetail.findFirst.mock.calls
    .map((call) => call[0].where.externalSessionId)
    .filter((value: unknown): value is string => typeof value === "string");
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    target: { type: "session", id: LEGACY_RAW_SESSION_ID },
    computeTargetId: COMPUTE_TARGET_ID,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });
});

describe("resolveSessionTraceCommentTarget", () => {
  it("resolves a session still stored under its legacy RAW key", async () => {
    mocks.db.sessionDetail.findFirst.mockImplementation((args: never) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return Promise.resolve(
        where.externalSessionId === LEGACY_RAW_SESSION_ID
          ? { artifactId: "artifact-legacy" }
          : null
      );
    });

    const resolved = await resolveSessionTraceCommentTarget(input());

    expect(resolved?.artifactId).toBe("artifact-legacy");
    expect(probedSessionIds()).toEqual([
      PROJECTED_SESSION_ID,
      LEGACY_RAW_SESSION_ID,
    ]);
  });

  // ISS-11190: `session_detail.artifact_id` is `@db.Uuid`, and Postgres raises
  // on a non-UUID there instead of matching nothing, so the probe must never be
  // issued for one. A mock answering `null` to it is the false green this
  // replaces.
  it("never probes the artifact id for a non-UUID target", async () => {
    mocks.db.sessionDetail.findFirst.mockResolvedValue(null);

    await resolveSessionTraceCommentTarget(
      input({
        target: { type: CommentTargetType.Session, id: "opencode-ses_1" },
      })
    );

    expect(probedArtifactIds()).toEqual([]);
    expect(probedSessionIds()).toContain("opencode-ses_1");
  });

  it("resolves a UUID target by its artifact id before any fallback", async () => {
    mocks.db.sessionDetail.findFirst.mockImplementation((args: never) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return Promise.resolve(
        where.artifactId === SESSION_ARTIFACT_ID
          ? { artifactId: SESSION_ARTIFACT_ID }
          : null
      );
    });

    const resolved = await resolveSessionTraceCommentTarget(
      input({
        target: {
          type: CommentTargetType.Session,
          id: SESSION_ARTIFACT_ID,
        },
      })
    );

    expect(resolved?.artifactId).toBe(SESSION_ARTIFACT_ID);
    expect(probedArtifactIds()).toEqual([SESSION_ARTIFACT_ID]);
    expect(probedSessionIds()).toEqual([]);
    expect(mocks.findOwnedById).not.toHaveBeenCalled();
  });

  it("falls back to the external id when a UUID target misses the artifact id", async () => {
    mocks.db.sessionDetail.findFirst.mockImplementation((args: never) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return Promise.resolve(
        where.externalSessionId === SESSION_ARTIFACT_ID
          ? { artifactId: "artifact-claude" }
          : null
      );
    });

    const resolved = await resolveSessionTraceCommentTarget(
      input({
        target: {
          type: CommentTargetType.Session,
          id: SESSION_ARTIFACT_ID,
        },
      })
    );

    expect(resolved?.artifactId).toBe("artifact-claude");
    expect(probedArtifactIds()).toEqual([SESSION_ARTIFACT_ID]);
  });

  it("returns null when no candidate holds the session", async () => {
    // The widening must not invent a target: an id nothing stores is still
    // unresolvable, and the caller's not-found path depends on it.
    mocks.db.sessionDetail.findFirst.mockResolvedValue(null);

    expect(await resolveSessionTraceCommentTarget(input())).toBeNull();
  });
});
