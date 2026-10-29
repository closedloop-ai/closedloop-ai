/**
 * Branch-coverage top-up for `csv-export.ts` (ISS-11280): the "Unattributed"
 * fallbacks on `toCsvExportRows`, the non-empty `tokenUsageByModel` arm, the
 * aggregation key's user fallback, and `sortCsvExportRows`'s ordering.
 *
 * `csv-export.test.ts` (sibling file) already covers the happy-path row shape
 * and the keyset-pagination loop through `agentSessionsService.findExportRows`
 * — this file drives `toCsvExportRows` and `collectAggregatedCsvExportRows`
 * directly so it doesn't need that harness's full DB mock surface.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionExportRecord } from "./records";

const findManyMock = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: (fn: (db: unknown) => unknown) =>
      fn({ sessionDetail: { findMany: findManyMock } }),
  };
});

import { collectAggregatedCsvExportRows, toCsvExportRows } from "./csv-export";

/**
 * `user` is the row's person, which the export reads off the artifact's
 * creator (ISS-12251 D-4); it is placed there so each case states only it.
 */
function exportRecord({
  user = null,
  artifact = { project: null },
  ...overrides
}: Record<string, unknown> = {}): AgentSessionExportRecord {
  return {
    sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
    deviceTimeZone: null,
    harness: "claude",
    model: "claude-sonnet-4",
    artifact: { ...(artifact as object), createdBy: user },
    tokenUsageByModel: [],
    ...overrides,
  } as unknown as AgentSessionExportRecord;
}

describe("toCsvExportRows — Unattributed fallbacks", () => {
  it("falls back to Unattributed user/team/project and Unknown model when the row carries none", () => {
    const rows = toCsvExportRows(
      exportRecord({ user: null, artifact: { project: null }, model: null })
    );

    expect(rows).toEqual([
      expect.objectContaining({
        user: "Unattributed",
        team: "Unattributed",
        project: "Unattributed",
        model: "Unknown",
      }),
    ]);
  });

  it("returns one row per model with converted token/cost fields when tokenUsageByModel is non-empty", () => {
    const rows = toCsvExportRows(
      exportRecord({
        user: {
          id: "user-1",
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          avatarUrl: null,
          teamMemberships: [{ team: { name: "Platform" } }],
        },
        artifact: { project: { name: "Agent Platform" } },
        tokenUsageByModel: [
          {
            model: "gpt-4",
            inputTokens: 100n,
            outputTokens: 50n,
            cacheWriteTokens: 5n,
            cacheReadTokens: 2n,
            estimatedCost: { toNumber: () => 1.23 },
          },
        ],
      })
    );

    expect(rows).toEqual([
      expect.objectContaining({
        model: "gpt-4",
        sessionCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 5,
        cacheReadTokens: 2,
        estimatedCost: 1.23,
      }),
    ]);
  });
});

const ORG = "org-1";

describe("collectAggregatedCsvExportRows — aggregation and ordering", () => {
  it("merges two userless sessions into one aggregated row under the same fallback key, threading the caller's where through unchanged", async () => {
    findManyMock.mockResolvedValueOnce([
      exportRecord({ user: null, model: "shared-model" }),
      exportRecord({ user: null, model: "shared-model" }),
    ]);
    const where = { artifact: { is: { organizationId: ORG } } };

    const rows = await collectAggregatedCsvExportRows(where);

    // collectAggregatedCsvExportRows passes its caller's `where` straight to
    // the query with no transformation of its own — org-scoping is the
    // caller's contract, not this function's, so the only thing to pin here
    // is that the argument actually reaches `findMany` unchanged.
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where })
    );
    expect(rows).toEqual([
      expect.objectContaining({ user: "Unattributed", sessionCount: 2 }),
    ]);
  });

  it("sorts by date descending, then by user ascending within the same date", async () => {
    findManyMock.mockResolvedValueOnce([
      exportRecord({
        sessionStartedAt: new Date("2026-05-19T17:00:00.000Z"),
        user: userFixture("user-b", "Bea"),
        model: "m1",
      }),
      exportRecord({
        sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
        user: userFixture("user-b", "Bea"),
        model: "m1",
      }),
      exportRecord({
        sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
        user: userFixture("user-a", "Ada"),
        model: "m1",
      }),
    ]);

    const rows = await collectAggregatedCsvExportRows({});

    expect(rows.map((row) => [row.date, row.user])).toEqual([
      ["2026-05-20", "Ada"],
      ["2026-05-20", "Bea"],
      ["2026-05-19", "Bea"],
    ]);
  });

  it("breaks a same-date, same-user tie by model, ascending", async () => {
    findManyMock.mockResolvedValueOnce([
      exportRecord({
        sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
        user: userFixture("user-a", "Ada"),
        model: "zeta-model",
      }),
      exportRecord({
        sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
        user: userFixture("user-a", "Ada"),
        model: "alpha-model",
      }),
    ]);

    const rows = await collectAggregatedCsvExportRows({});

    expect(rows.map((row) => row.model)).toEqual(["alpha-model", "zeta-model"]);
  });
});

function userFixture(id: string, firstName: string) {
  return {
    id,
    email: `${id}@example.com`,
    firstName,
    lastName: "",
    avatarUrl: null,
    teamMemberships: [],
  };
}
