import {
  LIST_QUERY_EXPRESSION_PARAM,
  serializeListQueryExpression,
} from "@repo/api/src/types/list-query-expression";
import { keys } from "@repo/database/keys";
import { SESSION_LIST_PARITY_CONCURRENT_UPDATE } from "@repo/lib/sessions/__tests__/session-list-parity-concurrency";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import {
  bindParityOwners,
  type ConformCase,
  parityTotalOf,
} from "@repo/lib/sessions/__tests__/session-list-parity-model";
import {
  SESSION_LIST_PARITY_LEGACY_REQUESTS,
  SESSION_LIST_PARITY_REFUSALS,
} from "@repo/lib/sessions/__tests__/session-list-parity-skew";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyParityWrite,
  type ParityCloudHost,
  readParityParams,
  readParityRefusal,
  seedParityHost,
} from "@/__tests__/support/agent-sessions/session-list-parity.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";

/**
 * ISS-9483 (PRD-721 R10-S08) — the CLOUD half of the Sessions list parity
 * harness for unknown and version-skewed requests and for a write landing
 * between reads. The desktop half is
 * apps/desktop/test/session-list-parity-skew.test.ts; both read the lists in
 * `@repo/lib/sessions/__tests__/session-list-parity-{skew,concurrency}.ts`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

describeIfDb("Sessions list parity, cloud: skew and writes (ISS-9483)", () => {
  let conformHost: ParityCloudHost | undefined;

  beforeAll(async () => {
    conformHost = await seedParityHost(
      committedOrganizations,
      SESSION_LIST_PARITY_CONFORM_SCENARIO.rows
    );
  });

  afterAll(() => committedOrganizations.cleanup());

  it.each(SESSION_LIST_PARITY_REFUSALS)(
    "refuses $name",
    async ({ listQuery, refusal }) => {
      expect(
        await readParityRefusal({
          [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify(listQuery),
        })
      ).toBe(refusal);
    }
  );

  it.each(SESSION_LIST_PARITY_LEGACY_REQUESTS)(
    "reads a legacy request: $name",
    async ({ params, expectedKeys }) => {
      expect(
        await readParityParams(organizationOf(conformHost), params)
      ).toEqual({ keys: expectedKeys, total: expectedKeys.length });
    }
  );

  it("answers for the rows as written when a write lands between reads", async () => {
    const scenario = SESSION_LIST_PARITY_CONCURRENT_UPDATE;
    const host = await seedParityHost(committedOrganizations, scenario.rows);
    for (const parityCase of scenario.before) {
      expect(await readConformCase(host, parityCase), parityCase.name).toEqual(
        expectedReadOf(parityCase)
      );
    }
    for (const write of scenario.writes) {
      await applyParityWrite(host, write);
    }
    for (const parityCase of scenario.after) {
      expect(await readConformCase(host, parityCase), parityCase.name).toEqual(
        expectedReadOf(parityCase)
      );
    }
  });
});

function organizationOf(host: ParityCloudHost | undefined): string {
  if (!host) {
    throw new Error("the conform scenario was not seeded");
  }
  return host.organizationId;
}

async function readConformCase(host: ParityCloudHost, parityCase: ConformCase) {
  return await readParityParams(host.organizationId, {
    [LIST_QUERY_EXPRESSION_PARAM]: serializeListQueryExpression(
      bindParityOwners(parityCase.expression, host.ownerIds)
    ),
    ...parityCase.page,
  });
}

function expectedReadOf(parityCase: ConformCase) {
  return {
    keys: parityCase.expectedKeys,
    total: parityTotalOf(parityCase, parityCase.expectedKeys),
  };
}
