import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS,
} from "@repo/api/src/types/project-tree";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-7222-8222-222222222222",
    organizationId: "11111111-1111-7111-8111-111111111111",
  },
  getAssignedArtifactTree: vi.fn(),
  getManuallyOrderedAssignedArtifactTree: vi.fn(),
  manualOrderingEnabled: false,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("../assigned-artifact-tree-service", () => ({
  assignedArtifactTreeService: {
    getAssignedArtifactTree: mocks.getAssignedArtifactTree,
    getManuallyOrderedAssignedArtifactTree:
      mocks.getManuallyOrderedAssignedArtifactTree,
  },
}));

vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  isManualArtifactOrderingEnabled: vi.fn(
    async () => mocks.manualOrderingEnabled
  ),
}));

import { GET, MAX_PROJECT_FILTER_VALUES } from "../assigned-tree/route";

const ASSIGNEE_ID = "33333333-3333-7333-8333-333333333333";
const OTHER_ORGANIZATION_ID = "99999999-9999-7999-8999-999999999999";
const FROM_ISO = "2026-06-01T00:00:00.000Z";
const TO_ISO = "2026-06-30T23:59:59.999Z";
const PROJECT_A = "0d0d0d0d-0d0d-7d0d-8d0d-0d0d0d0d0d0d";
const PROJECT_B = "0e0e0e0e-0e0e-7e0e-8e0e-0e0e0e0e0e0e";
const TAG_ID = "0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0a";
const OTHER_TAG_ID = "0b0b0b0b-0b0b-7b0b-8b0b-0b0b0b0b0b0b";

function request(query: string) {
  return new NextRequest(
    `https://api.example.test/artifacts/assigned-tree?${query}`
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /artifacts/assigned-tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.manualOrderingEnabled = false;
  });

  it("returns the merged tree for the requested assignee in one request", async () => {
    const tree = {
      nodes: [
        {
          root: { id: "root-1", name: "PRD" },
          children: [{ id: "child-1", depth: 1, parentId: "root-1" }],
        },
      ],
      externalParents: [],
    };
    mocks.getAssignedArtifactTree.mockResolvedValue(tree);

    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(tree);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      mocks.user.id,
      // ISS-10471: no facet occurrence narrows nothing, and the service is told
      // so explicitly rather than being handed a default set.
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: undefined,
        tagIds: undefined,
      }
    );
  });

  it("enables shared rank ordering only for viewers in the rollout", async () => {
    mocks.manualOrderingEnabled = true;
    mocks.getManuallyOrderedAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getManuallyOrderedAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      mocks.user.id,
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: undefined,
        tagIds: undefined,
      }
    );
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("scopes to the authenticated caller's organization, never a caller-supplied one", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&organizationId=${OTHER_ORGANIZATION_ID}`
      ),
      routeContext()
    );

    // The unsupported `organizationId` param is rejected outright rather than
    // accepted and quietly dropped.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects an unsupported filter param instead of silently ignoring it", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&updatedSince=2026-01-01`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a missing assigneeId", async () => {
    const response = await GET(request(""), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid assigneeId", async () => {
    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=not-a-uuid`),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes one status occurrence as a single-element filter", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=${IssueStatus.Todo}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: [IssueStatus.Todo],
        tagIds: undefined,
      }
    );
  });

  it.each([
    ["tagId", ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS],
    ["projectId", MAX_PROJECT_FILTER_VALUES],
  ])("rejects more than %s distinct %s values", async (param, cap) => {
    const over = Array.from(
      { length: cap + 1 },
      (_unused, index) =>
        `${param}=0a0a0a0a-0a0a-7a0a-8a0a-${String(index).padStart(12, "0")}`
    ).join("&");

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&${over}`
      ),
      routeContext()
    );

    // Rejected WHOLE rather than truncated (ISS-9073): a silently trimmed list
    // answers a narrower question than the caller asked and says nothing.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("dedupes a repeated value before the cap is applied", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });
    const repeated = Array.from(
      { length: ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS + 50 },
      () => `tagId=${TAG_ID}`
    ).join("&");

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&${repeated}`
      ),
      routeContext()
    );

    // ISS-7271: the cap bounds DISTINCT values, so one value repeated past it
    // parses rather than 400ing. This is also why the status and priority caps
    // are unreachable — both vocabularies are closed and smaller than their cap,
    // so no request can present more distinct members than the cap allows.
    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tagIds: [TAG_ID] })
    );
  });

  it("keeps EVERY occurrence of a repeated status", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=${IssueStatus.Todo}&status=${IssueStatus.InProgress}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    // The defect this shape exists to prevent: a reader that keeps one value per
    // key answers `?status=TODO&status=IN_PROGRESS` with IN_PROGRESS alone and
    // never says TODO was dropped.
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: [IssueStatus.Todo, IssueStatus.InProgress],
        tagIds: undefined,
      }
    );
  });

  it("accepts a document-vocabulary status, which no artifact type restricts", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=${DocumentStatus.Obsolete}`
      ),
      routeContext()
    );

    // An off-vocabulary row (a FEATURE carrying OBSOLETE) exists in production,
    // so refusing the combination would make exactly those rows unreachable
    // through the filter that exists to find them.
    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: [DocumentStatus.Obsolete],
        tagIds: undefined,
      }
    );
  });

  it("rejects a status outside both lifecycle vocabularies", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=NOT_A_STATUS`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a blank status occurrence instead of reading it as no filter", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=`
      ),
      routeContext()
    );

    // Widening to the whole population behind a parameter the caller believes
    // narrowed it is the same lie a page-scoped filter tells.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects one bad element among otherwise valid occurrences", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=${IssueStatus.Todo}&status=NOT_A_STATUS`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes the unset priority token through to the service", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&priority=${PRIORITY_UNSET_VALUE}`
      ),
      routeContext()
    );

    // "No priority" is a value the facet selects, so the token has to survive
    // the boundary rather than being read as an absent filter (ISS-9665).
    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: [PRIORITY_UNSET_VALUE],
        projectIds: undefined,
        status: undefined,
        tagIds: undefined,
      }
    );
  });

  it("keeps every occurrence of a repeated priority", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&priority=${Priority.Urgent}&priority=${Priority.High}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: [Priority.Urgent, Priority.High],
        projectIds: undefined,
        status: undefined,
        tagIds: undefined,
      }
    );
  });

  it("carries both facets when both are requested", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&status=${IssueStatus.Todo}&priority=${Priority.Urgent}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: [Priority.Urgent],
        projectIds: undefined,
        status: [IssueStatus.Todo],
        tagIds: undefined,
      }
    );
  });

  it("rejects a priority outside the filter vocabulary", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&priority=SOMEDAY`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a blank priority occurrence instead of reading it as no filter", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&priority=`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes repeated tagId occurrences through as a list", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&tagId=${TAG_ID}&tagId=${OTHER_TAG_ID}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      {
        dateWindow: undefined,
        favoritesOnly: undefined,
        hideCompletedItems: undefined,
        priority: undefined,
        projectIds: undefined,
        status: undefined,
        tagIds: [TAG_ID, OTHER_TAG_ID],
      }
    );
  });

  it("rejects a tagId that is not a uuid", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&tagId=not-a-uuid`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a blank tagId occurrence instead of reading it as no filter", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&tagId=`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes repeated projectId occurrences through as a list", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&projectId=${PROJECT_A}&projectId=${PROJECT_B}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      expect.objectContaining({ projectIds: [PROJECT_A, PROJECT_B] })
    );
  });

  it("rejects a projectId that is not a uuid", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&projectId=PRO-57`
      ),
      routeContext()
    );

    // The route takes ids, not user-facing slugs: accepting a slug it cannot
    // resolve would narrow to nothing while the caller believed it had filtered.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a blank projectId occurrence instead of reading it as no filter", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&projectId=`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes favoritesOnly=true through to the service", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&favoritesOnly=true`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      // The viewer identity the favorites predicate scopes to comes from the
      // authenticated caller, never from the query string.
      mocks.user.id,
      expect.objectContaining({ favoritesOnly: true })
    );
  });

  it("passes favoritesOnly=false through as false, not as omitted", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&favoritesOnly=false`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      expect.objectContaining({ favoritesOnly: false })
    );
  });

  it("rejects a favoritesOnly that is not true or false", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&favoritesOnly=1`
      ),
      routeContext()
    );

    // Reject-don't-guess: coercing "1" to a falsy default would switch the chip
    // off behind the caller's back.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes hideCompletedItems=true through to the service", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&hideCompletedItems=true`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      expect.objectContaining({ hideCompletedItems: true })
    );
  });

  it("passes hideCompletedItems=false through as false, not as omitted", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&hideCompletedItems=false`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      expect.objectContaining({ hideCompletedItems: false })
    );
  });

  it("rejects a hideCompletedItems that is not true or false", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&hideCompletedItems=yes`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("passes a complete date window through as instants", async () => {
    mocks.getAssignedArtifactTree.mockResolvedValue({
      nodes: [],
      externalParents: [],
    });

    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&dateField=${ArtifactDateField.CreatedAt}&dateFrom=${encodeURIComponent(FROM_ISO)}&dateTo=${encodeURIComponent(TO_ISO)}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      expect.anything(),
      expect.objectContaining({
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: new Date(FROM_ISO),
          to: new Date(TO_ISO),
        },
      })
    );
  });

  it("rejects a partial date window rather than honouring one end", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&dateFrom=${encodeURIComponent(FROM_ISO)}`
      ),
      routeContext()
    );

    // Honouring a lone `from` would answer a question the caller did not ask;
    // dropping it would return the whole population behind a filter the UI
    // still shows as active.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects an inverted date window", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&dateField=${ArtifactDateField.CreatedAt}&dateFrom=${encodeURIComponent(TO_ISO)}&dateTo=${encodeURIComponent(FROM_ISO)}`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects a datetime with no timezone offset", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&dateField=${ArtifactDateField.CreatedAt}&dateFrom=2026-06-01T00:00:00&dateTo=${encodeURIComponent(TO_ISO)}`
      ),
      routeContext()
    );

    // A bare local timestamp names a different instant per reader, which defeats
    // the reason the window is resolved before it reaches the wire.
    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("rejects an unknown dateField", async () => {
    const response = await GET(
      request(
        `${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&dateField=DUE_DATE&dateFrom=${encodeURIComponent(FROM_ISO)}&dateTo=${encodeURIComponent(TO_ISO)}`
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("returns a 500 envelope when the service throws", async () => {
    mocks.getAssignedArtifactTree.mockRejectedValue(new Error("boom"));

    const response = await GET(
      request(`${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`),
      routeContext()
    );

    expect(response.status).toBe(500);
  });
});
