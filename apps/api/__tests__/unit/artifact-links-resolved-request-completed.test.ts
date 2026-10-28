/**
 * ISS-9053. `GET /artifact-links/resolved` goes through `withAnyAuth`, whose
 * wrapper emits `request_completed` from its `finally`, so an in-process 5xx on
 * this route is already recorded. The daily 5xx the ticket found missing were
 * invocations at the function's memory ceiling — every one of their platform
 * REPORT lines reads `Max Memory Used: 2048 MB` of 2048 — and a process that
 * dies there never reaches any `finally`.
 *
 * This pins the half an in-process emit can see, through the real wrapper. The
 * route's dispatch suite mocks `withAnyAuth` away, so nothing else would notice
 * this route's error path losing its record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth/server", () => ({ auth: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: vi.fn(),
}));

vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: vi.fn(),
}));

// A request with no bearer token routes to `withAuth`; the other two lanes
// are never reached, so their dependency graphs need not load.
vi.mock("@/lib/auth/with-api-key-auth", () => ({ withApiKeyAuth: vi.fn() }));
vi.mock("@/lib/auth/with-desktop-session-auth", () => ({
  withDesktopSessionAuth: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/identifier-utils")>()),
  resolveArtifactIdentifier: vi.fn(),
}));

vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: {
    findResolvedLinksPage: vi.fn(),
    findResolvedLinkTreePage: vi.fn(),
  },
}));

import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { GET } from "@/app/artifact-links/resolved/route";
import { artifactLinksService } from "@/app/artifact-links/service";
import { findOrCreateUser } from "@/lib/auth/find-or-create-user";
import { resolveOrgHeader } from "@/lib/auth/resolve-org-header";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import { REQUEST_COMPLETED_EVENT } from "@/lib/route-utils";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const ARTIFACT_UUID = "11111111-1111-1111-1111-111111111111";
const CLERK_ORG_ID = "org_clerk_resolved";

describe("GET /artifact-links/resolved request_completed (ISS-9053)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      userId: "user_clerk_resolved",
      orgId: CLERK_ORG_ID,
      orgRole: "org:member",
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(resolveOrgHeader).mockResolvedValue({
      kind: "session",
      clerkOrgId: CLERK_ORG_ID,
      orgRole: "org:member",
    });
    vi.mocked(findOrCreateUser).mockResolvedValue(createTestAuthContext().user);
    vi.mocked(resolveArtifactIdentifier).mockResolvedValue(ARTIFACT_UUID);
  });

  it("records a failed resolved-links read at error with its path and status", async () => {
    vi.mocked(
      artifactLinksService.findResolvedLinkTreePage
    ).mockRejectedValueOnce(new Error("link traversal failed"));

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/artifact-links/resolved?artifactId=${ARTIFACT_UUID}&mode=tree`,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.objectContaining({
        method: "GET",
        path: "/artifact-links/resolved",
        status_code: 500,
      })
    );
    expect(log.info).not.toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.anything()
    );
  });
});
