import { resolveListQueryCapability } from "@repo/api/src/types/list-query-capability";
import { parseListQueryExpressionValue } from "@repo/api/src/types/list-query-expression-schema";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
} from "@repo/api/src/types/session-list-query-capabilities";
import { describe, expect, it } from "vitest";
import {
  SESSION_LIST_PARITY_CONCURRENT_UPDATE,
  type SessionListParityWrite,
} from "./session-list-parity-concurrency";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "./session-list-parity-conform";
import type {
  ConformCase,
  SessionListParityRow,
} from "./session-list-parity-model";
import {
  SESSION_LIST_PARITY_LEGACY_REQUESTS,
  SESSION_LIST_PARITY_REFUSALS,
} from "./session-list-parity-skew";

const CAPABILITIES = [
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
];

describe("Sessions list parity skew and write lists (ISS-9483)", () => {
  it("refuses every refusal request with its stated code on both declarations", () => {
    for (const { name, listQuery, refusal } of SESSION_LIST_PARITY_REFUSALS) {
      const parsed = parseListQueryExpressionValue(listQuery);
      if (!parsed.ok) {
        expect(parsed.refused.code, name).toBe(refusal);
        continue;
      }
      for (const capability of CAPABILITIES) {
        expect(
          resolveListQueryCapability(parsed.expression, capability),
          name
        ).toMatchObject({ ok: false, refused: { code: refusal } });
      }
    }
  });

  it("names only conform rows in every legacy request", () => {
    const keys = new Set(
      SESSION_LIST_PARITY_CONFORM_SCENARIO.rows.map((row) => row.key)
    );
    for (const { name, expectedKeys } of SESSION_LIST_PARITY_LEGACY_REQUESTS) {
      for (const key of expectedKeys) {
        expect(keys.has(key), `${name} names ${key}`).toBe(true);
      }
    }
  });

  // Every write-scenario case orders by last activity alone, and both hosts
  // count a last-activity tie by its start time (session-list-parity-fixture),
  // so a repeated instant and start among the returned rows would be a tie.
  it("never lets a write-scenario case depend on a tie, before or after the writes", () => {
    const scenario = SESSION_LIST_PARITY_CONCURRENT_UPDATE;
    const written = applyWrites(scenario.rows, scenario.writes);
    expect(tiedCases(scenario.rows, scenario.before)).toEqual([]);
    expect(tiedCases(written, scenario.after)).toEqual([]);
  });
});

/**
 * The cases that sort by anything but last activity, name a row the scenario
 * does not hold, or return two rows at one instant.
 */
function tiedCases(
  rows: readonly SessionListParityRow[],
  cases: readonly ConformCase[]
): string[] {
  return cases.flatMap((parityCase) => {
    const sortFields = parityCase.expression.sorts?.map((rule) => rule.field);
    const returned = rows.filter((row) =>
      parityCase.expectedKeys.includes(row.key)
    );
    const instants = new Set(
      returned.map((row) => `${row.lastActivityAt}|${row.startedAt}`)
    );
    const untied =
      sortFields?.length === 1 &&
      sortFields[0] === SessionListField.LastActivity &&
      returned.length === parityCase.expectedKeys.length &&
      instants.size === returned.length;
    return untied ? [] : [parityCase.name];
  });
}

function applyWrites(
  rows: readonly SessionListParityRow[],
  writes: readonly SessionListParityWrite[]
): SessionListParityRow[] {
  return rows.map((row) => {
    const write = writes.find((candidate) => candidate.key === row.key);
    if (!write) {
      return row;
    }
    return {
      ...row,
      updatedAt: write.updatedAt,
      lastActivityAt: write.lastActivityAt ?? row.lastActivityAt,
      status: write.status ?? row.status,
      endedAt: write.endedAt === undefined ? row.endedAt : write.endedAt,
    };
  });
}
