// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: the module's export set IS the corpus under test — a named-import list would restate the thing being verified, which is exactly how a second story for an already-storied phase slips through.
import * as phaseStories from "../guided-onboarding-phases.stories";
import { WIZARD_PHASES } from "../guided-onboarding-types";

/**
 * The story corpus is the RENDERED proof that a phase mounts with no wizard
 * shell around it, and nothing in Storybook fails when a phase simply has no
 * story — it quietly stops being demonstrated. This file pins that corpus and
 * nothing else: the mount itself is executed by
 * `guided-onboarding-phase-registry.test.tsx`, and Storybook's own sweep plays
 * every story, so re-mounting here would be a third copy of one proof.
 *
 * The corpus is DERIVED from the module's NAMED exports rather than restated,
 * which is what makes "exactly one" a claim: a second story for a phase that
 * already has one lengthens `STORIED_PHASES` and fails the comparison, and a
 * phase added to `WIZARD_PHASES` without a story fails it the other way
 * (ISS-8345). The `default` export is excluded because it is `meta`, not a
 * story: counting its `args.phase` would let a phase be satisfied by the
 * shared defaults with no story of its own, which is the same silent gap in a
 * narrower place.
 */
const STORIED_PHASES = Object.entries(phaseStories).flatMap(([name, story]) => {
  if (name === "default") {
    return [];
  }
  const phase = story.args?.phase;
  return phase === undefined ? [] : [phase];
});

describe("guided onboarding phase stories", () => {
  it("gives every wizard phase exactly one story", () => {
    expect([...STORIED_PHASES].sort()).toEqual([...WIZARD_PHASES].sort());
  });
});
