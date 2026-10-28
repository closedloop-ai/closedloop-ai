import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import {
  SESSION_LIST_MAX_FILTER_VALUES,
  SESSION_LIST_MAX_OFFSET,
} from "@repo/api/src/types/agent-session-list-limits";
import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { findIssue } from "@repo/api/src/types/zod-issue.test-helpers";
import { describe, expect, it } from "vitest";
import { parseQueryParams } from "@/lib/route-utils";
import {
  agentSessionCreateBodySchema,
  agentSessionListQuerySchema,
  agentSessionUsageQuerySchema,
  baseAgentSessionQuerySchema,
  sanitizedAgentSessionCreateBodySchema,
} from "./validators";

describe("agentSessionUsageQuerySchema — comparison opt-in (ISS-5809)", () => {
  it("accepts explicit attribution options and preserves the legacy default", () => {
    expect(agentSessionUsageQuerySchema.parse({}).attribution).toBeUndefined();
    for (const attribution of Object.values(AgentSessionUsageAttribution)) {
      expect(
        agentSessionUsageQuerySchema.parse({ attribution }).attribution
      ).toBe(attribution);
      expect(
        agentSessionListQuerySchema.safeParse({ attribution }).success
      ).toBe(false);
    }
    expect(
      agentSessionUsageQuerySchema.safeParse({ attribution: "unknown" }).success
    ).toBe(false);
  });
  it("accepts the prior-period comparison on the usage read", () => {
    const parsed = agentSessionUsageQuerySchema.parse({
      startDate: "2026-07-08T00:00:00.000Z",
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(parsed.comparison).toBe(AgentSessionComparisonMode.Prior);
  });

  it("leaves comparison undefined when absent", () => {
    expect(agentSessionUsageQuerySchema.parse({}).comparison).toBeUndefined();
  });

  it("rejects an unrecognized comparison mode rather than dropping it", () => {
    expect(
      agentSessionUsageQuerySchema.safeParse({ comparison: "next" }).success
    ).toBe(false);
  });

  it("REJECTS comparison on the list and base schemas, which compute none", () => {
    // Accepting a filter a route cannot honor and silently dropping it is the
    // failure mode AGENTS.md forbids; the strict shapes reject it instead.
    expect(
      agentSessionListQuerySchema.safeParse({
        comparison: AgentSessionComparisonMode.Prior,
      }).success
    ).toBe(false);
    expect(
      baseAgentSessionQuerySchema.safeParse({
        comparison: AgentSessionComparisonMode.Prior,
      }).success
    ).toBe(false);
  });
});

describe("agentSessionListQuerySchema", () => {
  it("ISS-10332: accepts the priority sort and the priorities facet incl. the unset token", () => {
    const parsed = agentSessionListQuerySchema.parse({
      sorts: ["priority:desc"],
      priorities: [Priority.High, PRIORITY_UNSET_VALUE],
    });
    expect(parsed.sorts).toEqual([{ column: "priority", dir: "desc" }]);
    expect(parsed.priorities).toEqual([Priority.High, PRIORITY_UNSET_VALUE]);
    // A single repeated-key value normalizes to an array like every facet.
    expect(
      agentSessionListQuerySchema.parse({ priorities: Priority.Low }).priorities
    ).toEqual([Priority.Low]);
  });

  it("ISS-10332: REJECTS an off-vocabulary priority rather than accepting and ignoring it", () => {
    for (const value of ["CRITICAL", "high", ""]) {
      expect(
        agentSessionListQuerySchema.safeParse({ priorities: [value] }).success,
        value
      ).toBe(false);
    }
  });

  it("accepts Autonomy in both scalar and ordered sort forms", () => {
    const scalar = agentSessionListQuerySchema.parse({
      sortBy: "autonomy",
      sortDir: "desc",
    });
    const ordered = agentSessionListQuerySchema.parse({
      sorts: ["autonomy:desc"],
    });

    expect({ sortBy: scalar.sortBy, sortDir: scalar.sortDir }).toEqual({
      sortBy: "autonomy",
      sortDir: "desc",
    });
    expect(ordered.sorts).toEqual([{ column: "autonomy", dir: "desc" }]);
  });

  it("ISS-12251: accepts the assignee Owner sort beside the user spelling old clients send", () => {
    for (const column of ["assignee", "user"] as const) {
      expect(
        agentSessionListQuerySchema.parse({ sortBy: column, sortDir: "asc" })
          .sortBy
      ).toBe(column);
      expect(
        agentSessionListQuerySchema.parse({ sorts: [`${column}:asc`] }).sorts
      ).toEqual([{ column, dir: "asc" }]);
    }
  });

  it("parses harness/model/autonomy/cost facets, normalizing single values to arrays", () => {
    const parsed = agentSessionListQuerySchema.parse({
      harnesses: ["claude", "codex"],
      models: "claude-opus-4",
      autonomyTiers: ["high", "unknown"],
      costBuckets: "from_50",
    });

    expect(parsed.harnesses).toEqual(["claude", "codex"]);
    expect(parsed.models).toEqual(["claude-opus-4"]);
    expect(parsed.autonomyTiers).toEqual(["high", "unknown"]);
    expect(parsed.costBuckets).toEqual(["from_50"]);
  });

  it("parses change-presence/pr-association facets, normalizing single values to arrays", () => {
    const parsed = agentSessionListQuerySchema.parse({
      changePresence: "has_changes",
      prAssociation: ["has_pr", "no_pr"],
    });

    expect(parsed.changePresence).toEqual(["has_changes"]);
    expect(parsed.prAssociation).toEqual(["has_pr", "no_pr"]);
  });

  it("leaves the new facets undefined when absent", () => {
    const parsed = agentSessionListQuerySchema.parse({});

    expect(parsed.harnesses).toBeUndefined();
    expect(parsed.models).toBeUndefined();
    expect(parsed.autonomyTiers).toBeUndefined();
    expect(parsed.costBuckets).toBeUndefined();
    expect(parsed.changePresence).toBeUndefined();
    expect(parsed.prAssociation).toBeUndefined();
    // FEA-3284/FEA-3345: the validator leaves absent quality undefined; the
    // server seam (`buildWhere`) resolves it to the `all` fail-open default, so
    // an ungated caller shows every session rather than inheriting the hide gate.
    expect(parsed.quality).toBeUndefined();
  });

  it("parses every FEA-4145 quality-segment value and rejects unknown values", () => {
    // All three Substantive | Idle | All segment values are accepted...
    for (const value of SESSION_QUALITY_VALUES) {
      expect(
        agentSessionListQuerySchema.parse({ quality: value }).quality
      ).toBe(value);
    }
    // ...including `idle`, which the FEA-4145 segment newly added.
    expect(agentSessionListQuerySchema.parse({ quality: "idle" }).quality).toBe(
      "idle"
    );
    // ...and an unsupported value is REJECTED, not silently dropped.
    expect(
      agentSessionListQuerySchema.safeParse({ quality: "bogus" }).success
    ).toBe(false);
  });

  it("rejects unsupported query params instead of silently dropping them", () => {
    const result = agentSessionListQuerySchema.safeParse({
      unknownFilter: "value",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported query params even when mixed with valid ones", () => {
    const result = agentSessionListQuerySchema.safeParse({
      limit: 10,
      offset: 0,
      bogus: "should-fail",
    });

    expect(result.success).toBe(false);
  });
});

describe("agentSessionListQuerySchema — offset ceiling (ISS-8528)", () => {
  it("rejects offset above SESSION_LIST_MAX_OFFSET with the correct Zod path", () => {
    const result = agentSessionListQuerySchema.safeParse({
      offset: SESSION_LIST_MAX_OFFSET + 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const offsetIssue = result.error.issues.find((issue) =>
        issue.path.includes("offset")
      );
      expect(offsetIssue).toBeDefined();
      expect(offsetIssue!.path).toEqual(["offset"]);
    }
  });

  it("accepts offset at exactly SESSION_LIST_MAX_OFFSET", () => {
    const result = agentSessionListQuerySchema.safeParse({
      offset: SESSION_LIST_MAX_OFFSET,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(SESSION_LIST_MAX_OFFSET);
    }
  });

  it("accepts offset=0 (the default path)", () => {
    const result = agentSessionListQuerySchema.safeParse({ offset: 0 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(0);
    }
  });

  it("produces a 400 through the route entry point for over-cap offset", () => {
    const request = {
      nextUrl: {
        searchParams: new URLSearchParams({
          offset: String(SESSION_LIST_MAX_OFFSET + 1),
        }),
      },
    };
    const { errorResponse } = parseQueryParams(
      request,
      agentSessionListQuerySchema
    );

    expect(errorResponse).not.toBeNull();
    expect(errorResponse!.status).toBe(400);
  });
});

describe("baseAgentSessionQuerySchema", () => {
  it("rejects unsupported query params instead of silently dropping them", () => {
    const result = baseAgentSessionQuerySchema.safeParse({
      unknownFilter: "value",
    });

    expect(result.success).toBe(false);
  });

  // AGENTS.md L87-96: version-skewed Desktop clients may still send `search`
  // after the API deploys ahead — the base schema accepts and ignores it so
  // those clients don't get 400'd.
  it("accepts search for backward compatibility with version-skewed Desktop clients", () => {
    const result = baseAgentSessionQuerySchema.safeParse({
      search: "some query",
    });

    expect(result.success).toBe(true);
  });
});

describe("isoDateQuerySchema — Postgres timestamp floor (ISS-8735)", () => {
  const BELOW_PG_TIMESTAMP_FLOOR = [
    "-100000-01-01T00:00:00.000Z",
    "-271821-04-20T00:00:00.000Z",
  ] as const;
  const BELOW_FLOOR_MESSAGE =
    "Date is before the earliest instant a timestamp column can hold";
  const ACCEPTED_ISO_DATES = [
    "2026-06-03T24:00:00Z",
    "0050-03-04T10:00:00Z",
    "2024-02-29T12:00:00Z",
  ] as const;
  const LIST_QUERY_DATE_FIELDS = [
    "startDate",
    "endDate",
    "completedAfter",
  ] as const;

  it.each(LIST_QUERY_DATE_FIELDS)(
    "rejects a below-floor %s with the floor message",
    (field) => {
      for (const value of BELOW_PG_TIMESTAMP_FLOOR) {
        const result = agentSessionListQuerySchema.safeParse({
          [field]: value,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(findIssue(result.error.issues, [field])?.message).toBe(
            BELOW_FLOOR_MESSAGE
          );
        }
      }
    }
  );

  it.each(BELOW_PG_TIMESTAMP_FLOOR)(
    "rejects a below-floor startedAt %s on the create body with the floor message",
    (value) => {
      const result = agentSessionCreateBodySchema.safeParse({
        computeTargetId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        externalSessionId: "external-session-id",
        startedAt: value,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(findIssue(result.error.issues, ["startedAt"])?.message).toBe(
          BELOW_FLOOR_MESSAGE
        );
      }
    }
  );

  it.each(ACCEPTED_ISO_DATES)("accepts %s as startDate, unchanged", (value) => {
    const result = agentSessionListQuerySchema.safeParse({
      startDate: value,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startDate).toBe(value);
    }
  });

  it("accepts a valid startedAt on the create body, unchanged", () => {
    const value = "2026-06-03T24:00:00Z";
    const result = agentSessionCreateBodySchema.safeParse({
      computeTargetId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      externalSessionId: "external-session-id",
      startedAt: value,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startedAt).toBe(value);
    }
  });

  it("still rejects a malformed date with the original message", () => {
    const result = agentSessionListQuerySchema.safeParse({
      startDate: "not-a-date",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(findIssue(result.error.issues, ["startDate"])?.message).toBe(
        "Invalid date"
      );
    }
  });
});

describe("agentSessionListQuerySchema — repeatable facet bounds (ISS-9073)", () => {
  /** `n` distinct RFC-9562 UUIDs; the facet parses each with `z.string().uuid()`. */
  function uuids(count: number): string[] {
    return Array.from(
      { length: count },
      (_, index) =>
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
  }

  it("rejects more distinct values than the cap, naming the facet", () => {
    const result = agentSessionListQuerySchema.safeParse({
      userIds: uuids(SESSION_LIST_MAX_FILTER_VALUES + 1),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(findIssue(result.error.issues, ["userIds"])?.code).toBe("too_big");
    }
  });

  it("accepts exactly the cap", () => {
    const parsed = agentSessionListQuerySchema.parse({
      userIds: uuids(SESSION_LIST_MAX_FILTER_VALUES),
    });

    expect(parsed.userIds).toHaveLength(SESSION_LIST_MAX_FILTER_VALUES);
  });

  it("de-duplicates BEFORE capping, so one value repeated past the cap still parses to one entry", () => {
    // A cap-then-dedupe implementation would 400 this: the width to bound is
    // the DISTINCT set, and a client repeating one valid value costs nothing.
    const [single] = uuids(1);
    const parsed = agentSessionListQuerySchema.parse({
      userIds: Array.from(
        { length: SESSION_LIST_MAX_FILTER_VALUES + 50 },
        () => single
      ),
    });

    expect(parsed.userIds).toEqual([single]);
  });

  it("de-duplicates the ordered sort rules on the raw entry, keeping distinct rules for one column", () => {
    // `sorts` is built by the same helper. Two different rules on one column
    // are both kept here (resolveSessionSortRules picks the first later), and
    // a repeated identical rule collapses without changing the applied order.
    const distinct = agentSessionListQuerySchema.parse({
      sorts: ["cost:asc", "cost:desc"],
    });
    const repeated = agentSessionListQuerySchema.parse({
      sorts: ["cost:desc", "cost:desc", "started:asc"],
    });

    expect(distinct.sorts).toEqual([
      { column: "cost", dir: "asc" },
      { column: "cost", dir: "desc" },
    ]);
    expect(repeated.sorts).toEqual([
      { column: "cost", dir: "desc" },
      { column: "started", dir: "asc" },
    ]);
  });
});

describe("sanitizedAgentSessionCreateBodySchema — non-object bodies (ISS-9073)", () => {
  it("leaves a non-object body for the wrapped schema to report at the root", () => {
    const result =
      sanitizedAgentSessionCreateBodySchema.safeParse("not a body");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(findIssue(result.error.issues, [])?.code).toBe("invalid_type");
    }
  });
});

/**
 * ISS-8724: the ordered `sorts` param REJECTS a malformed or unknown entry
 * rather than dropping it, because an accept-and-drop rule renders in the
 * toolbar as applied while the order it asked for never happened. That posture
 * is the whole reason the param exists and nothing asserted it, so a rewrite
 * that reverted to dropping would have left the suite green.
 *
 * Every fixture below is an INDEPENDENT literal. Building one from
 * `AGENT_SESSION_SORT_COLUMNS` or from `parseSessionSortRule` would move the
 * expectation with the code it is guarding, and the mutation could not fail it.
 */
describe("agentSessionListQuerySchema — ordered sort rejection (ISS-8724)", () => {
  const MALFORMED_SORT_ENTRIES = [
    ["no separator", "cost"],
    ["empty column", ":asc"],
    ["empty direction", "cost:"],
    ["separator only", ":"],
    ["unknown column", "definitely-not-a-column:asc"],
    ["unknown direction", "cost:sideways"],
    ["uppercase direction", "cost:ASC"],
  ] as const;

  for (const [label, entry] of MALFORMED_SORT_ENTRIES) {
    it(`rejects a sorts entry — ${label}`, () => {
      const result = agentSessionListQuerySchema.safeParse({ sorts: [entry] });

      expect(result.success).toBe(false);
      expect(findIssue(result.error?.issues ?? [], ["sorts", 0])).toBeDefined();
    });
  }

  // `parseQueryParams` hands the schema a bare STRING, not an array, when
  // exactly one `sorts=` appears in the query — the shape a one-rule hand-built
  // URL actually produces — and every case above uses the array form.
  it("rejects a malformed single-value sorts param, not only the array form", () => {
    const result = agentSessionListQuerySchema.safeParse({ sorts: "cost" });

    expect(result.success).toBe(false);
    expect(findIssue(result.error?.issues ?? [], ["sorts", 0])).toBeDefined();
  });

  // The sibling that keeps the block above from being vacuous: the SAME
  // assertion run against a well-formed entry must come out the other way, or
  // a schema that rejected everything would pass every case above.
  it("accepts a well-formed entry under the same assertion, in either wire form", () => {
    const asArray = agentSessionListQuerySchema.safeParse({
      sorts: ["cost:asc"],
    });
    const asSingleValue = agentSessionListQuerySchema.safeParse({
      sorts: "cost:asc",
    });

    expect(asArray.success).toBe(true);
    expect(
      findIssue(asArray.error?.issues ?? [], ["sorts", 0])
    ).toBeUndefined();
    expect(asArray.data?.sorts).toEqual([{ column: "cost", dir: "asc" }]);
    expect(asSingleValue.success).toBe(true);
    expect(asSingleValue.data?.sorts).toEqual([{ column: "cost", dir: "asc" }]);
  });

  // REJECT, not drop. This pins the SCHEMA half only: the whole parse fails and
  // yields no `data`, so no caller can receive a silently shortened rule list.
  // Turning that into the 400 an operator sees is `parseQueryParams` plus
  // `apps/api/app/agent-sessions/route.ts`, and is NOT asserted here.
  it("rejects the whole query when only the second of two rules is bad", () => {
    const result = agentSessionListQuerySchema.safeParse({
      sorts: ["cost:asc", "definitely-not-a-column:asc"],
    });

    expect(result.success).toBe(false);
    expect(findIssue(result.error?.issues ?? [], ["sorts", 1])).toBeDefined();
    expect(result.data).toBeUndefined();
  });
});
