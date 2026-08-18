/**
 * ISS-5508: the header run actions grey out while a run is in flight, and after
 * ISS-5474 / PR #4605 nothing on screen said why.
 *
 * Assertions are on the ACCESSIBLE contract — accessible description, accessible
 * name, `aria-disabled`, and real keyboard reachability — never on a class name
 * or a `title`, since a `title` on a `disabled` item is the treatment the ticket
 * explicitly rules out.
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
  usePathname: () => "/acme/issues/ship-the-thing",
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

import { IssueEditorHeader } from "../issue-editor-header";

const LOOP_VOCABULARY = /loop/i;

const FEATURE: DocumentWithProject = {
  id: "feature-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.Feature,
  status: DocumentStatus.InReview,
  project: null,
} as unknown as DocumentWithProject;

/**
 * `evaluate_feature` on purpose, not `execute`.
 *
 * `issue-editor.tsx` feeds this header `useDocumentGenerationStatus(feature.id)`,
 * and the only loop `apps/app` dispatches against a FEATURE id is
 * `RunLoopCommand.EvaluateFeature` — `plan` and `execute` are dispatched against
 * the linked PLAN's id (`usePlanActions({ documentId: linkedPlanId })`). Driving
 * these cases with `command: "execute"` would assert a state this surface cannot
 * reach. See ISS-5758 for the pre-existing wiring defect behind that.
 */
const EVALUATING: GenerationStatus = {
  status: "RUNNING",
  command: "evaluate_feature",
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
};

const FINISHED: GenerationStatus = { ...EVALUATING, status: "SUCCESS" };

function renderHeader(opts: {
  explainEnabled: boolean;
  generationStatus?: GenerationStatus;
  generationStatusLoading?: boolean;
  isEvaluating?: boolean;
  onEvaluateFeature?: () => void;
}) {
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      opts.explainEnabled &&
      key === ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY,
  };

  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <SidebarProvider>
        <IssueEditorHeader
          displayTitle="Ship the thing"
          feature={FEATURE}
          generationStatus={opts.generationStatus}
          generationStatusLoading={opts.generationStatusLoading ?? false}
          hasPlan={true}
          isEvaluating={opts.isEvaluating ?? false}
          isReady={true}
          onDelete={vi.fn()}
          onEvaluateFeature={opts.onEvaluateFeature ?? vi.fn()}
          onGeneratePlan={vi.fn()}
          onMoveToProject={vi.fn()}
          onStartBuild={vi.fn()}
          onToggleMetadataPanel={vi.fn()}
        />
      </SidebarProvider>
    </FeatureFlagAdapterProvider>
  );
}

async function openActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Actions" }));
}

function evaluateItem() {
  return screen.getByRole("menuitem", { name: "Evaluate Issue" });
}

describe("IssueEditorHeader — why a run action is unavailable (ISS-5508)", () => {
  test("gives the unavailable item an accessible description naming the cause", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: true, generationStatus: EVALUATING });
    await openActions(user);

    expect(evaluateItem()).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    // The item's own name is untouched — the cause is a description, not a
    // suffix smuggled into the label the way `— last run failed` was.
    expect(evaluateItem()).toHaveAccessibleName("Evaluate Issue");
  });

  test("the unavailable item stays keyboard-reachable and refuses activation", async () => {
    const onEvaluateFeature = vi.fn();
    const user = userEvent.setup();
    renderHeader({
      explainEnabled: true,
      generationStatus: EVALUATING,
      onEvaluateFeature,
    });
    await openActions(user);

    const item = evaluateItem();
    // `aria-disabled`, NOT Radix's `disabled` — Radix drops a `disabled` item
    // from the menu's roving focus (`data-disabled`), so a description hung off
    // one is unreachable by keyboard. Arrowing into the menu must land on it.
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toHaveAttribute("data-disabled");

    // Generate Plan is natively disabled (a plan exists) so Radix skips it;
    // Start Building is the first stop and this item is the second. Reaching it
    // by arrow key at all is the whole point of `aria-disabled`.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(item).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onEvaluateFeature).not.toHaveBeenCalled();
    // Refusing the select keeps the menu open, so the explanation stays visible.
    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).toBeInTheDocument();
  });

  test("only the running command's item is explained", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: true, generationStatus: EVALUATING });
    await openActions(user);

    // Start Building is a different command, so it must carry no description —
    // this pins that the cause is per-item and not menu-wide.
    expect(
      screen.getByRole("menuitem", { name: "Start Building" })
    ).not.toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
  });

  test("says nothing when no run is in flight", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: true, generationStatus: undefined });
    await openActions(user);

    // The other direction — without it this suite passes on a build that always
    // renders the explanation.
    expect(evaluateItem()).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("says nothing for a finished run, nor while the status fetch is loading", async () => {
    const user = userEvent.setup();
    const finished = renderHeader({
      explainEnabled: true,
      generationStatus: FINISHED,
    });
    await openActions(user);
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    finished.unmount();

    // `isCommandDisabled` also greys the item out while the status poll is
    // loading. That says nothing about whether a run exists, so claiming one is
    // in flight there would be the same lie in the other direction.
    renderHeader({
      explainEnabled: true,
      generationStatus: undefined,
      generationStatusLoading: true,
    });
    await openActions(user);
    expect(evaluateItem()).toBeInTheDocument();
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("is closed by default — flag off keeps the native disabled item", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: false, generationStatus: EVALUATING });
    await openActions(user);

    const item = evaluateItem();
    // Radix's own `disabled`, exactly as it shipped before ISS-5508 — and the
    // reason this is a defect: arrowing through the menu skips straight past it,
    // so there is nowhere a keyboard or screen-reader user could hear a cause.
    expect(item).toHaveAttribute("data-disabled");
    // Arrowing the whole menu never reaches it: Start Building is the only
    // focusable stop, so focus stays there however far you arrow.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(item).not.toHaveFocus();
    expect(
      screen.getByRole("menuitem", { name: "Start Building" })
    ).toHaveFocus();
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("revives no Loop vocabulary in the actions menu", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: true, generationStatus: EVALUATING });
    await openActions(user);

    const menu = screen.getByRole("menu");
    // Asserted with the explanation genuinely on screen, so it cannot pass
    // vacuously on a build that renders nothing.
    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).toBeInTheDocument();
    expect(menu.textContent ?? "").not.toMatch(LOOP_VOCABULARY);
  });

  test("stays silent when the run is NOT the only thing blocking the item", async () => {
    const user = userEvent.setup();
    // The user's own evaluate click is still in flight, which the run finishing
    // does not settle. Naming the run there would explain the wrong cause and
    // outlive it — the same lie as the loading case, from the other side.
    renderHeader({
      explainEnabled: true,
      generationStatus: EVALUATING,
      isEvaluating: true,
    });
    await openActions(user);

    const item = screen.getByRole("menuitem", { name: "Evaluating Issue..." });
    expect(item).toHaveAttribute("data-disabled");
    expect(item).not.toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("the menu note is not a live region", async () => {
    const user = userEvent.setup();
    renderHeader({ explainEnabled: true, generationStatus: EVALUATING });
    await openActions(user);

    // A menu is opened AFTER the run started, so the description is read on
    // focus. A live region here would re-announce on every menu open.
    expect(screen.getByText(RUN_IN_FLIGHT_REASON)).not.toHaveAttribute(
      "role",
      "status"
    );
  });
});
