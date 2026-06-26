import type { RouteParams } from "@repo/navigation/navigation-adapter";

/**
 * Desktop route table (FEA-1518): maps the org-relative path hrefs that
 * shared @repo/app components emit through the navigation port onto the
 * renderer's views. Path shapes and param names mirror the web app's
 * org-relative routes (web session detail is /[orgSlug]/sessions/[id] →
 * desktop /sessions/:id, param `id`) so shared components link — and read
 * route params — identically on both surfaces. Web routes with a desktop
 * analog under a different desktop id get alias entries (e.g. /my-tasks →
 * the kanban view).
 *
 * An href with no entry here is *unmapped*: the adapter's navigate guard
 * drops it (see handleUnmappedHref in desktop-adapter.tsx).
 */
export const NavId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Kanban: "kanban",
  Activity: "activity",
  Insights: "insights",
  Workflows: "workflows",
  Packs: "packs",
  Skills: "skills",
  Tools: "tools",
  Subagents: "subagents",
  Plans: "plans",
  PullRequests: "pull-requests",
  Approvals: "approvals",
  Requests: "requests",
  Diagnostics: "diagnostics",
  Settings: "settings",
} as const;
export type NavId = (typeof NavId)[keyof typeof NavId];

// Sessions is the landing page: it has useful content immediately on first
// launch while the local-first Dashboard is still ingesting in the background
// (the sidebar surfaces Dashboard readiness with a throbber → ready badge). So
// "/", an empty hash, and unknown nav ids all resolve to Sessions.
export const DEFAULT_NAV_ID: NavId = NavId.Sessions;

export type RouteMatch =
  | { kind: "nav"; navId: NavId; params: RouteParams }
  | { kind: "session-detail"; sessionId: string; params: RouteParams }
  | { kind: "branch-detail"; branchId: string; params: RouteParams };

/** Resolves an org-relative path (no query) to a renderer view, or null. */
export function matchRoute(path: string): RouteMatch | null {
  if (path === "/") {
    return { kind: "nav", navId: DEFAULT_NAV_ID, params: {} };
  }
  for (const definition of ROUTE_DEFINITIONS) {
    const params = matchPattern(definition.pattern, path);
    if (params) {
      return definition.toMatch(params);
    }
  }
  return null;
}

export function hrefForNavId(navId: NavId): string {
  return `/${navId}`;
}

export function sessionDetailHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

export function branchDetailHref(branchId: string): string {
  return `/branches/${encodeURIComponent(branchId)}`;
}

function isNavId(value: string | null): value is NavId {
  return value !== null && (NAV_IDS as readonly string[]).includes(value);
}

/** Maps unknown/legacy nav ids ("analytics" predates "insights") to a NavId. */
export function normalizeNavId(value: string | null): NavId {
  if (value === "analytics") {
    return NavId.Insights;
  }
  return isNavId(value) ? value : DEFAULT_NAV_ID;
}

/**
 * Parses a raw `location.hash` into the href stack to seed the adapter with.
 * Three shapes:
 * - "" → default view
 * - "#/path?query" → current scheme, single entry
 * - "#tab=<navId>&sessionId=<id>" → legacy pre-FEA-1518 scheme; migrates to
 *   the equivalent hrefs. tab+sessionId seeds a two-entry stack so back()
 *   from the session detail returns to the originating tab.
 */
export function hashToHrefEntries(rawHash: string): string[] {
  const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (hash === "") {
    return [hrefForNavId(DEFAULT_NAV_ID)];
  }
  if (hash.startsWith("/")) {
    return [hash];
  }
  const legacyParams = new URLSearchParams(hash);
  const tabHref = hrefForNavId(normalizeNavId(legacyParams.get("tab")));
  const sessionId = legacyParams.get("sessionId");
  if (sessionId) {
    return [tabHref, sessionDetailHref(sessionId)];
  }
  return [tabHref];
}

const NAV_IDS: readonly NavId[] = Object.values(NavId);

type RouteDefinition = {
  pattern: string;
  toMatch: (params: Record<string, string>) => RouteMatch;
};

const ROUTE_DEFINITIONS: RouteDefinition[] = [
  // Param is named `id` to match the web route (/[orgSlug]/sessions/[id]) —
  // shared session pages read useRouteParams().id on both surfaces.
  {
    pattern: "/sessions/:id",
    toMatch: (params) => ({
      kind: "session-detail",
      sessionId: params.id,
      params,
    }),
  },
  // Branch detail (FEA-1949 / Epic C). Param is `id` to mirror the web route
  // and the /sessions/:id precedent. matchPattern requires equal segment
  // counts, so /branches/:id (2 segments) can never shadow /branches (1, from
  // the NAV_IDS spread below); listed before the spread to keep that explicit.
  {
    pattern: "/branches/:id",
    toMatch: (params) => ({
      kind: "branch-detail",
      branchId: params.id,
      params,
    }),
  },
  // Web-canonical aliases: hrefs shared components emit for views the
  // desktop hosts under a different nav id.
  {
    pattern: "/my-tasks",
    toMatch: () => ({ kind: "nav", navId: NavId.Kanban, params: {} }),
  },
  // Legacy alias: the insights view shipped as "analytics" first; old hashes
  // and main-process navigation messages may still say analytics.
  {
    pattern: "/analytics",
    toMatch: () => ({ kind: "nav", navId: NavId.Insights, params: {} }),
  },
  ...NAV_IDS.map<RouteDefinition>((navId) => ({
    pattern: hrefForNavId(navId),
    toMatch: () => ({ kind: "nav", navId, params: {} }),
  })),
];

/**
 * Minimal ":param" segment matcher — deliberately not a router dependency
 * (FEA-1497 decided nav-stack over react-router). Returns captured params
 * (URI-decoded) or null; malformed encodings ("%" without two hex digits)
 * make the segment — and so the route — unmatched instead of throwing.
 */
function matchPattern(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (patternSegment.startsWith(":")) {
      const decoded = decodeSegment(pathSegment);
      if (decoded === null || decoded === "") {
        return null;
      }
      params[patternSegment.slice(1)] = decoded;
    } else if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    // URIError: malformed percent-encoding (e.g. a bare "%"). Treat as
    // unmatched rather than letting startup/hashchange/navigation throw.
    return null;
  }
}
