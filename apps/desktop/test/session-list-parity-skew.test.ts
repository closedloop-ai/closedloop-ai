/**
 * ISS-9483 (PRD-721 R10-S08) — the DESKTOP half of the Sessions list parity
 * harness for unknown and version-skewed requests and for a write landing
 * between reads. The cloud half is
 * apps/api/app/agent-sessions/service/session-list-parity-skew.integration.test.ts;
 * both read the lists in
 * `@repo/lib/sessions/__tests__/session-list-parity-{skew,concurrency}.ts`.
 */
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression.js";
import { SESSION_LIST_PARITY_CONCURRENT_UPDATE } from "@repo/lib/sessions/__tests__/session-list-parity-concurrency.js";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform.js";
import {
  type ConformCase,
  parityTotalOf,
} from "@repo/lib/sessions/__tests__/session-list-parity-model.js";
import {
  SESSION_LIST_PARITY_LEGACY_REQUESTS,
  SESSION_LIST_PARITY_REFUSALS,
} from "@repo/lib/sessions/__tests__/session-list-parity-skew.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureOrgDirectory,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import {
  applyParityWrite,
  closeParityHost,
  openParityStore,
  PARITY_API_KEY,
  PARITY_API_ORIGIN,
  type ParityTestDb,
  parityOrgDirectoryResponse,
  parityPayloadOf,
  parityRefusalOf,
  readParityEntries,
} from "./support/session-list-parity-host.js";

let conformStore: Promise<ParityTestDb> | undefined;

beforeEach(async () => {
  resetOrgDirectoryCacheForTest();
  await ensureOrgDirectory({
    getApiOrigin: () => PARITY_API_ORIGIN,
    getApiKey: () => PARITY_API_KEY,
    fetchImpl: parityOrgDirectoryResponse,
  });
});

afterEach(() => {
  resetOrgDirectoryCacheForTest();
});

afterAll(async () => {
  conformStore = undefined;
  await closeParityHost();
});

describe("Sessions list parity, desktop: skew and writes (ISS-9483)", () => {
  it.each(SESSION_LIST_PARITY_REFUSALS)(
    "refuses $name",
    ({ listQuery, refusal }) => {
      expect(
        parityRefusalOf({ [LIST_QUERY_EXPRESSION_PARAM]: listQuery })
      ).toBe(refusal);
    }
  );

  it.each(SESSION_LIST_PARITY_LEGACY_REQUESTS)(
    "reads a legacy request: $name",
    async ({ params, expectedKeys }) => {
      conformStore ??= openParityStore(
        SESSION_LIST_PARITY_CONFORM_SCENARIO.rows
      );
      const db = await conformStore;
      const read = { keys: expectedKeys, total: expectedKeys.length };
      expect(await readParityEntries(db, params)).toEqual({
        list: read,
        pageData: read,
      });
    }
  );

  it("answers for the rows as written when a write lands between reads", async () => {
    const scenario = SESSION_LIST_PARITY_CONCURRENT_UPDATE;
    const db = await openParityStore(scenario.rows);
    for (const parityCase of scenario.before) {
      expect(await readCase(db, parityCase), parityCase.name).toEqual(
        expectedEntriesOf(parityCase)
      );
    }
    for (const write of scenario.writes) {
      await applyParityWrite(db, write);
    }
    for (const parityCase of scenario.after) {
      expect(await readCase(db, parityCase), parityCase.name).toEqual(
        expectedEntriesOf(parityCase)
      );
    }
  });
});

async function readCase(db: ParityTestDb, parityCase: ConformCase) {
  return await readParityEntries(db, parityPayloadOf(parityCase));
}

function expectedEntriesOf(parityCase: ConformCase) {
  const read = {
    keys: [...parityCase.expectedKeys],
    total: parityTotalOf(parityCase, parityCase.expectedKeys),
  };
  return { list: read, pageData: read };
}
