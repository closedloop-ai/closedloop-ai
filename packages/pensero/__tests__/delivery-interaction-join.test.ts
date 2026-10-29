/**
 * The intra-feed join, against the synthetic hazard fixture.
 *
 * The counts asserted here are the ones a reader of a coverage report would
 * see, so they are stated exactly rather than as ranges — a drifting count is
 * the signal that a hazard regressed.
 */

import { describe, expect, it } from "vitest";
import type { PenseroDeliveryRow } from "../delivery-contract";
import { extractDeliverySegment } from "../delivery-extractor";
import {
  buildInteractionIndex,
  mergeInteractionIndexes,
  PullRequestResolution,
  resolveDeliveryRow,
  resolveDeliveryRows,
} from "../delivery-interaction-join";
import fixture from "./fixtures/pensero-delivery-hazards.fixture.json";

const segment = extractDeliverySegment(fixture);
const index = buildInteractionIndex(segment.rows);
const resolved = resolveDeliveryRows(segment.rows, index);

function resolvedById(itemId: string) {
  const entry = resolved.find((candidate) => candidate.row.itemId === itemId);
  if (!entry) {
    throw new Error(`fixture row ${itemId} not resolved`);
  }
  return entry;
}

function countBy(resolution: PullRequestResolution): number {
  return resolved.filter((entry) => entry.resolution === resolution).length;
}

describe("interaction join over the hazard fixture", () => {
  it("H2: gives a creator row the number only a sibling review row carried", () => {
    const creator = resolvedById("2656228");
    expect(creator.row.pullRequest).toBeNull();
    expect(creator.resolution).toBe(PullRequestResolution.Interaction);
    expect(creator.pullRequest).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4228,
    });
  });

  it("H3: leaves a creator row with no review counterpart explicitly unresolved", () => {
    const orphan = resolvedById("2656365");
    expect(orphan.resolution).toBe(PullRequestResolution.NoCounterpart);
    expect(orphan.pullRequest).toBeNull();
  });

  it("H10: a non-pull-request row is NoInteraction, not NoCounterpart", () => {
    // Three different absences, kept apart: "this is not about a PR", "this is
    // about a PR whose number never arrived", and "we have no such PR".
    expect(resolvedById("2670502").resolution).toBe(
      PullRequestResolution.NoInteraction
    );
    expect(resolvedById("2685218").resolution).toBe(
      PullRequestResolution.NoInteraction
    );
  });

  it("H4: resolves a example-infrastructure creator row to its own repository", () => {
    expect(resolvedById("2670452").pullRequest).toEqual({
      owner: "example-org",
      repo: "infrastructure",
      number: 148,
    });
  });

  it("H5: resolves two same-titled creator rows to two different pull requests", () => {
    expect(resolvedById("2666774").pullRequest?.number).toBe(4298);
    expect(resolvedById("2666775").pullRequest?.number).toBe(4301);
  });

  it("produces the exact resolution split for the fixture", () => {
    expect({
      direct: countBy(PullRequestResolution.Direct),
      interaction: countBy(PullRequestResolution.Interaction),
      noInteraction: countBy(PullRequestResolution.NoInteraction),
      noCounterpart: countBy(PullRequestResolution.NoCounterpart),
      ambiguous: countBy(PullRequestResolution.Ambiguous),
    }).toEqual({
      direct: 16,
      interaction: 9,
      noInteraction: 5,
      noCounterpart: 9,
      ambiguous: 0,
    });
    expect(resolved).toHaveLength(39);
  });
});

describe("cross-segment resolution", () => {
  const creatorOnly = segment.rows.filter(
    (row) => row.interaction?.id === "1539716" && !row.pullRequest
  );
  const reviewsOnly = segment.rows.filter(
    (row) => row.interaction?.id === "1539716" && row.pullRequest
  );

  it("H3: a creator row resolves from a number that arrived in another segment", () => {
    // Segment A holds the creator row alone — unresolvable on its own.
    const segmentAIndex = buildInteractionIndex(creatorOnly);
    expect(resolveDeliveryRow(creatorOnly[0], segmentAIndex).resolution).toBe(
      PullRequestResolution.NoCounterpart
    );

    // Segment B carries the reviews. Merged, the creator row resolves.
    const segmentBIndex = buildInteractionIndex(reviewsOnly);
    const merged = mergeInteractionIndexes(segmentAIndex, segmentBIndex);
    expect(resolveDeliveryRow(creatorOnly[0], merged).pullRequest?.number).toBe(
      4228
    );
  });

  it("seeding an index forward is equivalent to merging two", () => {
    const seeded = buildInteractionIndex(
      reviewsOnly,
      buildInteractionIndex(creatorOnly)
    );
    const merged = mergeInteractionIndexes(
      buildInteractionIndex(creatorOnly),
      buildInteractionIndex(reviewsOnly)
    );
    expect([...seeded]).toEqual([...merged]);
  });
});

describe("ambiguity is never a tie-break", () => {
  const base = segment.rows.find((row) => row.itemId === "2656344");
  if (!base) {
    throw new Error("fixture review row missing");
  }

  const contradicting: PenseroDeliveryRow = {
    ...base,
    itemId: "contradiction",
    title:
      "Review pull_request: closedloop-ai/closedloop-ai#9999 with title 'something else'",
    pullRequest: {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 9999,
    },
  };

  it("marks an interaction naming two pull requests as ambiguous", () => {
    const conflicted = buildInteractionIndex([base, contradicting]);
    const creator = segment.rows.find((row) => row.itemId === "2656228");
    if (!creator) {
      throw new Error("fixture creator row missing");
    }
    const result = resolveDeliveryRow(creator, conflicted);
    expect(result.resolution).toBe(PullRequestResolution.Ambiguous);
    // The decisive assertion: it did NOT pick the first observation.
    expect(result.pullRequest).toBeNull();
  });

  it("does not let a later agreeing row demote ambiguity back to a winner", () => {
    const conflicted = buildInteractionIndex([base, contradicting, base]);
    expect(resolveDeliveryRow(base, conflicted).resolution).toBe(
      PullRequestResolution.Ambiguous
    );
  });

  it("treats the same number in a different repository as a contradiction", () => {
    const crossRepo: PenseroDeliveryRow = {
      ...base,
      itemId: "cross-repo",
      pullRequest: {
        owner: "closedloop-ai",
        repo: "example-infrastructure",
        number: 4228,
      },
    };
    expect(
      resolveDeliveryRow(base, buildInteractionIndex([base, crossRepo]))
        .resolution
    ).toBe(PullRequestResolution.Ambiguous);
  });

  it("does not create ambiguity from repeated agreeing observations", () => {
    expect(
      resolveDeliveryRow(base, buildInteractionIndex([base, base])).resolution
    ).toBe(PullRequestResolution.Direct);
  });
});
