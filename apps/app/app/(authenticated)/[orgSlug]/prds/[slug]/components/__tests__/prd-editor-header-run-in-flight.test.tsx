/**
 * ISS-5508: the PRD header's run actions grey out while a run is in flight.
 *
 * The shared `RunActionMenuItem` behavior is proven by the issue-header suite;
 * what is only reachable HERE is this header's own per-item "the run is the only
 * blocker" predicate. Every guard on this header is a LOCAL MUTATION pending
 * flag, and unlike the plan header those do not disable the Actions trigger — so
 * each one is genuinely observable, and dropping it would turn a menu item into
 * a promise that never comes true.
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
  usePathname: () => "/acme/prds/ship-the-thing",
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

// "Amend PRD" only renders when the PRD request-changes flag is on, and that
// flag is read through the analytics port. Drive it from the fixture so both the
// item-present and item-absent cases are reachable.
const amendFlagEnabled = { current: true };
vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: amendFlagEnabled.current }),
}));

import { PRDEditorHeader } from "../prd-editor-header";

const LOOP_VOCABULARY = /loop/i;

const PRD: DocumentWithProject = {
  id: "prd-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.Prd,
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
  amendEnabled?: boolean;
  explainEnabled?: boolean;
  generationStatus?: GenerationStatus;
  isEvaluating?: boolean;
  isGenerating?: boolean;
  isRequestingChanges?: boolean;
}) {
  amendFlagEnabled.current = opts.amendEnabled ?? true;
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      (opts.explainEnabled ?? true) &&
      key === ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY,
  };

  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <SidebarProvider>
        <PRDEditorHeader
          generationStatus={opts.generationStatus}
          isEvaluating={opts.isEvaluating ?? false}
          isGenerating={opts.isGenerating ?? false}
          isRequestingChanges={opts.isRequestingChanges ?? false}
          onDecomposeFeatures={vi.fn()}
          onDelete={vi.fn()}
          onEvaluatePrd={vi.fn()}
          onExport={vi.fn()}
          onGeneratePlan={vi.fn()}
          onGeneratePrd={vi.fn()}
          onMove={vi.fn()}
          onRename={vi.fn()}
          onRequestChanges={vi.fn()}
          onToggleMetadataPanel={vi.fn()}
          prd={PRD}
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

describe("PRDEditorHeader — why a run action is unavailable (ISS-5508)", () => {
  test.each([
    ["Generate PRD", "generate_prd"],
    ["Evaluate PRD", "evaluate_prd"],
    ["Amend PRD", "request_prd_changes"],
  ] as const)("%s is explained for its own run, and only its own", async (label, command) => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: running(command) });
    await openActions(user);

    expect(item(label)).toHaveAccessibleDescription(RUN_IN_FLIGHT_REASON);
    expect(item(label)).toHaveAttribute("aria-disabled", "true");
    // Decompose into Issues is never gated by a run, so it pins that the
    // description is per-item rather than menu-wide.
    expect(item("Decompose into Issues")).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
  });

  test("Generate PRD is NOT explained while its own mutation is pending", async () => {
    const user = userEvent.setup();
    // The item relabels to "Generating PRD..." — a different, honest cause. A
    // run finishing does not settle the click already in flight.
    renderHeader({
      generationStatus: running("generate_prd"),
      isGenerating: true,
    });
    await openActions(user);

    expect(item("Generating PRD...")).toHaveAttribute("data-disabled");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("Evaluate PRD is NOT explained while its own mutation is pending", async () => {
    const user = userEvent.setup();
    renderHeader({
      generationStatus: running("evaluate_prd"),
      isEvaluating: true,
    });
    await openActions(user);

    expect(item("Evaluating PRD...")).toHaveAttribute("data-disabled");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("Amend PRD is NOT explained while either of its mutations is pending", async () => {
    const user = userEvent.setup();
    const amending = renderHeader({
      generationStatus: running("request_prd_changes"),
      isRequestingChanges: true,
    });
    await openActions(user);
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    amending.unmount();

    // Its guard is `!(isGenerating || isRequestingChanges)` — the second term
    // has to be covered too or half the predicate is unpinned.
    renderHeader({
      generationStatus: running("request_prd_changes"),
      isGenerating: true,
    });
    await openActions(user);
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("says nothing when no run is in flight", async () => {
    const user = userEvent.setup();
    renderHeader({ generationStatus: undefined });
    await openActions(user);

    expect(item("Generate PRD")).toBeInTheDocument();
    expect(item("Generate PRD")).not.toHaveAccessibleDescription(
      RUN_IN_FLIGHT_REASON
    );
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });

  test("is closed by default and revives no Loop vocabulary", async () => {
    const user = userEvent.setup();
    const off = renderHeader({
      explainEnabled: false,
      generationStatus: running("generate_prd"),
    });
    await openActions(user);
    expect(item("Generate PRD")).toHaveAttribute("data-disabled");
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
    off.unmount();

    renderHeader({ generationStatus: running("generate_prd") });
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
    // "Amend PRD" is behind its own flag. With that flag off the item is absent,
    // so a `request_prd_changes` run must leave the menu silent — otherwise the
    // footer explains an unavailability nothing on screen exhibits.
    renderHeader({
      amendEnabled: false,
      generationStatus: running("request_prd_changes"),
    });
    await openActions(user);

    expect(
      screen.queryByRole("menuitem", { name: "Amend PRD" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RUN_IN_FLIGHT_REASON)).not.toBeInTheDocument();
  });
});
