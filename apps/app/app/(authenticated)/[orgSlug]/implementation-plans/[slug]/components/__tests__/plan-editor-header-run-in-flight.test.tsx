/**
 * ISS-5508: the plan header's run actions grey out while a run is in flight.
 *
 * The shared `RunActionMenuItem` behavior is proven by the issue-header suite;
 * what is only reachable HERE is this header's own per-item "the run is the only
 * blocker" predicate. Without these cases, dropping `&& isApproved` from the
 * Execute guard or `&& !isPending` from the rest leaves the suite green while
 * the menu promises an availability that never arrives.
 */
import type {
  DocumentWithProject,
  GenerationStatus,
} from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { RUN_IN_FLIGHT_REASON } from "@repo/app/documents/components/run-action-availability";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/acme/implementation-plans/ship-the-thing",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "ship-the-thing" }),
}));

vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));

// The header reads `branch-pr` through the analytics port; it is unrelated to
// the run-availability treatment, so hold it off.
vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: false }),
}));

import { PlanEditorHeader } from "../plan-editor-header";

const LOOP_VOCABULARY = /loop/i;

const PLAN: DocumentWithProject = {
  id: "plan-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.ImplementationPlan,
  status: DocumentStatus.InReview,
  project: null,
} as unknown as DocumentWithProject;

function running(command: GenerationStatus["command"]): GenerationStatus {
  return {
    status: "RUNNING",
    command,
    htmlUrl: null,
    startedAt: null,
    completedAt: null,
    correlationId: null,
  };
}

function renderHeader(opts: {
  canEvaluateCode?: boolean;
  explainEnabled?: boolean;
  generationStatus?: GenerationStatus;
  isApproved?: boolean;
  isExecuting?: boolean;
  isPending?: boolean;
}) {
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      (opts.explainEnabled ?? true) &&
      key === ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY,
  };

  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <SidebarProvider>
        <PlanEditorHeader
          generationStatus={opts.generationStatus}
          isApproved={opts.isApproved ?? true}
          isDraft={false}
          isExecuting={opts.isExecuting ?? false}
          isPending={opts.isPending ?? false}
          onApprove={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onDelete={vi.fn()}
          onEvaluateCode={(opts.canEvaluateCode ?? true) ? vi.fn() : undefined}
          onEvaluatePlan={vi.fn()}
          onExecute={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportToLinear={vi.fn()}
          onMove={vi.fn()}
          onRegenerate={vi.fn()}
          onRequestChanges={vi.fn()}
          onToggleMetadataPanel={vi.fn()}
          plan={PLAN}
        />
      </SidebarProvider>
    </FeatureFlagAdapterProvider>
  );
}

async function openActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Actions" }));
}

function item(name: string) {
  return screen.getByRole("menuitem", { name });
}

describe("PlanEditorHeader — why a run action is unavailable (ISS-5508)", () => {
  test("Execute is explained when an execute run is the only blocker", async () => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: running("execute") });
    await openActions(user);

    expect(item("Execute")).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    expect(item("Execute")).toHaveAttribute("aria-disabled", "true");
    expect(item("Execute")).not.toHaveAttribute("data-disabled");
  });

  test("Execute is NOT explained on an unapproved plan", async () => {
    const user = userEvent.setup();
    // The run finishing does not approve the plan, so promising availability
    // when it ends would be a lie the user reads as the fix not working.
    renderHeader({ generationStatus: running("execute"), isApproved: false });
    await openActions(user);

    expect(item("Execute")).toHaveAttribute("data-disabled");
    expect(item("Execute")).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("Execute is NOT explained while its own mutation is pending", async () => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: running("execute"), isExecuting: true });
    await openActions(user);

    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test.each([
    ["Request Changes", "request_changes"],
    ["Regenerate Plan", "plan"],
    ["Evaluate Plan", "evaluate_plan"],
    ["Evaluate PR", "evaluate_code"],
  ] as const)("%s is explained for its own run, and only its own", async (label, command) => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: running(command) });
    await openActions(user);

    expect(item(label)).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    // Its siblings are unrelated commands and must stay unexplained, so this
    // pins the per-command wiring rather than "something in the menu says it".
    expect(item("Execute")).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
  });

  test("a pending mutation closes the whole menu, so no item can promise anything", () => {
    // Honest about what this pins: `isPending` disables the Actions TRIGGER, so
    // the per-item `&& !isPending` guards are belt-and-braces behind a menu that
    // cannot be opened. The reachable contract is the trigger, and that is what
    // is asserted — not a guard the menu makes unobservable.
    renderHeader({ generationStatus: running("plan"), isPending: true });

    expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("says nothing when no run is in flight", async () => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: undefined });
    await openActions(user);

    expect(item("Execute")).toBeInTheDocument();
    expect(item("Execute")).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("is closed by default and revives no Loop vocabulary", async () => {
    const user = userEvent.setup();
    const off = renderHeader({
      explainEnabled: false,
      generationStatus: running("execute"),
    });
    await openActions(user);
    expect(item("Execute")).toHaveAttribute("data-disabled");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    off.unmount();

    renderHeader({ generationStatus: running("execute") });
    await openActions(user);
    // Asserted with the explanation genuinely on screen, so absence cannot pass
    // vacuously on a build that renders nothing.
    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).toBeInTheDocument();
    expect(screen.getByRole("menu").textContent ?? "").not.toMatch(
      LOOP_VOCABULARY
    );
  });

  test("no note explains an item the menu is not rendering", async () => {
    const user = userEvent.setup();
    // "Evaluate PR" only exists when an evaluatable PR is present. With no
    // handler the item is absent, so an `evaluate_code` run must leave the menu
    // silent rather than explain an unavailability nothing on screen exhibits.
    renderHeader({
      canEvaluateCode: false,
      generationStatus: running("evaluate_code"),
    });
    await openActions(user);

    expect(
      screen.queryByRole("menuitem", { name: "Evaluate PR" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });
});
