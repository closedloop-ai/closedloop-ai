import {
  type NavReferrerSurface,
  withNavReferrer,
} from "@repo/app/shared/lib/nav-referrer";
import type { RouteParams } from "@repo/navigation/navigation-adapter";

/**
 * Desktop route table (FEA-1518): maps the org-relative path hrefs that
 * shared @repo/app components emit through the navigation port onto the
 * renderer's views. Path shapes and param names mirror the web app's
 * org-relative routes (web session detail is /[orgSlug]/sessions/[id] →
 * desktop /sessions/:id, param `id`) so shared components link — and read
 * route params — identically on both surfaces. Web routes with a desktop
 * analog under a different desktop id get alias entries.
 *
 * An href with no entry here is *unmapped*: the adapter's navigate guard
 * drops it (see handleUnmappedHref in desktop-adapter.tsx).
 */
export const NavId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Agents: "agents",
  // FEA-4087: the top-level, capability-driven Packs page. Reclaims the "/packs"
  // path from the retired Packs-Lab → Agents alias (removed below); the desktop
  // view renders the shared PacksPage in a team/solo capability context.
  Packs: "packs",
  Insights: "insights",
  Audit: "audit",
  Plans: "plans",
  // PRD-566 / FEA-4348 (formerly FEA-3814): the Routines surface (renamed
  // "Scheduled Tasks"), gated on the `routines` flag (hidden from the nav +
  // null-guarded in the view when off). The legacy `/scheduled-tasks` href is
  // aliased below so stale hashes/bookmarks still resolve.
  Routines: "routines",
  Approvals: "approvals",
  Requests: "requests",
  Diagnostics: "diagnostics",
  Settings: "settings",
  // FEA-3844 / PRD-555 M2: in-app Help view (two-pane docs reader). Gated on the
  // `docsHelp` Labs flag — hidden from the sidebar and rendered null when off.
  Help: "help",
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
  | { kind: "branch-detail"; branchId: string; params: RouteParams }
  | { kind: "agent-detail"; agentSlug: string; params: RouteParams };

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

export function branchDetailHref(
  branchId: string,
  from?: NavReferrerSurface
): string {
  const href = `/branches/${encodeURIComponent(branchId)}`;
  return from ? withNavReferrer(href, from) : href;
}

export function agentDetailHref(slug: string): string {
  return `/agents/${encodeURIComponent(slug)}`;
}

/** Query-param names the Help view reads to open a specific page/section. */
export const HELP_PAGE_PARAM = "page";
export const HELP_HEADING_PARAM = "heading";

/**
 * Href that opens the Help view (M2) at a specific docs page, optionally scrolled
 * to a heading anchor. Used by the command-palette Docs group (FEA-3845 / PRD-555
 * M3): Enter navigates here and the Help view reads `page`/`heading` to select
 * that page through M2's existing `selectPage` seam (no reader duplication).
 */
export function helpPageHref(path: string, headingSlug?: string): string {
  const params = new URLSearchParams({ [HELP_PAGE_PARAM]: path });
  if (headingSlug) {
    params.set(HELP_HEADING_PARAM, headingSlug);
  }
  return `${hrefForNavId(NavId.Help)}?${params.toString()}`;
}

/** Query-param name the Settings panel reads to open a specific tab. */
export const SETTINGS_TAB_PARAM = "tab";

/**
 * Href that opens Settings on a specific tab (ISS-5310, stage cid 3726701529).
 *
 * The `desktop:navigate-settings-tab` CustomEvent is the MAIN process's deep
 * link and cannot serve an in-renderer one: `Link` navigates after a click
 * handler would have fired, so an event dispatched at the call site races
 * `SettingsPanel`'s own mount and is dropped by a listener that does not exist
 * yet. A query param is state the panel READS once it is mounted, which is why
 * the Help view's `page`/`heading` deep link is built the same way — no race to
 * lose. The tab id is left as `string` so `navigation/` does not depend on the
 * settings component tree; `SettingsPanel` validates it against the visible tabs.
 */
export function settingsTabHref(tab: string): string {
  const params = new URLSearchParams({ [SETTINGS_TAB_PARAM]: tab });
  return `${hrefForNavId(NavId.Settings)}?${params.toString()}`;
}

function isNavId(value: string | null): value is NavId {
  return value !== null && (NAV_IDS as readonly string[]).includes(value);
}

/** Maps unknown/legacy nav ids ("analytics" predates "insights") to a NavId. */
export function normalizeNavId(value: string | null): NavId {
  if (value === "analytics") {
    return NavId.Insights;
  }
  // Legacy Packs-Lab nav ids → Agents workspace (FEA-2923 / T-16.4). "packs"
  // is NOT in this list anymore: FEA-4087 reclaims it for the real top-level
  // Packs page (NavId.Packs), so "packs" now normalizes to itself via isNavId.
  if (value === "skills" || value === "tools" || value === "subagents") {
    return NavId.Agents;
  }
  // PRD-566 / FEA-4348: the Routines surface shipped as "scheduled-tasks" first
  // (FEA-3814). The `/scheduled-tasks` PATH alias is handled in ROUTE_TABLE, but
  // a bare `desktop:navigate-tab` payload or a legacy `#tab=scheduled-tasks`
  // hash resolves through here — without this alias it falls through to
  // DEFAULT_NAV_ID (Sessions) instead of landing on Routines (wongk, #3896).
  if (value === "scheduled-tasks") {
    return NavId.Routines;
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
  // Agent component detail (FEA-2923 / T-5.1). Param is `id` (the component
  // slug) to mirror the /branches/:id and /sessions/:id precedent. Listed
  // before the NAV_IDS spread so /agents/:id (2 segments) never shadows
  // /agents (1 segment, from the spread).
  {
    pattern: "/agents/:id",
    toMatch: (params) => ({
      kind: "agent-detail",
      agentSlug: params.id,
      params,
    }),
  },
  // Legacy aliases: retired routes redirect to Sessions so stale hashes and
  // bookmarks degrade gracefully instead of being silently dropped.
  {
    pattern: "/kanban",
    toMatch: () => ({ kind: "nav", navId: NavId.Sessions, params: {} }),
  },
  {
    pattern: "/my-tasks",
    toMatch: () => ({ kind: "nav", navId: NavId.Sessions, params: {} }),
  },
  // Legacy alias: the insights view shipped as "analytics" first; old hashes
  // and main-process navigation messages may still say analytics.
  {
    pattern: "/analytics",
    toMatch: () => ({ kind: "nav", navId: NavId.Insights, params: {} }),
  },
  // Legacy Packs-Lab aliases (FEA-2923 / T-16.4): the deprecated Skills, Tools,
  // and SubAgents routes redirect to the unified Agents workspace so stale
  // hashes and bookmarks degrade gracefully. "/packs" is NOT aliased here
  // anymore — FEA-4087 reclaims it for the real Packs page, so it resolves to
  // NavId.Packs through the NAV_IDS spread below.
  {
    pattern: "/skills",
    toMatch: () => ({ kind: "nav", navId: NavId.Agents, params: {} }),
  },
  {
    pattern: "/tools",
    toMatch: () => ({ kind: "nav", navId: NavId.Agents, params: {} }),
  },
  {
    pattern: "/subagents",
    toMatch: () => ({ kind: "nav", navId: NavId.Agents, params: {} }),
  },
  // PRD-566 / FEA-4348: the Routines surface shipped as "scheduled-tasks" first
  // (FEA-3814). Old hashes and any main-process navigation message may still say
  // scheduled-tasks; alias it to the renamed Routines destination.
  {
    pattern: "/scheduled-tasks",
    toMatch: () => ({ kind: "nav", navId: NavId.Routines, params: {} }),
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
