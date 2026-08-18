/**
 * Drift guard (ISS-6042) for the agent-session vocabularies in the REST reference.
 *
 * `apps/web/content/docs/api-reference/openapi.json` hand-copies four enums that
 * have canonical SSOTs in `@repo/api`: the viewer scope, the session-quality
 * segment, transcript availability, and the usage comparison opt-in. ISS-6042
 * added three endpoints (`/agent-sessions/{id}`, `/usage`, `/analytics`) that
 * restate the first and third of those, so a value added to a SSOT now has four
 * documented surfaces to drift away from instead of one. Lint and typecheck only
 * prove the spec parses; nothing else compares the copies against the source.
 *
 * This mirrors the ISS-4616 status-vocabulary guard next door: parse openapi.json
 * as data (an allowed config/data comparison, not a raw-source scan) and assert
 * each documented enum matches its SSOT.
 *
 * The `status` filter is the fifth vocabulary and the only one the spec spells
 * out in PROSE rather than in an `enum`, because its schema deliberately stays
 * an open string: the route validator is `optionalNonEmptyStringSchema` and a
 * version-skewed client's spelling still has to reach the server, so an `enum`
 * would publish a contract narrower than the one the route honours and reject
 * those calls at the client. That makes the description the only place the six
 * filterable values reach a spec reader, and prose is what nothing else compares
 * to a SSOT — so {@link advertisedStatusVocabulary} scans the advertised
 * sentence the way the MCP-side guard in
 * `apps/mcp/src/__tests__/agent-session-read.test.ts` scans the tool
 * description, paired with a schema assertion so nobody closes the drift gap by
 * narrowing the wire contract instead.
 *
 * Sets, not sequences: `viewerScope` is already documented in two different
 * orders in this file (the shared query parameter lists `self` first, the
 * response schemas list `organization` first) and OpenAPI attaches no meaning to
 * enum order. Asserting sorted values catches every add/remove/rename — the
 * drift that matters — without failing on a cosmetic reordering.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SESSION_QUALITY_VALUES,
  SESSION_STATUS_FILTER_VALUES,
} from "@repo/api/src/agent-session-filters";
import { AGENT_SESSION_VIEWER_SCOPE_OPTIONS } from "@repo/api/src/types/agent-session";
import { AGENT_SESSION_COMPARISON_MODES } from "@repo/api/src/types/agent-session-usage-comparison";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type EnumSurface = { enum?: string[]; type?: string; items?: EnumSurface };
type ParameterEntry = { $ref?: string; name?: string; schema?: EnumSurface };
type OpenApiDoc = {
  paths: Record<string, Record<string, { parameters?: ParameterEntry[] }>>;
  components: {
    parameters: Record<
      string,
      { name?: string; description?: string; schema?: EnumSurface }
    >;
    schemas: Record<
      string,
      { properties?: Record<string, EnumSurface & { items?: EnumSurface }> }
    >;
  };
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Every place the spec restates the viewer-scope vocabulary. */
function viewerScopeSurfaces(): (EnumSurface | undefined)[] {
  return [
    openApi.components.parameters.AgentSessionViewerScope.schema,
    openApi.components.schemas.AgentSessionListResponse.properties?.viewerScope,
    openApi.components.schemas.AgentSessionUsageSummary.properties?.viewerScope,
    openApi.components.schemas.AgentSessionAnalytics.properties?.viewerScope,
  ];
}

describe("openapi.json agent-session vocabulary contract (ISS-6042)", () => {
  it("documents the exact viewer-scope vocabulary from the SSOT everywhere it appears", () => {
    const expected = sorted(AGENT_SESSION_VIEWER_SCOPE_OPTIONS);
    const surfaces = viewerScopeSurfaces();

    // A surface that lost its enum (or was renamed away) must fail here rather
    // than vacuously pass an `undefined === undefined` comparison.
    expect(surfaces.filter((surface) => surface?.enum)).toHaveLength(
      surfaces.length
    );
    for (const surface of surfaces) {
      expect(sorted(surface?.enum ?? [])).toEqual(expected);
    }
  });

  it("documents the exact session-quality vocabulary from the SSOT", () => {
    expect(
      sorted(
        openApi.components.parameters.AgentSessionQuality.schema?.enum ?? []
      )
    ).toEqual(sorted(SESSION_QUALITY_VALUES));
  });

  it("documents the exact transcript-availability vocabulary from the SSOT", () => {
    expect(
      sorted(
        openApi.components.schemas.AgentSessionTranscriptAvailability.properties
          ?.availability.enum ?? []
      )
    ).toEqual(sorted(Object.values(TranscriptAvailability)));
  });

  it("advertises the exact session-status filter vocabulary from the SSOT", () => {
    const advertised = advertisedStatusVocabulary();

    // A prose rewrite that drops the sentence must fail here rather than pass
    // vacuously on an empty-vs-empty comparison.
    expect(advertised).not.toHaveLength(0);
    // Sorted SEQUENCES, not sets, and that is what keeps the slice safe
    // (ISS-6469). `ADVERTISED_STATUS_VOCABULARY_SENTENCE` is terminated only by
    // an em dash the prose supplies, so a rewrite that drops it leaves `[^—]+`
    // running to the end of the description and the scan widens to every
    // backticked identifier after the list — 17 of them once the read-back
    // paragraph names the legacy spellings. A Set comparison would swallow the
    // ones that merely repeat an advertised value; comparing arrays counts them,
    // so a widened window reds on length rather than passing on a matching set.
    expect(sorted(advertised)).toEqual(sorted(SESSION_STATUS_FILTER_VALUES));
  });

  it("keeps both status filter schemas open strings rather than closed enums", () => {
    // wongk, #5085: the response `status` is a read-time projection that can
    // exceed this vocabulary, and a version-skewed client still sends the
    // retired spellings — so the vocabulary is ADVERTISED in prose while the
    // request schemas stay open. Pinning an enum onto either would generate
    // clients that reject a value the server folds and answers.
    const single = openApi.components.parameters.AgentSessionStatus.schema;
    const multi = openApi.components.parameters.AgentSessionStatuses.schema;

    expect({ type: single?.type, enum: single?.enum }).toEqual({
      type: "string",
      enum: undefined,
    });
    expect({
      type: multi?.type,
      itemType: multi?.items?.type,
      itemEnum: multi?.items?.enum,
    }).toEqual({ type: "array", itemType: "string", itemEnum: undefined });
  });

  it("documents the exact usage-comparison opt-in from the SSOT", () => {
    const comparison = queryParameterSchema(
      "/agent-sessions/usage",
      "comparison"
    );

    // A parameter that was renamed away, or moved to `components/parameters`
    // without its enum, must fail here rather than pass vacuously through the
    // `?? []` fallback below.
    expect(comparison?.enum).toBeDefined();
    expect(sorted(comparison?.enum ?? [])).toEqual(
      sorted(AGENT_SESSION_COMPARISON_MODES)
    );
  });
});

/**
 * The schema of the query parameter `name` on `path`'s GET, declared either
 * inline or as a `$ref` into `components/parameters`.
 *
 * Resolving the ref is the point (thread thadeusb). `comparison` is the only
 * inline parameter on this path today, so a bare `find` on `parameter.name`
 * works — but `$ref` entries carry no `name`, so moving `comparison` into the
 * shared component block alongside its nine siblings would take this lookup out
 * of service. Following the ref keeps the assertion pointed at the same
 * vocabulary through that move instead of merely failing loudly after it.
 */
function queryParameterSchema(
  path: string,
  name: string
): EnumSurface | undefined {
  for (const parameter of openApi.paths[path].get.parameters ?? []) {
    if (parameter.name === name) {
      return parameter.schema;
    }
    const refName = parameter.$ref?.split("/").at(-1);
    const referenced = refName
      ? openApi.components.parameters[refName]
      : undefined;
    if (referenced?.name === name) {
      return referenced.schema;
    }
  }
  return undefined;
}

/**
 * The vocabulary sentence in the `status` parameter's description, up to the em
 * dash that ends the list. Scoped rather than read over the whole description
 * on purpose: the sentence AFTER it names the retired `completed`/`abandoned`
 * spellings, which are accepted but are deliberately NOT part of the advertised
 * vocabulary, so a whole-description sweep would assert the wrong set.
 */
const ADVERTISED_STATUS_VOCABULARY_SENTENCE =
  /canonical filter vocabulary this parameter advertises is ([^—]+)/;

/** Each backticked value inside that sentence. */
const BACKTICKED_VALUE = /`([^`]+)`/g;

/**
 * The status values `components/parameters/AgentSessionStatus` advertises in
 * prose (ISS-6470, thread wongk).
 *
 * The spec cannot express this as an `enum` — the request schema stays an open
 * string so a version-skewed client's retired spelling still reaches the
 * `inactive` predicate — so the vocabulary is published as prose instead, which
 * puts it back in reach of the same drift this file guards everywhere else.
 */
function advertisedStatusVocabulary(): string[] {
  const description =
    openApi.components.parameters.AgentSessionStatus.description ?? "";
  const sentence = ADVERTISED_STATUS_VOCABULARY_SENTENCE.exec(description)?.[1];
  return [...(sentence ?? "").matchAll(BACKTICKED_VALUE)].map(
    (match) => match[1]
  );
}
