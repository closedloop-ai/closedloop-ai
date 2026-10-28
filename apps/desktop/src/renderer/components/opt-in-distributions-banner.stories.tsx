import {
  DistributionMode,
  type OptInDistributionDto,
} from "@repo/api/src/types/distribution";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";
import { OptInDistributionsBanner } from "./opt-in-distributions-banner";

/**
 * FEA-2923 §I / FEA-4007: the app-shell prompt for an org-pushed distribution
 * in `opt_in` mode — a pack the org wants a targeted user to accept and
 * install themselves, as opposed to `auto_install`'s headless path.
 *
 * The component subscribes to the main-process
 * `desktop:distributions:opt-in-available` push
 * (`window.desktopApi.onDistributionsOptInAvailable`), so each story installs
 * that narrow `window.desktopApi` slice — including the `db` install/decline
 * bridge Accept and Dismiss call — and fires the subscription callback
 * synchronously on subscribe, the same shape the real reconcile push takes.
 */
const meta = {
  title: "Composites v1.0/Desktop Shell/Opt In Distributions Banner",
  tags: ["deprecated"],
  component: OptInDistributionsBanner,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

const ACCEPT_LABEL = "Accept & install";
const DISMISS_LABEL = "Dismiss";
const INSTALLING_LABEL = "Installing…";
const CONTROL_POLL_ATTEMPTS = 100;
const CONTROL_POLL_INTERVAL_MS = 10;

// The banner reads `DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY` itself (operator
// instruction, 2026-09-30) and renders nothing while it is off, so every story
// resolves that key open; the off state is a blank canvas and is pinned by the
// render tests instead.
const FLAG_ON_ADAPTER = {
  useFeatureFlagEnabled: (key: string) =>
    key === DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY,
};

/** One org-shared pack, awaiting the user's accept/dismiss. */
export const SinglePending = {
  render: () =>
    renderScenario({
      caption: "One pending distribution - Accept & install, or Dismiss.",
      distributions: [
        makeDistribution({
          id: "dist-pr-review",
          name: "PR Review Assistant",
          targetKind: "skill",
        }),
      ],
    }),
};

/**
 * "Accept & install" pressed. `installing` is set the instant the click
 * fires (before either bridge call is awaited), so a `db.catalogInstall`
 * that never resolves is what parks the canvas here instead of it flashing
 * past into a dismissed row.
 */
export const Installing = {
  render: () =>
    renderScenario({
      caption: "Mid-install: the row's own button, disabled and relabelled.",
      distributions: [
        makeDistribution({
          id: "dist-release-notes",
          name: "Release Notes Generator",
          targetKind: "plugin",
        }),
      ],
      installNeverResolves: true,
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const accept = await waitForControl(
      canvasElement,
      "opt-in-row-dist-release-notes",
      ACCEPT_LABEL
    );
    accept.click();
    await waitForText(
      canvasElement,
      "opt-in-row-dist-release-notes",
      INSTALLING_LABEL
    );
  },
};

/**
 * A failed install. ISS-5123: `ensureDistributionAssigned` runs first so a
 * withdrawn offer surfaces as this same row-scoped, actionable error rather
 * than installing a pack the org no longer offers — the row stays put
 * (unlike a success, which dismisses it), so the user can retry.
 */
export const InstallError = {
  render: () =>
    renderScenario({
      caption:
        "Install failed: the row keeps its label and shows an inline, actionable error instead of disappearing.",
      distributions: [
        makeDistribution({
          id: "dist-deploy-checks",
          name: "Deploy Preview Checks",
          targetKind: "command",
        }),
      ],
      installRejects: true,
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const accept = await waitForControl(
      canvasElement,
      "opt-in-row-dist-deploy-checks",
      ACCEPT_LABEL
    );
    accept.click();
    await waitForText(
      canvasElement,
      "opt-in-row-dist-deploy-checks",
      "Couldn't install Deploy Preview Checks. Try again, or ask your admin to re-share it."
    );
  },
};

/**
 * Four pending pushes at once — an org that shared more than
 * `MAX_VISIBLE_ROWS` (2) packs in one reconcile. The first two render as
 * their own rows; the rest collapse into one "N more" summary that points at
 * Plugins instead of stacking an unbounded wall of bars above the content.
 */
export const OverflowCollapsed = {
  render: () =>
    renderScenario({
      caption: "Four pending, two visible - the rest collapse into one row.",
      distributions: [
        makeDistribution({
          id: "dist-pr-review",
          name: "PR Review Assistant",
          targetKind: "skill",
        }),
        makeDistribution({
          id: "dist-release-notes",
          name: "Release Notes Generator",
          targetKind: "plugin",
        }),
        makeDistribution({
          id: "dist-deploy-checks",
          name: "Deploy Preview Checks",
          targetKind: "command",
        }),
        makeDistribution({
          id: "dist-onboarding-coach",
          name: "New Hire Onboarding Coach",
          targetKind: "agent",
          coaching: true,
        }),
      ],
    }),
};

/**
 * How many times each bridge call fired, so a play function can prove WHICH
 * install path actually ran rather than only that the row settled — both
 * `catalogInstall` and `coachingInstall` end the same way (`dismiss`), so the
 * row disappearing alone cannot tell the two paths apart.
 */
type BridgeCallCounts = {
  catalog: number;
  coaching: number;
  decline: number;
};

function freshBridgeCallCounts(): BridgeCallCounts {
  return { catalog: 0, coaching: 0, decline: 0 };
}

// Set by each story's own `render` on every mount, and read back by that same
// story's `play`. Module-scoped because `render`'s return value is JSX, not a
// place to hand a fixture's call counters to the play function that follows
// it — this mirrors how `installDesktopApiFixture` already reaches the
// component under test, through `window.desktopApi`, rather than props.
let coachingPackPendingCalls: BridgeCallCounts = freshBridgeCallCounts();
let dismissedCalls: BridgeCallCounts = freshBridgeCallCounts();

/**
 * A single pending coaching-pack distribution, alone rather than 4th in a
 * pile — `OverflowCollapsed` never renders or clicks its own coaching
 * fixture, since it always lands past `MAX_VISIBLE_ROWS` (2) in that story's
 * four-item list. Accept must route through the dedicated `coachingInstall`
 * bridge instead of the generic `catalogInstall` path.
 */
export const CoachingPackPending = {
  render: () => {
    const calls = freshBridgeCallCounts();
    coachingPackPendingCalls = calls;
    return renderScenario(
      {
        caption:
          "One coaching-pack distribution - Accept routes through coachingInstall, not the generic catalog path.",
        distributions: [
          makeDistribution({
            id: "dist-onboarding-coach",
            name: "New Hire Onboarding Coach",
            targetKind: "agent",
            coaching: true,
          }),
        ],
      },
      calls
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const accept = await waitForControl(
      canvasElement,
      "opt-in-row-dist-onboarding-coach",
      ACCEPT_LABEL
    );
    accept.click();
    // A successful accept dismisses the row (same as the generic path), so
    // the row disappearing is what proves the call actually settled instead
    // of rejecting into the row-scoped error state.
    await waitForRowGone(canvasElement, "opt-in-row-dist-onboarding-coach");

    if (coachingPackPendingCalls.coaching !== 1) {
      throw new Error(
        `Expected coachingInstall to fire once, got ${coachingPackPendingCalls.coaching}`
      );
    }
    if (coachingPackPendingCalls.catalog !== 0) {
      throw new Error(
        `catalogInstall fired ${coachingPackPendingCalls.catalog} time(s) for a coaching-pack distribution - the coaching path must never fall through to the generic catalog install`
      );
    }
  },
};

/**
 * Dismiss pressed on a pending row - the previously-unexercised persisted-
 * decline path (FEA-4050): the row disappears immediately AND the decline is
 * recorded via `declineDistribution` so a restart does not re-push the same
 * offer.
 */
export const Dismissed = {
  render: () => {
    const calls = freshBridgeCallCounts();
    dismissedCalls = calls;
    return renderScenario(
      {
        caption:
          "Dismiss pressed - the row disappears and the decline persists via declineDistribution.",
        distributions: [
          makeDistribution({
            id: "dist-pr-review",
            name: "PR Review Assistant",
            targetKind: "skill",
          }),
        ],
      },
      calls
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const dismiss = await waitForControl(
      canvasElement,
      "opt-in-row-dist-pr-review",
      DISMISS_LABEL
    );
    dismiss.click();
    await waitForRowGone(canvasElement, "opt-in-row-dist-pr-review");

    if (dismissedCalls.decline !== 1) {
      throw new Error(
        `Expected declineDistribution to fire once, got ${dismissedCalls.decline}`
      );
    }
  },
};

function makeDistribution({
  id,
  name,
  targetKind,
  coaching = false,
}: {
  id: string;
  name: string;
  targetKind: string;
  coaching?: boolean;
}): OptInDistributionDto {
  return {
    id,
    mode: DistributionMode.OptIn,
    catalogItem: { id: `catalog-${id}`, name, targetKind, coaching },
  };
}

type BannerScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  distributions: OptInDistributionDto[];
  /** Parks a click's install call mid-flight instead of ever settling. */
  installNeverResolves?: boolean;
  /** Rejects a click's install call, exercising the inline error path. */
  installRejects?: boolean;
};

function installDesktopApiFixture(
  scenario: BannerScenario,
  calls?: BridgeCallCounts
): void {
  const install = (kind: "catalog" | "coaching") => {
    if (calls) {
      calls[kind] += 1;
    }
    if (scenario.installNeverResolves) {
      return new Promise<void>(() => undefined);
    }
    if (scenario.installRejects) {
      return Promise.reject(new Error("story: install rejected"));
    }
    return Promise.resolve();
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        catalogInstall: () => install("catalog"),
        coachingInstall: () => install("coaching"),
        declineDistribution: () => {
          if (calls) {
            calls.decline += 1;
          }
          return Promise.resolve();
        },
        ensureDistributionAssigned: () => Promise.resolve(),
        acknowledgeDistributionHandled: () => Promise.resolve(),
      },
      // Fires synchronously on subscribe, the same shape the main-process
      // reconcile push takes on mount.
      onDistributionsOptInAvailable: (
        callback: (distributions: OptInDistributionDto[]) => void
      ) => {
        callback(scenario.distributions);
        return () => undefined;
      },
    },
    writable: true,
  });
}

function renderScenario(
  scenario: BannerScenario,
  calls?: BridgeCallCounts
): ReactNode {
  installDesktopApiFixture(scenario, calls);
  return (
    <FeatureFlagAdapterProvider adapter={FLAG_ON_ADAPTER}>
      <div className="flex flex-col">
        <OptInDistributionsBanner />
        <p className="px-4 py-3 text-muted-foreground text-sm">
          {scenario.caption}
        </p>
      </div>
    </FeatureFlagAdapterProvider>
  );
}

function findControl(
  root: HTMLElement,
  rowTestId: string,
  label: string
): HTMLElement | null {
  const row = root.querySelector(`[data-testid="${rowTestId}"]`);
  if (!row) {
    return null;
  }
  const buttons = row.querySelectorAll<HTMLElement>("button");
  for (const button of buttons) {
    if (button.textContent?.trim() === label) {
      return button;
    }
  }
  return null;
}

async function waitForControl(
  root: HTMLElement,
  rowTestId: string,
  label: string
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    const control = findControl(root, rowTestId, label);
    if (control) {
      return control;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${label}" never appeared in row "${rowTestId}"`);
}

async function waitForText(
  root: HTMLElement,
  rowTestId: string,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    const row = root.querySelector(`[data-testid="${rowTestId}"]`);
    if (row?.textContent?.includes(text)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${text}" never appeared in row "${rowTestId}"`);
}

/**
 * A settled accept or dismiss removes its row entirely (`dismiss` filters it
 * out of `pending`), so proving either path actually completed means waiting
 * for the row to be gone rather than for any text change inside it.
 */
async function waitForRowGone(
  root: HTMLElement,
  rowTestId: string
): Promise<void> {
  for (let attempt = 0; attempt < CONTROL_POLL_ATTEMPTS; attempt++) {
    if (!root.querySelector(`[data-testid="${rowTestId}"]`)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CONTROL_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`Row "${rowTestId}" never disappeared`);
}
