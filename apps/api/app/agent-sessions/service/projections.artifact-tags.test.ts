// ISS-8712: the Sessions LIST read projects the ORG TAG VOCABULARY — the generic
// `TagArtifact` join a PRD, an Issue, or a Branch already carries — onto each
// session row.
//
// Driven through `agentSessionsService.findSessions` rather than the projection
// helper alone, because the contract under test spans three pieces that can each
// be right on their own and wrong together: the SELECT joins `tagArtifacts` off
// the row's own Artifact, the service passes the caller's org + capabilities,
// and the projection scopes and shapes the result.

import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ORGANIZATION_ID = "org-1";
const OTHER_ORGANIZATION_ID = "org-2";
const PERMISSIONS = { canApply: true, canRemove: true };

describe("Sessions list artifact-tag projection (ISS-8712)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The trap this test exists to avoid: a single-tag, single-session fixture
  // passes whether the join is keyed on the row's artifact or on nothing at all.
  // Two sessions, each with its own tags plus a tag belonging to the other, is
  // what actually pins that a row carries ITS OWN tags.
  it("gives each row only the tags joined to its own artifact", async () => {
    installSessions([
      buildSessionListRecord({
        artifactId: "session-a",
        externalSessionId: "external-a",
        artifact: sessionArtifact("Session A", [
          tagRelation("tag-alpha", "alpha"),
          tagRelation("tag-beta", "beta"),
        ]),
      }),
      buildSessionListRecord({
        artifactId: "session-b",
        externalSessionId: "external-b",
        artifact: sessionArtifact("Session B", [
          tagRelation("tag-gamma", "gamma"),
        ]),
      }),
    ]);

    const response = await agentSessionsService.findSessions({
      organizationId: ORGANIZATION_ID,
      filters: {},
      tagPermissions: PERMISSIONS,
    });

    const byId = new Map(response.items.map((item) => [item.id, item]));
    expect(byId.get("session-a")?.tags?.map((tag) => tag.name)).toEqual([
      "alpha",
      "beta",
    ]);
    // The other session's tags are absent here, not merely "not first".
    expect(byId.get("session-a")?.tags?.map((tag) => tag.name)).not.toContain(
      "gamma"
    );
    expect(byId.get("session-b")?.tags?.map((tag) => tag.name)).toEqual([
      "gamma",
    ]);
    expect(byId.get("session-b")?.tags?.map((tag) => tag.name)).not.toContain(
      "alpha"
    );
  });

  it("drops a relation belonging to another organization", async () => {
    installSessions([
      buildSessionListRecord({
        artifact: sessionArtifact("Session One", [
          tagRelation("tag-ours", "ours"),
          tagRelation("tag-theirs", "theirs", OTHER_ORGANIZATION_ID),
        ]),
      }),
    ]);

    const response = await agentSessionsService.findSessions({
      organizationId: ORGANIZATION_ID,
      filters: {},
      tagPermissions: PERMISSIONS,
    });

    expect(response.items[0]?.tags).toEqual([
      { id: "tag-ours", name: "ours", color: TagColor.Blue },
    ]);
  });

  it("reports a loaded-but-empty relation as Available with no tags", async () => {
    installSessions([
      buildSessionListRecord({ artifact: sessionArtifact("S", []) }),
    ]);

    const response = await agentSessionsService.findSessions({
      organizationId: ORGANIZATION_ID,
      filters: {},
      tagPermissions: PERMISSIONS,
    });

    // `Available` + `[]` is the computed answer "this session has no tags",
    // which a cell may render as an empty picker. It must not be reachable by
    // the un-batched path below, which never asked.
    expect(response.items[0]?.tagAvailability).toBe(
      ArtifactTagAvailability.Available
    );
    expect(response.items[0]?.tags).toEqual([]);
  });

  it("omits every tag key when the caller supplied no capabilities", async () => {
    installSessions([
      buildSessionListRecord({
        artifact: sessionArtifact("S", [tagRelation("tag-alpha", "alpha")]),
      }),
    ]);

    const response = await agentSessionsService.findSessions({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    // Not `Unavailable`, and not an empty array: the KEYS are absent, so an
    // in-process consumer reading `"tags" in item` sees the honest "this read
    // never established who is asking" rather than a computed claim.
    const item = response.items[0];
    expect(item).toBeDefined();
    expect(Object.hasOwn(item as object, "tags")).toBe(false);
    expect(Object.hasOwn(item as object, "tagAvailability")).toBe(false);
    expect(Object.hasOwn(item as object, "tagPermissions")).toBe(false);
  });

  it("carries the caller's capabilities onto the row verbatim", async () => {
    installSessions([
      buildSessionListRecord({ artifact: sessionArtifact("S", []) }),
    ]);

    const response = await agentSessionsService.findSessions({
      organizationId: ORGANIZATION_ID,
      filters: {},
      tagPermissions: { canApply: true, canRemove: false },
    });

    expect(response.items[0]?.tagPermissions).toEqual({
      canApply: true,
      canRemove: false,
    });
  });
});

function installSessions(sessions: Record<string, unknown>[]) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue(sessions),
      count: vi.fn().mockResolvedValue(sessions.length),
    },
  });
}

function sessionArtifact(
  name: string,
  tagArtifacts: ReturnType<typeof tagRelation>[]
) {
  return {
    organizationId: ORGANIZATION_ID,
    name,
    status: "completed",
    slug: "SES-1",
    project: null,
    sourceLinks: [],
    tagArtifacts,
  };
}

function tagRelation(
  id: string,
  name: string,
  organizationId: string = ORGANIZATION_ID
) {
  return { tag: { id, name, color: TagColor.Blue, organizationId } };
}
