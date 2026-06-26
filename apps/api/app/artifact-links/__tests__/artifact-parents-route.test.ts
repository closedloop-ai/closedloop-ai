import { LinkType } from "@repo/api/src/types/artifact";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  findSelectedParentProjections: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("../service", () => ({
  artifactLinksService: {
    findSelectedParentProjections: mocks.findSelectedParentProjections,
  },
}));

import { GET } from "../parents/route";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const PR_ID = "22222222-2222-4222-8222-222222222222";

function request(query: string) {
  return new NextRequest(
    `https://api.example.test/artifact-links/parents?${query}`
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("GET /artifact-links/parents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns selected parent projections for repeated targetIds query params", async () => {
    const projections = [
      {
        targetId: DOC_ID,
        linkId: "link-1",
        linkType: LinkType.Produces,
        linkCreatedAt: "2026-05-13T00:00:00.000Z",
        parentArtifact: {
          id: "parent-doc-1",
          type: "DOCUMENT",
          subtype: "PRD",
          name: "Parent PRD",
          slug: "PRD-1",
          externalUrl: null,
        },
      },
      {
        targetId: PR_ID,
        linkId: "link-2",
        linkType: LinkType.Produces,
        linkCreatedAt: "2026-05-13T00:00:00.000Z",
        parentArtifact: {
          id: "parent-pr-1",
          type: "BRANCH",
          subtype: null,
          name: "PR #1170",
          slug: null,
          externalUrl:
            "https://github.com/closedloop-ai/symphony-alpha/pull/1170",
        },
      },
    ];
    mocks.findSelectedParentProjections.mockResolvedValue(projections);

    const response = await GET(
      request(`targetIds=${DOC_ID}&targetIds=${PR_ID}`),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(projections);
    expect(mocks.findSelectedParentProjections).toHaveBeenCalledWith(
      "org-1",
      [DOC_ID, PR_ID],
      { linkType: LinkType.Produces }
    );
  });

  it("returns explicit null parent projections", async () => {
    mocks.findSelectedParentProjections.mockResolvedValue([
      {
        targetId: DOC_ID,
        linkId: null,
        linkType: null,
        linkCreatedAt: null,
        parentArtifact: null,
      },
    ]);

    const response = await GET(request(`targetIds=${DOC_ID}`), routeContext());
    const body = await response.json();

    expect(body.data[0]).toEqual({
      targetId: DOC_ID,
      linkId: null,
      linkType: null,
      linkCreatedAt: null,
      parentArtifact: null,
    });
  });

  it("rejects empty targetIds", async () => {
    const response = await GET(request("targetIds="), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.findSelectedParentProjections).not.toHaveBeenCalled();
  });

  it("rejects more than 100 target ids", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`
    );

    const response = await GET(
      request(ids.map((id) => `targetIds=${id}`).join("&")),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findSelectedParentProjections).not.toHaveBeenCalled();
  });

  it("rejects comma-separated targetIds", async () => {
    const response = await GET(
      request(`targetIds=${DOC_ID},${PR_ID}`),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.findSelectedParentProjections).not.toHaveBeenCalled();
  });
});
