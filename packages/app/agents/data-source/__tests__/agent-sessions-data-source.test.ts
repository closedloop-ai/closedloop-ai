import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  type ListIsAnyOfClause,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpression } from "@repo/api/src/types/list-query-expression-schema";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import { createHttpAgentSessionsDataSource } from "../agent-sessions-data-source";

describe("createHttpAgentSessionsDataSource", () => {
  it.each([undefined, "skill::other"])(
    "rejects an unproven component cohort (%s)",
    async (componentScope) => {
      const source = createHttpAgentSessionsDataSource({
        get: async <T>() => ({ items: [], total: 0, componentScope }) as T,
      });
      await expect(
        source.list({ componentSlug: "skill::review" })
      ).rejects.toThrow("Component-scoped sessions unavailable");
      await expect(
        source.pageData({ componentSlug: "skill::review" })
      ).rejects.toThrow("Component-scoped sessions unavailable");
    }
  );

  it("keeps the scoped list when an older usage read cannot attest its cohort", async () => {
    const source = createHttpAgentSessionsDataSource({
      get: async <T>(path: string) =>
        (path.startsWith("/agent-sessions/usage")
          ? { totalSessions: 999 }
          : { items: [], total: 0, componentScope: "skill::review" }) as T,
    });
    const page = await source.pageData({ componentSlug: "skill::review" });
    expect(page.list.total).toBe(0);
    expect(page.usage).toBeUndefined();
    expect(page.usageError).toBe(true);
  });
  it("serializes selected session statuses as repeated query params", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      statuses: [SESSION_STATUS.ACTIVE, "completed", "abandoned"],
    });

    expect(requestedPaths).toEqual([
      `/agent-sessions?statuses=${SESSION_STATUS.ACTIVE}&statuses=${"completed"}&statuses=${"abandoned"}`,
    ]);
  });

  // FEA-4142: `countOnly` is a desktop-local projection hint; the cloud route
  // already returns a cheap `count()` total, so it must not reach the wire.
  it("strips the countOnly hint from the cloud query string", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      statuses: ["completed"],
      completedAfter: "2026-03-12T00:00:00.000Z",
      countOnly: true,
      limit: 1,
    });

    expect(requestedPaths).toEqual([
      `/agent-sessions?statuses=${"completed"}&completedAfter=2026-03-12T00%3A00%3A00.000Z&limit=1`,
    ]);
  });

  // PRD-721 / ISS-9346: the facets travel as one canonical `listQuery`
  // expression in place of the repeated legacy params they used to be sent as.
  it("sends harness/model/autonomy/cost facets as one listQuery expression", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      harnesses: ["claude", "codex"],
      models: ["claude-opus-4"],
      autonomyTiers: ["high", "unknown"],
      costBuckets: ["from_50"],
    });

    expect(requestedPaths).toHaveLength(1);
    expect(listQueryRequestOf(requestedPaths[0])).toEqual({
      path: "/agent-sessions",
      params: {},
      expression: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          anyOf(SessionListField.Harness, ["claude", "codex"]),
          anyOf(SessionListField.Model, ["claude-opus-4"]),
          anyOf(SessionListField.Autonomy, ["high", "unknown"]),
          anyOf(SessionListField.Cost, ["from_50"]),
        ],
      },
    });
  });

  // FEA-3120: the HTTP source always reads synced cloud state, so it stamps
  // `cloud` at the read boundary.
  it("stamps readSource=cloud on list responses that omit it", async () => {
    const source = createHttpAgentSessionsDataSource({
      get: <T>() =>
        Promise.resolve({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
        } as T),
    });

    const response = await source.list({});

    expect(response.readSource).toBe(ReadSource.Cloud);
  });

  // No silent overwrite: a backend that already attributes a source stays
  // authoritative — the boundary must not clobber `fallback` into `cloud`.
  it("preserves an explicit server-provided readSource", async () => {
    const source = createHttpAgentSessionsDataSource({
      get: <T>() =>
        Promise.resolve({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
          readSource: ReadSource.Fallback,
        } as T),
    });

    const response = await source.list({});

    expect(response.readSource).toBe(ReadSource.Fallback);
  });

  // PLN-1138 Phase 4 (AC cloud-path correctness): the cloud read is
  // server-authoritative — column sort and pagination are forwarded verbatim as
  // query params so the server's ORDER BY / LIMIT / OFFSET decide the page.
  it("forwards column sort and pagination as query params for the server to apply", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.list({
      sortBy: SessionSortKey.Started,
      sortDir: SessionSortDir.Desc,
      limit: 25,
      offset: 50,
    });

    // The canonical server sort key ("started"), not a column-detail alias — the
    // API validates the sort field against AGENT_SESSION_SORT_COLUMNS and
    // refuses others. PRD-721: the sort travels inside `listQuery`; paging
    // stays a legacy param beside it.
    expect(listQueryRequestOf(requestedPaths[0])).toEqual({
      path: "/agent-sessions",
      params: { limit: "25", offset: "50" },
      expression: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [
          { field: SessionSortKey.Started, direction: SessionSortDir.Desc },
        ],
      },
    });
  });

  // The cloud path must NOT re-order client-side: whatever order the server
  // returns is the order the user sees. A client comparator would fight the
  // server's ORDER BY and desync pagination.
  it("returns the server's item order untouched (no client-side re-sort)", async () => {
    const serverOrder = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const source = createHttpAgentSessionsDataSource({
      get: <T>() =>
        Promise.resolve({
          items: serverOrder,
          total: serverOrder.length,
          viewerScope: AgentSessionViewerScope.Self,
        } as T),
    });

    const response = await source.list({
      sortBy: SessionSortKey.Started,
      sortDir: SessionSortDir.Asc,
    });

    expect(response.items.map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  // The usage and analytics routes use the base schema, which does not model
  // pagination or sort. The HTTP source must strip those so the strict server
  // schema accepts the request.
  it("strips pagination and sort params from the usage query string", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.usage({
      startDate: "2026-01-01T00:00:00.000Z",
      limit: 25,
      offset: 0,
      sortBy: "started",
      sortDir: "desc",
    });

    expect(requestedPaths).toEqual([
      "/agent-sessions/usage?startDate=2026-01-01T00%3A00%3A00.000Z&attribution=omit",
    ]);
  });

  it("strips pagination and sort params from the analytics query string", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.analytics({
      startDate: "2026-01-01T00:00:00.000Z",
      limit: 25,
      offset: 50,
    });

    expect(requestedPaths).toEqual([
      "/agent-sessions/analytics?startDate=2026-01-01T00%3A00%3A00.000Z",
    ]);
  });

  // ISS-9741: the signal has to reach the TRANSPORT, not just be accepted by the
  // source — the init recorded here is what the web `fetch` (or the desktop
  // bridge) is handed, and it is the only thing that can tear the aggregate down.
  it("forwards the query's AbortSignal on the analytics request", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const get = <T>(_path: string, options?: RequestInit): Promise<T> => {
      inits.push(options);
      return Promise.resolve({} as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });
    const controller = new AbortController();

    await source.analytics(
      { startDate: "2026-01-01T00:00:00.000Z" },
      { signal: controller.signal }
    );
    await source.analytics({ startDate: "2026-01-01T00:00:00.000Z" });

    expect(inits[0]?.signal).toBe(controller.signal);
    // A signal-less read keeps the exact arity it always had, rather than being
    // handed `{ signal: undefined }`.
    expect(inits[1]).toBeUndefined();
  });

  // FEA-4157: the combined read fetches the list + usage for the same filters so
  // the table and its summary cards share one round trip's worth of work, and
  // stamps the list half `cloud` at the read boundary like the standalone `list`.
  it("pageData reads the list and usage endpoints and stamps the list cloud", async () => {
    const requestedPaths: string[] = [];
    const get = <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      if (path.startsWith("/agent-sessions/usage")) {
        return Promise.resolve({ totalSessions: 3 } as T);
      }
      return Promise.resolve({
        items: [{ id: "s1" }],
        total: 3,
        viewerScope: AgentSessionViewerScope.Self,
      } as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });

    const response = await source.pageData({ limit: 25, offset: 0 });

    // The list route receives pagination; the usage route uses the base schema
    // which does not model limit/offset/sortBy/sortDir — those are stripped so
    // the strict server schema accepts the request.
    expect(requestedPaths).toEqual([
      "/agent-sessions?limit=25&offset=0",
      "/agent-sessions/usage?attribution=omit",
    ]);
    expect(response.list.readSource).toBe(ReadSource.Cloud);
    expect(response.list.total).toBe(3);
    expect(response.usage?.totalSessions).toBe(3);
    expect(response.usageError).toBeUndefined();
  });

  // FEA-4177 — independent failure domains: a usage-read failure degrades ONLY
  // the summary half. `pageData` still resolves the list with `usage` omitted and
  // `usageError: true`, instead of rejecting and blanking the table.
  it("pageData resolves the list with usageError when only the usage read fails", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/agent-sessions/usage")) {
        return Promise.reject(new Error("usage read failed"));
      }
      return Promise.resolve({
        items: [{ id: "s1" }],
        total: 1,
        viewerScope: AgentSessionViewerScope.Self,
      } as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });

    const response = await source.pageData({ limit: 25, offset: 0 });

    expect(response.list.total).toBe(1);
    expect(response.list.readSource).toBe(ReadSource.Cloud);
    expect(response.usage).toBeUndefined();
    expect(response.usageError).toBe(true);
  });

  // FEA-4177 — the list is the required half: its failure still rejects (the
  // table cannot render without rows), even when the usage read succeeded.
  it("pageData rejects when the list read fails", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/agent-sessions/usage")) {
        return Promise.resolve({ totalSessions: 3 } as T);
      }
      return Promise.reject(new Error("list read failed"));
    };
    const source = createHttpAgentSessionsDataSource({ get });

    await expect(source.pageData({ limit: 25, offset: 0 })).rejects.toThrow(
      "list read failed"
    );
  });

  // FEA-4177 whitlockk review: a list rejection must surface the instant it lands —
  // it must NOT wait for the optional usage read. If usage stalls indefinitely, a
  // `Promise.allSettled([list, usage])` join would hang the whole read; the
  // required list is awaited directly so its rejection propagates immediately.
  it("pageData rejects on a list failure even while the usage read never settles", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/agent-sessions/usage")) {
        // Never settles — simulates a stalled optional read.
        return new Promise<T>(() => {
          /* intentionally pending forever */
        });
      }
      return Promise.reject(new Error("list read failed"));
    };
    const source = createHttpAgentSessionsDataSource({ get });

    await expect(source.pageData({ limit: 25, offset: 0 })).rejects.toThrow(
      "list read failed"
    );
  });
});

// ISS-5809: the comparison opt-in is a USAGE dimension. That the analytics and
// export reads cannot carry it is enforced by the TYPE — `comparison` lives on
// `AgentSessionUsageQueryFilters`, not the shared `AgentSessionQueryFilters` the
// other reads take — so collapsing that split fails `tsc` rather than a test
// here. What is testable is the wire shape of the usage read itself.
describe("createHttpAgentSessionsDataSource — usage comparison (ISS-5809)", () => {
  it("forwards the comparison opt-in on the usage read", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.usage({
      startDate: "2026-08-04T00:00:00.000Z",
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(requestedPaths).toEqual([
      `/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&comparison=${AgentSessionComparisonMode.Prior}&attribution=omit`,
    ]);
  });

  // Deploy skew: `apps/app` and `apps/api` promote independently, so a shell that
  // knows the opt-in can reach an API whose `.strict()` usage schema rejects it.
  // Losing the chips to that is acceptable; losing every headline card is not.
  it("retries without the opt-in when the API rejects it, and still returns a summary", async () => {
    const requestedPaths: string[] = [];
    const get = <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      if (path.includes("comparison=")) {
        return Promise.reject(
          new ApiError("Unrecognized key(s) in object: 'comparison'", 400)
        );
      }
      return Promise.resolve({ totalSessions: 7 } as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });

    const summary = await source.usage({
      startDate: "2026-08-04T00:00:00.000Z",
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(summary.totalSessions).toBe(7);
    expect(requestedPaths).toEqual([
      `/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&comparison=${AgentSessionComparisonMode.Prior}&attribution=omit`,
      "/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z",
    ]);
  });

  // ISS-7852 — the deploy-skew fallback and a supersession can land together: a
  // 400 arrives on the opt-in read just as the query is replaced. The retry is a
  // second read on the wire, and the desktop cloud bridge deliberately does not
  // forward the signal, so it would genuinely be issued for a range nobody is
  // waiting for. Cancellation has to win.
  it("does not fire the deploy-skew retry for a query superseded during the opt-in read", async () => {
    const controller = new AbortController();
    const requestedPaths: string[] = [];
    const get = <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      // The supersession happens while the opt-in read is in flight, so the
      // 400 and the abort reach the catch together.
      controller.abort();
      return Promise.reject(
        new ApiError("Unrecognized key(s) in object: 'comparison'", 400)
      ) as Promise<T>;
    };
    const source = createHttpAgentSessionsDataSource({ get });

    await expect(
      source.usage(
        {
          startDate: "2026-08-04T00:00:00.000Z",
          comparison: AgentSessionComparisonMode.Prior,
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    // Exactly the one opt-in read — the obsolete fallback never went out.
    expect(requestedPaths).toEqual([
      `/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&comparison=${AgentSessionComparisonMode.Prior}&attribution=omit`,
    ]);
  });

  // A 5xx or a timeout is not a schema disagreement. Retrying it would double the
  // load on an already-failing backend and mask the real error from the reader.
  it("does not retry a server error", async () => {
    const requestedPaths: string[] = [];
    const get = <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      return Promise.reject(new ApiError("upstream timeout", 503));
    };
    const source = createHttpAgentSessionsDataSource({ get });

    await expect(
      source.usage({
        startDate: "2026-08-04T00:00:00.000Z",
        comparison: AgentSessionComparisonMode.Prior,
      })
    ).rejects.toThrow("upstream timeout");
    expect(requestedPaths).toHaveLength(1);
  });
});

// ISS-6041: the combined read's usage half is the same read `usage()` issues, so
// it takes the same opt-in — that is what lets the desktop Sessions view, which
// reads through this exact source in Cloud mode, chip the deltas the web page
// chips. The list half must NOT carry the param: the list route's schema is
// strict and answers 400.
describe("createHttpAgentSessionsDataSource — pageData comparison (ISS-6041)", () => {
  it("forwards the opt-in on the usage half only, never on the list half", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.pageData({
      startDate: "2026-08-04T00:00:00.000Z",
      limit: 25,
      offset: 0,
      comparison: AgentSessionComparisonMode.Prior,
    });

    const [usagePath, listPath] = [...requestedPaths].sort();
    expect(usagePath).toBe(
      "/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&comparison=prior&attribution=omit"
    );
    expect(listQueryRequestOf(listPath)).toEqual(
      lastActivityListRequest("2026-08-04T00:00:00.000Z")
    );
    expect(
      requestedPaths.filter(
        (path) =>
          path.startsWith("/agent-sessions?") && path.includes("comparison")
      )
    ).toEqual([]);
  });

  it("returns the comparison the producer emitted on the usage half", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/agent-sessions/usage")) {
        return Promise.resolve({
          totalSessions: 12,
          comparison: {
            priorStartDate: "2026-07-05T00:00:00.000Z",
            priorEndDate: "2026-08-03T23:59:59.999Z",
            deltas: { sessions: 20 },
          },
        } as T);
      }
      return Promise.resolve({
        items: [],
        total: 0,
        viewerScope: AgentSessionViewerScope.Self,
      } as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });

    const page = await source.pageData({
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(page.usage?.comparison?.deltas.sessions).toBe(20);
  });

  // Same deploy-skew contract the standalone usage read has: an API that does not
  // know the param must cost the chips, never the headline figures.
  it("retries the usage half without the opt-in when the API rejects it", async () => {
    const requestedPaths: string[] = [];
    const get = <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      if (path.includes("comparison=")) {
        return Promise.reject(
          new ApiError("Unrecognized key(s) in object: 'comparison'", 400)
        );
      }
      if (path.startsWith("/agent-sessions/usage")) {
        return Promise.resolve({ totalSessions: 9 } as T);
      }
      return Promise.resolve({
        items: [],
        total: 0,
        viewerScope: AgentSessionViewerScope.Self,
      } as T);
    };
    const source = createHttpAgentSessionsDataSource({ get });

    const page = await source.pageData({
      startDate: "2026-08-04T00:00:00.000Z",
      comparison: AgentSessionComparisonMode.Prior,
    });

    expect(page.usage?.totalSessions).toBe(9);
    expect(page.usageError).toBeUndefined();
    expect(
      requestedPaths.filter((path) => path.startsWith("/agent-sessions/usage"))
    ).toEqual([
      `/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&comparison=${AgentSessionComparisonMode.Prior}&attribution=omit`,
      "/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z",
    ]);
  });

  // The listing omits unused attribution lenses even without comparison.
  it("omits unused attribution without changing the list query", async () => {
    const requestedPaths: string[] = [];
    const get = createRecordingAgentSessionsGet(requestedPaths);
    const source = createHttpAgentSessionsDataSource({ get });

    await source.pageData({
      startDate: "2026-08-04T00:00:00.000Z",
      limit: 25,
      offset: 0,
    });

    const [usagePath, listPath] = [...requestedPaths].sort();
    expect(usagePath).toBe(
      "/agent-sessions/usage?startDate=2026-08-04T00%3A00%3A00.000Z&attribution=omit"
    );
    expect(listQueryRequestOf(listPath)).toEqual(
      lastActivityListRequest("2026-08-04T00:00:00.000Z")
    );
  });
});

describe("ISS-13035 the list route's search term is opt-in", () => {
  it("LIST-SEARCH-1 keeps stripping the desktop-local search hint from the cloud list query", async () => {
    const requestedPaths: string[] = [];
    const source = createHttpAgentSessionsDataSource({
      get: createRecordingAgentSessionsGet(requestedPaths),
    });

    await source.list({ limit: 1, search: "feature" });

    expect(requestedPaths).toEqual(["/agent-sessions?limit=1"]);
  });

  it("LIST-SEARCH-2 sends listSearch to the cloud list route as search", async () => {
    const requestedPaths: string[] = [];
    const source = createHttpAgentSessionsDataSource({
      get: createRecordingAgentSessionsGet(requestedPaths),
    });

    await source.list({ limit: 1, listSearch: "feature" });

    expect(requestedPaths).toEqual(["/agent-sessions?limit=1&search=feature"]);
  });
});

function createRecordingAgentSessionsGet(requestedPaths: string[]) {
  return function get<T>(path: string): Promise<T> {
    requestedPaths.push(path);
    return Promise.resolve({
      items: [],
      total: 0,
      viewerScope: AgentSessionViewerScope.Self,
    } as T);
  };
}

/**
 * A recorded list path as its parsed `listQuery` expression plus the params
 * that travel beside it. A path with no `listQuery`, or one that does not
 * parse, yields a `null` expression so the assertion names the difference.
 */
function listQueryRequestOf(path: string | undefined) {
  const url = new URL(`https://cloud.invalid${path ?? ""}`);
  const raw = url.searchParams.get(LIST_QUERY_EXPRESSION_PARAM);
  url.searchParams.delete(LIST_QUERY_EXPRESSION_PARAM);
  const parsed = raw === null ? null : parseListQueryExpression(raw);
  return {
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
    expression: parsed?.ok ? parsed.expression : null,
  };
}

function anyOf(field: string, values: string[]): ListIsAnyOfClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}

/** The list half of a page read windowed from `startDate`, paged 25 from 0. */
function lastActivityListRequest(startDate: string) {
  return {
    path: "/agent-sessions",
    params: { limit: "25", offset: "0" },
    expression: {
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        {
          field: SessionListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
          min: startDate,
        },
      ],
    },
  };
}
