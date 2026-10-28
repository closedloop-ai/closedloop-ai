import { describe, expect, it, vi } from "vitest";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import {
  buildListCursorFilterClause,
  buildUsageFilterClause,
} from "../src/main/database/session-aggregate-filters.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../src/main/session/shared-agent-sessions-api.js";
import { sharedAgentSessionsQuerySchema } from "../src/shared/shared-agent-sessions-contract-schema.js";
import {
  createFakeSource,
  cursor,
  session,
  usageAggregate,
} from "./shared-agent-sessions-test-helpers.js";

describe("local component session cohort", () => {
  it("constrains the SQL page before loading rows and leaves the org corpus alone", async () => {
    const source = createFakeSource({
      sessions: {
        selected: session({ id: "selected" }),
        other: session({ id: "other" }),
      },
    });
    source.resolveComponentSessionIds = vi.fn(async () => ["selected"]);
    source.listSessionCursorPage = vi.fn(async () => ({
      rows: [cursor("selected")],
      total: 1,
    }));
    const result = await getSharedAgentSessions(source, {
      componentSlug: "skill::review",
      limit: 1,
    });
    expect(source.resolveComponentSessionIds).toHaveBeenCalledWith(
      "skill::review"
    );
    expect(source.listSessionCursorPage).toHaveBeenCalledWith(
      expect.objectContaining({
        componentSessionIds: ["selected"],
        limit: 1,
        offset: 0,
      })
    );
    expect(result.items.map((row) => row.id)).toEqual(["selected"]);
    expect(
      source.calls.some((call) => call.kind === "listAllSessionCursorRows")
    ).toBe(false);
  });
  it("keeps the repository filter, date window and sort on a component cohort", async () => {
    const repository = "closedloop-ai/selected";
    const inWindow = "2026-05-01T00:00:00.000Z";
    const newer = "2026-05-02T00:00:00.000Z";
    const source = createFakeSource({
      cursorRows: [
        cursor("other-repo", newer),
        cursor("newest", newer),
        cursor("in-window", inWindow),
        cursor("before-window", "2026-01-15T00:00:00.000Z"),
      ],
      sessions: {
        "other-repo": session({
          id: "other-repo",
          repositoryFullName: "closedloop-ai/other",
          updatedAt: newer,
          startedAt: newer,
          lastActivityAt: newer,
        }),
        newest: session({
          id: "newest",
          repositoryFullName: repository,
          updatedAt: newer,
          startedAt: newer,
          lastActivityAt: newer,
        }),
        "in-window": session({
          id: "in-window",
          repositoryFullName: repository,
          updatedAt: inWindow,
          startedAt: inWindow,
          lastActivityAt: inWindow,
        }),
        "before-window": session({
          id: "before-window",
          repositoryFullName: repository,
          updatedAt: "2026-01-15T00:00:00.000Z",
          startedAt: "2026-01-15T00:00:00.000Z",
          lastActivityAt: "2026-01-15T00:00:00.000Z",
        }),
      },
    });
    source.resolveComponentSessionIds = vi.fn(async () => [
      "before-window",
      "in-window",
      "other-repo",
      "newest",
    ]);
    const result = await getSharedAgentSessions(source, {
      componentSlug: "skill::review",
      repositories: [repository],
      startDate: "2026-04-01T00:00:00.000Z",
      endDate: "2026-06-30T23:59:59.999Z",
      sortBy: SessionListCursorSortKey.LastActivity,
      sortDir: "desc",
      limit: 50,
      offset: 0,
    });
    expect(result.items.map((row) => row.id)).toEqual(["newest", "in-window"]);
    expect(result.total).toBe(2);
  });
  it("carries an empty cohort to SQL rather than treating it as an absent filter", async () => {
    const source = createFakeSource({});
    source.resolveComponentSessionIds = async () => [];
    source.aggregateUsage = vi.fn(async () => usageAggregate({}));
    await getSharedAgentSessionUsage(source, {
      componentSlug: "skill::review",
    });
    expect(source.aggregateUsage).toHaveBeenCalledWith(
      expect.objectContaining({ componentSessionIds: [] })
    );
    const list = buildListCursorFilterClause({ componentSessionIds: [] });
    const usage = buildUsageFilterClause({ componentSessionIds: [] });
    expect(list.params).toEqual(["[]"]);
    expect(usage.params).toEqual(["[]"]);
    expect(list.clause).toContain("s.id IN (SELECT value FROM json_each($1))");
    expect(usage.clause).toContain("s.id IN (SELECT value FROM json_each($1))");
  });
  it("refuses a missing native resolver and malformed modeled component scope", async () => {
    await expect(
      getSharedAgentSessions(createFakeSource({}), {
        componentSlug: "skill::review",
      })
    ).rejects.toThrow("Component-scoped sessions unavailable");
    expect(
      sharedAgentSessionsQuerySchema.safeParse({ componentSlug: 42 }).success
    ).toBe(false);
  });
});
