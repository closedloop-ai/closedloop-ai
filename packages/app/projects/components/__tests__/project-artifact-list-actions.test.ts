import { describe, expect, it, vi } from "vitest";
import { favoriteProjectSelection } from "../project-artifact-list-actions";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("favoriteProjectSelection", () => {
  it("stars every artifact in a mixed favorite selection", () => {
    const mutate = vi.fn();

    favoriteProjectSelection(
      new Set([FIRST, SECOND]),
      new Set([FIRST]),
      mutate
    );

    expect(mutate.mock.calls).toEqual([
      [{ artifactId: FIRST, isFavorite: false }],
      [{ artifactId: SECOND, isFavorite: false }],
    ]);
  });

  it("unstars every artifact when the whole selection is favorite", () => {
    const mutate = vi.fn();

    favoriteProjectSelection(
      new Set([FIRST, SECOND]),
      new Set([FIRST, SECOND]),
      mutate
    );

    expect(mutate.mock.calls).toEqual([
      [{ artifactId: FIRST, isFavorite: true }],
      [{ artifactId: SECOND, isFavorite: true }],
    ]);
  });
});
