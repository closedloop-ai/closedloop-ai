import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import { describe, expect, it } from "vitest";
import {
  adaptAgentComponentDetailToResponse,
  adaptAgentComponentToResponse,
  createHttpAgentComponentsDataSource,
} from "../agent-components-data-source";

// The canonical detail shape used by the detail tests. `makeComponent` supplies
// the shared `AgentComponent` fields; the cohort-delivery + detail-only fields
// are layered on top. Callers override the two skew-sensitive fields
// (`locPerDollar` / `locDelta`) to exercise the version-skew fallback.
function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    ...makeComponent(),
    properties: { path: "/agents/my-agent.md", format: "md" },
    prompt: "You are a helpful agent.",
    versions: [],
    resolvedState: "unresolved",
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    locDelta: null,
    successRate: null,
    successDelta: null,
    tokenEfficiencyDelta: null,
    efficiencyTrend: [],
    mergedPrs: null,
    qualityScore: null,
    qualityDelta: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-1234-5678-abcd-efgh",
    slug: overrides.slug ?? "subagent::test-subagent",
    name: "Test Subagent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    locPerDollar: 3.14,
    trend: [1, 2, 3],
    collaborators: ["alice", "bob", "carol"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeListResponse(
  items: AgentComponent[] = []
): AgentComponentListResponse {
  return { items, total: items.length, hasMore: false };
}

// ---------------------------------------------------------------------------
// Recording HTTP client
// ---------------------------------------------------------------------------

function createRecordingGet(
  requestedPaths: string[],
  respond: (path: string) => unknown = () => makeListResponse()
) {
  return function get<T>(path: string): Promise<T> {
    requestedPaths.push(path);
    return Promise.resolve(respond(path) as T);
  };
}

// ---------------------------------------------------------------------------
// T-10.4: Real HTTP data source tests
// ---------------------------------------------------------------------------

describe("createHttpAgentComponentsDataSource", () => {
  it("calls GET /agent-components (not /agents) for list with no filters", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({});

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/agent-components");
    expect(paths[0]).not.toContain("/agents");
  });

  it("serialises kinds as repeated query params in the list URL", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({
      kinds: [AgentComponentKind.Skill, AgentComponentKind.Command],
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("kinds=skill");
    expect(paths[0]).toContain("kinds=command");
  });

  it("omits the query string when no filters are provided", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.list({});

    // No '?' in the URL when filters are empty
    expect(paths[0]).not.toContain("?");
  });

  it("calls GET /agent-components/:slug for detail with a UUID slug", async () => {
    const slug = "550e8400-e29b-41d4-a716-446655440000";
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => ({
        ...makeComponent({ id: slug }),
        properties: {
          path: "/path/to/agent.md",
          format: "md",
        },
        prompt: "You are an expert…",
        versions: [],
        sessionsTab: [],
        sessionsTabTruncated: false,
        branchesTab: [],
        branchesTabTruncated: false,
        provenance: [],
        usageSessions: [],
      })),
    });

    await source.detail(slug);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(`/agent-components/${slug}`);
  });

  it("encodes a slug containing a slash into a single path segment for detail", async () => {
    // Org-identity slugs are `${kind}::${key}`, and skills key on a leading
    // slash (`skill::/name`). An unencoded slash would split into extra path
    // segments and miss the single-segment `[slug]` detail route (a 404 even
    // though the row was in the list). The API route `decodeURIComponent`s the
    // param back before the org lookup.
    const slug = "skill::/name";
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths),
    });

    await source.detail(slug);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/agent-components/skill%3A%3A%2Fname");
    expect(decodeURIComponent(paths[0].replace("/agent-components/", ""))).toBe(
      slug
    );
  });

  it("scope is 'agent-components:http'", () => {
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([]),
    });
    expect(source.scope).toBe("agent-components:http");
  });

  it("has no subscribe method (HTTP is poll-only)", () => {
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([]),
    });
    expect(source.subscribe).toBeUndefined();
  });
});

describe("adaptAgentComponentToResponse", () => {
  it("produces an AgentComponent with all required fields (no undefined)", () => {
    const raw = makeComponent();
    const adapted = adaptAgentComponentToResponse(raw);

    // All fields present and not undefined
    expect(adapted.id).toBe(raw.id);
    expect(adapted.name).toBe(raw.name);
    expect(adapted.kind).toBe(raw.kind);
    expect(adapted.sourceType).toBe(raw.sourceType);
    expect(adapted.source).toBe(raw.source);
    expect(adapted.harness).toBe(raw.harness);
    expect(adapted.invocations).toBe(raw.invocations);
    expect(adapted.sessions).toBe(raw.sessions);
    expect(adapted.locPerDollar).toBe(raw.locPerDollar);
    expect(adapted.trend).toEqual(raw.trend);
    expect(adapted.collaborators).toEqual(raw.collaborators);
    expect(adapted.computeTargetIds).toEqual(raw.computeTargetIds);
    expect(adapted.firstSeenAt).toBe(raw.firstSeenAt);
    expect(adapted.lastSeenAt).toBe(raw.lastSeenAt);
  });

  it("copies lastInvokedAt through when present (recently-active signal)", () => {
    const lastInvokedAt = "2026-06-15T12:00:00.000Z";
    const raw = makeComponent({ lastInvokedAt });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.lastInvokedAt).toBe(lastInvokedAt);
  });

  it("omits lastInvokedAt when the raw row has none (never invoked)", () => {
    const raw = makeComponent();
    // The default fixture has no lastInvokedAt.
    expect(raw.lastInvokedAt).toBeUndefined();
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.lastInvokedAt).toBeUndefined();
    expect("lastInvokedAt" in adapted).toBe(false);
  });

  it("copies versionCount through when present (collapsed multi-version family)", () => {
    const raw = makeComponent({ versionCount: 5 });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.versionCount).toBe(5);
  });

  it("omits versionCount when the raw row has none (single-version component)", () => {
    const raw = makeComponent();
    expect(raw.versionCount).toBeUndefined();
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.versionCount).toBeUndefined();
    expect("versionCount" in adapted).toBe(false);
  });

  it("copies honestSource through the field-by-field list adapter (ISS-5009)", () => {
    // This adapter names every field it keeps and silently drops the rest, so
    // an additive DTO field that is not listed never reaches the flag-gated
    // Source cell — the whole feature would render its legacy fallback with no
    // error anywhere. Assert the passthrough on the LIST adapter specifically;
    // the detail adapter spreads `...raw` and gets it for free.
    const honestSource = {
      hasProvenance: true,
      source: ComponentScope.User,
      sourceType: SourceType.Local,
    } as const;
    const raw = makeComponent({ honestSource });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.honestSource).toEqual(honestSource);
  });

  it("omits honestSource when the raw row has none (server predates ISS-5009)", () => {
    const raw = makeComponent();
    expect(raw.honestSource).toBeUndefined();
    const adapted = adaptAgentComponentToResponse(raw);
    // Omission-preserving, not `honestSource: undefined`: absence is the
    // contract's "assume `source` is meaningful", and a present-but-undefined
    // key blurs that for anything probing with `in`.
    expect("honestSource" in adapted).toBe(false);
  });

  it("id is the DB UUID (not a colon-slug)", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const raw = makeComponent({ id: uuid });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.id).toBe(uuid);
    expect(adapted.id).not.toContain(":");
  });

  it("preserves an empty collaborators (authors) set", () => {
    const raw = makeComponent({ collaborators: [] });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.collaborators).toEqual([]);
  });

  it("preserves null invocations and sessions for configured-only kinds", () => {
    const raw = makeComponent({
      kind: AgentComponentKind.Hook,
      invocations: null,
      sessions: null,
      locPerDollar: null,
    });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.invocations).toBeNull();
    expect(adapted.sessions).toBeNull();
    expect(adapted.locPerDollar).toBeNull();
  });

  it("list() maps all items through adaptAgentComponentToResponse", async () => {
    const component1 = makeComponent({ id: "uuid-001", name: "Agent One" });
    const component2 = makeComponent({
      id: "uuid-002",
      name: "Agent Two",
      kind: AgentComponentKind.Command,
    });
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () =>
        makeListResponse([component1, component2])
      ),
    });

    const result = await source.list({});

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe("uuid-001");
    expect(result.items[1].id).toBe("uuid-002");
    expect(result.total).toBe(2);
  });
});

describe("createHttpAgentComponentsDataSource detail call", () => {
  it("calls GET /agent-components/:slug with a UUID slug", async () => {
    const slug = "550e8400-e29b-41d4-a716-446655440000";
    const paths: string[] = [];
    const detail = makeDetail({ id: slug });
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => detail),
    });

    const result = await source.detail(slug);

    expect(paths[0]).toBe(`/agent-components/${slug}`);
    expect(result.id).toBe(slug);
  });

  it("normalizes a version-skewed LEGACY-only detail payload (old server) through detail()", async () => {
    // ISS-4667 (wongk): the server predates the rename — it OMITS the canonical
    // `locPerDollar`/`locDelta` and sends the KLOC-unit legacy fields instead.
    // `detail()` must normalize like `list()` does, or a current client opening
    // the row silently loses LOC/$ and its delta. This drives the production
    // `detail()` path (not the adapter directly) so the wiring is proven.
    const slug = "subagent::legacy-agent";
    const legacyOnly = makeDetail({
      slug,
      // Omit the canonical fields entirely (undefined), not null: a `null` is the
      // producer's honest "unavailable" and would NOT fall back.
      locPerDollar: undefined,
      locDelta: undefined,
      // 0.002 KLOC/$ === 2 LOC/$; unit-free legacy delta carries the same number.
      klocPerDollar: 0.002,
      klocDelta: 12,
    });
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([], () => legacyOnly),
    });

    const result = await source.detail(slug);

    expect(result.locPerDollar).toBeCloseTo(2, 10);
    expect(result.locDelta).toBe(12);
  });
});

describe("adaptAgentComponentDetailToResponse (ISS-4667 version skew)", () => {
  it("returns a present canonical locPerDollar/locDelta verbatim", () => {
    const raw = makeDetail({ locPerDollar: 3.14, locDelta: 25 });
    const adapted = adaptAgentComponentDetailToResponse(raw);
    expect(adapted.locPerDollar).toBe(3.14);
    expect(adapted.locDelta).toBe(25);
  });

  it("scales a legacy-only thousand-line payload into canonical LOC per dollar and falls back the delta", () => {
    const raw = makeDetail({
      locPerDollar: undefined,
      locDelta: undefined,
      klocPerDollar: 0.000_875,
      klocDelta: -8,
    });
    const adapted = adaptAgentComponentDetailToResponse(raw);
    expect(adapted.locPerDollar).toBeCloseTo(0.875, 10);
    expect(adapted.locDelta).toBe(-8);
  });

  it("preserves an explicit canonical null (producer's honest unavailable), never reviving legacy", () => {
    const raw = makeDetail({
      locPerDollar: null,
      locDelta: null,
      klocPerDollar: 5,
      klocDelta: 99,
    });
    const adapted = adaptAgentComponentDetailToResponse(raw);
    expect(adapted.locPerDollar).toBeNull();
    expect(adapted.locDelta).toBeNull();
  });

  /**
   * wongk (PR #4322) — ISS-4798 version skew. A server predating the cohort
   * rollup OMITS `mergedPrs`. The adapter spread the payload unchanged, and the
   * card's formatter only recognized `null`, so `undefined` reached
   * `Intl.NumberFormat.format` and rendered "NaN" on web and desktop cloud mode.
   */
  it("normalizes an omitted mergedPrs to the contract's null", () => {
    const raw = makeDetail({});
    Reflect.deleteProperty(raw, "mergedPrs");

    expect(adaptAgentComponentDetailToResponse(raw).mergedPrs).toBeNull();
  });

  it("passes a present mergedPrs through untouched, including a real zero", () => {
    expect(
      adaptAgentComponentDetailToResponse(makeDetail({ mergedPrs: 42 }))
        .mergedPrs
    ).toBe(42);
    expect(
      adaptAgentComponentDetailToResponse(makeDetail({ mergedPrs: 0 }))
        .mergedPrs
    ).toBe(0);
  });

  /**
   * codex review (#4962) — ISS-5521 version skew, and the MIRROR IMAGE of the
   * `mergedPrs` case above.
   *
   * There, omission has a declared meaning on the contract ("not computable")
   * and normalizing to `null` is what stops a lie. Here it does the opposite: an
   * older server applied the same `COHORT_SCAN_CAP` and simply cannot report it,
   * so folding the omission to `false` hands the card the "counted over every
   * session" copy for precisely the response that has the weakest claim to it.
   * The adapter must let the omission survive so the render can treat it as a
   * third state.
   */
  it("preserves an omitted mergedPrsTruncated as unknown rather than folding it to false", () => {
    const raw = makeDetail({ mergedPrs: 996 });
    Reflect.deleteProperty(raw, "mergedPrsTruncated");

    const adapted = adaptAgentComponentDetailToResponse(raw);

    expect(adapted.mergedPrsTruncated).toBeUndefined();
    // Guards the specific regression: `?? false` also satisfies "not true", so
    // asserting undefined-ness is the only assertion the old coercion fails.
    expect(adapted.mergedPrsTruncated).not.toBe(false);
  });

  it("passes a declared mergedPrsTruncated through in both directions", () => {
    expect(
      adaptAgentComponentDetailToResponse(
        makeDetail({ mergedPrsTruncated: true })
      ).mergedPrsTruncated
    ).toBe(true);
    expect(
      adaptAgentComponentDetailToResponse(
        makeDetail({ mergedPrsTruncated: false })
      ).mergedPrsTruncated
    ).toBe(false);
  });
});
