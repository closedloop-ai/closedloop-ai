// ISS-10995: the Session DETAIL read projects the org tag vocabulary, as the
// list read has since ISS-8712. The Details tab's Tags row is the surface, and
// before this the detail passed no `tagContext` at all — so the response
// carried neither `tags` nor `tagAvailability`, and the row's
// availability-and-array guard dropped it on every real response (whitlockk, #8697).
//
// Driven through `agentSessionsService.findSessionDetail` rather than the
// projection helper alone, for the reason its list sibling
// (`projections.artifact-tags.test.ts`) gives: the SELECT joining
// `tagArtifacts`, the route-supplied capabilities, and the projection's scoping
// can each be right alone and wrong together.

import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
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
const SESSION_ID = "session-1";
const PERMISSIONS = { canApply: true, canRemove: true };

describe("findSessionDetail — artifact tags (ISS-10995)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves the joined relation and the caller's capabilities", async () => {
    installDetail([tagRelation("tag-alpha", "alpha")]);

    const detail = await findDetail(PERMISSIONS);

    expect(detail?.tagAvailability).toBe(ArtifactTagAvailability.Available);
    expect(detail?.tags).toEqual([
      { id: "tag-alpha", name: "alpha", color: TagColor.Blue },
    ]);
    expect(detail?.tagPermissions).toEqual(PERMISSIONS);
  });

  it("reports a loaded-but-empty relation as Available with no tags", async () => {
    installDetail([]);

    const detail = await findDetail(PERMISSIONS);

    // `Available` + `[]` is the computed "this session has no tags", which the
    // Details row renders as an empty picker. It must stay unreachable from the
    // no-capabilities path below, which never asked.
    expect(detail?.tagAvailability).toBe(ArtifactTagAvailability.Available);
    expect(detail?.tags).toEqual([]);
  });

  it("drops a relation belonging to another organization", async () => {
    installDetail([
      tagRelation("tag-ours", "ours"),
      tagRelation("tag-theirs", "theirs", OTHER_ORGANIZATION_ID),
    ]);

    const detail = await findDetail(PERMISSIONS);

    expect(detail?.tags).toEqual([
      { id: "tag-ours", name: "ours", color: TagColor.Blue },
    ]);
  });

  it("omits every tag key when the caller supplied no capabilities", async () => {
    installDetail([tagRelation("tag-alpha", "alpha")]);

    const detail = await findDetail(undefined);

    // The branch merged-trace fan-out's shape: the KEYS are absent, so an
    // in-process consumer reading `"tags" in detail` sees "this read never
    // established who is asking" rather than a computed claim. Not
    // `Unavailable`, and not an empty array.
    expect(detail).toBeDefined();
    expect(Object.hasOwn(detail as object, "tags")).toBe(false);
    expect(Object.hasOwn(detail as object, "tagAvailability")).toBe(false);
    expect(Object.hasOwn(detail as object, "tagPermissions")).toBe(false);
  });
});

function findDetail(tagPermissions: typeof PERMISSIONS | undefined) {
  return agentSessionsService.findSessionDetail({
    id: SESSION_ID,
    organizationId: ORGANIZATION_ID,
    ...(tagPermissions === undefined ? {} : { tagPermissions }),
  });
}

function installDetail(tagArtifacts: ReturnType<typeof tagRelation>[]) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionDetailRecord({
          artifactId: SESSION_ID,
          artifact: {
            organizationId: ORGANIZATION_ID,
            name: "Session One",
            status: "completed",
            slug: "SES-1",
            project: null,
            sourceLinks: [],
            tagArtifacts,
          },
        }),
      ]),
    },
    sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

function tagRelation(
  id: string,
  name: string,
  organizationId: string = ORGANIZATION_ID
) {
  return { tag: { id, name, color: TagColor.Blue, organizationId } };
}
