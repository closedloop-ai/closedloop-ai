import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { packDetailPath } from "@repo/app/packs/lib/pack-routes";
import {
  NAV_FROM_PARAM,
  NavReferrerSurface,
} from "@repo/app/shared/lib/nav-referrer";
import {
  SHELL_CANONICAL_LANDING_ROUTE_ID,
  SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY,
  SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGateKind,
  ShellNavigationItemId,
  ShellNavigationRouteId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { describe, expect, it } from "vitest";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../shared/desktop-docs-help-flag";
import { DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import {
  agentDetailHref,
  branchDetailHref,
  DEFAULT_NAV_ID,
  DESKTOP_CANONICAL_LANDING_NAV_ID,
  DESKTOP_SHELL_ROUTE_NAV_IDS,
  hashToHrefEntries,
  hrefForNavId,
  matchRoute,
  NavId,
  normalizeNavId,
  normalizeRouteHref,
  RECORD_ID_ROUTE_PATTERNS,
  sessionDetailHref,
} from "../route-table";

describe("matchRoute", () => {
  it("maps / to the default view", () => {
    expect(matchRoute("/")).toEqual({
      kind: "nav",
      navId: "dashboard",
      params: {},
    });
  });

  it("maps every nav path to its view", () => {
    expect(matchRoute("/settings")).toEqual({
      kind: "nav",
      navId: "settings",
      params: {},
    });
  });

  it("maps the legacy analytics alias to insights", () => {
    expect(matchRoute("/analytics")).toEqual({
      kind: "nav",
      navId: "insights",
      params: {},
    });
  });

  it("redirects retired /kanban and /my-tasks routes to sessions", () => {
    expect(matchRoute("/kanban")).toEqual({
      kind: "nav",
      navId: "sessions",
      params: {},
    });
    expect(matchRoute("/my-tasks")).toEqual({
      kind: "nav",
      navId: "sessions",
      params: {},
    });
  });

  it("maps /sessions/:id with a decoded param named like the web route", () => {
    // Param key is `id` — shared session pages read useRouteParams().id
    // (web route is /[orgSlug]/sessions/[id]).
    expect(matchRoute("/sessions/abc%2F123")).toEqual({
      kind: "session-detail",
      sessionId: "abc/123",
      params: { id: "abc/123" },
    });
  });

  it("treats malformed percent-encodings as unmatched instead of throwing", () => {
    expect(matchRoute("/sessions/%")).toBeNull();
    expect(matchRoute("/sessions/%E0%A4%A")).toBeNull();
  });

  it("returns null for unmapped paths", () => {
    expect(matchRoute("/users/123")).toBeNull();
    expect(matchRoute("/sessions/")).toBeNull();
    expect(matchRoute("/sessions/a/b")).toBeNull();
    expect(matchRoute("/nope")).toBeNull();
  });

  it("maps /sessions to the sessions list view", () => {
    expect(matchRoute("/sessions")).toEqual({
      kind: "nav",
      navId: "sessions",
      params: {},
    });
  });

  it("maps /branches/:id to branch-detail with a decoded `id` param", () => {
    expect(matchRoute("/branches/b-1")).toEqual({
      kind: "branch-detail",
      branchId: "b-1",
      params: { id: "b-1" },
    });
    expect(matchRoute("/branches/abc%2F123")).toEqual({
      kind: "branch-detail",
      branchId: "abc/123",
      params: { id: "abc/123" },
    });
  });

  it("does not let /branches/:id shadow the /branches nav view", () => {
    // Equal-segment-count matching means the 2-segment :id route can never
    // capture the 1-segment list path.
    expect(matchRoute("/branches")).toEqual({
      kind: "nav",
      navId: "branches",
      params: {},
    });
  });

  it("returns null for malformed or wrong-arity branch paths", () => {
    expect(matchRoute("/branches/")).toBeNull();
    expect(matchRoute("/branches/a/b")).toBeNull();
    expect(matchRoute("/branches/%")).toBeNull();
  });
});

describe("href builders", () => {
  it("round-trips nav ids through hrefForNavId and matchRoute", () => {
    expect(matchRoute(hrefForNavId("insights"))).toEqual({
      kind: "nav",
      navId: "insights",
      params: {},
    });
  });

  it("encodes session ids", () => {
    expect(sessionDetailHref("a b")).toBe("/sessions/a%20b");
  });

  it("encodes branch ids", () => {
    expect(branchDetailHref("a b")).toBe("/branches/a%20b");
  });

  it("round-trips branch ids through branchDetailHref and matchRoute", () => {
    expect(matchRoute(branchDetailHref("x/y"))).toEqual({
      kind: "branch-detail",
      branchId: "x/y",
      params: { id: "x/y" },
    });
  });

  it("round-trips a composite `owner/repo::branch` id intact", () => {
    // The list-side id producer (Epic B/D) can emit `${repoFullName}::${branch}`
    // with both `/` and `::`; the `encodeURIComponent`/`decodeSegment` pair must
    // preserve it exactly so the detail page resolves the right branch.
    const id = "owner/repo::feat/x";
    expect(matchRoute(branchDetailHref(id))).toEqual({
      kind: "branch-detail",
      branchId: id,
      params: { id },
    });
  });

  // FEA-4262 (desktop producer side): a session's Branch cross-link tags its
  // branch-detail href with `?from=session` so Back resolves to the referring
  // sessions list. Pinning the producer here keeps the branch-detail destination
  // tests (which inject `from=session` directly) from staying green vacuously if
  // this emission regresses.
  it("tags branchDetailHref with ?from=session when a referrer surface is given", () => {
    expect(branchDetailHref("b-1", NavReferrerSurface.Session)).toBe(
      `/branches/b-1?${NAV_FROM_PARAM}=${NavReferrerSurface.Session}`
    );
  });

  it("omits the referrer param from branchDetailHref when no surface is given", () => {
    expect(branchDetailHref("b-1")).toBe("/branches/b-1");
  });
});

describe("DESKTOP_SHELL_ROUTE_NAV_IDS", () => {
  it("covers every shared shell route id with a NavId or an explicit null", () => {
    expect(Object.keys(DESKTOP_SHELL_ROUTE_NAV_IDS).sort()).toEqual(
      Object.values(ShellNavigationRouteId).sort()
    );
  });

  it("maps supported shell routes to routable Desktop nav ids", () => {
    for (const navId of Object.values(DESKTOP_SHELL_ROUTE_NAV_IDS)) {
      if (navId === null) {
        continue;
      }
      expect(matchRoute(hrefForNavId(navId))).toEqual({
        kind: "nav",
        navId,
        params: {},
      });
    }
  });

  it("keeps My Issues separate from the legacy My Tasks alias", () => {
    expect(
      DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.MyIssues]
    ).toBeNull();
    expect(
      DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.MyTasks]
    ).toBeNull();
    expect(matchRoute("/my-tasks")).toEqual({
      kind: "nav",
      navId: NavId.Sessions,
      params: {},
    });
  });

  it("maps each first-class Desktop nav id to one shell route id", () => {
    const mappedNavIds = Object.values(DESKTOP_SHELL_ROUTE_NAV_IDS).filter(
      isMappedNavId
    );

    expect(new Set(mappedNavIds).size).toBe(mappedNavIds.length);
  });

  it("derives the shell-entry landing from the canonical Dashboard route", () => {
    expect(DESKTOP_CANONICAL_LANDING_NAV_ID).toBe(
      DESKTOP_SHELL_ROUTE_NAV_IDS[SHELL_CANONICAL_LANDING_ROUTE_ID]
    );
    expect(DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.Dashboard]).toBe(
      NavId.Dashboard
    );
    // The seed IS the landing. A `DEFAULT_NAV_ID` that disagreed is what opened
    // Desktop on Sessions and left Dashboard reachable only through a second,
    // experience-gated redirect.
    expect(DEFAULT_NAV_ID).toBe(DESKTOP_CANONICAL_LANDING_NAV_ID);
    expect(DEFAULT_NAV_ID).toBe(NavId.Dashboard);
  });

  it("keeps Desktop gate metadata aligned with Desktop flag keys", () => {
    const itemById = new Map(
      SHELL_NAVIGATION_ITEMS.map((item) => [item.id, item])
    );
    const desktopGatesFor = (itemId: ShellNavigationItemId) =>
      itemById.get(itemId)?.gates?.[ShellNavigationSurface.Desktop] ?? [];

    expect(SHELL_DESKTOP_LABS_NAV_GATE_KEY).toBe(
      DESKTOP_LABS_NAV_FEATURE_FLAG_KEY
    );
    expect(SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY).toBe(
      DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY
    );
    expect(desktopGatesFor(ShellNavigationItemId.Agents)).toEqual([
      desktopLabsContainerGate(),
      desktopLabsItemGate(DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY),
    ]);
    expect(desktopGatesFor(ShellNavigationItemId.Help)).toEqual([
      desktopLabsContainerGate(),
      desktopLabsItemGate(DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY),
    ]);
    expect(desktopGatesFor(ShellNavigationItemId.Insights)).toEqual([
      desktopLabsContainerGate(),
    ]);
    expect(desktopGatesFor(ShellNavigationItemId.Packs)).toEqual([
      desktopLabsContainerGate(),
    ]);
    expect(desktopGatesFor(ShellNavigationItemId.Plans)).toEqual([
      desktopLabsContainerGate(),
    ]);
  });
});

describe("normalizeNavId", () => {
  it("passes valid ids, aliases analytics, defaults unknowns", () => {
    expect(normalizeNavId("analytics")).toBe("insights");
    expect(normalizeNavId("bogus")).toBe("dashboard");
    expect(normalizeNavId(null)).toBe("dashboard");
  });

  it("falls the retired Routines and Audit Bot ids through to the landing view (PRD-797 AC-001.1)", () => {
    for (const retired of ["routines", "scheduled-tasks", "audit"]) {
      expect(normalizeNavId(retired)).toBe("dashboard");
    }
  });
});

describe("hashToHrefEntries", () => {
  it("seeds an empty hash with the landing view", () => {
    // The launch seed. Anything else here means Desktop opens on a surface the
    // user is then redirected away from.
    expect(hashToHrefEntries("")).toEqual(["/dashboard"]);
    expect(hashToHrefEntries("#")).toEqual(["/dashboard"]);
  });

  it("passes through the current path scheme", () => {
    expect(hashToHrefEntries("#/sessions/123?tab=events")).toEqual([
      "/sessions/123?tab=events",
    ]);
  });

  it.each([
    ["/settings/account", "/settings?tab=account"],
    ["/settings/security", "/settings?panel=desktop-app"],
    ["/settings/relay-gateway", "/settings?panel=desktop-app"],
    ["/settings/relay", "/settings?panel=desktop-app"],
    ["/settings/gateway", "/settings?panel=desktop-app"],
    ["/settings/compute-targets", "/settings?panel=desktop-app"],
    ["/settings/cli-tools", "/settings?panel=desktop-app"],
    ["/settings/binary-paths", "/settings?panel=desktop-app"],
  ])("normalizes %s to %s", (href, expected) => {
    expect(normalizeRouteHref(href)).toBe(expected);
  });

  it("preserves existing Settings subpath query params and replaces tab", () => {
    expect(
      normalizeRouteHref("/settings/account?from=command&tab=security")
    ).toBe("/settings?from=command&tab=account");
  });

  // ISS-10286: the aliases the Desktop App panel owns write the v2 `panel`
  // vocabulary, so the path wins over a stale `?panel=` rather than a stale
  // `?tab=`.
  it("replaces a stale panel on a Desktop App alias", () => {
    expect(
      normalizeRouteHref("/settings/security?from=command&panel=profile")
    ).toBe("/settings?from=command&panel=desktop-app");
  });

  /**
   * ISS-10286 split the aliases across two vocabularies, which is what made the
   * CROSS direction reachable: an alias that writes `?tab=` cannot clear a
   * stale `?panel=` by overwriting its own param, and `parseSettingsRouteParams`
   * reads `panel` first — so before this, `/settings/account?panel=profile`
   * opened Profile while the path said Account (tamsinb, #4032721366). Both
   * directions, because clearing one vocabulary and not the other is exactly
   * the half-fix that shipped.
   */
  it("clears a stale panel when the alias writes the tab vocabulary", () => {
    expect(
      normalizeRouteHref("/settings/account?from=command&panel=profile")
    ).toBe("/settings?from=command&tab=account");
  });

  it("clears a stale tab when the alias writes the panel vocabulary", () => {
    expect(
      normalizeRouteHref("/settings/security?from=command&tab=account")
    ).toBe("/settings?from=command&panel=desktop-app");
  });

  // Only the FIRST "?" delimits the query. A later one lives inside a value —
  // here a `returnTo` that carries its own query — and must survive whole.
  it("keeps a query value that itself contains a question mark", () => {
    expect(
      normalizeRouteHref("/settings/security?returnTo=/branches?owner=grace")
    ).toBe("/settings?returnTo=%2Fbranches%3Fowner%3Dgrace&panel=desktop-app");
  });

  it("normalizes an encoded question mark to the same href as a literal one", () => {
    expect(
      normalizeRouteHref(
        "/settings/security?returnTo=%2Fbranches%3Fowner%3Dgrace"
      )
    ).toBe(
      normalizeRouteHref("/settings/security?returnTo=/branches?owner=grace")
    );
  });

  it("keeps a fragment inside a query value instead of truncating there", () => {
    expect(
      normalizeRouteHref("/settings/security?returnTo=/branches#top")
    ).toBe("/settings?returnTo=%2Fbranches%23top&panel=desktop-app");
  });

  it("normalizes an empty query to the bare alias href", () => {
    expect(normalizeRouteHref("/settings/security?")).toBe(
      "/settings?panel=desktop-app"
    );
  });

  it("migrates a legacy analytics tab to insights", () => {
    expect(hashToHrefEntries("#tab=analytics")).toEqual(["/insights"]);
  });

  it.each([
    ["#/settings/account", "/settings?tab=account"],
    ["#/settings/security", "/settings?panel=desktop-app"],
    ["#/settings/relay-gateway", "/settings?panel=desktop-app"],
    ["#/settings/cli-tools", "/settings?panel=desktop-app"],
  ])("restores %s as %s", (hash, expected) => {
    expect(hashToHrefEntries(hash)).toEqual([expected]);
  });

  it("restores a Settings subpath hash whose returnTo carries its own query", () => {
    expect(
      hashToHrefEntries("#/settings/security?returnTo=/branches?owner=grace")
    ).toEqual([
      "/settings?returnTo=%2Fbranches%3Fowner%3Dgrace&panel=desktop-app",
    ]);
  });

  it("migrates a legacy tab+sessionId hash to a two-entry stack", () => {
    expect(hashToHrefEntries("#tab=dashboard&sessionId=s-1")).toEqual([
      "/dashboard",
      "/sessions/s-1",
    ]);
  });

  it("falls back to the landing view for unparseable hashes", () => {
    expect(hashToHrefEntries("#garbage")).toEqual(["/dashboard"]);
  });
});

// T-18.6 + FEA-4087: the retired Skills/Tools/Subagents Packs-Lab ids stay
// removed, but "packs" is reclaimed as the real top-level Packs page (NavId.Packs).
describe("NavId — retired Packs-Lab entries removed, Packs reclaimed (FEA-4087)", () => {
  it("does not include Skills, Tools, or Subagents in NavId", () => {
    const values = Object.values(NavId);
    expect(values).not.toContain("skills");
    expect(values).not.toContain("tools");
    expect(values).not.toContain("subagents");
  });

  it("includes Agents and the reclaimed Packs in NavId", () => {
    expect(NavId.Agents).toBe("agents");
    expect(NavId.Packs).toBe("packs");
  });

  // Type-level guard: ensure the NavId object does not have the retired keys,
  // but does carry the reclaimed Packs key (FEA-4087).
  it("has the Packs key but not Skills, Tools, or Subagents keys on the NavId object", () => {
    expect("Packs" in NavId).toBe(true);
    expect("Skills" in NavId).toBe(false);
    expect("Tools" in NavId).toBe(false);
    expect("Subagents" in NavId).toBe(false);
  });
});

describe("matchRoute — /packs is the Packs page; other Packs-Lab aliases → Agents (FEA-4087)", () => {
  it("resolves /packs to the reclaimed NavId.Packs (no longer Agents)", () => {
    expect(matchRoute("/packs")).toEqual({
      kind: "nav",
      navId: "packs",
      params: {},
    });
  });

  it("redirects /skills to NavId.Agents", () => {
    expect(matchRoute("/skills")).toEqual({
      kind: "nav",
      navId: "agents",
      params: {},
    });
  });

  it("redirects /tools to NavId.Agents", () => {
    expect(matchRoute("/tools")).toEqual({
      kind: "nav",
      navId: "agents",
      params: {},
    });
  });

  it("redirects /subagents to NavId.Agents", () => {
    expect(matchRoute("/subagents")).toEqual({
      kind: "nav",
      navId: "agents",
      params: {},
    });
  });

  it("maps /agents to the Agents workspace (not redirected)", () => {
    expect(matchRoute("/agents")).toEqual({
      kind: "nav",
      navId: "agents",
      params: {},
    });
  });

  it("maps /agents/:id to agent-detail with a decoded `id` param", () => {
    expect(matchRoute("/agents/my-agent-slug")).toEqual({
      kind: "agent-detail",
      agentSlug: "my-agent-slug",
      params: { id: "my-agent-slug" },
    });
  });

  it("maps /agents/:id with URL-encoded characters", () => {
    expect(matchRoute("/agents/some%2Fcomponent")).toEqual({
      kind: "agent-detail",
      agentSlug: "some/component",
      params: { id: "some/component" },
    });
  });

  it("does not let /agents/:id shadow the /agents nav view", () => {
    expect(matchRoute("/agents")).toEqual({
      kind: "nav",
      navId: "agents",
      params: {},
    });
  });

  it("returns null for malformed or wrong-arity agent paths", () => {
    expect(matchRoute("/agents/")).toBeNull();
    expect(matchRoute("/agents/a/b")).toBeNull();
    expect(matchRoute("/agents/%")).toBeNull();
  });
});

describe("matchRoute pack detail (ISS-6925)", () => {
  it("maps /packs/:id to the Packs view carrying a decoded `id` param", () => {
    expect(matchRoute("/packs/my-pack-id")).toEqual({
      kind: "nav",
      navId: "packs",
      params: { id: "my-pack-id" },
    });
  });

  it("agrees with the shared path builder both shells link through", () => {
    expect(matchRoute(packDetailPath("my-pack-id"))).toEqual({
      kind: "nav",
      navId: "packs",
      params: { id: "my-pack-id" },
    });
  });

  it("decodes an encoded id, so the host reads the same value web does", () => {
    expect(matchRoute(packDetailPath("scope/pack"))).toEqual({
      kind: "nav",
      navId: "packs",
      params: { id: "scope/pack" },
    });
  });

  it("does not let /packs/:id shadow the /packs nav view", () => {
    expect(matchRoute("/packs")).toEqual({
      kind: "nav",
      navId: "packs",
      params: {},
    });
  });

  it("returns null for malformed or wrong-arity pack paths", () => {
    expect(matchRoute("/packs/")).toBeNull();
    expect(matchRoute("/packs/a/b")).toBeNull();
    expect(matchRoute("/packs/%")).toBeNull();
  });
});

describe("normalizeNavId — 'packs' is the Packs page; other Packs-Lab values → Agents (FEA-4087)", () => {
  it("passes 'packs' through to the reclaimed Packs nav (no longer Agents)", () => {
    expect(normalizeNavId("packs")).toBe("packs");
  });

  it("maps legacy 'skills' hash tab to Agents", () => {
    expect(normalizeNavId("skills")).toBe("agents");
  });

  it("maps legacy 'tools' hash tab to Agents", () => {
    expect(normalizeNavId("tools")).toBe("agents");
  });

  it("maps legacy 'subagents' hash tab to Agents", () => {
    expect(normalizeNavId("subagents")).toBe("agents");
  });

  it("still maps 'analytics' to Insights (pre-existing alias)", () => {
    expect(normalizeNavId("analytics")).toBe("insights");
  });

  it("passes through valid 'agents' unchanged", () => {
    expect(normalizeNavId("agents")).toBe("agents");
  });

  it("defaults unknown values to the default nav (dashboard)", () => {
    expect(normalizeNavId("bogus")).toBe("dashboard");
    expect(normalizeNavId(null)).toBe("dashboard");
  });
});

describe("hashToHrefEntries — 'packs' tab → Packs page; other Packs-Lab tabs → Agents (FEA-4087)", () => {
  it("migrates a 'packs' tab hash to the reclaimed Packs page (no longer Agents)", () => {
    expect(hashToHrefEntries("#tab=packs")).toEqual(["/packs"]);
  });

  it("migrates a legacy skills tab hash to the Agents workspace", () => {
    expect(hashToHrefEntries("#tab=skills")).toEqual(["/agents"]);
  });

  it("migrates a legacy tools tab hash to the Agents workspace", () => {
    expect(hashToHrefEntries("#tab=tools")).toEqual(["/agents"]);
  });

  it("migrates a legacy subagents tab hash to the Agents workspace", () => {
    expect(hashToHrefEntries("#tab=subagents")).toEqual(["/agents"]);
  });
});

describe("agentDetailHref (T-18.6)", () => {
  it("encodes agent slugs", () => {
    expect(agentDetailHref("some/slug")).toBe("/agents/some%2Fslug");
  });

  it("round-trips an agent slug through agentDetailHref and matchRoute", () => {
    const slug = "owner/repo::subagent";
    expect(matchRoute(agentDetailHref(slug))).toEqual({
      kind: "agent-detail",
      agentSlug: slug,
      params: { id: slug },
    });
  });

  it("produces a simple slug href", () => {
    expect(agentDetailHref("my-agent")).toBe("/agents/my-agent");
  });
});

/**
 * ISS-6642: the desktop twin of `e2e/agents-breadcrumb-encoding.spec.ts`.
 *
 * `matchPattern` decodes a captured segment exactly ONCE, so a double-encoded
 * href hands the agent-detail route a slug that is still percent-encoded and
 * still has no literal `::` — the identity codec misses it, the detail fetch
 * misses, and the crumb leaks `%3A%3A%2F%2F`. Web repairs that at its page
 * boundary (`normalizeAgentSlug`, ISS-4776) and had this route boundary as its
 * only repo-wide caller; desktop's route table now repairs it too.
 *
 * The assertions compare the two resolved routes to EACH OTHER rather than to a
 * literal: "the double-encoded href resolves to the same component" is the
 * claim, and pinning both sides to a constant is what lets the two paths drift
 * while both stay green.
 */
const CANONICAL_AGENT_SLUG = "command:://cl-ci-babysit";

describe("matchRoute agent-detail slug repair (ISS-6642)", () => {
  it("resolves a double-encoded href to the same component as the correctly-encoded one", () => {
    const correct = agentDetailHref(CANONICAL_AGENT_SLUG);
    // What a router hop that encoded an ALREADY-encoded segment emits.
    const doubleEncoded = `/agents/${encodeURIComponent(encodeURIComponent(CANONICAL_AGENT_SLUG))}`;
    expect(doubleEncoded).not.toBe(correct);

    const fromCorrect = matchRoute(correct);
    const fromDoubleEncoded = matchRoute(doubleEncoded);

    expect(fromCorrect).toEqual({
      kind: "agent-detail",
      agentSlug: CANONICAL_AGENT_SLUG,
      params: { id: CANONICAL_AGENT_SLUG },
    });
    // The identity the detail view, the fetch, and the crumb all key off. The
    // raw `params.id` capture is deliberately NOT normalized, so this asserts
    // the repaired field alone.
    expect(
      fromDoubleEncoded?.kind === "agent-detail"
        ? fromDoubleEncoded.agentSlug
        : null
    ).toBe(
      fromCorrect?.kind === "agent-detail" ? fromCorrect.agentSlug : undefined
    );
  });

  it("leaves a slug whose key legitimately contains a literal % untouched", () => {
    // The case the repair deliberately protects: `load%20test` is the real key,
    // not an encoding of `load test`. It already carries a literal `::`, so a
    // repair that decoded unconditionally would mangle it into `load test`.
    const slug = "tool::load%20test";

    expect(matchRoute(agentDetailHref(slug))).toEqual({
      kind: "agent-detail",
      agentSlug: slug,
      params: { id: slug },
    });
  });
});

/**
 * ISS-10286 — the `/settings/security` alias, driven through the two
 * production steps that decide where a user lands: the route table's rewrite,
 * and the Settings v2 parser that reads the result.
 *
 * The contract is that the request SURVIVES as a known panel id. ISS-10195 left
 * the desktop's machine-local controls with no v2 owner, and the legacy `?tab=`
 * spelling has had no reader since — so this link reached the parser naming
 * NOTHING and opened the default panel as if the user had browsed there. The
 * Labs → Desktop App panel is now its owner, so the same link resolves.
 */
describe("the security deep link as Settings v2 reads it", () => {
  it("resolves to the Desktop App panel rather than naming nothing", () => {
    const href = normalizeRouteHref("/settings/security");
    const query = href.slice(href.indexOf("?") + 1);

    const params = parseSettingsRouteParams(new URLSearchParams(query));

    expect(params.panel).toBe(SettingsPanelId.DesktopApp);
    expect(params.requestedPanel).toBe(SettingsPanelId.DesktopApp);
  });

  it("keeps the returnTo the link carries", () => {
    const href = normalizeRouteHref("/settings/security?returnTo=/branches");
    const query = href.slice(href.indexOf("?") + 1);

    const params = parseSettingsRouteParams(new URLSearchParams(query));

    expect(params.panel).toBe(SettingsPanelId.DesktopApp);
    expect(params.returnTo).toBe("/branches");
  });

  // The other half of the split, and the one a reader is most likely to assume
  // away: Account did NOT move into this panel, so its alias still speaks the
  // unread legacy vocabulary and still names no panel.
  it("leaves the account alias naming no panel at all", () => {
    const href = normalizeRouteHref("/settings/account");
    const query = href.slice(href.indexOf("?") + 1);

    const params = parseSettingsRouteParams(new URLSearchParams(query));

    expect(params.panel).toBeNull();
    expect(params.requestedPanel).toBeNull();
  });
});

function desktopLabsContainerGate() {
  return {
    kind: ShellNavigationGateKind.DesktopLabsContainer,
    key: SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  };
}

function desktopLabsItemGate(key: string) {
  return {
    kind: ShellNavigationGateKind.DesktopLabsItem,
    key,
  };
}

function isMappedNavId(navId: NavId | null): navId is NavId {
  return navId !== null;
}

describe("RECORD_ID_ROUTE_PATTERNS (ISS-12259)", () => {
  it("lists the routes with an id param and no route without one", () => {
    expect(RECORD_ID_ROUTE_PATTERNS).toEqual(
      expect.arrayContaining(["/sessions/:id", "/agents/:id"])
    );
    expect(RECORD_ID_ROUTE_PATTERNS).not.toContain(
      hrefForNavId(NavId.Sessions)
    );
  });
});
