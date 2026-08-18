import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import type { TokenTrendPoint } from "@repo/api/src/types/agent-component-analytics";
import type { AgentComponentInvocationReadRow } from "@repo/api/src/types/agent-component-invocation";
import type { SyncedAgentSessionEvent } from "@repo/api/src/types/agent-session";
import type { BranchViewBranch } from "@repo/api/src/types/branch-view";
import type { TraceComment } from "@repo/api/src/types/comment";
import type { Document } from "@repo/api/src/types/document";
import type { Loop } from "@repo/api/src/types/loop";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import { ApiAdapterProvider } from "../provider";
import { useApiClient } from "../use-api-client";

/**
 * ISS-5771 regression suite for the web client's JSON date revival.
 *
 * `useApiClient` reads every response through `JSON.parse(raw, reviveWithDates)`.
 * Before this ticket the reviver keyed off VALUE SHAPE alone, so *any* ISO-8601
 * string became a `Date` — including fields the shared contract declares as
 * `string` and including user-authored free text. The declared type and the
 * runtime shape disagreed app-wide, silently, and `tsc` could not see it.
 *
 * These tests drive the real hook through the real parse boundary and assert the
 * RUNTIME TYPE of the parsed value, not that a helper was called.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const TEST_ORIGIN = "https://api.test";
const ISO = "2026-08-10T12:34:56.000Z";

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("useApiClient date revival (ISS-5771)", () => {
  it("leaves a contract-`string` timestamp as a string (invokedAt)", async () => {
    const row = await getData<AgentComponentInvocationReadRow>({
      invokedAt: ISO,
      capturedAt: ISO,
      sourceModifiedAt: ISO,
    });

    expect(typeof row.invokedAt).toBe("string");
    expect(row.invokedAt).toBe(ISO);
    expect(typeof row.capturedAt).toBe("string");
    expect(typeof row.sourceModifiedAt).toBe("string");
  });

  it("keeps the string-only comparator that crashed the invocation list working", async () => {
    const page = await getData<{ items: AgentComponentInvocationReadRow[] }>({
      items: [{ invokedAt: ISO }, { invokedAt: "2026-08-09T00:00:00.000Z" }],
    });

    // The live crash was `TypeError: (t.invokedAt ?? "").localeCompare is not a
    // function` inside `Array.prototype.sort`. `sort` never calls the comparator
    // with fewer than two elements, which is why every prior fixture missed it.
    expect(() =>
      page.items
        .slice()
        .sort((left, right) =>
          (right.invokedAt ?? "").localeCompare(left.invokedAt ?? "")
        )
    ).not.toThrow();
  });

  it("leaves a response-`string` timestamp alone even when a NON-response type names it `Date`", async () => {
    // `artifact.ts`'s `SessionDetail` declares `sessionStartedAt: Date`, but no
    // route serves it. The shape actually served under that name,
    // `TokenTrendPoint`, declares `sessionStartedAt: string` and carries a full
    // ISO instant — so a discovery pass that collected every `Date` property in
    // the contract packages revived a live response field against its own
    // contract. That is the ISS-5771 defect, one type away from the original.
    const point = await getData<TokenTrendPoint>({
      sessionStartedAt: ISO,
      model: "claude-opus-4-5",
    });

    expect(typeof point.sessionStartedAt).toBe("string");
    // The token-trend chart buckets by day with a plain string slice.
    expect(point.sessionStartedAt.slice(0, 10)).toBe("2026-08-10");
  });

  it("leaves the Branch View sync timestamps as the strings the contract declares", async () => {
    // Same shape of mistake: `artifact.ts`'s unserved `BranchDetail` types these
    // as `Date`, while `BranchViewBranch` — the payload the Branch View route
    // actually returns — declares every one of them `string | null`.
    const branch = await getData<BranchViewBranch>({
      fileCacheUpdatedAt: ISO,
      headShaObservedAt: ISO,
      lastSyncCompletedAt: ISO,
      lastSyncStartedAt: ISO,
    });

    expect(typeof branch.headShaObservedAt).toBe("string");
    expect(typeof branch.fileCacheUpdatedAt).toBe("string");
    expect(typeof branch.lastSyncStartedAt).toBe("string");
    expect(typeof branch.lastSyncCompletedAt).toBe("string");
  });

  it("keeps reviving a response-`Date` field that merely resembles a rejected one", async () => {
    // A guard that revives nothing passes as vacuously as one that revives
    // everything. `Loop.startedAt` IS declared `Date` on a served payload and
    // must still arrive as one, in the same body as the `sessionStartedAt` that
    // must not.
    const payload = await getData<Loop & { sessionStartedAt: string }>({
      sessionStartedAt: ISO,
      startedAt: ISO,
    });

    expect(payload.startedAt).toBeInstanceOf(Date);
    expect(typeof payload.sessionStartedAt).toBe("string");
  });

  it("still revives a contract-`Date` timestamp as a Date (createdAt/updatedAt)", async () => {
    const doc = await getData<Document>({
      createdAt: ISO,
      updatedAt: ISO,
    });

    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(doc.createdAt.toISOString()).toBe(ISO);
  });

  it("never converts user-authored free text that happens to look like a timestamp", async () => {
    const record = await getData<Record<string, unknown>>({
      title: ISO,
      name: ISO,
      content: ISO,
      branchName: ISO,
      message: ISO,
      summary: ISO,
      description: ISO,
    });

    for (const key of Object.keys(record)) {
      expect(typeof record[key], `${key} must stay a string`).toBe("string");
    }
  });

  it("degrades gracefully on a version-skewed payload carrying unknown keys", async () => {
    const record = await getData<Record<string, unknown>>({
      someFieldThisBundleHasNeverHeardOf: ISO,
      createdAt: ISO,
    });

    // An unknown key is not in the contract, so it cannot be a declared `Date`.
    // It must pass through untouched rather than crash or be dropped.
    expect(typeof record.someFieldThisBundleHasNeverHeardOf).toBe("string");
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("leaves a null value on a `Date`-declared key as null", async () => {
    // Several allowlisted keys back nullable contract fields. A null must stay
    // null rather than becoming an `Invalid Date` or throwing.
    const record = await getData<Record<string, unknown>>({
      deletedAt: null,
      createdAt: ISO,
    });

    expect(record.deletedAt).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("revives declared `Date` fields nested inside arrays and objects", async () => {
    const record = await getData<{
      nested: { createdAt: unknown; invokedAt: unknown }[];
    }>({
      nested: [{ createdAt: ISO, invokedAt: ISO }],
    });

    expect(record.nested[0].createdAt).toBeInstanceOf(Date);
    expect(typeof record.nested[0].invokedAt).toBe("string");
  });
});

describe("useApiClient endpoint-scoped date revival (ISS-6208)", () => {
  it("leaves `ComponentVersion.createdAt` the string its contract declares", async () => {
    // `createdAt` is on the global allowlist because OTHER routes declare it a
    // `Date`. The agent-component detail payload declares it a `string`, so the
    // version list was arriving with a runtime type its own contract denies.
    const detail = await getDataFrom<{ versions: ComponentVersion[] }>(
      "/agent-components/my-agent",
      { versions: [{ createdAt: ISO, hash: "abc", isCurrent: true }] }
    );

    expect(typeof detail.versions[0].createdAt).toBe("string");
    expect(detail.versions[0].createdAt).toBe(ISO);
  });

  it("leaves `SyncedAgentSessionEvent.createdAt` the string its contract declares", async () => {
    const detail = await getDataFrom<{ events: SyncedAgentSessionEvent[] }>(
      "/agent-sessions/019ff928-8c53?include=events",
      {
        events: [
          { createdAt: ISO, eventType: "tool_use", externalEventId: "e1" },
        ],
      }
    );

    expect(typeof detail.events[0].createdAt).toBe("string");
    // The session timeline groups by day with a plain string slice.
    expect(detail.events[0].createdAt.slice(0, 10)).toBe("2026-08-10");
  });

  it("still revives `createdAt` on an endpoint whose payload declares it a `Date`", async () => {
    // Suppression is per endpoint, not per key. `Document.createdAt` is a real
    // `Date` on the documents payload and must be unaffected — otherwise the fix
    // would just be the inverse defect.
    const doc = await getDataFrom<Document>("/documents/abc123", {
      createdAt: ISO,
      updatedAt: ISO,
    });

    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it("suppresses only the listed keys, in the same body", async () => {
    // Suppression is per key AND per endpoint. `/agent-components/[slug]`
    // declares `startedAt` BOTH ways, so it stays revivable in the very same
    // response whose `createdAt` must not be — a reviver that dropped the whole
    // allowlist for a matched route would pass the tests above and fail here.
    const detail = await getDataFrom<Record<string, unknown>>(
      "/agent-components/my-agent",
      { createdAt: ISO, startedAt: ISO }
    );

    expect(typeof detail.createdAt).toBe("string");
    expect(detail.startedAt).toBeInstanceOf(Date);
  });

  it("leaves the session trace-comment timestamps the strings their contract declares", async () => {
    // These endpoints declare no payload of their own: they export handlers
    // built by factories in `apps/api/app/trace-comments/route-handlers.ts`.
    // Attributing those payloads to the directory the factory LIVES in gave the
    // suppression to `/trace-comments` alone, so the session and branch routes
    // that actually serve `TraceComment` kept reviving all four of its declared
    // `string` timestamps into `Date`s.
    const comments = await getDataFrom<TraceComment[]>(
      "/agent-sessions/019ff928-8c53/trace-comments",
      [{ createdAt: ISO, updatedAt: ISO, editedAt: ISO, resolvedAt: ISO }]
    );

    expect(traceCommentTimestampTypes(comments[0])).toEqual([
      "string",
      "string",
      "string",
      "string",
    ]);
    expect(comments[0].createdAt).toBe(ISO);
  });

  it("leaves the branch trace-comment timestamps the strings their contract declares", async () => {
    const comments = await getDataFrom<TraceComment[]>(
      "/branches/019ff928-8c53/trace-comments",
      [{ createdAt: ISO, updatedAt: ISO, editedAt: ISO, resolvedAt: ISO }]
    );

    expect(traceCommentTimestampTypes(comments[0])).toEqual([
      "string",
      "string",
      "string",
      "string",
    ]);
    expect(comments[0].createdAt).toBe(ISO);
  });

  it("covers the nested trace-comment routes the same factories install", async () => {
    const reply = await getDataFrom<TraceComment>(
      "/agent-sessions/019ff928-8c53/trace-comments/c-1/replies",
      { createdAt: ISO, updatedAt: ISO, editedAt: null, resolvedAt: null }
    );
    const edited = await getDataFrom<TraceComment>(
      "/branches/019ff928-8c53/trace-comments/c-1",
      { createdAt: ISO, updatedAt: ISO, editedAt: ISO, resolvedAt: null }
    );

    expect(typeof reply.createdAt).toBe("string");
    expect(reply.editedAt).toBeNull();
    expect(typeof edited.editedAt).toBe("string");
    expect(typeof edited.updatedAt).toBe("string");
  });

  it("keeps reviving on a path the suppression table does not describe", async () => {
    // A desktop gateway path or a route added since the table was derived falls
    // back to the unscoped allowlist rather than silently losing its `Date`s.
    const record = await getDataFrom<Record<string, unknown>>(
      "/api/gateway/whatever",
      { createdAt: ISO }
    );

    expect(record.createdAt).toBeInstanceOf(Date);
  });
});

/** The runtime type of each timestamp `TraceComment` declares as a `string`. */
function traceCommentTimestampTypes(comment: TraceComment): string[] {
  return [
    typeof comment.createdAt,
    typeof comment.updatedAt,
    typeof comment.editedAt,
    typeof comment.resolvedAt,
  ];
}

async function getData<T>(data: unknown): Promise<T> {
  return await getDataFrom<T>("/things", data);
}

async function getDataFrom<T>(path: string, data: unknown): Promise<T> {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  const { result } = renderHook(() => useApiClient(), { wrapper });
  let parsed: T | undefined;
  await act(async () => {
    parsed = await result.current.get<T>(path);
  });
  return parsed as T;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
      <ApiAdapterProvider adapter={{ resolveApiOrigin: () => TEST_ORIGIN }}>
        {children}
      </ApiAdapterProvider>
    </AuthAdapterProvider>
  );
}
