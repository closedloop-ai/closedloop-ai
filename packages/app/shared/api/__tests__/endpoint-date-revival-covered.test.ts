import { describe, expect, it } from "vitest";
import { DATE_REVIVAL_KEYS } from "../date-revival-keys";
import {
  ENDPOINT_STRING_ONLY_DATE_KEYS,
  type EndpointStringOnlyDateKeys,
  stringOnlyDateKeysForPath,
} from "../endpoint-date-revival";
import { loadRepoSources } from "./date-revival-discovery";
import {
  deriveEndpointStringOnlyDateKeys,
  discoverEndpointDateKeyConflicts,
  discoverEndpointDateKeyProfiles,
  discoverServedRouteUrls,
} from "./endpoint-date-key-discovery";

/**
 * Endpoint-scoped guard for the API client's date revival (ISS-6208).
 *
 * `date-revival-keys-covered.test.ts` proves the KEY list matches the union of
 * every response contract. That union is a repo-wide answer to a per-endpoint
 * question, and it cannot see the collisions this file exists for: a key that is
 * a `Date` on one route's payload and a `string` on another's. The first use
 * legitimizes the key globally, so the string contracts were returned as `Date`s
 * — the exact shape of ISS-5771, surviving inside its own fix.
 *
 * So this re-derives, per served URL, the allowlisted keys that URL's own
 * payloads resolve ONLY to `string`, and asserts the shipped suppression table
 * matches. It also pins the endpoints that declare a key BOTH ways in one
 * response, which no key-only reviver can resolve, so a new one is a build
 * failure rather than a silent corruption.
 */

/**
 * Floors for the "guard the guard" assertions, deliberately far below today's
 * numbers: they catch a scan that collapsed to nothing, not a count that
 * legitimately moves.
 */
const MIN_ENDPOINT_PROFILES = 100;
/** An App Router dynamic segment in a route template. */
const DYNAMIC_TEMPLATE_SEGMENT = /^\[.*\]$/;
const MIN_SUPPRESSION_ENTRIES = 20;

/**
 * Endpoints that declare an allowlisted key as BOTH a `string` and a `Date`
 * within one response surface.
 *
 * These are NOT suppressed: the reviver sees one key name per body and cannot
 * separate the two uses, so dropping the key would break the `Date` half. They
 * are pinned here so the set can only change deliberately. Resolving one means
 * making that endpoint's payload spell the field one way — after which its entry
 * comes off this list and (if it is now string-only) appears in the suppression
 * table instead.
 */
const UNRESOLVABLE_ENDPOINT_COLLISIONS: readonly EndpointStringOnlyDateKeys[] =
  [
    {
      keys: ["lastActivityAt", "lastSeenAt", "startedAt", "updatedAt"],
      route: "/agent-components/[slug]",
    },
    {
      keys: ["awaitingInputSince", "endedAt", "startedAt", "updatedAt"],
      route: "/agent-sessions/[id]",
    },
    { keys: ["checkedAt"], route: "/compute-targets/[id]/health-check" },
    { keys: ["createdAt"], route: "/documents" },
  ];

describe("endpoint-scoped date revival (ISS-6208)", () => {
  const sources = loadRepoSources();
  const profiles = discoverEndpointDateKeyProfiles(sources);
  const servedRoutes = discoverServedRouteUrls(sources);

  it("reaches a non-trivial endpoint surface", () => {
    expect(profiles.length).toBeGreaterThan(MIN_ENDPOINT_PROFILES);
    expect(ENDPOINT_STRING_ONLY_DATE_KEYS.length).toBeGreaterThan(
      MIN_SUPPRESSION_ENTRIES
    );
  });

  it("suppresses exactly the keys each endpoint declares only as `string`", () => {
    const derived = deriveEndpointStringOnlyDateKeys(
      profiles,
      DATE_REVIVAL_KEYS,
      servedRoutes
    );

    expect(
      ENDPOINT_STRING_ONLY_DATE_KEYS,
      "The shipped suppression table no longer matches the route payloads. Regenerate `ENDPOINT_STRING_ONLY_DATE_KEYS` in `endpoint-date-revival.ts` from this derivation — an entry that disappeared means that endpoint now declares the key as a `Date`, and an entry that appeared means a live string contract is being handed back as a `Date`."
    ).toEqual(derived);
  });

  it("pins the endpoints that declare a key both ways", () => {
    const conflicts = discoverEndpointDateKeyConflicts(
      profiles,
      DATE_REVIVAL_KEYS
    );

    expect(
      conflicts,
      "An endpoint now declares an allowlisted key as both a `string` and a `Date` in one response. A key-only reviver cannot tell the two apart, so one of them will be wrong at runtime while `tsc` sees neither. Spell the field one way on that payload, or record it in UNRESOLVABLE_ENDPOINT_COLLISIONS with the reason."
    ).toEqual(UNRESOLVABLE_ENDPOINT_COLLISIONS);
  });

  it("covers the two contracts the global list was corrupting", () => {
    // `ComponentVersion.createdAt` and `SyncedAgentSessionEvent.createdAt` are
    // both declared `string` and were both arriving as `Date`s because other
    // routes declare `createdAt` a `Date`.
    expect(stringOnlyDateKeysForPath("/agent-components/my-agent")).toContain(
      "createdAt"
    );
    expect(
      stringOnlyDateKeysForPath("/agent-sessions/019ff928-8c53")
    ).toContain("createdAt");
  });

  it("keeps an endpoint that really serves `Date`s unsuppressed", () => {
    // A table that suppressed everything would satisfy the assertions above as
    // vacuously as one that suppressed nothing. `Document.createdAt` IS a `Date`
    // on the documents detail payload and must stay revivable.
    expect(stringOnlyDateKeysForPath("/documents/abc123")).not.toContain(
      "createdAt"
    );
    expect(stringOnlyDateKeysForPath("/projects/abc123").size).toBe(0);
  });

  it("ignores the query string and the hash", () => {
    expect(
      stringOnlyDateKeysForPath("/branches?limit=10&cursor=abc")
    ).toContain("createdAt");
    expect(stringOnlyDateKeysForPath("/branches#top")).toContain("createdAt");
  });

  it("decodes a percent-encoded literal segment", () => {
    // Decoding is what lets an encoded LITERAL still match its own entry. A
    // dynamic segment matches whatever it is given, so only a literal proves
    // the decode actually runs.
    expect(
      stringOnlyDateKeysForPath("/agent-components/source%2Doccurrences")
    ).toContain("lastSeenAt");
  });

  it("degrades to no suppression on a malformed escape rather than throwing", () => {
    // `decodeURIComponent` throws on a lone `%`. A badly built path must cost
    // the suppression, not the response.
    expect(() => stringOnlyDateKeysForPath("/branches/%E0%A4%A")).not.toThrow();
    expect(stringOnlyDateKeysForPath("/agent-components/%")).toContain(
      "createdAt"
    );
  });

  it("suppresses only the keys listed for the matched endpoint", () => {
    // `/agent-components/[slug]` declares `startedAt` and `updatedAt` BOTH
    // ways, so they are pinned collisions and must stay revivable. Suppression
    // must not spread from `createdAt` to every allowlisted key on the route.
    const keys = stringOnlyDateKeysForPath("/agent-components/my-agent");

    expect(keys).toContain("createdAt");
    expect(keys).not.toContain("startedAt");
    expect(keys).not.toContain("updatedAt");
  });

  it("falls back to the unscoped allowlist for an unknown path", () => {
    // A desktop gateway path, a relay path, or a route added since this table
    // was derived must keep the previous behavior rather than silently losing
    // its `Date`s.
    expect(stringOnlyDateKeysForPath("/api/gateway/sessions").size).toBe(0);
    expect(stringOnlyDateKeysForPath("").size).toBe(0);
    expect(stringOnlyDateKeysForPath("/").size).toBe(0);
  });

  it("shadows a literal sibling of a dynamic suppression entry", () => {
    // `/agent-sessions/usage` is a sibling of `/agent-sessions/[id]`, whose
    // payload declares `createdAt` a `string`. Without a shadow row the usage
    // route would match that dynamic entry and lose a `Date` its own payload
    // never declared as a string.
    expect(stringOnlyDateKeysForPath("/agent-sessions/usage").size).toBe(0);
    expect(stringOnlyDateKeysForPath("/agent-sessions/analytics").size).toBe(0);
    expect(stringOnlyDateKeysForPath("/branches/usage").size).toBe(0);
    // The dynamic sibling itself is untouched by the shadow.
    expect(stringOnlyDateKeysForPath("/agent-sessions/abc123")).toContain(
      "createdAt"
    );
  });

  it("shadows a route whose own dynamic segment could spell another's literal", () => {
    // `/documents/by-slug/[slug]` serves `DocumentDetail`, whose `createdAt` IS
    // a `Date`. A document slugged `attachments` produces a path that also
    // matches `/documents/[id]/attachments` — the more specific literal at
    // segment 1 must win, or that document loses its `Date`.
    expect(
      stringOnlyDateKeysForPath("/documents/by-slug/attachments").size
    ).toBe(0);
    // The route the suppression is actually for is untouched.
    expect(stringOnlyDateKeysForPath("/documents/doc-1/attachments")).toContain(
      "createdAt"
    );
  });

  it("shadows every served route a dynamic entry would otherwise capture", () => {
    const described = new Set(
      ENDPOINT_STRING_ONLY_DATE_KEYS.map((entry) => entry.route)
    );
    const leaked = servedRoutes
      .filter((route) => !described.has(route))
      .filter((route) => stringOnlyDateKeysForPath(route).size > 0);

    expect(
      leaked,
      `These served routes match another endpoint's suppression entry but were never examined for those keys, so revival would be dropped on a payload that may declare them \`Date\`. Add a shadow row (empty keys) for each: ${leaked.join(", ")}`
    ).toEqual([]);
  });

  it("never suppresses a key the matched endpoint declares as a `Date`", () => {
    // The direction that actually matters at runtime, and the one set equality
    // against the derivation cannot see: run the SHIPPED matcher over every
    // discovered endpoint and assert it hands back nothing that endpoint's own
    // payload declares a `Date`. A route added tomorrow that serves a `Date`
    // under a name a dynamic sibling suppresses fails here.
    const violations: string[] = [];
    for (const profile of profiles) {
      const suppressed = stringOnlyDateKeysForPath(
        toConcretePath(profile.route)
      );
      for (const key of suppressed) {
        if (profile.dateKeys.has(key)) {
          violations.push(`${profile.route} -> ${key}`);
        }
      }
    }

    expect(
      violations,
      `The matcher suppresses a key these endpoints declare as a \`Date\`, so the response arrives as a \`string\` while \`tsc\` says \`Date\`. Give each endpoint its own entry (empty keys, if it suppresses nothing): ${violations.join(", ")}`
    ).toEqual([]);
  });

  it("suppresses only keys the global allowlist already revives", () => {
    for (const endpoint of ENDPOINT_STRING_ONLY_DATE_KEYS) {
      for (const key of endpoint.keys) {
        expect(
          DATE_REVIVAL_KEYS.has(key),
          `${endpoint.route} suppresses ${key}, which is not revived anyway`
        ).toBe(true);
      }
    }
  });
});

/** A route template as a concrete request path, with each `[param]` filled in. */
function toConcretePath(route: string): string {
  return route
    .split("/")
    .map((segment) => (DYNAMIC_TEMPLATE_SEGMENT.test(segment) ? "x" : segment))
    .join("/");
}
