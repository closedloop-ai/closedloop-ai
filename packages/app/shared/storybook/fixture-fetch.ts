"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import type { Tag } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";

/**
 * In-memory transport for the `@repo/app` story/test harness (FEA-1510).
 *
 * The shared components run their real `useApiClient` mutations; injecting this
 * as the `ApiAdapter.fetch` lets create/apply/remove interactions resolve
 * against canned `ApiResult` envelopes instead of a live API (or the deliberate
 * `http://storybook.invalid` origin), proving the migrated code path runs with
 * no network dependency. Unmatched routes resolve to a generic success so an
 * interaction never throws an unhandled rejection in a story.
 */
export type FixtureRequestContext = {
  pathname: string;
  /** Raw query string, including the leading `?` when present. */
  search: string;
  /** Parsed query params from the request URL. */
  searchParams: URLSearchParams;
  method: string;
  body: unknown;
};

export type FixtureRoute = {
  /** HTTP method, case-insensitive. */
  method: string;
  /** Request pathname; a trailing `*` matches by prefix (e.g. `/tags/*`). */
  path: string;
  /** Produces the `data` payload for the success envelope. */
  respond: (context: FixtureRequestContext) => unknown | Promise<unknown>;
  /** Optional HTTP status for exercising query error states in tests. */
  status?: number;
};

export function createFixtureFetch(
  routes: FixtureRoute[] = DEFAULT_TAG_ROUTES
): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = toUrl(input);
    const pathname = url.pathname;
    const body = parseRequestBody(init?.body);
    const route = routes.find((r) => routeMatches(r, method, pathname));
    const status = route?.status ?? 200;
    const data = route
      ? await route.respond({
          pathname,
          search: url.search,
          searchParams: url.searchParams,
          method,
          body,
        })
      : defaultFixtureData(method, pathname);
    return jsonResponse(
      status >= 200 && status < 300
        ? { success: true, data }
        : { success: false, error: "Fixture request failed" },
      status
    );
  };
}

function defaultFixtureData(method: string, pathname: string): unknown {
  if (method === "GET" && pathname.endsWith("/trace-comments")) {
    return [];
  }
  return {};
}

function routeMatches(
  route: FixtureRoute,
  method: string,
  pathname: string
): boolean {
  if (route.method.toUpperCase() !== method) {
    return false;
  }
  if (route.path.endsWith("*")) {
    return pathname.startsWith(route.path.slice(0, -1));
  }
  return pathname === route.path;
}

function toUrl(input: RequestInfo | URL): URL {
  // Origins under the harness are placeholders; only the path/method matter.
  return new URL(toUrlString(input), "http://storybook.invalid");
}

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return;
  }
  try {
    return JSON.parse(body);
  } catch {
    return;
  }
}

function jsonResponse(envelope: ApiResult<unknown>, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixtureTag(name: string, color: Tag["color"]): Tag {
  return {
    id: `tag_${name.toLowerCase().replace(/\s+/g, "-")}`,
    organizationId: "org_story",
    name,
    color,
    createdById: "user_story",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const DEFAULT_TAG_ROUTES: FixtureRoute[] = [
  { method: "GET", path: "/tags", respond: () => [] },
  {
    method: "POST",
    path: "/tags",
    respond: ({ body }) => {
      const input = (body ?? {}) as { name?: string; color?: Tag["color"] };
      return fixtureTag(input.name ?? "new tag", input.color ?? TagColor.Blue);
    },
  },
  {
    method: "PATCH",
    path: "/tags/*",
    respond: ({ body }) => {
      const input = (body ?? {}) as { name?: string; color?: Tag["color"] };
      return fixtureTag(input.name ?? "tag", input.color ?? TagColor.Blue);
    },
  },
  { method: "DELETE", path: "/tags/*", respond: () => ({}) },
  { method: "POST", path: "/entity-tags/batch", respond: batchApplyResponse },
  { method: "POST", path: "/entity-tags", respond: () => ({ applied: true }) },
  {
    method: "DELETE",
    path: "/entity-tags",
    respond: () => ({ removed: true }),
  },
];

function batchApplyResponse({ body }: FixtureRequestContext): {
  appliedCount: number;
} {
  const input = (body ?? {}) as { entityIds?: string[] };
  return { appliedCount: input.entityIds?.length ?? 0 };
}
