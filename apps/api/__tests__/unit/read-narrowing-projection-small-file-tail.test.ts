import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  };
});

vi.mock("@repo/analytics/server", () => ({
  analytics: { capture: vi.fn() },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: vi.fn() },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  branchProviderFallbackService: { findByIds: vi.fn() },
}));

vi.mock("@/app/artifacts/session-displayed-status-service", () => ({
  sessionDisplayedStatusService: { findByIds: vi.fn() },
}));

vi.mock("@/app/tags/tag-projection-select", () => ({
  mapTagRelations: vi.fn(() => []),
}));

import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { IssueStatus } from "@repo/api/src/types/document";
import { TeamRole } from "@repo/api/src/types/teams";
import { ApiKeySource, ArtifactType } from "@repo/database";
import {
  createModelDouble,
  type ModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { apiKeysService } from "@/app/api-keys/service";
import { artifactLinksService } from "@/app/artifact-links/service";
import {
  collectAncestors,
  collectDescendants,
} from "@/app/artifacts/assigned-artifact-tree-graph";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { sessionDisplayedStatusService } from "@/app/artifacts/session-displayed-status-service";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { publicKeysService } from "@/app/public-keys/service";
import { pullRequestRatingsService } from "@/app/pull-requests/ratings-service";
import { teamsService } from "@/app/teams/service";
import { ApiKeyVerificationStatus } from "@/lib/auth/api-key-verification";
import { hashToken } from "@/lib/auth/token-hash";

/**
 * Read narrowing for the small-file tail (ISS-9191, chunk D of ISS-6922).
 *
 * Every case drives a production entry point against `createModelDouble`,
 * which projects the stored row through the query's `select` the way Postgres
 * does. That is what makes these falsifiable: with the `select` removed the
 * double hands back EVERY fixture column and the `returnedColumns` expectation
 * fails. A characterization test written against a plain `mockResolvedValue`
 * would pass either way, because an unselected read returns a superset and the
 * mappers name their fields.
 *
 * Fixture rows therefore carry non-null values in the columns production must
 * NOT receive — a null and an absent column serialize identically, so a null
 * there would make the assertion unfalsifiable.
 *
 * Two cases are contract PINS rather than reductions — `listActivityEvents`
 * and `unregisterUserPublicKey` select every column their table has, so no
 * output assertion can distinguish them and they stay green under the
 * counterfactual by construction. Their guard is `tsc`: the `satisfies
 * Record<keyof Row, true>` on each constant.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const TEAM_ID = "66666666-6666-4666-8666-666666666666";
const FIELD_ID = "77777777-7777-4777-8777-777777777777";
const OPTION_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const ARTIFACT_LINK_DTO_COLUMNS = [
  "id",
  "organizationId",
  "sourceId",
  "targetId",
  "linkType",
  "metadata",
  "createdAt",
];

const PARENT_EDGE_COLUMNS = [
  "sourceId",
  "targetId",
  "linkType",
  "sortOrder",
  "metadata",
];

const CANONICAL_PARENT_COLUMNS = [
  "id",
  "sourceId",
  "targetId",
  "linkType",
  "sortOrder",
  "metadata",
  "createdAt",
];

const ACTIVITY_EVENT_COLUMNS = [
  "id",
  "organizationId",
  "artifactId",
  "actorType",
  "actorId",
  "action",
  "before",
  "after",
  "createdAt",
];

const STORED_API_KEY_COLUMNS = [
  "id",
  "organizationId",
  "userId",
  "name",
  "keyPrefix",
  "expiresAt",
  "scopes",
  "lastUsedAt",
  "createdAt",
  "revokedAt",
];

const VERIFIED_API_KEY_COLUMNS = [
  "id",
  "userId",
  "organizationId",
  "scopes",
  "source",
  "gatewayId",
  "boundPublicKey",
];

const ENUM_OPTION_COLUMNS = ["id", "enabled"];

const RATING_SUMMARY_COLUMNS = [
  "id",
  "userId",
  "score",
  "comment",
  "createdAt",
  "updatedAt",
];

const USER_PUBLIC_KEY_COLUMNS = [
  "id",
  "userId",
  "organizationId",
  "publicKeyBase64",
  "fingerprint",
  "createdAt",
];

/** Every `artifact_links` column, participation projection included. */
function artifactLinkRow(overrides: Row = {}): Row {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    organizationId: ORG_ID,
    sourceId: ARTIFACT_ID,
    targetId: OTHER_ARTIFACT_ID,
    linkType: LinkType.Produces,
    sortOrder: 1000,
    branchParticipation: BranchParticipationKind.Wrote,
    branchParticipationMethod: "push",
    branchParticipationObservedAt: NOW,
    lastContributedAt: NOW,
    metadata: { note: "kept" },
    createdAt: NOW,
    ...overrides,
  };
}

/** Every `artifact_activity_events` column. */
function activityEventRow(overrides: Row = {}): Row {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    organizationId: ORG_ID,
    artifactId: ARTIFACT_ID,
    actorType: ArtifactActivityActorType.User,
    actorId: USER_ID,
    action: ArtifactActivityAction.StatusChange,
    before: { status: IssueStatus.Todo },
    after: { status: IssueStatus.Done },
    createdAt: NOW,
    ...overrides,
  };
}

/** Every `api_keys` column, the stored credential hash included. */
function apiKeyRow(overrides: Row = {}): Row {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    organizationId: ORG_ID,
    userId: USER_ID,
    name: "CI key",
    scopes: ["read", "write"],
    keyHash: hashToken("sk_live_plaintext"),
    keyPrefix: "sk_live_",
    expiresAt: null,
    lastUsedAt: NOW,
    createdAt: NOW,
    revokedAt: null,
    source: ApiKeySource.USER_CREATED,
    gatewayId: "gateway-1",
    boundPublicKey: "-----BEGIN PUBLIC KEY-----",
    ...overrides,
  };
}

/** Every `custom_field_enum_options` column. */
function enumOptionRow(overrides: Row = {}): Row {
  return {
    id: OPTION_ID,
    customFieldId: FIELD_ID,
    name: "In review",
    color: "blue",
    enabled: true,
    sortOrder: 3,
    ...overrides,
  };
}

/** Every `artifact_ratings` column. */
function artifactRatingRow(overrides: Row = {}): Row {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    artifactId: ARTIFACT_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    score: 4,
    comment: "Solid",
    artifactVersion: 7,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Every `user_public_keys` column. */
function userPublicKeyRow(overrides: Row = {}): Row {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    userId: USER_ID,
    organizationId: ORG_ID,
    publicKeyBase64: "base64-key",
    fingerprint: "fingerprint-1",
    createdAt: NOW,
    ...overrides,
  };
}

/** Every `team_members` column. */
function teamMemberRow(overrides: Row = {}): Row {
  return {
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    teamId: TEAM_ID,
    userId: USER_ID,
    role: TeamRole.Member,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("artifact link reads", () => {
  it.each([
    {
      label: "findLinks",
      call: () => artifactLinksService.findLinks(ORG_ID, ARTIFACT_ID),
    },
    {
      label: "findSourceLinks",
      call: () => artifactLinksService.findSourceLinks(ORG_ID, ARTIFACT_ID),
    },
    {
      label: "findTargetLinks",
      call: () => artifactLinksService.findTargetLinks(ORG_ID, ARTIFACT_ID),
    },
  ])(
    "$label reads only the columns the ArtifactLink DTO carries",
    async ({ call }) => {
      const artifactLink = createModelDouble([
        artifactLinkRow({ sourceId: ARTIFACT_ID, targetId: ARTIFACT_ID }),
      ]);
      mockWithDbAll({ artifactLink });

      const links = await call();

      expect(links).toHaveLength(1);
      expect(artifactLink.returnedColumns).toEqual([ARTIFACT_LINK_DTO_COLUMNS]);
    }
  );
});

describe("assignee-scoped tree walk", () => {
  it.each([
    { label: "collectAncestors", walk: collectAncestors },
    { label: "collectDescendants", walk: collectDescendants },
  ])(
    "$label reads only the columns a ranked parent edge is built from",
    async ({ walk }) => {
      const artifactLink = createModelDouble([artifactLinkRow()]);
      mockWithDbAll({
        artifactLink,
        // The walk stops after one level when no ancestor artifact loads, which
        // is enough: the link read has already happened.
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await walk(ORG_ID, new Map(), [
        ARTIFACT_ID,
        OTHER_ARTIFACT_ID,
      ]);

      expect(result.parentEdges.size).toBe(1);
      expect(artifactLink.returnedColumns).toEqual([PARENT_EDGE_COLUMNS]);
    }
  );
});

describe("project tree link read", () => {
  it("reads the ranked edge, hierarchy metadata, and stable tie-break keys", async () => {
    const artifactLink = createModelDouble([artifactLinkRow()]);
    mockWithDbAll({
      artifactLink,
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: ARTIFACT_ID,
            projectId: PROJECT_ID,
            organizationId: ORG_ID,
            type: ArtifactType.DOCUMENT,
            subtype: null,
            title: "Parent",
            status: IssueStatus.Todo,
            stackRank: 1000,
            assignee: null,
          },
          {
            id: OTHER_ARTIFACT_ID,
            projectId: PROJECT_ID,
            organizationId: ORG_ID,
            type: ArtifactType.DOCUMENT,
            subtype: null,
            title: "Child",
            status: IssueStatus.Todo,
            stackRank: 2000,
            assignee: null,
          },
        ]),
      },
    });
    vi.mocked(branchProductEligibilityService.findByIds).mockResolvedValue(
      new Map()
    );
    vi.mocked(branchProviderFallbackService.findByIds).mockResolvedValue(
      new Set()
    );
    vi.mocked(sessionDisplayedStatusService.findByIds).mockResolvedValue(
      new Map()
    );

    const tree = await projectTreeService.getProjectTree(PROJECT_ID, ORG_ID);

    // The edge resolved, so the child nests rather than rooting beside it.
    expect(tree.nodes).toHaveLength(1);
    expect(artifactLink.returnedColumns).toEqual([CANONICAL_PARENT_COLUMNS]);
  });
});

describe("artifact activity list", () => {
  it("reads exactly the columns the activity DTO carries", async () => {
    const artifactActivityEvent = createModelDouble([activityEventRow()]);
    mockWithDbAll({ artifactActivityEvent });

    const page = await artifactActivityService.listActivityEvents({
      organizationId: ORG_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(page.items).toHaveLength(1);
    expect(artifactActivityEvent.returnedColumns).toEqual([
      ACTIVITY_EVENT_COLUMNS,
    ]);
  });
});

describe("API key reads", () => {
  it("list renders a key without ever loading its stored hash", async () => {
    const apiKey = createModelDouble([apiKeyRow()]);
    mockWithDbAll({ apiKey });

    const keys = await apiKeysService.list(ORG_ID, USER_ID);

    expect(keys).toHaveLength(1);
    expect(apiKey.returnedColumns).toEqual([STORED_API_KEY_COLUMNS]);
  });

  it("verification resolves a caller without reading the hash back", async () => {
    const apiKey = createModelDouble([apiKeyRow()]);
    mockWithDbAll({ apiKey });

    const outcome = await apiKeysService.verifyKeyOutcome("sk_live_plaintext", {
      updateLastUsedAt: false,
    });

    expect(outcome.status).toBe(ApiKeyVerificationStatus.Ok);
    expect(apiKey.returnedColumns).toEqual([VERIFIED_API_KEY_COLUMNS]);
  });
});

describe("custom field enum option validation", () => {
  function mockFieldLookup(
    fieldType: string,
    customFieldEnumOption: ModelDouble
  ) {
    mockWithDbAll({
      customFieldEnumOption,
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
      },
      customField: {
        findFirst: vi.fn().mockResolvedValue({
          id: FIELD_ID,
          organizationId: ORG_ID,
          fieldType,
          numberFormat: null,
          entityTypes: [CustomFieldEntityType.Document],
          name: "Stage",
          enumOptions: [],
        }),
      },
    });
  }

  it("validates a single enum option from two columns", async () => {
    const customFieldEnumOption = createModelDouble([enumOptionRow()]);
    mockFieldLookup(CustomFieldType.Enum, customFieldEnumOption);

    await customFieldValuesService.validateValueForEntity(
      FIELD_ID,
      CustomFieldEntityType.Document,
      ARTIFACT_ID,
      ORG_ID,
      OPTION_ID
    );

    expect(customFieldEnumOption.returnedColumns).toEqual([
      ENUM_OPTION_COLUMNS,
    ]);
  });

  it("validates a multi-enum batch from the same two columns", async () => {
    const customFieldEnumOption = createModelDouble([enumOptionRow()]);
    mockFieldLookup(CustomFieldType.MultiEnum, customFieldEnumOption);

    await customFieldValuesService.validateValueForEntity(
      FIELD_ID,
      CustomFieldEntityType.Document,
      ARTIFACT_ID,
      ORG_ID,
      [OPTION_ID]
    );

    expect(customFieldEnumOption.returnedColumns).toEqual([
      ENUM_OPTION_COLUMNS,
    ]);
  });
});

describe("pull request rating reads", () => {
  it("the summary reads only the columns it renders back", async () => {
    const artifactRating = createModelDouble([artifactRatingRow()]);
    mockWithDbAll({
      artifactRating: {
        ...artifactRating,
        aggregate: vi
          .fn()
          .mockResolvedValue({ _avg: { score: 4 }, _count: { _all: 1 } }),
      },
      artifact: { findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }) },
    });

    const result = await pullRequestRatingsService.getRating(
      ARTIFACT_ID,
      USER_ID,
      ORG_ID
    );

    expect(result.ok).toBe(true);
    expect(artifactRating.returnedColumns).toEqual([RATING_SUMMARY_COLUMNS]);
  });

  it("the upsert reads only the previous score and comment it compares", async () => {
    const artifactRating = createModelDouble([artifactRatingRow()]);
    mockWithDbAll({
      artifactRating: {
        ...artifactRating,
        aggregate: vi
          .fn()
          .mockResolvedValue({ _avg: { score: 5 }, _count: { _all: 1 } }),
        upsert: vi
          .fn()
          .mockResolvedValue(artifactRatingRow({ score: 5, comment: "Great" })),
      },
      artifact: { findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }) },
    });

    const result = await pullRequestRatingsService.upsertRating(
      ARTIFACT_ID,
      USER_ID,
      ORG_ID,
      5,
      "Great"
    );

    expect(result.ok).toBe(true);
    expect(artifactRating.returnedColumns).toEqual([["score", "comment"]]);
  });
});

describe("browser public key revocation", () => {
  it("reads the key row the revocation notification is built from", async () => {
    const userPublicKey = createModelDouble([userPublicKeyRow()]);
    mockWithDbAll({
      userPublicKey,
      // No online target, so the notification fan-out issues no command.
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await publicKeysService.unregisterUserPublicKey({
      userId: USER_ID,
      organizationId: ORG_ID,
      fingerprint: "fingerprint-1",
    });

    expect(result.deleted).toBe(true);
    expect(userPublicKey.returnedColumns).toEqual([USER_PUBLIC_KEY_COLUMNS]);
  });
});

describe("team membership existence check", () => {
  it("answers membership from the id alone", async () => {
    const teamMember = createModelDouble([teamMemberRow()]);
    mockWithDbAll({ teamMember });

    await expect(teamsService.isMember(TEAM_ID, USER_ID)).resolves.toBe(true);

    expect(teamMember.returnedColumns).toEqual([["id"]]);
  });
});
