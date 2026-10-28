import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  ArtifactSubtype: { PRD: "PRD", IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN" },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
    UNINSTALLED: "UNINSTALLED",
    PENDING_CLAIM: "PENDING_CLAIM",
    SUSPENDED: "SUSPENDED",
  },
}));

vi.mock("@repo/google", () => ({
  exchangeCodeForTokens: vi.fn(),
  exportDocAsMarkdown: vi.fn(),
  getUserInfo: vi.fn(),
  listDocsInFolder: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
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
  resolveEncryptedIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
  buildIntegrationTokenColumns: vi.fn(),
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getLatest: vi.fn() },
}));

import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype } from "@repo/database";
import { revokeToken } from "@repo/google";
import {
  createLinearClient,
  extractTasksWithLLM,
  getTeams,
  refreshAccessToken,
} from "@repo/linear";
import {
  createModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { documentVersionService } from "@/app/documents/document-version-service";
import { publicRepositoryService } from "@/app/integrations/github/public-repositories/service";
import { googleService } from "@/app/integrations/google/service";
import { linearService } from "@/app/integrations/linear/service";
import {
  buildIntegrationTokenColumns,
  resolveEncryptedIntegrationToken,
} from "@/lib/integration-encryption";
import { mockWithDbAll } from "../utils/db-helpers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "33333333-3333-4333-8333-333333333333";
const REPO_ID = "44444444-4444-4444-8444-444444444444";

const mockResolveEncryptedToken = resolveEncryptedIntegrationToken as Mock;
const mockBuildTokenColumns = buildIntegrationTokenColumns as Mock;
const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockRevokeToken = revokeToken as Mock;
const mockCreateLinearClient = createLinearClient as Mock;
const mockGetTeams = getTeams as Mock;
const mockExtractTasksWithLLM = extractTasksWithLLM as Mock;
const mockGetLatestVersion = documentVersionService.getLatest as Mock;

function googleRow(overrides: Row = {}): Row {
  return {
    id: "google-1",
    organizationId: ORG_ID,
    googleUserId: "guser-1",
    googleEmail: "person@example.com",
    accessTokenEncrypted: "google-encrypted-access",
    refreshTokenEncrypted: "google-encrypted-refresh",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function linearRow(overrides: Row = {}): Row {
  return {
    id: "linear-1",
    organizationId: ORG_ID,
    accessTokenEncrypted: "linear-encrypted-access",
    refreshTokenEncrypted: "linear-encrypted-refresh",
    tokenExpiresAt: null,
    linearOrgId: "lin-org-1",
    linearOrgName: "Acme",
    defaultTeamId: "team-1",
    webhookId: null,
    webhookSecret: "linear-webhook-secret",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEncryptedToken.mockImplementation((encrypted: string | null) =>
    Promise.resolve(encrypted)
  );
  // What the shared builder hands a write path on its normal, encrypt-
  // succeeded route: ciphertext only.
  mockBuildTokenColumns.mockResolvedValue({
    accessTokenEncrypted: "linear-fresh-access-ciphertext",
    refreshTokenEncrypted: "linear-fresh-refresh-ciphertext",
  });
});

describe("google integration status read", () => {
  it("still renders the connected account email from the narrowed row", async () => {
    const googleIntegration = createModelDouble([googleRow()]);
    mockWithDbAll({ googleIntegration });

    const result = await googleService.getIntegrationStatus(ORG_ID);

    expect(result).toEqual({
      success: true,
      connected: true,
      email: "person@example.com",
    });
  });

  it("hands getIntegration's callers exactly the columns the token helper reads", async () => {
    const googleIntegration = createModelDouble([googleRow()]);
    mockWithDbAll({ googleIntegration });

    await googleService.getIntegration(ORG_ID);

    // Exact, so this reddens on a dropped column AND on a widened select —
    // the two routes that consume this row pass it straight to
    // `ensureValidAccessToken` and read nothing else.
    expect(googleIntegration.returnedColumns).toEqual([
      ["accessTokenEncrypted", "refreshTokenEncrypted", "tokenExpiresAt"],
    ]);
  });

  it("revokes the encrypted-derived token on disconnect", async () => {
    const googleIntegration = createModelDouble([googleRow()]);
    mockWithDbAll({ googleIntegration });

    await googleService.disconnect(ORG_ID);

    // Reddens if `accessTokenEncrypted` leaves GOOGLE_TOKEN_SELECT: the row
    // would resolve no token and nothing would be revoked.
    expect(mockRevokeToken).toHaveBeenCalledWith("google-encrypted-access");
  });

  it("never pulls a Google credential column for a status check", async () => {
    const googleIntegration = createModelDouble([googleRow()]);
    mockWithDbAll({ googleIntegration });

    await googleService.getIntegrationStatus(ORG_ID);

    expect(googleIntegration.returnedColumns).toEqual([["googleEmail"]]);
  });
});

describe("linear token refresh through the narrowed row", () => {
  it("refreshes an expired token and exports an approved plan with the NEW access token", async () => {
    const rows = [
      linearRow({ tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    ];
    const linearIntegration = createModelDouble(rows);
    const artifact = createModelDouble([
      {
        id: DOC_ID,
        organizationId: ORG_ID,
        type: "DOCUMENT",
        subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
        status: DocumentStatus.Approved,
      },
    ]);
    mockWithDbAll({ linearIntegration, artifact });
    mockGetLatestVersion.mockResolvedValue({ content: "- [ ] Task" });
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "linear-fresh-access",
      refreshToken: "linear-fresh-refresh",
      expiresIn: 3600,
    });
    mockCreateLinearClient.mockReturnValue({});
    mockGetTeams.mockResolvedValue([{ id: "team-1", name: "T", key: "T" }]);
    mockExtractTasksWithLLM.mockResolvedValue([]);

    const result = await linearService.exportImplementationPlan(
      DOC_ID,
      "team-1",
      ORG_ID,
      "user-1"
    );

    // The success path is also the only falsifiable guard on the artifact
    // gate's narrowed columns: dropping `subtype` or `status` from that select
    // makes each read `undefined`, which fails the gate and reddens this. The
    // two reject-branch tests drafted alongside it were deleted — they expect
    // the same rejection an absent column produces, so they pass whether the
    // select is right or missing the column entirely.
    expect(result).toEqual({ success: true, issuesCreated: 0, issues: [] });
    // Reddens if `refreshTokenEncrypted` leaves the select: the expired row
    // would then not be refreshed at all.
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(
      "linear-encrypted-refresh"
    );
    expect(mockCreateLinearClient).toHaveBeenCalledWith("linear-fresh-access");
    // The write-back must land on the row the narrowed read identified, with
    // the columns the builder produced.
    expect(mockBuildTokenColumns).toHaveBeenCalledWith(
      "linear-fresh-access",
      "linear-fresh-refresh"
    );
    expect(rows[0]?.accessTokenEncrypted).toBe(
      "linear-fresh-access-ciphertext"
    );
  });

  it("never pulls the Linear webhook secret for an export", async () => {
    const linearIntegration = createModelDouble([linearRow()]);
    const artifact = createModelDouble([
      {
        id: DOC_ID,
        organizationId: ORG_ID,
        type: "DOCUMENT",
        subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
        status: DocumentStatus.Approved,
      },
    ]);
    mockWithDbAll({ linearIntegration, artifact });
    mockGetLatestVersion.mockResolvedValue({ content: "- [ ] Task" });
    mockCreateLinearClient.mockReturnValue({});
    mockGetTeams.mockResolvedValue([{ id: "team-1", name: "T", key: "T" }]);
    mockExtractTasksWithLLM.mockResolvedValue([]);

    await linearService.exportImplementationPlan(
      DOC_ID,
      "team-1",
      ORG_ID,
      "user-1"
    );

    // Guard first: with no read at all this assertion would be vacuously true.
    expect(linearIntegration.returnedColumns.length).toBeGreaterThan(0);
    expect(linearIntegration.returnedColumns.flat()).not.toContain(
      "webhookSecret"
    );
  });
});

describe("linear integration status", () => {
  it("renders the workspace name and default team from the narrowed row", async () => {
    const linearIntegration = createModelDouble([linearRow()]);
    mockWithDbAll({ linearIntegration });
    mockCreateLinearClient.mockReturnValue({});
    mockGetTeams.mockResolvedValue([{ id: "team-1", name: "T", key: "T" }]);

    const result = await linearService.getIntegrationStatus(ORG_ID);

    // `linearOrgName` and `defaultTeamId` are the two columns this read adds on
    // top of LINEAR_TOKEN_SELECT; nothing else in the repo asserts them, so
    // dropping either would otherwise go straight to `undefined` in the payload.
    expect(result).toEqual({
      success: true,
      connected: true,
      organizationName: "Acme",
      defaultTeamId: "team-1",
      teams: [{ id: "team-1", name: "T", key: "T" }],
    });
  });
});

describe("public repository branch fetch", () => {
  it("addresses the outbound GitHub call with the narrowed coordinates", async () => {
    const publicRepository = createModelDouble([
      {
        id: REPO_ID,
        organizationId: ORG_ID,
        githubRepoId: "999",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        htmlUrl: "https://github.com/acme/widgets",
        defaultBranchName: "main",
      },
    ]);
    mockWithDbAll({ publicRepository });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        requestedUrls.push(String(input));
        return Promise.resolve(new Response("", { status: 404 }));
      })
    );

    // The scrape 404s, which is fine — the assertion is the address it used.
    await expect(
      publicRepositoryService.getBranches(REPO_ID, ORG_ID, 5)
    ).rejects.toThrow("Failed to fetch branches from GitHub");

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/acme/widgets/");
  });
});
