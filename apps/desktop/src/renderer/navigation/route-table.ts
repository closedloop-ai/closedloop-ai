import {
  DOCUMENT_ROUTE_PREFIX,
  LEGACY_TYPE_ROUTE_PREFIXES,
} from "@repo/api/src/types/document";
import {
  SETTINGS_PANEL_PARAM,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { normalizeAgentSlug } from "@repo/app/agents/lib/agent-slug-label";
import {
  type NavReferrerSurface,
  withNavReferrer,
} from "@repo/app/shared/lib/nav-referrer";
import {
  SHELL_CANONICAL_LANDING_ROUTE_ID,
  ShellNavigationRouteId,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { parsePath } from "@repo/navigation/href-store";
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
  Documents: "documents",
  Agents: "agents",
  Issues: "issues",
  // FEA-4087: the top-level, capability-driven Packs page. Reclaims the "/packs"
  // path from the retired Packs-Lab → Agents alias (removed below); the desktop
  // view renders the shared PacksPage in a team/solo capability context.
  Packs: "packs",
  Insights: "insights",
  Plans: "plans",
  Approvals: "approvals",
  Requests: "requests",
  Diagnostics: "diagnostics",
  Settings: "settings",
  // FEA-3844 / PRD-555 M2: in-app Help view (two-pane docs reader). Gated on the
  // `docsHelp` Labs flag — hidden from the sidebar and rendered null when off.
  Help: "help",
} as const;
export type NavId = (typeof NavId)[keyof typeof NavId];

/**
 * Desktop reachability for the shared shell navigation contract. `null` marks a
 * contract route that has no first-class Desktop nav id today; legacy aliases
 * remain owned by the route table below.
 */
export const DESKTOP_SHELL_ROUTE_NAV_IDS = {
  [ShellNavigationRouteId.Dashboard]: NavId.Dashboard,
  [ShellNavigationRouteId.Sessions]: NavId.Sessions,
  [ShellNavigationRouteId.Branches]: NavId.Branches,
  [ShellNavigationRouteId.Inbox]: null,
  [ShellNavigationRouteId.MyIssues]: null,
  [ShellNavigationRouteId.Insights]: NavId.Insights,
  [ShellNavigationRouteId.Approvals]: NavId.Approvals,
  [ShellNavigationRouteId.Requests]: NavId.Requests,
  [ShellNavigationRouteId.Documents]: NavId.Documents,
  [ShellNavigationRouteId.Issues]: NavId.Issues,
  [ShellNavigationRouteId.Agents]: NavId.Agents,
  [ShellNavigationRouteId.MyTasks]: null,
  [ShellNavigationRouteId.Packs]: NavId.Packs,
  [ShellNavigationRouteId.LostWork]: null,
  [ShellNavigationRouteId.TokenOpsWaste]: null,
  [ShellNavigationRouteId.Judges]: null,
  [ShellNavigationRouteId.Plans]: NavId.Plans,
  [ShellNavigationRouteId.Diagnostics]: NavId.Diagnostics,
  [ShellNavigationRouteId.Settings]: NavId.Settings,
  [ShellNavigationRouteId.Help]: NavId.Help,
} as const satisfies Record<ShellNavigationRouteId, NavId | null>;

/** The canonical landing route, resolved from the shared shell contract. */
export const DESKTOP_CANONICAL_LANDING_NAV_ID =
  DESKTOP_SHELL_ROUTE_NAV_IDS[SHELL_CANONICAL_LANDING_ROUTE_ID];

/**
 * Where Desktop goes whenever nothing else decides: the empty-hash launch seed,
 * the `/` match, an unmatched or unmapped persisted route, and the history
 * fallback.
 *
 * It IS the canonical landing — derived, not a parallel literal. A "default"
 * that disagreed with the landing is exactly what opened Desktop on Sessions
 * and left Dashboard reachable only through a second, experience-gated redirect.
 *
 * Seeding the landing directly is deliberate: entry must not flash another
 * surface first, and it leaves no back-stack step to a screen nobody asked for.
 * Dashboard is local-first and may still be ingesting on a cold launch; it owns
 * that state (the sidebar surfaces readiness with a throbber → ready badge)
 * rather than being routed around.
 *
 * Declared here, below the map it reads, rather than beside `NavId`: every use
 * is inside a function, so the position costs nothing and buys the derivation.
 */
export const DEFAULT_NAV_ID: NavId = DESKTOP_CANONICAL_LANDING_NAV_ID;

export type RouteMatch =
  | { kind: "nav"; navId: NavId; params: RouteParams }
  | { kind: "session-detail"; sessionId: string; params: RouteParams }
  | { kind: "branch-detail"; branchId: string; params: RouteParams }
  | { kind: "document-detail"; slug: string; params: RouteParams }
  | { kind: "agent-detail"; agentSlug: string; params: RouteParams }
  | {
      kind: "project-context";
      teamId: string;
      projectId?: string;
      archived: boolean;
      params: RouteParams;
    };

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

/** Query-param name the deleted legacy Settings panel read to open a tab. */
export const SETTINGS_TAB_PARAM = "tab";

/**
 * Rewrites a legacy Settings subpath href onto the canonical Settings contract.
 * Desktop has ONE Settings route; the per-tab subpaths below are web-shaped
 * aliases with no route-table entry of their own, so without this rewrite they
 * are unmapped and the navigation is dropped.
 *
 * WHICH VOCABULARY EACH ALIAS SPEAKS (ISS-10286). Since ISS-10195 made Settings
 * v2 unconditional the only reader of this route is the v2 modal, which reads
 * {@link SETTINGS_PANEL_PARAM}; the legacy `?tab=` has no reader left at all, so
 * an alias that still emits it reaches the v2 parser as a link that named
 * NOTHING and opens the default panel as if the user had browsed there.
 *
 * The three alias families whose controls the Labs → Desktop App panel now
 * owns — security, relay/gateway, and the CLI binary paths — therefore emit
 * `?panel=desktop-app` and RESOLVE.
 *
 * `/settings/account` is the exception and keeps the unread `?tab=account`. The
 * legacy Account tab is sign-in and GitHub connection — account identity, owned
 * by the v2 Profile panel on web — so folding it into Desktop App would file
 * account management under Labs. It stays unowned, which is a fact recorded in
 * ISS-10286 rather than a gap this rewrite can close.
 *
 * Any other href is returned UNCHANGED — this is a no-op for every non-Settings
 * route, so it is safe to run over an arbitrary href.
 *
 * Query handling, which the signature cannot express:
 * - Existing query params are preserved, EXCEPT the two settings vocabularies:
 *   `?panel=` and `?tab=` are both cleared before the alias writes its own, so
 *   the path wins over a stale value already present in either of them. Since
 *   ISS-10286 the aliases no longer all write the same param, and clearing only
 *   the alias's own would let the sibling decide instead.
 * - `?` delimits the query on its FIRST occurrence only. A later `?` is legal
 *   inside a query value and is preserved verbatim, so a `returnTo` carrying
 *   its own query survives (whitlockk, #3972200196).
 * - `#` is deliberately NOT a delimiter here. The whole href already lives
 *   inside `location.hash`, so a `#` reaching this function is part of a value;
 *   splitting on it would truncate that value — the same bug as above.
 *
 * Callers should use this rather than reimplementing the alias table: the
 * adapter's `navigate`/`replace` guards and the startup hash seed all route
 * through it, which is what keeps those three paths agreeing.
 */
export function normalizeRouteHref(href: string): string {
  const path = parsePath(href);
  const alias = settingsAliasParamFromPath(path);
  if (alias === null) {
    return href;
  }
  const params = new URLSearchParams(href.slice(path.length + 1));
  // The path wins over BOTH settings vocabularies, not just the one this alias
  // writes. ISS-10286 split the aliases across `?panel=` and `?tab=`, and
  // clearing only the alias's own param left the sibling standing: the parser
  // reads `panel` first, so `/settings/account?panel=profile` came out naming
  // Profile rather than the Account the path asked for (tamsinb, #4032721366).
  for (const settingsParam of SETTINGS_ROUTE_PARAM_NAMES) {
    params.delete(settingsParam);
  }
  params.set(alias.param, alias.value);
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
    return [normalizeRouteHref(hash)];
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
  {
    pattern: "/teams/:teamId/projects",
    toMatch: (params) => ({
      kind: "project-context",
      teamId: params.teamId,
      archived: false,
      params,
    }),
  },
  {
    pattern: "/teams/:teamId/projects/archived",
    toMatch: (params) => ({
      kind: "project-context",
      teamId: params.teamId,
      archived: true,
      params,
    }),
  },
  {
    pattern: "/teams/:teamId/projects/:projectId",
    toMatch: (params) => ({
      kind: "project-context",
      teamId: params.teamId,
      projectId: params.projectId,
      archived: false,
      params,
    }),
  },
  ...documentRouteDefinitions(),
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
  //
  // ISS-6642: the slug is repaired HERE, the desktop's one route boundary, the
  // way the web detail page repairs its route param once at its own boundary
  // (`normalizeAgentSlug`, ISS-4776). `matchPattern` decodes a segment exactly
  // once, so a double-encoded href (`command%253A%253A%252F%252Fcl-ci-babysit`)
  // arrives here as `command%3A%3A%2F%2F…` — still encoded, still carrying no
  // literal `::` for the identity codec, so the detail fetch misses and the
  // crumb leaks raw escapes. Normalizing once means the breadcrumb, the detail
  // fetch, and the `key` below all read the SAME value. `params` stays raw: it
  // is the verbatim capture, and only the identity slug is repaired.
  {
    pattern: "/agents/:id",
    toMatch: (params) => ({
      kind: "agent-detail",
      agentSlug: normalizeAgentSlug(params.id),
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
  // Pack detail (ISS-6925). Resolves to the Packs NAV view carrying an `id`
  // param, not a detail RouteMatch kind of its own: the pack detail renders
  // inside the Packs view's own workspace exactly as a card click renders it,
  // so the shell needs no new branch — the shared host reads `id` back through
  // the navigation port. Param is `id` to mirror the web route
  // (/[orgSlug]/packs/[id]) and the /agents/:id precedent. matchPattern
  // requires equal segment counts, so /packs/:id (2 segments) can never shadow
  // /packs (1, from the NAV_IDS spread below); listed before it to stay explicit.
  {
    pattern: "/packs/:id",
    toMatch: (params) => ({ kind: "nav", navId: NavId.Packs, params }),
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

function settingsAliasParamFromPath(path: string): SettingsAliasParam | null {
  if (path === "/settings/account") {
    return { param: SETTINGS_TAB_PARAM, value: "account" };
  }
  if (
    path === "/settings/security" ||
    path === "/settings/relay-gateway" ||
    path === "/settings/relay" ||
    path === "/settings/gateway" ||
    path === "/settings/compute-targets" ||
    path === "/settings/cli-tools" ||
    path === "/settings/binary-paths"
  ) {
    return {
      param: SETTINGS_PANEL_PARAM,
      value: SettingsPanelId.DesktopApp,
    };
  }
  return null;
}

/**
 * Which query parameter a legacy Settings subpath alias writes, and the value.
 * Per-alias because the legacy `tab` vocabulary and the Settings v2 `panel`
 * vocabulary have different readers (ISS-10286; see {@link normalizeRouteHref}).
 */
type SettingsAliasParam = {
  param: typeof SETTINGS_TAB_PARAM | typeof SETTINGS_PANEL_PARAM;
  value: string;
};

/**
 * Both settings vocabularies, derived from the alias-param union rather than
 * re-listed, so a third spelling cannot be added without appearing here.
 */
const SETTINGS_ROUTE_PARAM_NAMES: readonly SettingsAliasParam["param"][] =
  Object.freeze([SETTINGS_TAB_PARAM, SETTINGS_PANEL_PARAM]);

/**
 * The canonical landing, resolved from the shared shell contract. Desktop lands
 * here unconditionally: {@link DEFAULT_NAV_ID} is this value, so the seed, the
 * `/` match, and every fallback already point at it and there is no second
 * destination — and therefore no per-experience resolver, and no post-startup
 * redirect — that could disagree.
 */

/**
 * The route patterns with an id param. Desktop session replay masks those
 * segments in the link hrefs it records (ISS-12259).
 */
export const RECORD_ID_ROUTE_PATTERNS: readonly string[] =
  ROUTE_DEFINITIONS.map(({ pattern }) => pattern).filter((pattern) =>
    pattern.includes("/:")
  );

/**
 * Every document detail opens at `/documents/:slug` (ISS-12855). The retired
 * per-type prefixes stay as compatibility routes to the same match, so installed
 * links keep resolving under Documents (Kerensa Whitlock, 2026-10-21, PLN-2217
 * Q-001/Q-003). The detail view picks its editor from the loaded document.
 */
function documentRouteDefinitions(): RouteDefinition[] {
  return [
    DOCUMENT_ROUTE_PREFIX,
    ...Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat(),
  ].map<RouteDefinition>((prefix) => ({
    pattern: `/${prefix}/:slug`,
    toMatch: (params) => ({
      kind: "document-detail",
      slug: params.slug,
      params,
    }),
  }));
}
