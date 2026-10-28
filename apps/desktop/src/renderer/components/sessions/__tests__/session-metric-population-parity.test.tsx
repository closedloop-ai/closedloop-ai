import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "@repo/app/agents/components/detail/session-properties-panel";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../../../feature-flags/desktop-feature-flag-provider";

/**
 * @description ISS-7737 — the desktop half of the population disclosure.
 *
 * `SessionPropertiesPanel` is one shared component, so the thing that can
 * genuinely split the two surfaces is the GATE, not the render: web resolves a
 * PostHog key through `FeatureFlagAdapterProvider`, the desktop renderer
 * resolves the same key out of this launch's assignment through
 * `DesktopFeatureFlagProvider` (ISS-8753 — no local registry, no build-type
 * fallback), and the panel is dark by default on both. Desktop is a PRODUCER of the
 * mismatch as well as a surface for it — its own parser writes `agent_turns`
 * from the parent transcript while folding token usage over every delegated
 * subagent file — so a key that drifted would leave the packaged app presenting
 * a parent-only turn count four rows from a subagent-folded rollup with nothing
 * said about either.
 *
 * Both trees are mounted in ONE test and compared TO EACH OTHER rather than each
 * to a list of expected sentences: a constant would have to be edited to match
 * whatever the surfaces became, and would therefore go on passing while they
 * diverged. Each tree is seeded from its OWN surface's constant, so a split
 * literal leaves the web tree unflagged and the comparison fails.
 *
 * `apps/desktop/test/feature-flags-cross-surface.test.ts` pins the two constants
 * byte-equal; this file is the render-level consequence of that, not a second
 * copy of it.
 */

const PROPERTIES_TOGGLE_RE = /Properties/;

/** The ticket's session: a parent-only 1,016 turns beside the folded rollup. */
const FOLDED_SESSION = createAgentSessionDetailFixture({
  turns: 1016,
  tokensIn: 97_223,
  tokensOut: 27_783_684,
  cache: 7_994_296_736,
  cacheWrite: 238_501_193,
  inputTokens: 97_223,
  outputTokens: 27_783_684,
  cacheReadTokens: 7_994_296_736,
  cacheWriteTokens: 238_501_193,
  estimatedCost: 6229.941_627_15,
});

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("ISS-7737 the population disclosure reads the same on both surfaces", () => {
  beforeEach(() => {
    originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    if (originalDesktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    vi.restoreAllMocks();
  });

  it("states the same populations from the desktop Labs key as from the web flag", async () => {
    // The web tree is rendered FIRST and is the reference: its adapter resolves
    // synchronously, so the sentences it produces are established (and asserted
    // non-empty) before desktop is asked to match them. Reversing that would let
    // a desktop tree whose gate never opened be compared against an equally
    // empty web tree and pass.
    const web = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY],
        })}
      >
        <SessionPropertiesPanel session={FOLDED_SESSION} />
      </FeatureFlagAdapterProvider>
    );
    openProperties(web.container);
    const webSentences = announcementsIn(web.container);
    expect(webSentences.length).toBe(3);
    web.unmount();

    // The desktop key is carried by this launch's assignment and nothing else,
    // so the assignment is what actually drives the render.
    installDesktopApi({
      enabledKeys: [
        DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
      ],
    });
    const desktop = render(
      <DesktopFeatureFlagProvider>
        <SessionPropertiesPanel session={FOLDED_SESSION} />
      </DesktopFeatureFlagProvider>
    );
    openProperties(desktop.container);

    // The Labs value arrives asynchronously through the preload bridge, so the
    // match is awaited rather than read once.
    await waitFor(() =>
      expect(announcementsIn(desktop.container)).toEqual(webSentences)
    );
  });

  it("says nothing on either surface with no key seeded", () => {
    // The closed-by-default pole, and the one that catches a desktop gate
    // defaulting ON: a renderer whose assignment carries no verdict must read
    // exactly as the web app does with no flag.
    installDesktopApi({ enabledKeys: [] });

    const desktop = render(
      <DesktopFeatureFlagProvider>
        <SessionPropertiesPanel session={FOLDED_SESSION} />
      </DesktopFeatureFlagProvider>
    );
    openProperties(desktop.container);
    const desktopSentences = announcementsIn(desktop.container);
    desktop.unmount();

    const web = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <SessionPropertiesPanel session={FOLDED_SESSION} />
      </FeatureFlagAdapterProvider>
    );
    openProperties(web.container);

    expect(announcementsIn(web.container)).toEqual(desktopSentences);
    expect(desktopSentences).toEqual([]);
  });
});

// `fireEvent`, not `user-event`: `apps/desktop` does not depend on the latter,
// and the panel toggle is a plain click with no pointer-sequence semantics.
function openProperties(container: HTMLElement) {
  fireEvent.click(
    within(container).getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
}

/**
 * Every population sentence the panel announces, in row order. Read off the
 * `sr-only` tails `ExplainedPropertyValue` emits — the row's ONE statement of
 * the fact, and something only the real treatment produces.
 */
function announcementsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".prd-prop .sr-only")]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.includes("round-trips") || text.includes("turns"));
}

/**
 * Seed this launch's flag ASSIGNMENT — the only thing the desktop gate reads.
 *
 * ISS-8753 retired the local Labs registry and the build-type fallback that sat
 * beside it, so the retired `getAllFlags` + `getRuntimeStatus` pair no longer
 * decides anything and an `isPackaged` argument has nothing left to select. The
 * verdicts arrive over the E2E assignment seam in the real
 * {@link DesktopFeatureFlagAssignment} wire shape and are folded through the
 * same `readFeatureAssignment` boundary as a live reply, with the anonymous
 * subject an unauthenticated mount actually is.
 */
function installDesktopApi({
  enabledKeys,
}: {
  enabledKeys: readonly string[];
}) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getE2eSeededFeatureFlags: vi.fn(() =>
        Promise.resolve({
          userId: ASSIGNMENT_SUBJECT,
          resolved: true,
          flags: Object.fromEntries(enabledKeys.map((key) => [key, true])),
        } satisfies DesktopFeatureFlagAssignment)
      ),
    },
  });
}

/**
 * A legible marker in the seeded payload, never an identity: the provider reads
 * a seeded assignment with a `null` subject, so nothing correlates against this.
 */
const ASSIGNMENT_SUBJECT = "e2e-harness";
