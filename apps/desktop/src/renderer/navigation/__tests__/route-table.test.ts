import { describe, expect, it } from "vitest";
import {
  branchDetailHref,
  hashToHrefEntries,
  hrefForNavId,
  matchRoute,
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
    expect(matchRoute("/kanban")).toEqual({
      kind: "nav",
      navId: "kanban",
      params: {},
    });
    expect(matchRoute("/pull-requests")).toEqual({
      kind: "nav",
      navId: "pull-requests",
      params: {},
    });
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

  it("maps /sessions/:id with a decoded param named like the web route", () => {
    // Param key is `id` — shared session pages read useRouteParams().id
    // (web route is /[orgSlug]/sessions/[id]).
    expect(matchRoute("/sessions/abc%2F123")).toEqual({
      kind: "session-detail",
      sessionId: "abc/123",
      params: { id: "abc/123" },
    });
  });

  it("maps the web-canonical /my-tasks alias to the kanban view", () => {
    expect(matchRoute("/my-tasks")).toEqual({
      kind: "nav",
      navId: "kanban",
      params: {},
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
    expect(normalizeNavId("kanban")).toBe("kanban");
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

  it("migrates a legacy tab-only hash", () => {
    expect(hashToHrefEntries("#tab=kanban")).toEqual(["/kanban"]);
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
