import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { documentKeys } from "../document-keys";
import { documentsSummaryQueryKey } from "../use-documents-summary";

/**
 * ISS-8936 — that the writes this index performs actually reach the band's cache.
 *
 * `documentKeys.summaries()` is a SIBLING of `documentKeys.lists()`, so a
 * `lists()` invalidation does not prefix-match it. Without the explicit line in
 * `invalidateArtifactCaches`, an inline status edit on the Documents index
 * refreshed the row and left the band's `updatedInWindow` and its `Of N in this
 * view` denominator stated as current — settled, unmarked, and wrong
 * (review-soul finding A). This asserts the PREFIX relationship the invalidator
 * depends on, then that the invalidator names it.
 */
describe("documents summary cache invalidation", () => {
  it("does not sit under the list prefix, which is why it needs naming", () => {
    const client = new QueryClient();
    const summaryKey = documentsSummaryQueryKey({});
    // SEEDED, because `findAll` over an empty cache answers `[]` for every key
    // and would pass whatever the prefixes were (review thread on #8000). With a
    // real summary entry in the cache the two `findAll`s below are a matched
    // pair: the `lists()` prefix must MISS this entry and the `summaries()`
    // prefix must HIT it, so neither assertion can be satisfied by a locator
    // that resolves to nothing.
    client.setQueryData(summaryKey, {
      total: 1,
      producedByAgentSessions: 0,
      updatedInWindow: 0,
      neverEdited: 0,
      windowDays: 7,
    });
    const cache = client.getQueryCache();

    // The structural fact the finding turned on, asserted rather than assumed:
    // the summary key's second segment is not "list", so no `lists()`
    // invalidation can ever reach it.
    expect(summaryKey.at(1)).not.toBe(documentKeys.lists().at(1));
    expect(summaryKey.at(1)).toBe(documentKeys.summaries().at(1));
    expect(cache.findAll({ queryKey: documentKeys.lists() })).toEqual([]);
    expect(
      cache
        .findAll({ queryKey: documentKeys.summaries() })
        .map((query) => query.queryKey)
    ).toEqual([summaryKey]);
  });

  it("is invalidated by the shared artifact-write invalidator", async () => {
    const { invalidateArtifactCaches } = await import("../use-documents");
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    invalidateArtifactCaches(client, { artifactId: "artifact-1" });

    // Kills: deleting the `summaries()` line from `invalidateArtifactCaches`.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: documentKeys.summaries(),
    });
  });
});
