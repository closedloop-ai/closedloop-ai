import { generateKeyPairSync } from "node:crypto";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  formatVibeEnvironmentMarker,
  type VibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "@repo/database/scripts/vibe-environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockValidateGitHubOidcToken,
  mockCreateSchemaUrlMinter,
  mockCreateSslClient,
  mockStageVibeSeedRows,
  mockRestoreStagedVibeSeedRows,
  mockPresignTranscriptPutObject,
  mockHeadTranscriptObject,
  mockResolvePersonClerkIdentity,
  mockGetUser,
  mockUpdateOrganization,
} = vi.hoisted(() => ({
  mockValidateGitHubOidcToken: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockCreateSslClient: vi.fn(),
  mockStageVibeSeedRows: vi.fn(),
  mockRestoreStagedVibeSeedRows: vi.fn(),
  mockPresignTranscriptPutObject: vi.fn(),
  mockHeadTranscriptObject: vi.fn(),
  mockResolvePersonClerkIdentity: vi.fn(),
  mockGetUser: vi.fn(),
  mockUpdateOrganization: vi.fn(),
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

// The restore itself is driven against real Postgres by
// `packages/database/__tests__/integration/iss12056-vibe-environment-restore.integration.test.ts`.
vi.mock("@repo/database/scripts/vibe-environment-restore", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/vibe-environment-restore")
  >("@repo/database/scripts/vibe-environment-restore");
  return {
    ...actual,
    stageVibeSeedRows: mockStageVibeSeedRows,
    restoreStagedVibeSeedRows: mockRestoreStagedVibeSeedRows,
  };
});

vi.mock("@repo/aws/transcript-storage", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/aws/transcript-storage")
  >("@repo/aws/transcript-storage");
  return {
    ...actual,
    presignTranscriptPutObject: mockPresignTranscriptPutObject,
    headTranscriptObject: mockHeadTranscriptObject,
  };
});

// The Clerk lookup is driven with synthetic answers by
// `app/preview-schemas/vibe-environment/service/person-identity.test.ts`.
vi.mock(
  "@/app/preview-schemas/vibe-environment/service/person-identity",
  () => ({ resolvePersonClerkIdentity: mockResolvePersonClerkIdentity })
);

vi.mock("@/lib/auth/clerk-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/clerk-service")
  >("@/lib/auth/clerk-service");
  return {
    ...actual,
    clerkService: {
      ...actual.clerkService,
      getUser: mockGetUser,
      updateOrganization: mockUpdateOrganization,
    },
  };
});

import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import {
  VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
  VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
  VibeEnvironmentOrgChoice,
} from "@/app/preview-schemas/vibe-environment/constants";
import { POST as DESKTOP_SESSION } from "@/app/preview-schemas/vibe-environment/desktop-session/route";
import { POST as FINALIZE } from "@/app/preview-schemas/vibe-environment/finalize/route";
import { POST as OBJECTS } from "@/app/preview-schemas/vibe-environment/objects/route";
import { POST as ROWS } from "@/app/preview-schemas/vibe-environment/rows/route";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const BRANCH = "vibe/bulk-tags";
const SCHEMA = deriveBranchSchemaName(BRANCH, normalizePreviewSchemaName);
const PREFIX = `vibe-environments/${SCHEMA}/`;
const CLERK_ORG = "org_2abcPersonActive";
const CLERK_USER = "user_2abcPerson";
const CLERK_ORG_NAME = "ClosedLoop";
const PERSON_EMAIL = "andy@closedloop.example";
const TRANSCRIPT_KEY = "0199a000-0000-7000-8000-00000000000a/ct-1/s-1.jsonl";
const PERSON_PROFILE = {
  id: CLERK_USER,
  email: PERSON_EMAIL,
  firstName: "Andy",
  lastName: "Person",
  imageUrl: "https://img.clerk.example/andy.png",
  phoneNumber: "+15550100",
};
const STAND_IN_ROW = "0199a000-0000-7000-8000-0000000000aa";
const SEEDED_ORG_ROW = "0199a000-0000-7000-8000-0000000000bb";
const SEEDED_PENDING = {
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Pending,
};

type Handler = (request: Parameters<typeof ROWS>[0]) => Promise<Response>;

function call(handler: Handler, path: string, body: unknown) {
  const request = new Request(
    `https://api.stage.example/preview-schemas/vibe-environment/${path}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: "Bearer test-oidc-token" },
    }
  );
  return handler(request as Parameters<typeof ROWS>[0]);
}

/** A pg client whose schema comment is `marker` and whose other reads are `rows`. */
function fakeClient(
  marker: VibeEnvironmentMarker | null,
  transcriptRows: { id: string; key: string }[] = []
) {
  const issued: { sql: string; params?: unknown[] }[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string, params?: unknown[]) => {
      issued.push({ sql, params });
      if (sql.includes("obj_description")) {
        return Promise.resolve({
          rows: [
            {
              comment:
                marker === null ? null : formatVibeEnvironmentMarker(marker),
            },
          ],
        });
      }
      if (sql.includes("object_storage_key AS key")) {
        return Promise.resolve({ rows: transcriptRows });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  mockCreateSslClient.mockReturnValue(client);
  return { client, issued };
}

describe("vibe environment routes", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
    mockStageVibeSeedRows.mockResolvedValue({ staged: 2 });
    mockRestoreStagedVibeSeedRows.mockResolvedValue({ tables: 3, rows: 40 });
    mockPresignTranscriptPutObject.mockResolvedValue(
      "https://s3.example/put?signed"
    );
    mockHeadTranscriptObject.mockResolvedValue({ etag: '"etag-1"' });
    mockResolvePersonClerkIdentity.mockResolvedValue({
      clerkUserId: CLERK_USER,
      clerkOrgId: CLERK_ORG,
      clerkOrgName: CLERK_ORG_NAME,
      isOrgAdmin: true,
      chosenBy: VibeEnvironmentOrgChoice.LastActive,
    });
    mockGetUser.mockResolvedValue(PERSON_PROFILE);
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
  });

  it("authenticates every route against the vibe environment caller", async () => {
    fakeClient(SEEDED_PENDING);
    await call(ROWS, "rows", { branch: BRANCH, table: "users", rows: "[]" });
    await call(OBJECTS, "objects", {
      branch: BRANCH,
      key: TRANSCRIPT_KEY,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });
    await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(mockValidateGitHubOidcToken).toHaveBeenCalledTimes(3);
    for (const [, options] of mockValidateGitHubOidcToken.mock.calls) {
      expect(options).toEqual({
        caller: GitHubOidcCaller.PreviewSchemaVibeEnvironment,
      });
    }
  });

  it("stages a batch as raw JSON text into the branch's preview schema", async () => {
    const { client } = fakeClient(SEEDED_PENDING);
    const rows = '[{"id":1,"byte_size":9007199254740993}]';

    const response = await call(ROWS, "rows", {
      branch: BRANCH,
      table: "users",
      rows,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { branch: BRANCH, schema: SCHEMA, table: "users", staged: 2 },
    });
    expect(mockCreateSslClient).toHaveBeenCalledWith(
      `postgresql://minted/${SCHEMA}`
    );
    expect(mockStageVibeSeedRows).toHaveBeenCalledWith(
      client,
      SCHEMA,
      "users",
      rows
    );
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an ordinary preview (no marker)", null],
    [
      "a blank vibe environment",
      { mode: VibeEnvironmentMode.Blank, state: VibeEnvironmentState.Ready },
    ],
    [
      "a seeded environment that is already ready",
      { mode: VibeEnvironmentMode.Seeded, state: VibeEnvironmentState.Ready },
    ],
  ])("refuses to load rows into %s", async (_label, marker) => {
    fakeClient(marker);

    const response = await call(ROWS, "rows", {
      branch: BRANCH,
      table: "users",
      rows: "[]",
    });

    expect(response.status).toBe(409);
    expect(mockStageVibeSeedRows).not.toHaveBeenCalled();
  });

  it("refuses on a branch preview deployment, before touching the database", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", BRANCH);
    fakeClient(SEEDED_PENDING);

    const response = await call(ROWS, "rows", {
      branch: BRANCH,
      table: "users",
      rows: "[]",
    });

    expect(response.status).toBe(403);
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("refuses when the deployment is not on the allowlisted stage host", async () => {
    vi.stubEnv("PGHOST", "prod.rds.amazonaws.com");
    fakeClient(SEEDED_PENDING);

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(response.status).toBe(403);
    expect(mockCreateSslClient).not.toHaveBeenCalled();
  });

  it("refuses a table name that is not a plain identifier", async () => {
    const response = await call(ROWS, "rows", {
      branch: BRANCH,
      table: 'users"; DROP SCHEMA public; --',
      rows: "[]",
    });

    expect(response.status).toBe(400);
    expect(mockStageVibeSeedRows).not.toHaveBeenCalled();
  });

  it("answers 422 with the restore's refusal", async () => {
    fakeClient(SEEDED_PENDING);
    mockStageVibeSeedRows.mockRejectedValue(
      new VibeSeedRestoreError(`${SCHEMA} has no table billing`)
    );

    const response = await call(ROWS, "rows", {
      branch: BRANCH,
      table: "billing",
      rows: "[]",
    });

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("has no table billing");
  });

  it("presigns a transcript upload under the schema's own key prefix", async () => {
    fakeClient(SEEDED_PENDING);

    const response = await call(OBJECTS, "objects", {
      branch: BRANCH,
      key: TRANSCRIPT_KEY,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        branch: BRANCH,
        schema: SCHEMA,
        uploadUrl: "https://s3.example/put?signed",
      },
    });
    expect(mockPresignTranscriptPutObject).toHaveBeenCalledWith({
      key: `${PREFIX}${TRANSCRIPT_KEY}`,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });
  });

  it.each([
    ["climbs out of the prefix", "../preview_other_1a2b3c4d/x.jsonl"],
    ["is absolute", "/etc/x.jsonl"],
    ["has an empty segment", "org//x.jsonl"],
  ])("refuses an object key that %s", async (_label, key) => {
    fakeClient(SEEDED_PENDING);

    const response = await call(OBJECTS, "objects", {
      branch: BRANCH,
      key,
      checksumCrc64Nvme: "AAAAAAAAAAA=",
    });

    expect(response.status).toBe(422);
    expect(mockPresignTranscriptPutObject).not.toHaveBeenCalled();
  });

  it("finalizes: restores, checks the org binding in the transaction, reconciles transcripts, then marks ready", async () => {
    const { client, issued } = fakeClient(SEEDED_PENDING, [
      { id: "t-1", key: TRANSCRIPT_KEY },
      { id: "t-2", key: "missing/ct/s.jsonl" },
    ]);
    mockHeadTranscriptObject.mockImplementation((key: string) =>
      Promise.resolve(
        key.endsWith(TRANSCRIPT_KEY) ? { etag: '"etag-1"' } : null
      )
    );
    const inTransactionQueries: { sql: string; params?: unknown[] }[] = [];
    mockRestoreStagedVibeSeedRows.mockImplementation(
      async (
        _client: unknown,
        _schema: string,
        _logger: unknown,
        inTransaction: (tx: {
          query: (sql: string, params?: unknown[]) => Promise<unknown>;
        }) => Promise<void>
      ) => {
        await inTransaction({
          query: (sql: string, params?: unknown[]) => {
            inTransactionQueries.push({ sql, params });
            if (sql.startsWith("SELECT 1")) {
              return Promise.resolve({ rows: [], rowCount: 0 });
            }
            if (sql.includes('"users" u') && sql.startsWith("UPDATE")) {
              return Promise.resolve({
                rows: [{ id: STAND_IN_ROW, organization_id: SEEDED_ORG_ROW }],
                rowCount: 1,
              });
            }
            return Promise.resolve({ rows: [], rowCount: 1 });
          },
        });
        return { tables: 3, rows: 40 };
      }
    );

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        branch: BRANCH,
        schema: SCHEMA,
        tables: 3,
        rows: 40,
        transcripts: { reconciled: 1, missing: 1 },
        clerkOrgId: CLERK_ORG,
        personOrgAdmin: true,
        boundOrg: {
          clerkOrgId: CLERK_ORG,
          name: CLERK_ORG_NAME,
          chosenBy: VibeEnvironmentOrgChoice.LastActive,
        },
        adoptedPerson: {
          userId: STAND_IN_ROW,
          clerkUserId: CLERK_USER,
          email: PERSON_PROFILE.email,
          name: `${PERSON_PROFILE.firstName} ${PERSON_PROFILE.lastName}`,
        },
      },
    });
    expect(mockRestoreStagedVibeSeedRows).toHaveBeenCalledWith(
      client,
      SCHEMA,
      expect.anything(),
      expect.any(Function)
    );
    expect(inTransactionQueries[0]?.sql).toContain(
      `UPDATE "${SCHEMA}"."organizations" SET clerk_id`
    );
    expect(inTransactionQueries[0]?.params).toEqual([
      CLERK_ORG,
      LOCAL_TRUSTED_ORG_ID,
      `${PERSON_PROFILE.email} Co`,
    ]);
    const adoptionIndex = inTransactionQueries.findIndex(
      (q) => q.sql.startsWith("UPDATE") && q.sql.includes('"users" u')
    );
    // After the org binding, which is the first statement.
    expect(adoptionIndex).toBeGreaterThan(0);
    const adoption = inTransactionQueries[adoptionIndex];
    expect(adoption?.sql).toContain(`UPDATE "${SCHEMA}"."users" u`);
    expect(adoption?.params).toEqual([
      CLERK_USER,
      PERSON_EMAIL,
      "Andy",
      "Person",
      PERSON_PROFILE.imageUrl,
      PERSON_PROFILE.phoneNumber,
      CLERK_ORG,
      LOCAL_TRUSTED_USER_ID,
    ]);
    expect(mockGetUser).toHaveBeenCalledWith(CLERK_USER);
    // The person's Clerk org keeps its own name (ISS-12135 decision 2).
    expect(mockUpdateOrganization).not.toHaveBeenCalled();
    expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
      PERSON_EMAIL,
      undefined,
      undefined,
      { requireAdmin: true }
    );
    expect(mockHeadTranscriptObject).toHaveBeenCalledWith(
      `${PREFIX}${TRANSCRIPT_KEY}`
    );
    const etagUpdates = issued.filter((q) => q.sql.includes("stored_etag"));
    expect(etagUpdates.map((q) => q.params)).toEqual([['"etag-1"', "t-1"]]);
    expect(issued.find((q) => q.sql.includes("upload_status"))?.params).toEqual(
      [TranscriptUploadStatus.Uploaded]
    );
    const markerWrite = issued.findIndex((q) =>
      q.sql.startsWith("COMMENT ON SCHEMA")
    );
    expect(markerWrite).toBeGreaterThan(issued.indexOf(etagUpdates[0]));
    expect(issued[markerWrite]?.sql).toContain(
      formatVibeEnvironmentMarker({
        mode: VibeEnvironmentMode.Seeded,
        state: VibeEnvironmentState.Ready,
      })
    );
  });

  it("leaves the environment pending when the seed holds no org bound to the person's Clerk org", async () => {
    const { issued } = fakeClient(SEEDED_PENDING);
    mockRestoreStagedVibeSeedRows.mockImplementation(
      async (
        _client: unknown,
        _schema: string,
        _logger: unknown,
        inTransaction: (tx: {
          query: (sql: string, params?: unknown[]) => Promise<unknown>;
        }) => Promise<void>
      ) => {
        await inTransaction({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        });
      }
    );

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain(
      "expected one seeded organization to bind"
    );
    expect(issued.some((q) => q.sql.startsWith("COMMENT ON SCHEMA"))).toBe(
      false
    );
  });

  it("refuses to finalize when the person cannot be resolved, before loading anything", async () => {
    fakeClient(SEEDED_PENDING);
    mockResolvePersonClerkIdentity.mockResolvedValue({
      refused:
        "The person belongs to 2 stage Clerk orgs; pass clerk_org_id to choose one",
    });

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(response.status).toBe(422);
    expect(mockRestoreStagedVibeSeedRows).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before restoring seeded rows, with the org by name and the refusal's code", async () => {
    const { issued } = fakeClient(SEEDED_PENDING);
    const clerkOrgs = [{ id: CLERK_ORG, name: "Side Project", isAdmin: false }];
    mockResolvePersonClerkIdentity.mockResolvedValue({
      refused: `The person is not an admin of Clerk org Side Project (${CLERK_ORG})`,
      code: VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
      clerkOrgs,
    });

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
      clerkOrgId: CLERK_ORG,
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toContain(`Side Project (${CLERK_ORG})`);
    expect(body.code).toBe(VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN);
    expect(body.details).toEqual({ clerkOrgs });
    expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
      PERSON_EMAIL,
      CLERK_ORG,
      undefined,
      { requireAdmin: true }
    );
    expect(mockRestoreStagedVibeSeedRows).not.toHaveBeenCalled();
    expect(
      issued.some((query) => query.sql.startsWith("COMMENT ON SCHEMA"))
    ).toBe(false);
  });

  it("answers an ambiguous person with every org by name and id, machine-readable", async () => {
    fakeClient(SEEDED_PENDING);
    mockResolvePersonClerkIdentity.mockResolvedValue({
      refused:
        "The person belongs to 2 stage Clerk orgs; pass clerk_org_id to choose one",
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      clerkOrgs: [
        { id: "org_a", name: "ClosedLoop", isAdmin: true },
        { id: "org_b", name: "Side Project", isAdmin: true },
      ],
    });

    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false,
      code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
      details: {
        clerkOrgs: [
          { id: "org_a", name: "ClosedLoop", isAdmin: true },
          { id: "org_b", name: "Side Project", isAdmin: true },
        ],
      },
    });
  });

  it("passes a chosen Clerk org through to the lookup", async () => {
    fakeClient(SEEDED_PENDING);

    await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
      clerkOrgId: CLERK_ORG,
    });

    expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
      PERSON_EMAIL,
      CLERK_ORG,
      undefined,
      { requireAdmin: true }
    );
  });

  it("rejects a selected Clerk id that is not an org id before lookup", async () => {
    const response = await call(FINALIZE, "finalize", {
      branch: BRANCH,
      personEmail: PERSON_EMAIL,
      clerkOrgId: "user_2abcPerson",
    });

    expect(response.status).toBe(400);
    expect(mockResolvePersonClerkIdentity).not.toHaveBeenCalled();
  });

  describe("desktop session", () => {
    const claim = {
      refreshTokenHash: "a".repeat(64),
      publicKeySpki: generateKeyPairSync("ed25519")
        .publicKey.export({ format: "der", type: "spki" })
        .toString("base64"),
      gatewayId: "0199a000-0000-7000-8000-0000000000ff",
    };
    const ORG_ROW = "0199a000-0000-7000-8000-000000000001";

    /** A client answering the desktop-session reads in order. */
    function desktopClient(opts: {
      marker: VibeEnvironmentMarker | null;
      org: boolean;
      user: string | null;
      existingTokenUser?: string;
    }) {
      const issued: { sql: string; params?: unknown[] }[] = [];
      let userLookups = 0;
      const client = {
        connect: vi.fn(() => Promise.resolve()),
        end: vi.fn(() => Promise.resolve()),
        query: vi.fn((sql: string, params?: unknown[]) => {
          issued.push({ sql, params });
          if (sql.includes("obj_description")) {
            return Promise.resolve({
              rows: [
                {
                  comment:
                    opts.marker === null
                      ? null
                      : formatVibeEnvironmentMarker(opts.marker),
                },
              ],
            });
          }
          if (sql.includes(`FROM "${SCHEMA}"."organizations"`)) {
            return Promise.resolve({
              rows: opts.org ? [{ id: ORG_ROW, clerk_id: CLERK_ORG }] : [],
            });
          }
          if (sql.startsWith(`SELECT id FROM "${SCHEMA}"."users"`)) {
            userLookups += 1;
            const id = opts.user ?? (userLookups > 1 ? "new-user" : null);
            return Promise.resolve({ rows: id === null ? [] : [{ id }] });
          }
          if (sql.includes("token_hash = $1")) {
            return Promise.resolve({
              rows:
                opts.existingTokenUser === undefined
                  ? []
                  : [{ session_id: "s-old", user_id: opts.existingTokenUser }],
            });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      mockCreateSslClient.mockReturnValue(client);
      return issued;
    }

    function mint(extra: Record<string, unknown> = {}) {
      return call(DESKTOP_SESSION, "desktop-session", {
        branch: BRANCH,
        personEmail: PERSON_EMAIL,
        desktopAuth: claim,
        ...extra,
      });
    }

    it("writes a session and refresh token for the person's existing user in the preview schema", async () => {
      const issued = desktopClient({
        marker: SEEDED_PENDING,
        org: true,
        user: "u-person",
      });

      const response = await mint();

      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        schema: SCHEMA,
        created: true,
      });
      const session = issued.find((q) =>
        q.sql.includes(`INSERT INTO "${SCHEMA}"."desktop_sessions"`)
      );
      expect(session?.params?.slice(1, 4)).toEqual([
        "u-person",
        ORG_ROW,
        claim.gatewayId,
      ]);
      expect(String(session?.params?.[4])).toContain("BEGIN PUBLIC KEY");
      const token = issued.find((q) =>
        q.sql.includes(`INSERT INTO "${SCHEMA}"."desktop_refresh_tokens"`)
      );
      expect(token?.params?.[3]).toBe(claim.refreshTokenHash);
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it("offers the org the environment already holds when the request names none (ISS-12135)", async () => {
      desktopClient({ marker: SEEDED_PENDING, org: true, user: "u-person" });

      expect((await mint()).status).toBe(200);
      expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
        PERSON_EMAIL,
        undefined,
        undefined,
        { boundOrgIds: [CLERK_ORG] }
      );
    });

    it("leaves a named clerkOrgId to decide on its own", async () => {
      const issued = desktopClient({
        marker: SEEDED_PENDING,
        org: true,
        user: "u-person",
      });

      expect((await mint({ clerkOrgId: CLERK_ORG })).status).toBe(200);
      expect(mockResolvePersonClerkIdentity).toHaveBeenCalledWith(
        PERSON_EMAIL,
        CLERK_ORG,
        undefined,
        {}
      );
      expect(issued.some((q) => q.sql.startsWith("SELECT clerk_id FROM"))).toBe(
        false
      );
    });

    it("creates the person's user from their Clerk profile when they have not signed in yet", async () => {
      mockGetUser.mockResolvedValue({
        id: CLERK_USER,
        email: PERSON_EMAIL,
        createdAt: 0,
        firstName: "Andy",
        lastName: "Person",
        imageUrl: "https://img.example/a.png",
        phoneNumber: null,
      });
      const issued = desktopClient({
        marker: SEEDED_PENDING,
        org: true,
        user: null,
      });

      const response = await mint();

      expect(response.status).toBe(200);
      expect(mockGetUser).toHaveBeenCalledWith(CLERK_USER);
      const insert = issued.find((q) =>
        q.sql.includes(`INSERT INTO "${SCHEMA}"."users"`)
      );
      expect(insert?.params?.slice(1)).toEqual([
        CLERK_USER,
        ORG_ROW,
        PERSON_EMAIL,
        "Andy",
        "Person",
        "https://img.example/a.png",
        null,
      ]);
    });

    it("answers a repeat claim with the session it already has", async () => {
      const issued = desktopClient({
        marker: SEEDED_PENDING,
        org: true,
        user: "u-person",
        existingTokenUser: "u-person",
      });

      const response = await mint();

      expect((await response.json()).data).toMatchObject({
        sessionId: "s-old",
        created: false,
      });
      expect(issued.some((q) => q.sql.includes("INSERT INTO"))).toBe(false);
    });

    it("refuses a claim that belongs to another user", async () => {
      desktopClient({
        marker: SEEDED_PENDING,
        org: true,
        user: "u-person",
        existingTokenUser: "u-someone-else",
      });

      expect((await mint()).status).toBe(422);
    });

    it("refuses until an org in the environment is bound to the person's Clerk org (blank mode before sign-in)", async () => {
      desktopClient({
        marker: {
          mode: VibeEnvironmentMode.Blank,
          state: VibeEnvironmentState.Ready,
        },
        org: false,
        user: null,
      });

      expect((await mint()).status).toBe(422);
    });

    it("refuses an ordinary preview", async () => {
      desktopClient({ marker: null, org: true, user: "u-person" });

      expect((await mint()).status).toBe(409);
    });

    it.each([
      [
        "a refresh token instead of its hash",
        { refreshTokenHash: "secret-token" },
      ],
      ["a gateway id that is not a uuid", { gatewayId: "gateway-1" }],
    ])("rejects %s", async (_label, override) => {
      const response = await call(DESKTOP_SESSION, "desktop-session", {
        branch: BRANCH,
        personEmail: PERSON_EMAIL,
        desktopAuth: { ...claim, ...override },
      });

      expect(response.status).toBe(400);
      expect(mockCreateSslClient).not.toHaveBeenCalled();
    });
  });
});
