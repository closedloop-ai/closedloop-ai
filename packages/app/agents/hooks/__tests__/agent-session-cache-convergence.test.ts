import { describe, expect, it } from "vitest";
import {
  coveringPrefixes,
  excludedFamilies,
  isQueryKeyPrefixOf,
} from "../../../shared/query/list-cache-convergence";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../lib/session-transcript-href";
import {
  agentSessionAlwaysConvergePrefixes,
  agentSessionBroadConvergePrefixes,
  agentSessionCacheConvergence,
} from "../agent-session-cache-convergence";
import { agentSessionKeys } from "../agent-session-keys";

const SCOPE = "scope-under-test";
const SESSION_ID = "session-1";
const TRANSCRIPT_REASON_PATTERN = /content-addressed|rawSha256/i;

/** Compare prefix sets without pinning an order invalidation does not carry. */
function sortedKeys(
  prefixes: readonly (readonly unknown[])[]
): readonly string[] {
  return prefixes.map((prefix) => JSON.stringify(prefix)).sort();
}

/**
 * Every family of `agentSessionKeys`, written out by hand. Deriving this from
 * `Object.keys(agentSessionKeys)` would make the test agree with whatever the
 * key object currently holds and prove nothing; the duplication is what turns a
 * new or deleted family into a failure here.
 */
const EXPECTED_FAMILIES = [
  "all",
  "usages",
  "usage",
  "analyticsRoot",
  "analytics",
  "lists",
  "list",
  "pageDataRoot",
  "pageData",
  "details",
  "detail",
  "eventsPagesOf",
  "invocationTree",
  "collaborators",
  "activity",
  "eventsPages",
  "transcripts",
  "transcriptAccess",
  "transcriptFile",
];

describe("agentSessionCacheConvergence", () => {
  it("classifies every family the key object exposes, and no others", () => {
    expect(Object.keys(agentSessionKeys).sort()).toEqual(
      [...EXPECTED_FAMILIES].sort()
    );
    expect(Object.keys(agentSessionCacheConvergence).sort()).toEqual(
      [...EXPECTED_FAMILIES].sort()
    );
  });

  it("converges the list, summary, analytics, and combined page-data reads on every flush", () => {
    // Written as literals rather than read back from `agentSessionKeys`: a key
    // renamed or re-rooted must fail here instead of silently re-agreeing.
    // Compared as a set — invalidation order carries no meaning, so pinning it
    // would only make a harmless reordering of the declaration fail.
    expect(sortedKeys(agentSessionAlwaysConvergePrefixes())).toEqual(
      sortedKeys([
        ["agent-sessions", "usage"],
        ["agent-sessions", "list"],
        ["agent-sessions", "analytics"],
        ["agent-sessions", "page-data"],
      ])
    );
  });

  it("sweeps only the detail prefix on a broad change", () => {
    expect(sortedKeys(agentSessionBroadConvergePrefixes())).toEqual(
      sortedKeys([["agent-sessions", "detail"]])
    );
  });

  it("never converges transcripts, and records a substantive why", () => {
    const excluded = excludedFamilies(agentSessionCacheConvergence);

    expect([...excluded.keys()]).toEqual(["transcripts"]);
    // Pin the SUBSTANCE, not merely a non-empty string. A reason that survives
    // only a length check can be swapped, truncated, or left as placeholder text
    // while still reading as a deliberate, reviewed exclusion — which is the one
    // thing an exclusion must never be able to fake.
    expect(excluded.get("transcripts")).toMatch(TRANSCRIPT_REASON_PATTERN);
  });

  it("reaches the analytics subtree, so the Repository facet fallback converges", () => {
    // davetho review: analytics is the desktop sessions list's Repository
    // facet fallback while the usage summary reports no repositories, and
    // desktop holds it at `staleTime: Infinity`. Excluded, the facet kept
    // pre-sync options until remount whenever the summary stayed empty.
    const analyticsKey = agentSessionKeys.analytics(SCOPE, {});

    expect(
      agentSessionAlwaysConvergePrefixes().some((prefix) =>
        isQueryKeyPrefixOf(prefix, analyticsKey)
      )
    ).toBe(true);
  });

  it("keeps the transcript subtree out of the converging set", () => {
    // The positive assertions above say what DOES converge; this says the
    // excluded subtree is not swept by some other prefix (a `root`
    // classification promoted to `always` would catch it).
    const converging = [
      ...agentSessionAlwaysConvergePrefixes(),
      ...agentSessionBroadConvergePrefixes(),
    ];
    const transcriptKey = agentSessionKeys.transcriptAccess(
      SESSION_ID,
      MAIN_TRANSCRIPT_FILE_KEY
    );

    expect(
      converging.some((prefix) => isQueryKeyPrefixOf(prefix, transcriptKey))
    ).toBe(false);
  });

  it("proves each exact key is actually reached by the prefix the CONTRACT claims covers it", () => {
    // TanStack matches by prefix, so a `coveredBy` claim is only true while the
    // exact key literally begins with that prefix. The covering prefix is read
    // from the contract, not hand-paired here: a pair written out by hand keeps
    // agreeing with itself after the declaration it is supposed to police has
    // changed, so a mis-aimed `coveredBy` would go unobserved.
    const sampleExactKeys: Readonly<Record<string, readonly unknown[]>> = {
      analytics: agentSessionKeys.analytics(SCOPE, {}),
      detail: agentSessionKeys.detail(SCOPE, SESSION_ID),
      eventsPagesOf: agentSessionKeys.eventsPagesOf(SCOPE, SESSION_ID),
      eventsPages: agentSessionKeys.eventsPages(SCOPE, SESSION_ID, "cursor"),
      // ISS-10737. Built from the key factory, never written out as a literal:
      // the loop below is what PROVES the `details` prefix reaches this exact
      // key, and a hand-typed key would only prove the test agrees with itself.
      invocationTree: agentSessionKeys.invocationTree(SCOPE, SESSION_ID),
      // ISS-10796, from the factory for the same reason as `invocationTree`.
      collaborators: agentSessionKeys.collaborators(SCOPE, SESSION_ID),
      activity: agentSessionKeys.activity(SCOPE, SESSION_ID),
      list: agentSessionKeys.list(SCOPE, {}),
      pageData: agentSessionKeys.pageData(SCOPE, {}),
      transcriptAccess: agentSessionKeys.transcriptAccess(
        SESSION_ID,
        MAIN_TRANSCRIPT_FILE_KEY
      ),
      transcriptFile: agentSessionKeys.transcriptFile(
        SESSION_ID,
        "file.jsonl",
        "sha"
      ),
      usage: agentSessionKeys.usage(SCOPE, {}),
    };
    const covering = coveringPrefixes(
      agentSessionKeys,
      agentSessionCacheConvergence
    );

    // Every covered family is sampled, so none can silently skip the check.
    expect([...covering.keys()].sort()).toEqual(
      Object.keys(sampleExactKeys).sort()
    );
    for (const [familyName, prefix] of covering) {
      expect(isQueryKeyPrefixOf(prefix, sampleExactKeys[familyName])).toBe(
        true
      );
    }
  });

  it("keeps every family under the shared namespace root", () => {
    const root = agentSessionKeys.all;

    expect(root).toEqual(["agent-sessions"]);
    for (const prefix of [
      ...agentSessionAlwaysConvergePrefixes(),
      ...agentSessionBroadConvergePrefixes(),
    ]) {
      expect(isQueryKeyPrefixOf(root, prefix)).toBe(true);
    }
  });
});
