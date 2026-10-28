import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockValidateGitHubOidcToken,
  mockCreateSchemaUrlMinter,
  mockCreateSslClient,
  mockResolvePersonClerkIdentity,
} = vi.hoisted(() => ({
  mockValidateGitHubOidcToken: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockCreateSslClient: vi.fn(),
  mockResolvePersonClerkIdentity: vi.fn(),
}));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@repo/database/scripts/iam-database-url", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/iam-database-url")
  >("@repo/database/scripts/iam-database-url");
  return { ...actual, createSchemaUrlMinter: mockCreateSchemaUrlMinter };
});

vi.mock("@repo/database/scripts/db-utils", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/db-utils")
  >("@repo/database/scripts/db-utils");
  return { ...actual, createSslClient: mockCreateSslClient };
});

// The Clerk lookup is driven with synthetic answers by
// `app/preview-schemas/vibe-environment/service/person-identity.test.ts`.
vi.mock(
  "@/app/preview-schemas/vibe-environment/service/person-identity",
  () => ({ resolvePersonClerkIdentity: mockResolvePersonClerkIdentity })
);

import {
  VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
  VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
  VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
  VibeEnvironmentOrgChoice,
} from "@/app/preview-schemas/vibe-environment/constants";
import { POST as PERSON } from "@/app/preview-schemas/vibe-environment/person/route";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const BRANCH = "vibe/bulk-tags";
const CLERK_ORG = "org_2abcPersonActive";
const PERSON_EMAIL = "andy@closedloop.example";

function check(body: unknown) {
  const request = new Request(
    "https://api.stage.example/preview-schemas/vibe-environment/person",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: "Bearer test-oidc-token" },
    }
  );
  return PERSON(request as Parameters<typeof PERSON>[0]);
}

describe("ISS-12135 vibe environment person check", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
    mockResolvePersonClerkIdentity.mockResolvedValue({
      clerkUserId: "user_2abcPerson",
      clerkOrgId: CLERK_ORG,
      clerkOrgName: "Side Project",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.Requested,
    });
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/vercel");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("PGUSER", "vercel_iam");
    vi.stubEnv("PGDATABASE", "closedloop");
    vi.stubEnv("STAGE_PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "green");
    vi.stubEnv("PGSCHEMA", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers the bound org for an admin, authenticated as the vibe environment caller, without opening the database", async () => {
    const response = await check({
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
      clerkOrgId: CLERK_ORG,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        branch: BRANCH,
        clerkOrgId: CLERK_ORG,
        personOrgAdmin: true,
        clerkOrgName: "Side Project",
        clerkOrgChosenBy: VibeEnvironmentOrgChoice.Requested,
      },
    });
    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(
      expect.anything(),
      { caller: GitHubOidcCaller.PreviewSchemaVibeEnvironment }
    );
    expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
      PERSON_EMAIL,
      CLERK_ORG,
      undefined,
      { requireAdmin: true }
    );
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it.each([
    [
      VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
      `The person is not an admin of Clerk org Side Project (${CLERK_ORG})`,
      [{ id: CLERK_ORG, name: "Side Project", isAdmin: false }],
    ],
    [
      VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
      `The person is not an admin of any of their 1 stage Clerk orgs: Side Project (${CLERK_ORG})`,
      [{ id: CLERK_ORG, name: "Side Project", isAdmin: false }],
    ],
  ])(
    "answers the %s refusal with each org's name, id and admin flag",
    async (code, refused, clerkOrgs) => {
      mockResolvePersonClerkIdentity.mockResolvedValue({
        refused,
        code,
        clerkOrgs,
      });

      const response = await check({
        branch: BRANCH,
        personEmail: PERSON_EMAIL,
      });

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toContain(refused);
      expect(body.code).toBe(code);
      expect(body.details).toEqual({ clerkOrgs });
    }
  );

  it("answers the org it chose itself for a request without clerk_org_id, as an older skill sends", async () => {
    mockResolvePersonClerkIdentity.mockResolvedValue({
      clerkUserId: "user_2abcPerson",
      clerkOrgId: CLERK_ORG,
      clerkOrgName: "Side Project",
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.LastActive,
    });

    const response = await check({ branch: BRANCH, personEmail: PERSON_EMAIL });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      clerkOrgId: CLERK_ORG,
      clerkOrgChosenBy: VibeEnvironmentOrgChoice.LastActive,
    });
    expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
      PERSON_EMAIL,
      undefined,
      undefined,
      { requireAdmin: true }
    );
  });

  it("refuses a person Clerk cannot resolve, with the lookup's reason", async () => {
    mockResolvePersonClerkIdentity.mockResolvedValue({
      refused: "No stage Clerk user has that email",
    });

    const response = await check({ branch: BRANCH, personEmail: PERSON_EMAIL });

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain(
      "No stage Clerk user has that email"
    );
  });

  it("answers an ambiguous person with the same code and org list as finalize", async () => {
    const clerkOrgs = [
      { id: "org_2abcOne", name: "Acme", isAdmin: true },
      { id: "org_2abcTwo", name: "Globex", isAdmin: true },
    ];
    mockResolvePersonClerkIdentity.mockResolvedValue({
      refused: "The person belongs to 2 stage Clerk orgs",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs,
    });

    const response = await check({ branch: BRANCH, personEmail: PERSON_EMAIL });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe(VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS);
    expect(body.details).toEqual({ clerkOrgs });
  });

  it("refuses on a branch preview deployment, before asking Clerk", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", BRANCH);

    const response = await check({ branch: BRANCH, personEmail: PERSON_EMAIL });

    expect(response.status).toBe(403);
    expect(mockResolvePersonClerkIdentity).not.toHaveBeenCalled();
  });
});
