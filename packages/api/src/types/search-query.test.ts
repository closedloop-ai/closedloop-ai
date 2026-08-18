import { describe, expect, it } from "vitest";
import { SearchEntityType } from "./search-entity-kind";
import {
  hasStructuredFilters,
  PRIORITY_ORDINAL,
  parseSearchQuery,
  SEARCH_FILTER_KEYS,
  SearchFilterKey,
  SearchFilterOperator,
  SearchSuggestionSource,
} from "./search-query";

// A fixed clock so relative-date resolution is deterministic.
const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("parseSearchQuery — free text", () => {
  it("returns bare words as text with no filters or errors", () => {
    const parsed = parseSearchQuery("acme rocket launch", NOW);
    expect(parsed.text).toBe("acme rocket launch");
    expect(parsed.filters).toEqual({});
    expect(parsed.errors).toEqual([]);
  });

  it("keeps a non-filter colon token (e.g. a URL) as free text", () => {
    const parsed = parseSearchQuery("see http://example.com/x", NOW);
    expect(parsed.text).toBe("see http://example.com/x");
    expect(parsed.filters).toEqual({});
    expect(parsed.errors).toEqual([]);
  });

  it("strips filters and leaves only the free text", () => {
    const parsed = parseSearchQuery("status:TODO rocket priority:high", NOW);
    expect(parsed.text).toBe("rocket");
    expect(parsed.errors).toEqual([]);
  });

  it("supports an empty text with only filters (valid)", () => {
    const parsed = parseSearchQuery("status:DONE", NOW);
    expect(parsed.text).toBe("");
    expect(parsed.filters.status).toEqual({
      operator: SearchFilterOperator.Eq,
      value: "DONE",
    });
  });
});

describe("parseSearchQuery — owner mentions", () => {
  it("collects a single @owner", () => {
    const parsed = parseSearchQuery("@alice bug", NOW);
    expect(parsed.filters.owner).toEqual(["alice"]);
    expect(parsed.text).toBe("bug");
  });

  it("collects multiple @owners (OR within owner)", () => {
    const parsed = parseSearchQuery("@alice @bob deploy", NOW);
    expect(parsed.filters.owner).toEqual(["alice", "bob"]);
    expect(parsed.text).toBe("deploy");
  });

  it("treats a bare @ as text, not an owner", () => {
    const parsed = parseSearchQuery("email @ me", NOW);
    expect(parsed.filters.owner).toBeUndefined();
    expect(parsed.text).toBe("email @ me");
  });
});

describe("parseSearchQuery — status filter", () => {
  it("parses status:VALUE as equality, upper-casing the value", () => {
    const parsed = parseSearchQuery("status:todo", NOW);
    expect(parsed.filters.status).toEqual({
      operator: SearchFilterOperator.Eq,
      value: "TODO",
    });
    expect(parsed.errors).toEqual([]);
  });

  it("parses status!=DONE as negated equality", () => {
    const parsed = parseSearchQuery("status!=done", NOW);
    expect(parsed.filters.status).toEqual({
      operator: SearchFilterOperator.Neq,
      value: "DONE",
    });
  });

  it("rejects an unknown status value with an error and no filter", () => {
    const parsed = parseSearchQuery("status:wibble", NOW);
    expect(parsed.filters.status).toBeUndefined();
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].message).toContain("Unknown status value");
  });

  it("rejects an ordered operator on status (>=) as an error", () => {
    const parsed = parseSearchQuery("status>=todo", NOW);
    expect(parsed.filters.status).toBeUndefined();
    expect(parsed.errors).toHaveLength(1);
  });
});

describe("parseSearchQuery — priority filter (ordinal)", () => {
  it("parses priority:high equality", () => {
    const parsed = parseSearchQuery("priority:high", NOW);
    expect(parsed.filters.priority).toEqual({
      operator: SearchFilterOperator.Eq,
      value: "HIGH",
    });
  });

  it("parses priority>=medium with the >= operator", () => {
    const parsed = parseSearchQuery("priority>=medium", NOW);
    expect(parsed.filters.priority).toEqual({
      operator: SearchFilterOperator.Gte,
      value: "MEDIUM",
    });
  });

  it("parses priority<urgent with the < operator", () => {
    const parsed = parseSearchQuery("priority<urgent", NOW);
    expect(parsed.filters.priority).toEqual({
      operator: SearchFilterOperator.Lt,
      value: "URGENT",
    });
  });

  it("orders LOW < MEDIUM < HIGH < URGENT by ordinal", () => {
    expect(PRIORITY_ORDINAL.LOW).toBeLessThan(PRIORITY_ORDINAL.MEDIUM);
    expect(PRIORITY_ORDINAL.MEDIUM).toBeLessThan(PRIORITY_ORDINAL.HIGH);
    expect(PRIORITY_ORDINAL.HIGH).toBeLessThan(PRIORITY_ORDINAL.URGENT);
  });

  it("rejects an unknown priority value", () => {
    const parsed = parseSearchQuery("priority:huge", NOW);
    expect(parsed.filters.priority).toBeUndefined();
    expect(parsed.errors[0].message).toContain("Unknown priority value");
  });
});

describe("parseSearchQuery — project filter", () => {
  it("parses project:slug equality", () => {
    const parsed = parseSearchQuery("project:acme-web", NOW);
    expect(parsed.filters.project).toEqual({ value: "acme-web" });
  });

  it("keeps a quoted multi-word project name as one value", () => {
    const parsed = parseSearchQuery('project:"My Big Project" rocket', NOW);
    expect(parsed.filters.project).toEqual({ value: "My Big Project" });
    expect(parsed.text).toBe("rocket");
  });

  it("rejects an ordered operator on project", () => {
    const parsed = parseSearchQuery("project>acme", NOW);
    expect(parsed.filters.project).toBeUndefined();
    expect(parsed.errors).toHaveLength(1);
  });
});

describe("parseSearchQuery — updated date filter", () => {
  it("parses a relative window updated>7d relative to now", () => {
    const parsed = parseSearchQuery("updated>7d", NOW);
    expect(parsed.filters.updated).toEqual({
      kind: "bound",
      operator: SearchFilterOperator.Gt,
      date: new Date("2026-07-17T12:00:00.000Z"),
    });
  });

  it("parses an absolute ISO date updated<=2026-07-01", () => {
    const parsed = parseSearchQuery("updated<=2026-07-01", NOW);
    expect(parsed.filters.updated).toEqual({
      kind: "bound",
      operator: SearchFilterOperator.Lte,
      date: new Date("2026-07-01T00:00:00.000Z"),
    });
  });

  it("parses a range updated:2026-07-01..2026-07-15", () => {
    const parsed = parseSearchQuery("updated:2026-07-01..2026-07-15", NOW);
    expect(parsed.filters.updated).toEqual({
      kind: "range",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-15T00:00:00.000Z"),
    });
  });

  it("rejects a malformed updated date", () => {
    const parsed = parseSearchQuery("updated>notadate", NOW);
    expect(parsed.filters.updated).toBeUndefined();
    expect(parsed.errors[0].message).toContain("Invalid :updated date");
  });

  it("rejects a range with a bad bound", () => {
    const parsed = parseSearchQuery("updated:2026-07-01..bogus", NOW);
    expect(parsed.filters.updated).toBeUndefined();
    expect(parsed.errors[0].message).toContain("Invalid :updated range");
  });
});

describe("parseSearchQuery — combined + malformed", () => {
  it("ANDs different keys and preserves free text", () => {
    const parsed = parseSearchQuery(
      "@alice status:IN_PROGRESS priority>=high project:acme rocket",
      NOW
    );
    expect(parsed.filters.owner).toEqual(["alice"]);
    expect(parsed.filters.status?.value).toBe("IN_PROGRESS");
    expect(parsed.filters.priority?.operator).toBe(SearchFilterOperator.Gte);
    expect(parsed.filters.project?.value).toBe("acme");
    expect(parsed.text).toBe("rocket");
    expect(parsed.errors).toEqual([]);
  });

  it("reports an empty filter value as an error", () => {
    const parsed = parseSearchQuery("status:", NOW);
    expect(parsed.filters.status).toBeUndefined();
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].message).toContain("requires a value");
  });

  it("keeps good filters and still reports a bad one", () => {
    const parsed = parseSearchQuery("status:TODO priority:huge", NOW);
    expect(parsed.filters.status?.value).toBe("TODO");
    expect(parsed.filters.priority).toBeUndefined();
    expect(parsed.errors).toHaveLength(1);
  });
});

describe("parseSearchQuery — exact ID/slug lookup (FEA-3930)", () => {
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("lifts a bare UUID as an idLookup and empties the free text", () => {
    const parsed = parseSearchQuery(UUID, NOW);
    expect(parsed.idLookup).toEqual({ uuid: UUID });
    expect(parsed.text).toBe("");
    expect(parsed.filters).toEqual({});
    expect(parsed.errors).toEqual([]);
  });

  it("lifts a UUID case-insensitively (upper-case hex)", () => {
    const parsed = parseSearchQuery(UUID.toUpperCase(), NOW);
    expect(parsed.idLookup?.uuid).toBe(UUID.toUpperCase());
    expect(parsed.text).toBe("");
  });

  it.each([
    "FEA-123",
    // FEA-4137: ISS- (canonical Issue prefix) is a known slug too; FEA- stays
    // accepted as the compat alias.
    "ISS-123",
    "PRD-4",
    "PLN-77",
    "PRO-9",
    // Evergreen Document artifacts (DOC-*, FEA-3949) carry a projected slug too.
    "DOC-8",
  ])("lifts a known slug %s as an idLookup and empties the free text", (slug) => {
    const parsed = parseSearchQuery(slug, NOW);
    expect(parsed.idLookup).toEqual({ slug });
    expect(parsed.text).toBe("");
  });

  it("does NOT lift a session slug (SES-###) — sessions carry no projected slug", () => {
    // The search_document projection stores slug=null for sessions, so a
    // SES-slug exact lookup could never match; it stays free text instead of
    // becoming a doomed empty lookup.
    const parsed = parseSearchQuery("SES-2", NOW);
    expect(parsed.idLookup).toBeUndefined();
    expect(parsed.text).toBe("SES-2");
  });

  it("lifts a known slug case-insensitively, preserving the verbatim token", () => {
    const parsed = parseSearchQuery("fea-123", NOW);
    expect(parsed.idLookup?.slug).toBe("fea-123");
    expect(parsed.text).toBe("");
  });

  it("keeps the OTHER words as free text for a mixed id + text query", () => {
    const parsed = parseSearchQuery(`${UUID} rocket launch`, NOW);
    expect(parsed.idLookup).toEqual({ uuid: UUID });
    expect(parsed.text).toBe("rocket launch");
  });

  it("keeps free text and the id when the slug comes after words", () => {
    const parsed = parseSearchQuery("fix FEA-42 now", NOW);
    expect(parsed.idLookup).toEqual({ slug: "FEA-42" });
    expect(parsed.text).toBe("fix now");
  });

  it("only the FIRST id/slug is lifted; a later one falls back to free text", () => {
    const parsed = parseSearchQuery("FEA-1 FEA-2", NOW);
    expect(parsed.idLookup).toEqual({ slug: "FEA-1" });
    expect(parsed.text).toBe("FEA-2");
  });

  it("does not treat an unknown prefix or bare word as an idLookup", () => {
    const parsed = parseSearchQuery("BUG-7 acme notaslug", NOW);
    expect(parsed.idLookup).toBeUndefined();
    expect(parsed.text).toBe("BUG-7 acme notaslug");
  });

  it("does not treat a slug-like token without digits as an idLookup", () => {
    const parsed = parseSearchQuery("FEA-abc", NOW);
    expect(parsed.idLookup).toBeUndefined();
    expect(parsed.text).toBe("FEA-abc");
  });

  it("does not treat a partial/truncated UUID as an idLookup", () => {
    const parsed = parseSearchQuery("aaaaaaaa-bbbb-cccc-dddd", NOW);
    expect(parsed.idLookup).toBeUndefined();
    expect(parsed.text).toBe("aaaaaaaa-bbbb-cccc-dddd");
  });

  it("omits idLookup entirely for a plain free-text query", () => {
    const parsed = parseSearchQuery("acme rocket", NOW);
    expect("idLookup" in parsed).toBe(false);
  });

  it("coexists with structured filters (id first, filters parsed)", () => {
    const parsed = parseSearchQuery("FEA-9 status:TODO", NOW);
    expect(parsed.idLookup).toEqual({ slug: "FEA-9" });
    expect(parsed.filters.status?.value).toBe("TODO");
    expect(parsed.text).toBe("");
  });
});

describe("parseSearchQuery — type: filter (FEA-4134)", () => {
  it("lifts a single type: token into the type filter and strips it from text", () => {
    const parsed = parseSearchQuery("agent type:agent_session", NOW);
    expect(parsed.filters.type).toEqual({
      kinds: [SearchEntityType.AgentSession],
    });
    expect(parsed.text).toBe("agent");
    expect(parsed.errors).toEqual([]);
  });

  it("ORs repeated type: tokens (any-of), deduped in first-seen order", () => {
    const parsed = parseSearchQuery(
      "type:branch type:document type:branch",
      NOW
    );
    expect(parsed.filters.type).toEqual({
      kinds: [SearchEntityType.Branch, SearchEntityType.Document],
    });
    expect(parsed.text).toBe("");
    expect(parsed.errors).toEqual([]);
  });

  it("normalizes an upper/mixed-case type: value to the wire kind", () => {
    const parsed = parseSearchQuery("type:Document type:LOOP", NOW);
    expect(parsed.filters.type).toEqual({
      kinds: [SearchEntityType.Document, SearchEntityType.Loop],
    });
  });

  it("errors an unknown type: value without applying a filter", () => {
    const parsed = parseSearchQuery("type:widget agent", NOW);
    expect(parsed.filters.type).toBeUndefined();
    expect(parsed.errors).toEqual([
      { token: "type:widget", message: "Unknown type value: widget" },
    ]);
    // The unknown token is dropped from the FTS text, not run as free text.
    expect(parsed.text).toBe("agent");
  });

  it("errors a non-equality operator on type: (equality-only)", () => {
    const parsed = parseSearchQuery("type!=loop", NOW);
    expect(parsed.filters.type).toBeUndefined();
    expect(parsed.errors[0]).toEqual({
      token: "type!=loop",
      message: `:type supports ${SearchFilterOperator.Eq} only`,
    });
  });

  it("errors an empty type: value", () => {
    const parsed = parseSearchQuery("type:", NOW);
    expect(parsed.filters.type).toBeUndefined();
    expect(parsed.errors[0]?.message).toBe(
      `${SearchFilterKey.Type} requires a value`
    );
  });

  it("keeps a valid kind when a repeated token is unknown (partial error)", () => {
    const parsed = parseSearchQuery("type:document type:nope", NOW);
    expect(parsed.filters.type).toEqual({
      kinds: [SearchEntityType.Document],
    });
    expect(parsed.errors).toEqual([
      { token: "type:nope", message: "Unknown type value: nope" },
    ]);
  });

  it("ANDs type: with other filters and coexists with @owner + status", () => {
    const parsed = parseSearchQuery("@alice type:document status:DONE", NOW);
    expect(parsed.filters.type).toEqual({
      kinds: [SearchEntityType.Document],
    });
    expect(parsed.filters.owner).toEqual(["alice"]);
    expect(parsed.filters.status?.value).toBe("DONE");
  });

  it("counts a type: filter as a structured filter", () => {
    const parsed = parseSearchQuery("type:loop", NOW);
    expect(hasStructuredFilters(parsed.filters)).toBe(true);
  });
});

describe("SEARCH_FILTER_KEYS suggestion metadata", () => {
  it("exposes owner + type + the four :key filters", () => {
    const keys = SEARCH_FILTER_KEYS.map((k) => k.key);
    expect(keys).toContain("owner");
    expect(keys).toContain(SearchFilterKey.Type);
    expect(keys).toContain(SearchFilterKey.Status);
    expect(keys).toContain(SearchFilterKey.Priority);
    expect(keys).toContain(SearchFilterKey.Project);
    expect(keys).toContain(SearchFilterKey.Updated);
  });

  it("marks type as a static value source of the queryable entity kinds", () => {
    const type = SEARCH_FILTER_KEYS.find((k) => k.key === SearchFilterKey.Type);
    expect(type?.valueSource).toBe(SearchSuggestionSource.Static);
    expect(type?.staticValues).toContain(SearchEntityType.AgentSession);
    expect(type?.staticValues).toContain(SearchEntityType.Document);
    expect(type?.operators).toEqual([SearchFilterOperator.Eq]);
  });

  it("marks status/priority as static value sources", () => {
    const status = SEARCH_FILTER_KEYS.find(
      (k) => k.key === SearchFilterKey.Status
    );
    expect(status?.valueSource).toBe(SearchSuggestionSource.Static);
    expect(status?.staticValues).toContain("TODO");
  });

  it("marks owner/project as dynamic and names their endpoints", () => {
    const owner = SEARCH_FILTER_KEYS.find((k) => k.key === "owner");
    const project = SEARCH_FILTER_KEYS.find(
      (k) => k.key === SearchFilterKey.Project
    );
    expect(owner?.valueSource).toBe(SearchSuggestionSource.Dynamic);
    expect(owner?.dynamicEndpoint).toBeTruthy();
    expect(project?.valueSource).toBe(SearchSuggestionSource.Dynamic);
    expect(project?.dynamicEndpoint).toBeTruthy();
  });
});
