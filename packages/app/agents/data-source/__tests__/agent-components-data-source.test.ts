import {
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { InvocationLocPerDollarUncoveredOperand } from "@repo/api/src/types/agent-component-invocation-lines";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { sumDedupedInvocations } from "@repo/api/src/utils/agent-component-summary-aggregate";
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

  it("carries packIds through (ISS-5534 parent-pack identity)", () => {
    const packIds = ["acme-review-toolkit"];
    const adapted = adaptAgentComponentToResponse(makeComponent({ packIds }));
    expect(adapted.packIds).toEqual(packIds);
  });

  it("keeps an empty packIds distinct from an omitted one", () => {
    // `[]` is "belongs to no pack" — a real answer. Only OMISSION means the
    // producer could not report parentage, so the two must not collapse.
    const adapted = adaptAgentComponentToResponse(
      makeComponent({ packIds: [] })
    );
    expect(adapted.packIds).toEqual([]);
    expect("packIds" in adapted).toBe(true);
  });

  it("omits packIds when the raw row has none (version-skewed producer)", () => {
    const raw = makeComponent();
    expect(raw.packIds).toBeUndefined();
    const adapted = adaptAgentComponentToResponse(raw);
    expect("packIds" in adapted).toBe(false);
  });

  /**
   * ISS-6205: the seam that actually broke. This builder names every field it
   * keeps and silently drops the rest, so a dropped `packIds` did not surface as
   * a missing field — it surfaced two modules away, as the invocations reduction
   * reading every CURRENT-producer plugin as unreportable, dropping its rollup,
   * and publishing the "some calls may be missing" disclosure on views that had
   * nothing missing at all. Asserting the adapted row's fields alone would not
   * have caught the consequence, so the reduction is run over the adapter's own
   * output here.
   */
  it("keeps the deduped invocations total EXACT through the adapter", () => {
    const packIds = ["acme-review-toolkit"];
    const rows = [
      makeComponent({
        invocations: 50,
        kind: AgentComponentKind.Plugin,
        packIds,
        slug: "plugin::acme-review-toolkit",
      }),
      makeComponent({
        invocations: 30,
        kind: AgentComponentKind.Skill,
        packIds,
        slug: "skill::acme-review-skill",
      }),
    ].map(adaptAgentComponentToResponse);

    const total = sumDedupedInvocations(rows);

    // The plugin's rollup IS the skill's 30, and the adapter preserved the
    // parentage that proves it — so the rollup is dropped as already
    // represented, and the total keeps its exactness.
    expect(total.invocations).toBe(30);
    expect(total.exact).toBe(true);
  });

  it("carries versionId and fingerprint through (FEA-3982 exact-version identity)", () => {
    const versionId = "a1b2c3d4e5f67890abcdef1234567890";
    const fingerprint = "a1b2c3d4";
    const adapted = adaptAgentComponentToResponse(
      makeComponent({ fingerprint, versionId })
    );
    expect(adapted.versionId).toBe(versionId);
    expect(adapted.fingerprint).toBe(fingerprint);
  });

  it("omits versionId and fingerprint when the raw row has none (unversioned / name-only)", () => {
    const raw = makeComponent();
    expect(raw.versionId).toBeUndefined();
    expect(raw.fingerprint).toBeUndefined();
    const adapted = adaptAgentComponentToResponse(raw);
    expect("versionId" in adapted).toBe(false);
    expect("fingerprint" in adapted).toBe(false);
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
    const raw = makeComponent({ honestSource: HONEST_SOURCE_FIXTURE });
    const adapted = adaptAgentComponentToResponse(raw);
    expect(adapted.honestSource).toEqual(HONEST_SOURCE_FIXTURE);
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

  it("drops an honestSource whose sourceType this client's enum does not know", () => {
    // A newer producer can name a source type this build has never heard of.
    // Dropping the projection sends the flag-gated Source cell back to its
    // legacy echo; carrying the unknown token through would put a value on
    // screen that nothing here can map to a label.
    const raw = makeComponent({ honestSource: SKEWED_HONEST_SOURCE_FIXTURE });
    const adapted = adaptAgentComponentToResponse(raw);
    // Absent, not present-but-undefined: spreading the narrower's `undefined`
    // would leave the very key state the sibling omission case forbids, and a
    // `toBeUndefined()` alone reads the same on both.
    expect("honestSource" in adapted).toBe(false);
    expect(adapted.honestSource).toBeUndefined();
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
    // Both rows are SKEW-shaped — a producer that predates the authors axis
    // sends only the deprecated single-`owner` alias — because a row the
    // adapter would leave untouched cannot tell a mapped list from an
    // unmapped one: `id` and `total` ride through either way.
    const component1 = makeComponent({
      id: "uuid-001",
      name: "Agent One",
      collaborators: [],
      owner: "Ada",
    });
    const component2 = makeComponent({
      id: "uuid-002",
      name: "Agent Two",
      kind: AgentComponentKind.Command,
      collaborators: [],
      owner: "Grace",
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
    expect(result.items[0].collaborators).toEqual(["Ada"]);
    expect(result.items[1].collaborators).toEqual(["Grace"]);
    expect(result.total).toBe(2);
  });
});

describe("createHttpAgentComponentsDataSource detail call", () => {
  it("keeps an older invocation envelope's omitted cursor and additive row fields", async () => {
    const paths: string[] = [];
    const page = {
      items: [{ id: "invocation-a", futureField: true }],
      total: 2,
      hasMore: true,
      unmatchedCount: 0,
      ambiguousCount: 0,
    };
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => page),
    });
    expect(await source.invocationPage?.("skill::/review", "cursor")).toEqual(
      page
    );
    expect(paths).toEqual([
      "/agent-components/skill%3A%3A%2Freview/invocations?cursor=cursor",
    ]);
  });
  it("reads escaped continuation URLs and retains additive session page fields", async () => {
    const paths: string[] = [];
    const page = {
      items: [{ id: "session-a", futureField: true }],
      total: 51,
      nextCursor: null,
    };
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => page),
    });
    expect(await source.sessionPage?.("skill::/review", "opaque+/=")).toEqual(
      page
    );
    expect(paths).toEqual([
      "/agent-components/skill%3A%3A%2Freview/sessions?cursor=opaque%2B%2F%3D",
    ]);
  });

  it("rejects malformed continuation bodies instead of caching invented empty pages", async () => {
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet([], () => ({
        items: [],
        total: -1,
        nextCursor: null,
      })),
    });
    await expect(source.sessionPage?.("component", "cursor")).rejects.toThrow();
    await expect(
      source.invocationPage?.("component", "cursor")
    ).rejects.toThrow();
  });

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
    // ISS-4667 (whitlockk): the server predates the rename — it OMITS the canonical
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
   * whitlockk (PR #4322) — ISS-4798 version skew. A server predating the cohort
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
   * older server applied the same cohort scan cap and simply cannot report it,
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

/** ISS-5009 honest-Source projection, shared by the passthrough tests above. */
const HONEST_SOURCE_FIXTURE = {
  hasProvenance: true,
  source: ComponentScope.User,
  sourceType: SourceType.Local,
} as const;

// The same projection carrying a source type this client's enum does not know —
// what a newer producer sends. The wire is not constrained by the local type, so
// the value widens through `string` to reach the runtime guard the annotation
// would otherwise make unreachable.
const UNKNOWN_WIRE_SOURCE_TYPE: string = "quantum-repo";
const SKEWED_HONEST_SOURCE_FIXTURE = {
  ...HONEST_SOURCE_FIXTURE,
  sourceType: UNKNOWN_WIRE_SOURCE_TYPE as SourceType,
};

// ---------------------------------------------------------------------------
// ISS-6771: the additive-field guard for the list adapter
// ---------------------------------------------------------------------------

/** The keys `AgentComponent` declares optional — the ones a builder can drop. */
type OptionalAgentComponentKey = {
  [K in keyof AgentComponent]-?: undefined extends AgentComponent[K]
    ? K
    : never;
}[keyof AgentComponent];

/**
 * The two optional keys the adapter deliberately does NOT copy: deprecated
 * compat aliases it FOLDS into a canonical field instead — the legacy KLOC-unit
 * ratio into `locPerDollar` via `resolveLocPerDollar`, and `owner` into
 * `collaborators` via `resolveComponentAuthors`. Both folds are already covered
 * by the version-skew tests above. Named here only to exclude them from the
 * exhaustiveness check below, never read as a metric.
 *
 * This union is the one escape from that check, so treat it as closed: a NEW
 * field belongs here only if the adapter provably routes its value to a
 * canonical field, and that fold needs its own test. Adding a key here to clear
 * a `tsc` error is how the field ends up silently dropped anyway — the exact
 * ISS-5534/ISS-6205 failure this guard exists to stop.
 */
type FoldedOptionalKey = "klocPerDollar" | "owner";

/**
 * The optional fields `adaptAgentComponentToResponse` must carry through
 * verbatim.
 *
 * The adapter names each field it keeps and silently drops the rest, so an
 * unlisted additive field surfaces as a wrong render two modules away rather
 * than as an error at the seam — that is how `packIds` reached the invocations
 * reduction undefined (ISS-5534/ISS-6205), and how FEA-3982's
 * `versionId`/`fingerprint` never reached an HTTP row at all.
 *
 * The `Record<…>` is what makes this a guard rather than a list: it admits
 * EXACTLY the DTO's optional keys minus the folded pair, so a new additive
 * optional field fails `tsc` here until it is either carried or classified as a
 * fold. The tests below then force it to be exercised and proved.
 */
const CARRIED_OPTIONAL_KEY_SET: Record<
  Exclude<OptionalAgentComponentKey, FoldedOptionalKey>,
  true
> = {
  fingerprint: true,
  honestSource: true,
  lastInvokedAt: true,
  locPerDollarUncoveredOperand: true,
  packIds: true,
  versionCount: true,
  versionId: true,
};

describe("adaptAgentComponentToResponse optional-field coverage", () => {
  // Two rows, because the contract makes `versionCount` and
  // `versionId`/`fingerprint` mutually exclusive: a collapsed family badges a
  // version count, a single-version row badges a fingerprint. Populating both on
  // one row would pin a shape no producer emits.
  const singleVersionRow = makeComponent({
    fingerprint: "a1b2c3d4",
    honestSource: HONEST_SOURCE_FIXTURE,
    lastInvokedAt: "2026-06-15T12:00:00.000Z",
    packIds: ["acme-review-toolkit"],
    versionId: "a1b2c3d4e5f67890abcdef1234567890",
  });
  // ISS-10730: a suppressed LOC/$ row. The reason rides a NULL ratio (the
  // producer's own rule), so it belongs on the row that has no number rather
  // than on the single-version fixture above.
  const collapsedFamilyRow = makeComponent({
    versionCount: 5,
    locPerDollar: null,
    locPerDollarUncoveredOperand: InvocationLocPerDollarUncoveredOperand.Lines,
  });

  it("exercises every carried optional field with a fixture", () => {
    // Closes the loop on the type-level guard: `tsc` forces a new optional field
    // INTO the set, and this forces a fixture row to actually populate it, so
    // the passthrough test below cannot pass it over in silence.
    const populated = new Set([
      ...Object.keys(singleVersionRow),
      ...Object.keys(collapsedFamilyRow),
    ]);
    for (const key of Object.keys(CARRIED_OPTIONAL_KEY_SET)) {
      expect(populated.has(key), `no fixture populates ${key}`).toBe(true);
    }
  });

  it("carries every field it is handed through with its value intact", () => {
    // Whole-row, so it covers the required fields too and cannot be satisfied by
    // a present-but-undefined key the way an `in` probe can. Neither fixture
    // carries a folded alias, so every key here is one the adapter must keep.
    for (const raw of [singleVersionRow, collapsedFamilyRow]) {
      const adapted = adaptAgentComponentToResponse(raw);
      for (const [key, value] of Object.entries(raw)) {
        expect(adapted).toHaveProperty(key, value);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ISS-6822: the bounded page-data read
// ---------------------------------------------------------------------------

const PAGE_DATA_REQUEST: AgentComponentPageDataRequest = {
  filters: {
    kinds: [AgentComponentKind.Skill, AgentComponentKind.Command],
    collaborators: ["Ada", "Grace"],
    sources: ["repo-a"],
    harnesses: [Harness.Codex],
    search: "orchestrator",
  },
  sortBy: AgentComponentSortKey.Invocations,
  sortDir: AgentComponentSortDir.Desc,
  page: 2,
  pageSize: 50,
  honestSource: true,
  dedupePluginRollups: false,
};

function makePageDataResponse(
  items: AgentComponent[],
  envelope: Partial<AgentComponentPageDataResult> = {}
): AgentComponentPageDataResult {
  return {
    items,
    filteredTotal: items.length,
    totalPages: 1,
    page: 0,
    facets: { collaborators: [], sources: [], harnesses: [] },
    current: {
      components: items.length,
      invocations: 0,
      locPerDollar: null,
      locPerDollarSampleSize: 0,
      collaborators: 0,
      hasVerifiableLocPerDollar: false,
      invocationsExact: true,
      invocationsPluginCoverage: [],
    },
    ...envelope,
  };
}

describe("createHttpAgentComponentsDataSource page-data call (ISS-6822)", () => {
  it("sends every facet as a repeated param and both gates as explicit booleans", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => makePageDataResponse([])),
    });

    await source.pageData?.(PAGE_DATA_REQUEST);

    const [path] = paths;
    expect(path).toContain("/agent-components/page-data?");
    // A multi-select collapsed to its last value would silently widen or narrow
    // the population the whole response describes.
    expect(path).toContain("kinds=skill");
    expect(path).toContain("kinds=command");
    expect(path).toContain("collaborators=Ada");
    expect(path).toContain("collaborators=Grace");
    expect(path).toContain("sources=repo-a");
    expect(path).toContain("harnesses=codex");
    expect(path).toContain("search=orchestrator");
    expect(path).toContain("sortBy=invocations");
    expect(path).toContain("sortDir=desc");
    expect(path).toContain("page=2");
    expect(path).toContain("pageSize=50");
    // The two gates that change the NUMBERS travel with the request, and a
    // disabled one is spelled out rather than dropped — the server enables only
    // on the literal "true", so an omission and a "false" agree.
    expect(path).toContain("honestSource=true");
    expect(path).toContain("dedupePluginRollups=false");
  });

  it("preserves the omission of an absent window instead of sending an empty bound", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => makePageDataResponse([])),
    });

    await source.pageData?.(PAGE_DATA_REQUEST);

    // No `startDate` is the all-time view and no prior pair means "no baseline";
    // sending either as an empty string would be a value the server must then
    // reject or, worse, parse.
    expect(paths[0]).not.toContain("startDate");
    expect(paths[0]).not.toContain("prevStart");
    expect(paths[0]).not.toContain("prevEnd");
  });

  it("sends the window bounds when they are present", async () => {
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => makePageDataResponse([])),
    });

    // Three DISTINCT days. A prior period that abuts the current window is the
    // real-world case, but sharing a value with `startDate` makes every bound
    // interchangeable: any one of them read from the wrong request field still
    // serialises the string this asserts.
    await source.pageData?.({
      ...PAGE_DATA_REQUEST,
      startDate: "2026-06-01T00:00:00.000Z",
      prevStart: "2026-04-02T00:00:00.000Z",
      prevEnd: "2026-05-03T00:00:00.000Z",
    });

    expect(paths[0]).toContain("startDate=2026-06-01");
    expect(paths[0]).toContain("prevStart=2026-04-02");
    expect(paths[0]).toContain("prevEnd=2026-05-03");
  });

  it("normalises page rows through the SAME skew adapter the list read uses", async () => {
    // A page row and a list row are the same wire shape, so they must be
    // normalized the same way. Here a producer that predates the authors axis
    // sends only the deprecated single-`owner` alias: the adapter derives
    // `collaborators` from it, and a page read that skipped the adapter would
    // leave the Authors column blank on the page while the list showed the name
    // — the same row, two different answers, depending on which read fetched it.
    const paths: string[] = [];
    const legacyRow = makeComponent({ collaborators: [], owner: "Ada" });
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () => makePageDataResponse([legacyRow])),
    });

    const result = await source.pageData?.(PAGE_DATA_REQUEST);

    expect(result?.items[0]?.collaborators).toEqual(["Ada"]);
    expect(result?.items[0]?.collaborators).toEqual(
      adaptAgentComponentToResponse(legacyRow).collaborators
    );
  });

  it("carries the whole page envelope through beside the adapted rows", async () => {
    // Everything OUTSIDE `items` is what makes the page readable: how many rows
    // the narrowing matched, how many pages that is, which one came back, and
    // the facet universe the filter menus are built from. A read that rebuilt
    // its result around `items` alone would leave every one of them undefined,
    // and the toolbar would render an empty filter set and a one-page pager
    // over real rows. The values are distinctive so no default can supply them.
    const facets = {
      collaborators: [{ id: "Ada", label: "Ada", count: 9 }],
      sources: [{ id: "repo-a", label: "repo-a", count: 4 }],
      harnesses: [{ id: Harness.Codex, label: "Codex", count: 2 }],
    };
    const paths: string[] = [];
    const source = createHttpAgentComponentsDataSource({
      get: createRecordingGet(paths, () =>
        makePageDataResponse([makeComponent()], {
          filteredTotal: 137,
          totalPages: 9,
          page: 4,
          facets,
        })
      ),
    });

    const result = await source.pageData?.(PAGE_DATA_REQUEST);

    expect(result?.filteredTotal).toBe(137);
    expect(result?.totalPages).toBe(9);
    expect(result?.page).toBe(4);
    expect(result?.facets).toEqual(facets);
  });
});
