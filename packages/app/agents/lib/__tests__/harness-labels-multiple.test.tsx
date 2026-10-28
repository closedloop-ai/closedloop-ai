/**
 * ISS-5524 — a component used across more than one harness must not render the
 * raw wire value `both`.
 *
 * `HARNESS_DISPLAY_CONFIG` is typed `Record<string, …>` and was written against
 * a different vocabulary (it still carries `cursor` and `copilot`, which are not
 * `Harness` members), so nothing could demand a `Harness.Both` row and the
 * resolver's fallback handed the raw value straight to the badge. 30 components
 * in this org sit in that state.
 *
 * The property case below is the one that would have caught this the day `Both`
 * was added, and it is written to keep catching the NEXT member: it drives every
 * value of the `Harness` const object rather than a hand-listed set, so a new
 * member with no row fails here instead of shipping its own lowercase enum name.
 *
 * The expected wording is pinned as an INDEPENDENT literal. Deriving it from
 * `HARNESS_LABEL` — the map the implementation reads — would leave the case
 * green if that entry were deleted or reworded, which is the whole thing being
 * guarded.
 */

import { Harness } from "@repo/api/src/types/agent-component";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { HarnessBadge } from "../../components/session-status-badges";
import {
  resolveHarnessDisplayConfig,
  resolveHonestHarnessDisplayConfig,
} from "../harness-labels";

const MULTIPLE_HARNESSES_LABEL = "Multiple harnesses";
const RAW_BOTH_VALUE = "both";

describe("resolveHonestHarnessDisplayConfig", () => {
  it("never returns a Harness member's own raw value as its label", () => {
    for (const harness of Object.values(Harness)) {
      const { label } = resolveHonestHarnessDisplayConfig(harness);
      expect(label).not.toBe(harness);
    }
  });

  it("names the multi-harness rollup rather than echoing the enum", () => {
    expect(resolveHonestHarnessDisplayConfig(Harness.Both).label).toBe(
      MULTIPLE_HARNESSES_LABEL
    );
  });

  it("leaves every single-harness answer exactly as the shipped resolver gives it", () => {
    // The honest resolver adds a row; it must not quietly restyle the others.
    for (const harness of [Harness.Claude, Harness.Codex, Harness.Opencode]) {
      expect(resolveHonestHarnessDisplayConfig(harness)).toEqual(
        resolveHarnessDisplayConfig(harness)
      );
    }
  });

  it("still echoes the raw value for a harness nobody has mapped", () => {
    // The degradation ISS-5524 does NOT change: an unrecognized producer value
    // stays readable instead of being replaced by a fabricated label.
    expect(resolveHonestHarnessDisplayConfig("kiro").label).toBe("kiro");
  });
});

describe("HarnessBadge", () => {
  it("reads Multiple harnesses when the gate is open", () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY]}
      >
        <HarnessBadge harness={Harness.Both} />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(MULTIPLE_HARNESSES_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(RAW_BOTH_VALUE)).toBeNull();
  });

  it("keeps today's raw enum value while the gate is closed", () => {
    render(
      <AppCoreStoryProviders>
        <HarnessBadge harness={Harness.Both} />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(RAW_BOTH_VALUE)).toBeInTheDocument();
    expect(screen.queryByText(MULTIPLE_HARNESSES_LABEL)).toBeNull();
  });
});
