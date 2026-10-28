import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  projectByHarness,
  projectByProject,
  projectByRepository,
  projectByUser,
  projectModelFilterOptions,
} from "@/app/agent-sessions/service/usage-sql-projections";
import type { UsageSqlFacetCount } from "@/app/agent-sessions/service/usage-sql-reader";

const row = (over: Partial<UsageSqlFacetCount>): UsageSqlFacetCount => ({
  dimension: "owner",
  value: "u1",
  sessionCount: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
  errorCount: 0,
  ...over,
});

const user = (id: string, over: Partial<BasicUser> = {}): BasicUser =>
  ({
    id,
    email: `${id}@example.com`,
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
    ...over,
  }) as BasicUser;

describe("projectByUser", () => {
  it("labels a resolvable owner and carries its sums", () => {
    const [out] = projectByUser(
      [
        row({
          value: "u1",
          sessionCount: 41,
          inputTokens: 900,
          estimatedCost: 3.25,
        }),
      ],
      new Map([["u1", user("u1")]])
    );
    expect(out).toMatchObject({
      userId: "u1",
      userName: "Ada Lovelace",
      userEmail: "u1@example.com",
      sessionCount: 41,
      inputTokens: 900,
      estimatedCost: 3.25,
    });
  });

  it("drops an owner it cannot resolve rather than labelling it", () => {
    // A deleted owner leaves the session's user_id null (SetNull). Attributing
    // those sessions to anyone would be worse than omitting them.
    const out = projectByUser(
      [row({ value: "ghost", sessionCount: 5 })],
      new Map()
    );
    expect(out).toEqual([]);
  });

  it("drops a null owner key without consulting the lookup", () => {
    const out = projectByUser(
      [row({ value: null, sessionCount: 5 })],
      // A lookup that answers for a null key must not be able to attribute it.
      new Map([["null", user("null")]])
    );
    expect(out).toEqual([]);
  });

  it("sorts by session count, descending", () => {
    const out = projectByUser(
      [
        row({ value: "u1", sessionCount: 8 }),
        row({ value: "u2", sessionCount: 41 }),
        row({ value: "u3", sessionCount: 15 }),
      ],
      new Map([
        ["u1", user("u1")],
        ["u2", user("u2")],
        ["u3", user("u3")],
      ])
    );
    expect(out.map((r) => r.sessionCount)).toEqual([41, 15, 8]);
  });

  it("ignores rows from other dimensions", () => {
    const out = projectByUser(
      [row({ dimension: "harness", value: "claude", sessionCount: 99 })],
      new Map()
    );
    expect(out).toEqual([]);
  });
});

describe("projectByRepository", () => {
  it("publishes errorCount and omits the cache columns", () => {
    const [out] = projectByRepository([
      row({
        dimension: "repository",
        value: "o/r",
        sessionCount: 3,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 999,
        cacheWriteTokens: 999,
        estimatedCost: 1.5,
        errorCount: 2,
      }),
    ]);
    // The asymmetry is the contract's: byRepository declares errorCount and no
    // cache tokens, byUser the reverse.
    expect(out).toEqual({
      repositoryFullName: "o/r",
      sessionCount: 3,
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 1.5,
      errorCount: 2,
    });
    expect(out).not.toHaveProperty("cacheReadTokens");
  });

  it("drops the null-repository option, which has no key to publish under", () => {
    // Common and meaningful in the data — a session with no repository — but
    // repositoryFullName is non-nullable in the response.
    const out = projectByRepository([
      row({ dimension: "repository", value: null, sessionCount: 63 }),
      row({ dimension: "repository", value: "o/r", sessionCount: 1 }),
    ]);
    expect(out.map((r) => r.repositoryFullName)).toEqual(["o/r"]);
  });
});

describe("projectByHarness", () => {
  it("carries all four token columns plus cost", () => {
    const [out] = projectByHarness([
      row({
        dimension: "harness",
        value: "claude",
        sessionCount: 64,
        cacheReadTokens: 7,
        cacheWriteTokens: 9,
      }),
    ]);
    expect(out).toMatchObject({
      harness: "claude",
      sessionCount: 64,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
    });
    expect(out).not.toHaveProperty("errorCount");
  });
});

describe("projectModelFilterOptions", () => {
  it("returns counts only, with no sums", () => {
    const [out] = projectModelFilterOptions([
      row({
        dimension: "model",
        value: "opus",
        sessionCount: 4,
        estimatedCost: 9,
      }),
    ]);
    expect(out).toEqual({ model: "opus", sessionCount: 4 });
  });

  it("drops the null-model option", () => {
    const out = projectModelFilterOptions([
      row({ dimension: "model", value: null, sessionCount: 63 }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("projectByProject", () => {
  it("labels a project from the lookup", () => {
    const [out] = projectByProject(
      [row({ dimension: "project", value: "p1", sessionCount: 12 })],
      new Map([["p1", "Sessions v2"]])
    );
    expect(out).toEqual({
      projectId: "p1",
      projectName: "Sessions v2",
      sessionCount: 12,
    });
  });

  it("drops a project whose name cannot be resolved", () => {
    // A project id rendered as its own label is not a name, and a placeholder
    // is not an improvement over absence.
    const out = projectByProject(
      [row({ dimension: "project", value: "p-gone", sessionCount: 3 })],
      new Map()
    );
    expect(out).toEqual([]);
  });

  it("drops the null-project option", () => {
    const out = projectByProject(
      [row({ dimension: "project", value: null, sessionCount: 50 })],
      new Map()
    );
    expect(out).toEqual([]);
  });
});

/**
 * ISS-10851 — the tiebreak, on the only fixture that can reach it.
 *
 * Every case above ties on nothing: each feeds distinct session counts or a
 * single row, so the whole tiebreak clause could be deleted from all five
 * projections and the suite would stay green. These feed EQUAL counts in an
 * input order that is the reverse of the published one, so each case fails on
 * exactly one deletion — and the equality is on the full key sequence, not on a
 * membership check, because a set of the right rows in the wrong order is the
 * defect.
 */
describe("ISS-10851 — equal session counts resolve on the row's own key", () => {
  const TIED = 7;

  it("projectByUser orders a tie by userId, not by the input order", () => {
    const out = projectByUser(
      [
        row({ value: "u-c", sessionCount: TIED }),
        row({ value: "u-a", sessionCount: TIED }),
        row({ value: "u-b", sessionCount: TIED }),
      ],
      new Map([
        // Identical display names: `userName` is not a usable key, which is why
        // the projection reaches for the row's own id.
        ["u-a", user("u-a")],
        ["u-b", user("u-b")],
        ["u-c", user("u-c")],
      ])
    );
    expect(out.map((r) => r.userId)).toEqual(["u-a", "u-b", "u-c"]);
  });

  it("projectByHarness orders a tie by harness", () => {
    const out = projectByHarness([
      row({ dimension: "harness", value: "codex", sessionCount: TIED }),
      row({ dimension: "harness", value: "claude", sessionCount: TIED }),
    ]);
    expect(out.map((r) => r.harness)).toEqual(["claude", "codex"]);
  });

  it("projectByRepository orders a tie by repositoryFullName", () => {
    const out = projectByRepository([
      row({ dimension: "repository", value: "o/z", sessionCount: TIED }),
      row({ dimension: "repository", value: "o/a", sessionCount: TIED }),
    ]);
    expect(out.map((r) => r.repositoryFullName)).toEqual(["o/a", "o/z"]);
  });

  it("projectModelFilterOptions orders a tie by model", () => {
    const out = projectModelFilterOptions([
      row({ dimension: "model", value: "sonnet", sessionCount: TIED }),
      row({ dimension: "model", value: "opus", sessionCount: TIED }),
    ]);
    expect(out.map((r) => r.model)).toEqual(["opus", "sonnet"]);
  });

  it("projectByProject orders a tie by projectName", () => {
    const out = projectByProject(
      [
        row({ dimension: "project", value: "p2", sessionCount: TIED }),
        row({ dimension: "project", value: "p1", sessionCount: TIED }),
      ],
      new Map([
        ["p1", "Alpha"],
        ["p2", "Beta"],
      ])
    );
    expect(out.map((r) => r.projectName)).toEqual(["Alpha", "Beta"]);
  });

  it("falls through to projectId when two tied projects share a name", () => {
    // `Project` carries only `@@unique([organizationId, slug])` — one org can
    // hold two projects named the same, so name alone leaves the order to the
    // `UNION ALL` emission order, which is what diverged from the live path.
    const out = projectByProject(
      [
        row({ dimension: "project", value: "p-z", sessionCount: TIED }),
        row({ dimension: "project", value: "p-a", sessionCount: TIED }),
      ],
      new Map([
        ["p-a", "Duplicate Name"],
        ["p-z", "Duplicate Name"],
      ])
    );
    expect(out.map((r) => r.projectId)).toEqual(["p-a", "p-z"]);
  });
});
