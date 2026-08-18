/**
 * Unit tests for the artifact activity capture path (FEA-3864 / FEA-3535 S2).
 *
 * Covers:
 *  - diffArtifactFields: one event per changed field, correct action mapping,
 *    and no events for a no-op update (no double-count).
 *  - actor resolution: api_key ⇒ agent, session/desktop_session ⇒ user.
 *  - captureArtifactUpdate / captureBatchStatusChange / captureArtifactCreation
 *    schedule the right record calls via waitUntil.
 *  - FAILURE-ISOLATION (load-bearing): a recordActivityEvent rejection is
 *    swallowed and never propagates out of the capture path.
 */
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityEvent = vi.hoisted(() => vi.fn());
const recordActivityEvents = vi.hoisted(() => vi.fn());

// waitUntil executes its promise synchronously so tests can await the effect
// via a microtask flush, and so a rejected promise surfaces here (not to the
// caller) — proving the record runs off the response path.
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    // Attach a no-op catch so an isolated rejection doesn't become an
    // unhandled rejection in the test runner.
    Promise.resolve(p).catch(() => undefined);
  }),
}));

vi.mock("@/app/documents/artifact-activity-service", () => ({
  artifactActivityService: { recordActivityEvent, recordActivityEvents },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  type CapturedArtifactFields,
  captureArtifactCreation,
  captureArtifactUpdate,
  captureBatchStatusChange,
  diffArtifactFields,
  resolveActorType,
} from "../artifact-activity-capture";

const ORG = "org-1";
const ARTIFACT = "artifact-1";
const USER = "user-1";

function fields(
  over: Partial<CapturedArtifactFields> = {}
): CapturedArtifactFields {
  return {
    status: "DRAFT",
    assigneeId: null,
    approverId: null,
    priority: "MEDIUM",
    title: "Doc",
    dueDate: null,
    projectId: "proj-1",
    ...over,
  };
}

/** Flush the microtask queue so waitUntil'd record promises settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  recordActivityEvent.mockReset();
  recordActivityEvent.mockResolvedValue(undefined);
  recordActivityEvents.mockReset();
  recordActivityEvents.mockResolvedValue(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveActorType", () => {
  it("maps api_key to agent and session/desktop to user", () => {
    expect(resolveActorType("api_key")).toBe(ArtifactActivityActorType.Agent);
    expect(resolveActorType("session")).toBe(ArtifactActivityActorType.User);
    expect(resolveActorType("desktop_session")).toBe(
      ArtifactActivityActorType.User
    );
  });
});

describe("diffArtifactFields", () => {
  it("returns no changes for a no-op update (no double-count)", () => {
    expect(diffArtifactFields(fields(), fields())).toEqual([]);
  });

  it("emits a status_change for a status transition", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT" }),
      fields({ status: "IN_REVIEW" })
    );
    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      },
    ]);
  });

  it("names which role moved on assignee and approver changes", () => {
    const changes = diffArtifactFields(
      fields({ assigneeId: null, approverId: "a-old" }),
      fields({ assigneeId: "u-new", approverId: "a-new" })
    );
    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.Assignment,
        before: { field: "assigneeId", value: null },
        after: { field: "assigneeId", value: "u-new" },
      },
      {
        action: ArtifactActivityAction.Assignment,
        before: { field: "approverId", value: "a-old" },
        after: { field: "approverId", value: "a-new" },
      },
    ]);
  });

  it("emits field_change for title/priority/dueDate/project changes", () => {
    const changes = diffArtifactFields(
      fields({ title: "Old", priority: "LOW", projectId: "p1" }),
      fields({ title: "New", priority: "HIGH", projectId: "p2" })
    );
    expect(changes.map((c) => c.action)).toEqual([
      ArtifactActivityAction.FieldChange,
      ArtifactActivityAction.FieldChange,
      ArtifactActivityAction.FieldChange,
    ]);
    expect(changes[0].after).toEqual({ field: "priority", value: "HIGH" });
    expect(changes[1].after).toEqual({ field: "title", value: "New" });
    expect(changes[2].after).toEqual({ field: "projectId", value: "p2" });
  });

  it("normalizes dueDate to ISO and ignores equal timestamps", () => {
    const same = new Date("2026-07-22T00:00:00.000Z");
    expect(
      diffArtifactFields(
        fields({ dueDate: same }),
        fields({ dueDate: new Date(same.getTime()) })
      )
    ).toEqual([]);

    const changed = diffArtifactFields(
      fields({ dueDate: null }),
      fields({ dueDate: same })
    );
    expect(changed).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: same.toISOString() },
      },
    ]);
  });

  it("emits multiple events when several fields change at once", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT", assigneeId: null }),
      fields({ status: "APPROVED", assigneeId: "u-2" })
    );
    expect(changes).toHaveLength(2);
  });
});

describe("captureArtifactUpdate", () => {
  it("records one event per changed field, attributed to the actor", async () => {
    captureArtifactUpdate({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "session" },
      before: fields({ status: "DRAFT" }),
      after: fields({ status: "IN_REVIEW" }),
    });
    await flush();

    expect(recordActivityEvent).toHaveBeenCalledTimes(1);
    expect(recordActivityEvent).toHaveBeenCalledWith({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actorType: ArtifactActivityActorType.User,
      actorId: USER,
      action: ArtifactActivityAction.StatusChange,
      before: "DRAFT",
      after: "IN_REVIEW",
    });
  });

  it("attributes an api-key caller as an agent", async () => {
    captureArtifactUpdate({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "api_key" },
      before: fields({ assigneeId: null }),
      after: fields({ assigneeId: "u-2" }),
    });
    await flush();

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: ArtifactActivityActorType.Agent })
    );
  });

  it("records nothing for a no-op update", async () => {
    captureArtifactUpdate({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "session" },
      before: fields(),
      after: fields(),
    });
    await flush();
    expect(recordActivityEvent).not.toHaveBeenCalled();
  });

  it("FAILURE-ISOLATION: a record rejection never throws out of capture", async () => {
    recordActivityEvent.mockRejectedValue(new Error("db down"));
    expect(() =>
      captureArtifactUpdate({
        organizationId: ORG,
        artifactId: ARTIFACT,
        actor: { userId: USER, authMethod: "session" },
        before: fields({ status: "DRAFT" }),
        after: fields({ status: "IN_REVIEW" }),
      })
    ).not.toThrow();
    // Let the rejected record settle; must not surface as an unhandled throw.
    await flush();
    expect(recordActivityEvent).toHaveBeenCalledTimes(1);
  });
});

describe("captureBatchStatusChange", () => {
  it("records the moved artifacts in a SINGLE batched call (not one per row)", async () => {
    captureBatchStatusChange({
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [
        { artifactId: "a1", before: "DRAFT", after: "APPROVED" },
        { artifactId: "a2", before: "APPROVED", after: "APPROVED" }, // no-op
        { artifactId: "a3", before: "IN_REVIEW", after: "APPROVED" },
      ],
    });
    await flush();

    // Bounded fan-out: the whole batch goes through one batched insert call, so
    // a 500-item batch cannot spawn 500 concurrent transactions on the write
    // path. The per-row `recordActivityEvent` must NOT be used here.
    expect(recordActivityEvent).not.toHaveBeenCalled();
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
    expect(recordActivityEvents).toHaveBeenCalledWith({
      organizationId: ORG,
      events: [
        {
          artifactId: "a1",
          actorType: ArtifactActivityActorType.User,
          actorId: USER,
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "APPROVED",
        },
        {
          artifactId: "a3",
          actorType: ArtifactActivityActorType.User,
          actorId: USER,
          action: ArtifactActivityAction.StatusChange,
          before: "IN_REVIEW",
          after: "APPROVED",
        },
      ],
    });
  });

  it("records nothing when no status actually moved", async () => {
    captureBatchStatusChange({
      organizationId: ORG,
      actor: { userId: USER, authMethod: "session" },
      changes: [{ artifactId: "a1", before: "APPROVED", after: "APPROVED" }],
    });
    await flush();
    expect(recordActivityEvents).not.toHaveBeenCalled();
  });

  it("FAILURE-ISOLATION: a batched-record rejection never throws out of capture", async () => {
    recordActivityEvents.mockRejectedValue(new Error("db down"));
    expect(() =>
      captureBatchStatusChange({
        organizationId: ORG,
        actor: { userId: USER, authMethod: "session" },
        changes: [{ artifactId: "a1", before: "DRAFT", after: "APPROVED" }],
      })
    ).not.toThrow();
    await flush();
    expect(recordActivityEvents).toHaveBeenCalledTimes(1);
  });
});

describe("captureArtifactCreation", () => {
  it("records a creation event with an after snapshot and no before", async () => {
    captureArtifactCreation({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actor: { userId: USER, authMethod: "api_key" },
      after: { status: "DRAFT", title: "New PRD" },
    });
    await flush();

    expect(recordActivityEvent).toHaveBeenCalledWith({
      organizationId: ORG,
      artifactId: ARTIFACT,
      actorType: ArtifactActivityActorType.Agent,
      actorId: USER,
      action: ArtifactActivityAction.Creation,
      before: null,
      after: { status: "DRAFT", title: "New PRD" },
    });
  });
});
