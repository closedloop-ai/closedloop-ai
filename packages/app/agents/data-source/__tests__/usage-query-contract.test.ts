import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  type AgentSessionUsageQueryFilters,
  createHttpAgentSessionsDataSource,
  USAGE_STRIPPED_FILTER_KEYS,
} from "../agent-sessions-data-source";

/**
 * ISS-6041 — the agreement between {@link USAGE_STRIPPED_FILTER_KEYS} and the URL
 * the usage read actually builds.
 *
 * The exported list is a contract other modules reason about: the desktop
 * Sessions view derives its comparison scope by dropping exactly this set, on the
 * strength of "a field the usage request never carries cannot move the usage
 * aggregate or its prior window". `toBaseFilters` states the same set a second
 * time, as a type-checked destructure. Two statements of one set drift, and the
 * drift is silent — a usage route taught to honor `search` would leave desktop
 * holding a comparison computed over an unsearched population while the figures
 * beside it were searched, with every other test still green.
 *
 * So this asserts the built URL against the list itself, both ways: nothing in
 * the list survives into the query string, and everything NOT in it does.
 */

/**
 * EVERY field the filter shape can carry, which is what makes the two loops
 * below exhaustive rather than a sample.
 *
 * `Required<…>` is the load-bearing part: a hand-picked subset let a field added
 * to `AgentSessionQueryFilters` and stripped by `toBaseFilters` — but never added
 * to {@link USAGE_STRIPPED_FILTER_KEYS} — pass this suite green, because neither
 * loop can see a key the sample omits. That is precisely the drift this file
 * exists to catch, so the compiler is what enforces the sample's completeness:
 * a new field fails `tsc` here until it is given a value AND classified.
 *
 * Every value is non-empty and non-null, because `buildSearchParams` drops
 * `undefined`/`null` and emits nothing for an empty array — a field represented
 * by one of those would read as "stripped" no matter what the builder did.
 */
const RECOGNIZED_FILTERS: Required<AgentSessionUsageQueryFilters> = {
  componentSlug: "skill::review",
  autonomyTiers: ["high"],
  changePresence: ["has_changes"],
  comparison: AgentSessionComparisonMode.Prior,
  completedAfter: "2026-07-20T00:00:00.000Z",
  costBuckets: ["high"],
  countOnly: true,
  endDate: "2026-08-13T23:59:59.999Z",
  harness: "claude",
  harnesses: ["claude"],
  limit: 25,
  listSearch: "deploy",
  models: ["opus"],
  offset: 50,
  prAssociation: ["has_pr"],
  projectId: "project-usage-contract",
  projectIds: ["project-usage-contract"],
  quality: SESSION_QUALITY_VALUES[0],
  repositories: ["acme/web"],
  search: "deploy",
  sortBy: "cost",
  sortDir: "asc",
  // ISS-8335: the multi-rule sort. Non-empty, like every value here, so the loop
  // can tell a key the builder STRIPPED from one it merely serialized to nothing.
  sorts: ["cost:asc", "status:desc"],
  startDate: "2026-07-14T00:00:00.000Z",
  status: "active",
  statuses: ["active"],
  teamId: "team-usage-contract",
  userId: "user-usage-contract",
  userIds: ["user-usage-contract"],
  viewerScope: AgentSessionViewerScope.Organization,
};

describe("USAGE_STRIPPED_FILTER_KEYS", () => {
  it("retries the legacy schema without attribution when comparison is absent", async () => {
    const paths: string[] = [];
    const source = createHttpAgentSessionsDataSource({
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        return path.includes("attribution=")
          ? Promise.reject(new ApiError("Unknown attribution option", 400))
          : Promise.resolve({ totalSessions: 7 } as T);
      },
    });
    expect((await source.usage({})).totalSessions).toBe(7);
    expect(paths).toEqual([
      "/agent-sessions/usage?attribution=omit",
      "/agent-sessions/usage",
    ]);
  });

  it.each([401, 403, 429, 500, 503])(
    "does not repeat a %i failure",
    async (status) => {
      const paths: string[] = [];
      const source = createHttpAgentSessionsDataSource({
        get: <T>(path: string): Promise<T> => {
          paths.push(path);
          return Promise.reject(new ApiError("Request failed", status));
        },
      });
      await expect(source.usage({})).rejects.toThrow("Request failed");
      expect(paths).toHaveLength(1);
    }
  );

  it("surfaces the ORIGINAL 400 when the legacy retry is rejected too", async () => {
    // whitlockk review: a 400 does not name which part of the request the API
    // rejected, so this fallback also fires for a request that is simply bad.
    // The caller must then see the complaint about the request it MADE, not the
    // second one about a shape it never asked for.
    const paths: string[] = [];
    const source = createHttpAgentSessionsDataSource({
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        return Promise.reject(
          new ApiError(
            path.includes("attribution=")
              ? "endDate must be after startDate"
              : "Unknown legacy shape",
            400
          )
        ) as Promise<T>;
      },
    });

    await expect(source.usage({})).rejects.toThrow(
      "endDate must be after startDate"
    );
    // Still exactly the one retry — the fallback is attempted, not skipped.
    expect(paths).toEqual([
      "/agent-sessions/usage?attribution=omit",
      "/agent-sessions/usage",
    ]);
  });

  it("names every field the usage URL drops, and only those", async () => {
    const requestedPaths: string[] = [];
    const source = createHttpAgentSessionsDataSource({
      get: <T>(path: string): Promise<T> => {
        requestedPaths.push(path);
        return Promise.resolve({
          componentScope: RECOGNIZED_FILTERS.componentSlug,
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
        } as T);
      },
    });

    await source.usage(RECOGNIZED_FILTERS);

    const usageUrl = requestedPaths.at(0) ?? "";
    const query = new URLSearchParams(usageUrl.split("?").at(1) ?? "");
    for (const key of USAGE_STRIPPED_FILTER_KEYS) {
      expect(
        query.has(key),
        `${key} is listed as stripped but reached the usage URL`
      ).toBe(false);
    }
    // The other half of the contract: a field absent from the list MUST survive,
    // or the list is understating what the usage read ignores and the desktop
    // scope key would miss a dimension that really does move the aggregate.
    const stripped = new Set<string>(USAGE_STRIPPED_FILTER_KEYS);
    for (const key of Object.keys(RECOGNIZED_FILTERS)) {
      if (stripped.has(key)) {
        continue;
      }
      expect(
        query.has(key),
        `${key} is not listed as stripped but never reached the usage URL`
      ).toBe(true);
    }
  });
});
