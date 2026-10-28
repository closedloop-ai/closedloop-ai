/**
 * ISS-9584 (PRD-721) — the DESKTOP half of the Sessions list parity harness.
 *
 * Seeds each scenario of `@repo/lib/sessions/__tests__/session-list-parity-fixture`
 * into a real SQLite store, sends each fixture query as a `listQuery` through
 * the Sessions IPC request coercion, which compiles it (ISS-9479), and reads
 * the result through `getSharedAgentSessions` — the renderer's entry — so the
 * SQL cursor tier and the hydrated tier both run as production routes them.
 * Each case is read a second time through the `pageData` handler's body, the
 * read the Sessions page takes its rows from (ISS-9483), and every read
 * asserts its ordered keys and its `total`. The cloud half
 * (apps/api/app/agent-sessions/service/session-list-parity.integration.test.ts)
 * asserts the same expected keys against Postgres.
 */
import { DEFAULT_SESSION_QUALITY } from "@repo/api/src/agent-session-filters.js";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression.js";
import { SessionListField } from "@repo/api/src/types/list-query-fields.js";
import {
  DESKTOP_SESSION_LIST_LEGACY_PARAM_BEHAVIOR,
  SessionListOverLimit,
} from "@repo/api/src/types/session-list-query-capabilities.js";
import {
  SESSION_LIST_PARITY_CONFORM_SCENARIO,
  SESSION_LIST_PARITY_STARTED_DESC_KEYS,
  SESSION_LIST_PARITY_UNSORTED_KEYS,
} from "@repo/lib/sessions/__tests__/session-list-parity-conform.js";
import { SESSION_LIST_PARITY_EVIDENCE_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-evidence.js";
import { SESSION_LIST_PARITY_SCENARIOS } from "@repo/lib/sessions/__tests__/session-list-parity-fixture.js";
import {
  bindParityOwners,
  parityCasesOf,
  parityTotalOf,
  SESSION_LIST_PARITY_OWNER_NAMES,
  type SessionListParityCase,
  SessionListParityCaseKind,
  SessionListParityOwner,
  type SessionListParityScenario,
} from "@repo/lib/sessions/__tests__/session-list-parity-model.js";
import {
  SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT,
  SESSION_LIST_PARITY_SCOPED_USER_REQUESTS,
} from "@repo/lib/sessions/__tests__/session-list-parity-scoped-user.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { coerceSharedAgentSessionsListRequest } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import {
  ensureOrgDirectory,
  getOrgDirectorySnapshot,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import type { SharedAgentSessionsQuery } from "../src/shared/shared-agent-sessions-contract.js";
import {
  closeParityHost,
  openParityStore,
  PARITY_API_KEY,
  PARITY_API_ORIGIN,
  PARITY_OWNER_IDS,
  type ParityTestDb,
  parityOrgDirectoryResponse,
  parityPayloadOf,
  parityRefusalOf,
  readParityEntries,
  readParityList,
} from "./support/session-list-parity-host.js";

/**
 * One store per scenario, seeded on first use. Every case only reads, and the
 * time-zone rows set `TZ` at read time, so the store is shared.
 */
const seededStores = new Map<
  SessionListParityScenario,
  Promise<ParityTestDb>
>();
let priorTimeZone: string | undefined;

beforeEach(async () => {
  priorTimeZone = process.env.TZ;
  resetOrgDirectoryCacheForTest();
  await ensureOrgDirectory({
    getApiOrigin: () => PARITY_API_ORIGIN,
    getApiKey: () => PARITY_API_KEY,
    fetchImpl: parityOrgDirectoryResponse,
  });
});

afterEach(() => {
  if (priorTimeZone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = priorTimeZone;
  }
  resetOrgDirectoryCacheForTest();
});

afterAll(async () => {
  seededStores.clear();
  await closeParityHost();
});

describe("Sessions list parity, desktop (ISS-9584)", () => {
  describe.each(SESSION_LIST_PARITY_SCENARIOS)("$name", (scenario) => {
    it.each(parityCasesOf(scenario, SessionListParityCaseKind.Conform))(
      "conforms: $name",
      async (parityCase) => {
        if (parityCase.timeZones) {
          process.env.TZ = parityCase.timeZones.desktop;
        }
        const read = {
          keys: [...parityCase.expectedKeys],
          total: parityTotalOf(parityCase, parityCase.expectedKeys),
        };
        expect(await readBothEntries(scenario, parityCase)).toEqual({
          list: read,
          pageData: read,
        });
      }
    );

    it.each(parityCasesOf(scenario, SessionListParityCaseKind.DesktopRefusal))(
      "refuses: $name",
      (parityCase) => {
        expect(parityRefusalOf(parityPayloadOf(parityCase))).toBe(
          parityCase.desktopRefusal
        );
      }
    );

    it.each(parityCasesOf(scenario, SessionListParityCaseKind.KnownDivergence))(
      "diverges ($divergence): $name",
      async (parityCase) => {
        if (parityCase.timeZones) {
          process.env.TZ = parityCase.timeZones.desktop;
        }
        const read = {
          keys: [...parityCase.desktopExpectedKeys],
          total: parityTotalOf(parityCase, parityCase.desktopExpectedKeys),
        };
        expect(await readBothEntries(scenario, parityCase)).toEqual({
          list: read,
          pageData: read,
        });
      }
    );
  });

  // The owner-collation row would also pass on a cold directory — every owner
  // unresolved keeps cursor order — so it only measures `localeCompare` while
  // both owners resolve.
  it("resolves both owners the owner-collation row sorts by", () => {
    const snapshot = getOrgDirectorySnapshot();
    for (const owner of Object.values(SessionListParityOwner)) {
      expect(snapshot.get(PARITY_OWNER_IDS[owner])?.firstName).toBe(
        SESSION_LIST_PARITY_OWNER_NAMES[owner].firstName
      );
    }
  });
});

describe("a scoped userId beside listQuery (ISS-12271)", () => {
  it.each(SESSION_LIST_PARITY_SCOPED_USER_REQUESTS)(
    "$name",
    async ({ userId, expression, expectedKeys }) => {
      const db = await seededStore(SESSION_LIST_PARITY_CONFORM_SCENARIO);
      const request = coerceSharedAgentSessionsListRequest({
        ...(expression === undefined
          ? SESSION_LIST_PARITY_SCOPED_USER_LEGACY_SORT
          : {
              [LIST_QUERY_EXPRESSION_PARAM]: bindParityOwners(
                expression,
                PARITY_OWNER_IDS
              ),
            }),
        ...(userId === undefined ? {} : { userId: PARITY_OWNER_IDS[userId] }),
      });
      expect(await readParityList(db, request)).toEqual({
        keys: expectedKeys,
        total: expectedKeys.length,
      });
    }
  );
});

describe("desktop legacy-param behavior matches its declaration (ISS-9584)", () => {
  const declared = DESKTOP_SESSION_LIST_LEGACY_PARAM_BEHAVIOR;
  const scenario = SESSION_LIST_PARITY_CONFORM_SCENARIO;

  it("orders a read with no sort rule by its declared column", async () => {
    const db = await seededStore(scenario);
    expect(declared.unsortedOrder).toBe(SessionListField.Updated);
    expect((await readParityList(db, {})).keys).toEqual(
      SESSION_LIST_PARITY_UNSORTED_KEYS.desktop
    );
  });

  it("orders an unrecognized scalar sortBy by its declared column", async () => {
    const db = await seededStore(scenario);
    expect(declared.unknownSortBy).toBe(SessionListField.Started);
    expect((await readParityList(db, { sortBy: "not-a-column" })).keys).toEqual(
      SESSION_LIST_PARITY_STARTED_DESC_KEYS
    );
  });

  // The evidence corpus holds one idle row and three substantive ones, so an
  // "idle" or "substantive" fallback returns fewer rows than "all" does.
  it("reads an unrecognized quality as its declared fallback", async () => {
    const evidence = SESSION_LIST_PARITY_EVIDENCE_SCENARIO;
    const db = await seededStore(evidence);
    expect(declared.unknownQuality).toBe(DEFAULT_SESSION_QUALITY);
    const response = await getSharedAgentSessions(db.syncSource, {
      // The IPC payload is untyped at runtime; this is an unknown value.
      quality: "not-a-quality" as SharedAgentSessionsQuery["quality"],
      sortBy: SessionListField.LastActivity,
    });
    expect(response.total).toBe(evidence.rows.length);
  });

  it("clamps a limit above its declared maximum", async () => {
    const db = await seededStore(scenario);
    expect(declared.overLimit).toBe(SessionListOverLimit.Clamp);
    const response = await getSharedAgentSessions(db.syncSource, {
      limit: declared.maxLimit + 1,
      sortBy: SessionListField.LastActivity,
    });
    expect(response.pageInfo?.limit).toBe(declared.maxLimit);
  });

  it("serves an offset with no ceiling, as declared", async () => {
    const db = await seededStore(scenario);
    expect(declared.maxOffset).toBeNull();
    const offset = 50_000;
    const response = await getSharedAgentSessions(db.syncSource, {
      offset,
      sortBy: SessionListField.LastActivity,
    });
    expect(response.items).toEqual([]);
    expect(response.pageInfo?.offset).toBe(offset);
  });
});

/** The case read through the list and `pageData` entries. */
async function readBothEntries(
  scenario: SessionListParityScenario,
  parityCase: SessionListParityCase
) {
  return await readParityEntries(
    await seededStore(scenario),
    parityPayloadOf(parityCase)
  );
}

function seededStore(
  scenario: SessionListParityScenario
): Promise<ParityTestDb> {
  let store = seededStores.get(scenario);
  if (!store) {
    store = openParityStore(scenario.rows);
    seededStores.set(scenario, store);
  }
  return store;
}
