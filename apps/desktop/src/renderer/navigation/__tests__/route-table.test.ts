import { describe, expect, it } from "vitest";
import {
  agentDetailHref,
  branchDetailHref,
  hashToHrefEntries,
  hrefForNavId,
  matchRoute,
  NavId,
  normalizeNavId,
  sessionDetailHref,
} from "../route-table";

describe("matchRoute", () => {
  it("maps / to the default view", () => {
    expect(matchRoute("/")).toEqual({
      kind: "nav",
      navId: "sessions",
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
});

describe("normalizeNavId", () => {
  it("passes valid ids, aliases analytics, defaults unknowns", () => {
    expect(normalizeNavId("analytics")).toBe("insights");
    expect(normalizeNavId("bogus")).toBe("sessions");
    expect(normalizeNavId(null)).toBe("sessions");
  });
});

describe("hashToHrefEntries", () => {
  it("defaults an empty hash to the sessions view", () => {
    expect(hashToHrefEntries("")).toEqual(["/sessions"]);
    expect(hashToHrefEntries("#")).toEqual(["/sessions"]);
  });

  it("passes through the current path scheme", () => {
    expect(hashToHrefEntries("#/sessions/123?tab=events")).toEqual([
      "/sessions/123?tab=events",
    ]);
  });

  it("migrates a legacy analytics tab to insights", () => {
    expect(hashToHrefEntries("#tab=analytics")).toEqual(["/insights"]);
  });

  it("migrates a legacy tab+sessionId hash to a two-entry stack", () => {
    expect(hashToHrefEntries("#tab=dashboard&sessionId=s-1")).toEqual([
      "/dashboard",
      "/sessions/s-1",
    ]);
  });

  it("falls back to the sessions view for unparseable hashes", () => {
    expect(hashToHrefEntries("#garbage")).toEqual(["/sessions"]);
  });
});

// T-18.6: Packs-Lab removal route tests (AC-020, AC-025)
describe("NavId — Packs-Lab entries removed (T-18.6)", () => {
  it("does not include Packs, Skills, Tools, or Subagents in NavId", () => {
    const values = Object.values(NavId);
    expect(values).not.toContain("packs");
    expect(values).not.toContain("skills");
    expect(values).not.toContain("tools");
    expect(values).not.toContain("subagents");
  });

  it("includes Agents in NavId", () => {
    expect(NavId.Agents).toBe("agents");
  });

  // Type-level guard: ensure the NavId object does not have deprecated keys.
  // This is a runtime check that mirrors the compile-time absence.
  it("does not have Packs, Skills, Tools, or Subagents keys on the NavId object", () => {
    expect("Packs" in NavId).toBe(false);
    expect("Skills" in NavId).toBe(false);
    expect("Tools" in NavId).toBe(false);
    expect("Subagents" in NavId).toBe(false);
  });
});

describe("matchRoute — Packs-Lab legacy aliases → Agents (T-18.6)", () => {
  it("redirects /packs to NavId.Agents", () => {
    expect(matchRoute("/packs")).toEqual({
      kind: "nav",
      navId: "agents",
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

describe("normalizeNavId — Packs-Lab legacy hash values → Agents (T-18.6)", () => {
  it("maps legacy 'packs' hash tab to Agents", () => {
    expect(normalizeNavId("packs")).toBe("agents");
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

  it("defaults unknown values to the default nav (sessions)", () => {
    expect(normalizeNavId("bogus")).toBe("sessions");
    expect(normalizeNavId(null)).toBe("sessions");
  });
});

describe("hashToHrefEntries — Packs-Lab legacy tab hashes → Agents (T-18.6)", () => {
  it("migrates a legacy packs tab hash to the Agents workspace", () => {
    expect(hashToHrefEntries("#tab=packs")).toEqual(["/agents"]);
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
