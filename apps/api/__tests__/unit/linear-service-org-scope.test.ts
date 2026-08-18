/**
 * FEA-1749 Phase 5 — org-scoping of the Linear export artifact lookup.
 *
 * `exportImplementationPlan` used to authorize the artifact THROUGH the Project
 * relation (`where: { project: { organizationId } }`). That is an implicit inner
 * join: an artifact with no project matches no Project row, so the lookup
 * resolves to null and the route 404s — a silent, authorization-shaped failure
 * for a document that the caller's org legitimately owns.
 *
 * The fix scopes on `Artifact.organizationId`, the org SSOT (PRD-510 FR13),
 * matching every other by-id DOCUMENT read in the codebase (`document-service`
 * uses `where: { id, organizationId }` throughout).
 *
 * These are UNIT tests over a mocked Prisma, so they assert the WHERE CLAUSE the
 * service builds rather than the rows a database would return — the mock cannot
 * evaluate a relation filter, so a "returns the row" assertion here would pass
 * with or without the fix and prove nothing. The query shape IS the fix, so
 * asserting it is red before and green after. The behavioural counterpart (a
 * real cross-org row resolving to not-found against Postgres) lives in
 * `__tests__/integration/linear-export-org-scope.test.ts`.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

vi.mock("@repo/linear", () => ({
  createLinearClient: vi.fn(),
  createIssues: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  extractTasksWithLLM: vi.fn(),
  formatTaskForLinear: vi.fn(),
  getTeams: vi.fn(),
  getViewer: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: vi.fn(),
  decryptIntegrationToken: vi.fn(),
  resolveIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
  },
}));

import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType } from "@repo/database";
import {
  createIssues,
  createLinearClient,
  extractTasksWithLLM,
  formatTaskForLinear,
  getTeams,
} from "@repo/linear";
import { documentVersionService } from "@/app/documents/document-version-service";
import { linearService } from "@/app/integrations/linear/service";
import { resolveIntegrationToken } from "@/lib/integration-encryption";

const mockCreateIssues = createIssues as Mock;
const mockCreateLinearClient = createLinearClient as Mock;
const mockExtractTasksWithLLM = extractTasksWithLLM as Mock;
const mockFormatTaskForLinear = formatTaskForLinear as Mock;
const mockGetTeams = getTeams as Mock;
const mockResolveIntegrationToken = resolveIntegrationToken as Mock;
const mockDocumentVersionServiceGetLatest =
  documentVersionService.getLatest as Mock;

const ORG_ID = "org-test-123";
const DOCUMENT_ID = "doc-test-456";
const TEAM_ID = "team-test-789";
const USER_ID = "user-test-001";

function makeLinearIntegration() {
  return {
    id: "integ-1",
    organizationId: ORG_ID,
    accessToken: "plaintext-access-token",
    refreshToken: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    linearOrgId: "linear-org-1",
    linearOrgName: "Test Org",
    defaultTeamId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("Linear exportImplementationPlan — artifact org-scoping (FEA-1749)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the artifact lookup on the artifact's own organizationId, never through the Project relation", async () => {
    // The lookup is the only thing under test; returning null short-circuits the
    // export immediately after it, which keeps the test focused on the query.
    const mockDb = {
      artifact: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbCall(mockDb);

    const result = await linearService.exportImplementationPlan(
      DOCUMENT_ID,
      TEAM_ID,
      ORG_ID,
      USER_ID
    );

    expect(result).toMatchObject({ success: false, status: 404 });

    const where = mockDb.artifact.findFirst.mock.calls[0][0].where;

    // Isolation is preserved: the query still constrains the org. This is the
    // assertion that matters — the fix touches an authorization-adjacent query,
    // so prove it did not simply drop the org predicate and widen access.
    expect(where.organizationId).toBe(ORG_ID);

    // ...and it does so WITHOUT joining through Project. This is the regression:
    // a `project` relation filter silently excludes unparented artifacts.
    expect(where.project).toBeUndefined();

    expect(where).toEqual({
      id: DOCUMENT_ID,
      type: ArtifactType.DOCUMENT,
      organizationId: ORG_ID,
    });
  });

  it("exports an implementation plan whose projectId is null", async () => {
    // Guards the rest of exportImplementationPlan, not the query: proves nothing
    // downstream of the lookup reads `projectId`, so an unparented plan exports
    // exactly like a parented one once FEA-1749 Phase 1 lets the row exist.
    mockResolveIntegrationToken.mockResolvedValue("plaintext-access-token");
    mockExtractTasksWithLLM.mockResolvedValue([
      { title: "Task 1", description: "Do task 1", isCompleted: false },
    ]);
    mockFormatTaskForLinear.mockReturnValue({
      title: "Task 1",
      description: "Do task 1",
    });
    mockGetTeams.mockResolvedValue([{ id: TEAM_ID, name: "Eng", key: "ENG" }]);
    mockCreateIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "ENG-1",
        url: "https://linear.app/issue/ENG-1",
        title: "Task 1",
      },
    ]);
    mockCreateLinearClient.mockReturnValue({});
    mockDocumentVersionServiceGetLatest.mockResolvedValue({
      content: "# Implementation Plan\n\n## Tasks",
    });

    const unparentedPlan = {
      id: DOCUMENT_ID,
      type: ArtifactType.DOCUMENT,
      subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
      status: DocumentStatus.Approved,
      organizationId: ORG_ID,
      projectId: null,
    };

    const mockDb = {
      artifact: { findFirst: vi.fn().mockResolvedValue(unparentedPlan) },
      linearIntegration: {
        findUnique: vi.fn().mockResolvedValue(makeLinearIntegration()),
      },
      linearSubtask: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockWithDbCall(mockDb);

    const result = await linearService.exportImplementationPlan(
      DOCUMENT_ID,
      TEAM_ID,
      ORG_ID,
      USER_ID
    );

    expect(result).toMatchObject({ success: true, issuesCreated: 1 });
  });
});
