import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { makeBranchDetail } from "@repo/app/branches/__tests__/branch-fixtures";
import { BranchPrStatusPanel } from "@repo/app/branches/components/detail/branch-pr-status-panel";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFeatureFlagProvider } from "../../../feature-flags/desktop-feature-flag-provider";

/**
 * @description ISS-8629 — the desktop half of the withheld green tone.
 *
 * whitlockk on PR #7431: the partial and capped states were pinned only in the
 * `@repo/app` suite and the web E2E, and `BranchPrStatusPanel` is one SHARED
 * component the desktop renderer mounts too. What can genuinely split the two
 * surfaces is therefore the GATE and not the render: web resolves the PostHog
 * key through `FeatureFlagAdapterProvider`, and the desktop renderer resolves
 * the SAME key out of this launch's assignment through
 * `DesktopFeatureFlagProvider` — one key, unconditionally, with no Labs toggle
 * to pair with it and no local registry entry behind it (ISS-8753 retired both,
 * and marisolashgrove corrected the review thread to say so).
 *
 * Both trees are compared TO EACH OTHER rather than each to a list of expected
 * sentences, for the reason the sibling `session-metric-population-parity`
 * gives: a constant would have to be edited to match whatever the surfaces
 * became, and would go on passing while they diverged. Each tree is seeded from
 * its OWN surface's constant, so a split literal leaves one tree unflagged and
 * the comparison fails.
 *
 * WHY THIS LANE AND NOT `test/e2e`. The Electron seam the e2e suite walks —
 * seeded assignment → `getE2eSeededFeatureFlags` IPC → `DesktopFeatureFlagProvider`
 * — is a key-agnostic map lookup already covered for this provider by
 * `branch-detail-metric-honesty.spec.ts`. The shared-only unavailable-card
 * duplicate was removed in ISS-10527.
 * What is per-key is the literal, pinned byte-equal in
 * `apps/desktop/test/feature-flags-cross-surface.test.ts`, and the render-level
 * consequence of it, which is this file. A third Electron launch would re-prove
 * the handoff and not the states.
 */

const CHECKS_TRIGGER_RE = /Checks/;
/** Exact, so the "Checks & review" section heading cannot answer for the row. */
const CHECKS_ROW_LABEL = "Checks";
const HEAD_SHA = "c".repeat(40);

/**
 * The two states Kaito's 2026-08-31 ruling introduced, and the only two the
 * shortfall sentence has words for. Both are carried so a parity that held only
 * for the counted sentence cannot read as a pass for the capped one.
 */
const WITHHELD_POPULATIONS = [
  { items: 1, name: "a short list", totalCount: 9, truncated: false },
  { items: 2, name: "a capped list", totalCount: 2, truncated: true },
] as const;

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("ISS-8629 the withheld green tone reads the same on both surfaces", () => {
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

  for (const population of WITHHELD_POPULATIONS) {
    it(`states the same summary, tone and shortfall for ${population.name}`, async () => {
      // The web tree is rendered FIRST and is the reference: its adapter
      // resolves synchronously, so its statement is established — and asserted
      // to actually carry a withheld tone and a sentence — before desktop is
      // asked to match it. Reversing that would let a desktop tree whose gate
      // never opened be compared against an equally empty web tree and pass.
      const web = render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY],
          })}
        >
          <BranchPrStatusPanel detail={detailFor(population)} />
        </FeatureFlagAdapterProvider>
      );
      const expected = checksStatement(web.container);
      expect(expected.summary).not.toBe("");
      expect(expected.shortfall).not.toBe("");
      web.unmount();

      // The key is carried by this launch's ASSIGNMENT and nothing else, so the
      // assignment is what actually drives the render.
      installDesktopApi({
        enabledKeys: [BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY],
      });
      const desktop = render(
        <DesktopFeatureFlagProvider>
          <BranchPrStatusPanel detail={detailFor(population)} />
        </DesktopFeatureFlagProvider>
      );

      // The verdict arrives asynchronously over the preload bridge, so the
      // match is awaited rather than read once.
      await waitFor(() =>
        expect(checksStatement(desktop.container)).toEqual(expected)
      );
    });
  }

  it("shows neither surface the measured box with no key seeded", async () => {
    // The closed-by-default pole, and the one that catches a desktop gate
    // defaulting ON: a renderer whose assignment carries no verdict must read
    // exactly as the web app does with no flag. Both fall back to the live
    // provider read, which states no shortfall at all.
    const population = WITHHELD_POPULATIONS[0];
    const web = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <BranchPrStatusPanel detail={detailFor(population)} />
      </FeatureFlagAdapterProvider>
    );
    const expected = checksStatement(web.container);
    expect(expected.shortfall).toBe("");
    web.unmount();

    installDesktopApi({ enabledKeys: [] });
    const desktop = render(
      <DesktopFeatureFlagProvider>
        <BranchPrStatusPanel detail={detailFor(population)} />
      </DesktopFeatureFlagProvider>
    );

    await waitFor(() =>
      expect(checksStatement(desktop.container)).toEqual(expected)
    );
  });
});

/**
 * The checks box's whole observable statement: the words of the summary, the
 * TONE it is drawn at, and the sentence wired to the trigger as its accessible
 * description.
 *
 * The tone is read off the class list rather than a colour name because
 * `ToneLabel` is a text colour and that class list is the only place the
 * withheld green is visible at all — a comparison of the words alone would
 * match a desktop tree that drew the same tally in green.
 */
function checksStatement(container: HTMLElement): {
  shortfall: string;
  summary: string;
  tone: string;
} {
  const queries = within(container);
  // A population with rows draws a disclosure; a named non-answer draws a plain
  // row with no control. Either is the box, and which one a surface chose is
  // itself part of what the two trees have to agree on.
  const box =
    queries.queryByRole("button", { name: CHECKS_TRIGGER_RE }) ??
    queries.getByText(CHECKS_ROW_LABEL, { exact: true }).parentElement;
  if (!box) {
    throw new Error(
      "the panel rendered no checks box to read a statement from"
    );
  }
  // The toned value is the box's last element child on every shape, after the
  // chevron (where there is one) and the "Checks" label.
  const toned = box.lastElementChild;
  const describedBy = box.getAttribute("aria-describedby");
  const description = describedBy
    ? container.ownerDocument.getElementById(describedBy)
    : null;
  return {
    shortfall: description?.textContent ?? "",
    summary: toned?.textContent ?? "",
    tone: toned?.className ?? "",
  };
}

/** A selected pull request whose measured population is short of its count. */
function detailFor(population: {
  items: number;
  totalCount: number;
  truncated: boolean;
}) {
  return makeBranchDetail({
    selectedPullRequest: {
      headRefOid: HEAD_SHA,
      id: "pr-1",
      number: 7,
      repositoryFullName: "acme/web",
      state: GitHubPRState.Open,
    } as NonNullable<
      ReturnType<typeof makeBranchDetail>["selectedPullRequest"]
    >,
    selectedPullRequestChecksProjection: {
      headSha: HEAD_SHA,
      items: Array.from({ length: population.items }, (_unused, index) => ({
        conclusion: "SUCCESS",
        id: `check-${index}`,
        kind: BranchViewCheckKind.CheckRun,
        name: `check-${index}`,
        status: "COMPLETED",
        targetUrl: null,
      })),
      providerState: BranchViewChecksProviderState.Available,
      totalCount: population.totalCount,
      truncated: population.truncated,
      unavailableReason: null,
    },
    status: BranchStatus.Open,
  });
}

/**
 * Seed this launch's flag ASSIGNMENT — the only thing the desktop gate reads.
 * The verdicts arrive in the real {@link DesktopFeatureFlagAssignment} wire
 * shape and are folded through the same boundary as a live reply.
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
          flags: Object.fromEntries(enabledKeys.map((key) => [key, true])),
          resolved: true,
          userId: ASSIGNMENT_SUBJECT,
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
