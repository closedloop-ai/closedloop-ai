/**
 * ISS-5508: "Start Building" greys out while a run is in flight, and after
 * ISS-5474 / PR #4605 nothing on screen said why.
 *
 * Every assertion here is on the ACCESSIBLE contract — accessible description,
 * accessible name, `aria-disabled` — never on a class name or a `title`
 * attribute, because a `title` on a `disabled` button is exactly the treatment
 * the ticket rules out.
 */
import type { GenerationStatus } from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RUN_IN_FLIGHT_REASON } from "../../run-action-availability";
import { BranchesSection } from "../branches-section";

vi.mock("../overflow-menu", () => ({
  OverflowMenu: () => <div data-testid="overflow-menu" />,
}));

vi.mock("../select-pr-dialog", () => ({
  SelectPullRequestDialog: () => null,
}));

// The section's data hooks reach the API client; the states under test are
// driven entirely by `generationStatus`, so hold the link/PR reads at empty so
// the zero-branch "Start Building" path is the one that renders.
vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: () => ({ data: [] }),
  useDeleteArtifactLink: () => ({ mutate: vi.fn() }),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentPullRequest: () => ({ data: [] }),
}));

const LOOP_VOCABULARY = /loop/i;
/** Copy that would assert execution, which a deferred run has not begun. */
const EXECUTION_VOCABULARY = /in progress|running|started/i;

const EXECUTING: GenerationStatus = {
  status: "RUNNING",
  command: "execute",
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
};

const OTHER_COMMAND_RUNNING: GenerationStatus = {
  ...EXECUTING,
  command: "plan",
};

/**
 * A run that EXISTS but has not started (PR #4714 review, wongk).
 *
 * `mapLoopStatus` folds both `LoopStatus.Pending` and `LoopStatus.Blocked` onto
 * "PENDING" — deliberately, so a blocker-deferred dispatch stays visible rather
 * than vanishing — and neither has been claimed, so `startedAt` is null. This is
 * the state that makes "a run is in progress" a false claim and is why the copy
 * asserts existence instead; it is also the state a narrower "only explain
 * RUNNING" gate would silently stop explaining.
 */
const DEFERRED: GenerationStatus = { ...EXECUTING, status: "PENDING" };

const FINISHED: GenerationStatus = { ...EXECUTING, status: "SUCCESS" };

function renderSection(opts: {
  explainEnabled: boolean;
  generationStatus?: GenerationStatus;
  onStartBuild?: () => void;
}) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      opts.explainEnabled &&
      key === ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY,
  };

  return render(
    <BranchesSection
      documentId="doc-1"
      generationStatus={opts.generationStatus}
      onStartBuild={opts.onStartBuild ?? vi.fn()}
      planId="plan-1"
      projectId="project-1"
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NavigationProvider adapter={nav.adapter}>
          <FeatureFlagAdapterProvider adapter={adapter}>
            {children}
          </FeatureFlagAdapterProvider>
        </NavigationProvider>
      ),
    }
  );
}

function startBuilding() {
  return screen.getByRole("button", { name: "Start Building" });
}

describe("BranchesSection — why Start Building is unavailable (ISS-5508)", () => {
  it("gives the disabled control an accessible description naming the cause", () => {
    renderSection({ explainEnabled: true, generationStatus: EXECUTING });

    // The load-bearing assertion: the reason is reachable through the
    // accessibility tree, not merely painted next to the button.
    expect(startBuilding()).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
  });

  it("keeps the unavailable control focusable and refuses activation", async () => {
    const onStartBuild = vi.fn();
    const user = userEvent.setup();
    renderSection({
      explainEnabled: true,
      generationStatus: EXECUTING,
      onStartBuild,
    });

    const button = startBuilding();
    // `aria-disabled`, NOT `disabled` — a native disabled button is out of the
    // tab order and its description never reaches a screen-reader user.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onStartBuild).not.toHaveBeenCalled();
  });

  it("explains a deferred run that has not started, and does not claim it has", () => {
    renderSection({ explainEnabled: true, generationStatus: DEFERRED });

    expect(DEFERRED.startedAt).toBeNull();
    expect(startBuilding()).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    // The copy may report that a run exists; it may not report execution the
    // status cannot back. Asserted with the explanation genuinely on screen
    // above, so this cannot pass on a build that renders nothing.
    expect(RUN_IN_FLIGHT_REASON).not.toMatch(EXECUTION_VOCABULARY);
  });

  it("says nothing when no run is in flight", () => {
    // The other direction. Without it this suite would pass on a build that
    // always renders the explanation.
    renderSection({ explainEnabled: true, generationStatus: undefined });

    expect(startBuilding()).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    expect(startBuilding()).not.toBeDisabled();
  });

  it("says nothing for a finished run or a run of a different command", () => {
    const finished = renderSection({
      explainEnabled: true,
      generationStatus: FINISHED,
    });
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    finished.unmount();

    renderSection({
      explainEnabled: true,
      generationStatus: OTHER_COMMAND_RUNNING,
    });
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  it("is closed by default — flag off keeps the native disabled button", () => {
    renderSection({ explainEnabled: false, generationStatus: EXECUTING });

    const button = startBuilding();
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  it("revives no Loop vocabulary on the surface", () => {
    const { container } = renderSection({
      explainEnabled: true,
      generationStatus: EXECUTING,
    });

    // Asserted with the explanation genuinely on screen, so this cannot pass
    // vacuously on a build that renders nothing.
    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(LOOP_VOCABULARY);
    expect(container.querySelector('a[href*="/loops/"]')).toBeNull();
  });

  it("announces the explanation when it appears under the pressed button", () => {
    // The user pressed "Start Building"; focus is still on it when the poll
    // flips seconds later, and adding `aria-describedby` to an already-focused
    // element is not re-announced. This one instance needs a live region.
    renderSection({ explainEnabled: true, generationStatus: EXECUTING });

    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).toHaveAttribute(
      "role",
      "status"
    );
  });

  it("drops the explanation when the poll flips the run to a terminal state", () => {
    // The production path: the component stays MOUNTED and the status changes
    // under it. Every other case here renders a fresh tree with the terminal
    // status already set, which would not catch a value cached across renders.
    const { rerender } = renderSection({
      explainEnabled: true,
      generationStatus: EXECUTING,
    });
    expect(startBuilding()).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);

    rerender(
      <BranchesSection
        documentId="doc-1"
        generationStatus={FINISHED}
        onStartBuild={vi.fn()}
        planId="plan-1"
        projectId="project-1"
      />
    );

    expect(startBuilding()).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(startBuilding()).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });
});
