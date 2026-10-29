import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  type ListQueryExpression,
  serializeListQueryExpression,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  CLOUD_SESSION_LIST_LEGACY_PARAM_BEHAVIOR,
  SessionListOverLimit,
} from "@repo/api/src/types/session-list-query-capabilities";
import { keys } from "@repo/database/keys";
import {
  SESSION_LIST_PARITY_CONFORM_SCENARIO,
  SESSION_LIST_PARITY_UNSORTED_KEYS,
} from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import { SESSION_LIST_PARITY_SCENARIOS } from "@repo/lib/sessions/__tests__/session-list-parity-fixture";
import {
  bindParityOwners,
  type CloudDivergenceExpectation,
  parityCasesOf,
  parityTotalOf,
  type SessionListParityCase,
  SessionListParityCaseKind,
  type SessionListParityPage,
  type SessionListParityRead,
  type SessionListParityScenario,
} from "@repo/lib/sessions/__tests__/session-list-parity-model";
import {
  SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT,
  SESSION_LIST_PARITY_SCOPED_USER_REQUESTS,
} from "@repo/lib/sessions/__tests__/session-list-parity-scoped-user";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  type ParityCloudHost,
  type ParityQueryParams,
  readParityParams,
  seedParityDecoy,
  seedParityHost,
} from "@/__tests__/support/agent-sessions/session-list-parity.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { agentSessionListQuerySchema } from "../validators";

/**
 * ISS-9584 (PRD-721) — the CLOUD half of the Sessions list parity harness.
 *
 * Seeds each scenario of `@repo/lib/sessions/__tests__/session-list-parity-fixture`
 * into its own committed organization, sends each fixture query as a client
 * does — `listQuery` in the query string, parsed by the route's
 * `parseQueryParams`, which runs the ISS-9477 lowering — and reads it with the
 * real `findSessions`. Each read asserts its ordered keys and its `total`
 * (ISS-9483). The desktop half (apps/desktop/test/session-list-parity.test.ts)
 * asserts the same against SQLite. Keys are `externalSessionId`, the id both
 * hosts share.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** The key of the other organization's session, which no read may return. */
const DECOY_KEY = "decoy-other-organization";
/** The owner of {@link DECOY_KEY}, a user of the other organization. */
let decoyUserId = "";

const committedOrganizations = createCommittedTestOrganizationTracker();
const seeded = new Map<string, ParityCloudHost>();
let priorTimeZone: string | undefined;

describeIfDb("Sessions list parity, cloud (ISS-9584)", () => {
  beforeAll(async () => {
    for (const scenario of SESSION_LIST_PARITY_SCENARIOS) {
      seeded.set(
        scenario.name,
        await seedParityHost(committedOrganizations, scenario.rows)
      );
    }
    // A session in ANOTHER organization, a copy of a conform row. No expected
    // key list names it, so a read that crossed organizations fails.
    decoyUserId = await seedParityDecoy(
      committedOrganizations,
      SESSION_LIST_PARITY_CONFORM_SCENARIO.rows[0],
      DECOY_KEY
    );
  });

  afterAll(() => committedOrganizations.cleanup());

  beforeEach(() => {
    priorTimeZone = process.env.TZ;
  });

  afterEach(() => {
    if (priorTimeZone === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = priorTimeZone;
    }
  });

  describe.each(SESSION_LIST_PARITY_SCENARIOS)("$name", (scenario) => {
    it.each(parityCasesOf(scenario, SessionListParityCaseKind.Conform))(
      "conforms: $name",
      async (parityCase) => {
        if (parityCase.timeZones) {
          process.env.TZ = parityCase.timeZones.cloud;
        }
        const read = await readCase(scenario, parityCase);
        expect(read).toEqual({
          keys: parityCase.expectedKeys,
          total: parityTotalOf(parityCase, parityCase.expectedKeys),
        });
        expect(read.keys).not.toContain(DECOY_KEY);
      }
    );

    it.each(parityCasesOf(scenario, SessionListParityCaseKind.DesktopRefusal))(
      "serves what the desktop refuses: $name",
      async (parityCase) => {
        expect(await readCase(scenario, parityCase)).toEqual({
          keys: parityCase.cloudExpectedKeys,
          total: parityTotalOf(parityCase, parityCase.cloudExpectedKeys),
        });
      }
    );

    it.each(parityCasesOf(scenario, SessionListParityCaseKind.KnownDivergence))(
      "diverges ($divergence): $name",
      async (parityCase) => {
        if (parityCase.timeZones) {
          process.env.TZ = parityCase.timeZones.cloud;
        }
        const expected = cloudExpectedKeys(scenario, parityCase.cloud);
        // A row whose two expectations agree records no divergence. For the
        // identity tie this also catches two identities that happened to order
        // the rows alike.
        expect(expected).not.toEqual(parityCase.desktopExpectedKeys);
        expect(await readCase(scenario, parityCase)).toEqual({
          keys: expected,
          total: parityTotalOf(parityCase, expected),
        });
      }
    );
  });

  describe("a scoped userId beside listQuery (ISS-12271)", () => {
    it.each(SESSION_LIST_PARITY_SCOPED_USER_REQUESTS)(
      "$name",
      async ({ userId, expression, expectedKeys }) => {
        const scenario = SESSION_LIST_PARITY_CONFORM_SCENARIO;
        const { ownerIds } = hostOf(scenario);
        const read = await readParams(scenario, {
          ...(expression === undefined
            ? SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT
            : {
                [LIST_QUERY_EXPRESSION_PARAM]: serializeListQueryExpression(
                  bindParityOwners(expression, ownerIds)
                ),
              }),
          ...(userId === undefined ? {} : { userId: ownerIds[userId] }),
        });
        expect(read).toEqual({
          keys: expectedKeys,
          total: expectedKeys.length,
        });
      }
    );

    // The org scope keeps `userId` inside the caller's organization: the other
    // organization's user owns a seeded session, and it is not read.
    it("reads nothing for a userId from another organization", async () => {
      expect(decoyUserId).not.toBe("");
      const read = await readParams(SESSION_LIST_PARITY_CONFORM_SCENARIO, {
        [LIST_QUERY_EXPRESSION_PARAM]: serializeListQueryExpression({
          version: LIST_QUERY_EXPRESSION_VERSION,
        }),
        userId: decoyUserId,
      });
      expect(read).toEqual({ keys: [], total: 0 });
    });
  });

  describe("legacy params match the cloud declaration", () => {
    const declared = CLOUD_SESSION_LIST_LEGACY_PARAM_BEHAVIOR;

    it("orders a read with no sort rule by its declared column", async () => {
      expect(declared.unsortedOrder).toBe(SessionListField.LastActivity);
      const read = await readExpression(SESSION_LIST_PARITY_CONFORM_SCENARIO, {
        version: LIST_QUERY_EXPRESSION_VERSION,
      });
      expect(read.keys).toEqual(SESSION_LIST_PARITY_UNSORTED_KEYS.cloud);
    });

    it("refuses an unrecognized scalar sortBy", () => {
      expect(declared.unknownSortBy).toBeNull();
      expect(
        agentSessionListQuerySchema.safeParse({ sortBy: "not-a-column" })
          .success
      ).toBe(false);
    });

    it("refuses an unrecognized quality", () => {
      expect(declared.unknownQuality).toBeNull();
      expect(
        agentSessionListQuerySchema.safeParse({ quality: "not-a-quality" })
          .success
      ).toBe(false);
    });

    it("refuses a limit above its declared maximum", () => {
      expect(declared.overLimit).toBe(SessionListOverLimit.Refuse);
      expect(
        agentSessionListQuerySchema.safeParse({ limit: declared.maxLimit })
          .success
      ).toBe(true);
      expect(
        agentSessionListQuerySchema.safeParse({ limit: declared.maxLimit + 1 })
          .success
      ).toBe(false);
    });

    it("refuses an offset above its declared ceiling", () => {
      const maxOffset = declared.maxOffset ?? Number.NaN;
      expect(Number.isInteger(maxOffset)).toBe(true);
      expect(
        agentSessionListQuerySchema.safeParse({ offset: maxOffset }).success
      ).toBe(true);
      expect(
        agentSessionListQuerySchema.safeParse({ offset: maxOffset + 1 }).success
      ).toBe(false);
    });
  });
});

async function readCase(
  scenario: SessionListParityScenario,
  parityCase: SessionListParityCase
): Promise<SessionListParityRead> {
  return await readExpression(
    scenario,
    bindParityOwners(parityCase.expression, hostOf(scenario).ownerIds),
    parityCase.page
  );
}

async function readExpression(
  scenario: SessionListParityScenario,
  expression: ListQueryExpression,
  page?: SessionListParityPage
): Promise<SessionListParityRead> {
  return await readParams(scenario, {
    [LIST_QUERY_EXPRESSION_PARAM]: serializeListQueryExpression(expression),
    ...page,
  });
}

async function readParams(
  scenario: SessionListParityScenario,
  params: ParityQueryParams
): Promise<SessionListParityRead> {
  return await readParityParams(hostOf(scenario).organizationId, params);
}

function cloudExpectedKeys(
  scenario: SessionListParityScenario,
  expectation: CloudDivergenceExpectation
): readonly string[] {
  if ("keys" in expectation) {
    return expectation.keys;
  }
  const { artifactIds } = hostOf(scenario);
  return [...expectation.byHostIdentityDesc].sort((a, b) =>
    compareDescending(
      artifactIdOf(artifactIds, a),
      artifactIdOf(artifactIds, b)
    )
  );
}

function hostOf(scenario: SessionListParityScenario): ParityCloudHost {
  const host = seeded.get(scenario.name);
  if (!host) {
    throw new Error(`scenario ${scenario.name} was not seeded`);
  }
  return host;
}

function artifactIdOf(artifactIds: Map<string, string>, key: string): string {
  const artifactId = artifactIds.get(key);
  if (!artifactId) {
    throw new Error(`no artifact seeded for ${key}`);
  }
  return artifactId;
}

function compareDescending(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
}
