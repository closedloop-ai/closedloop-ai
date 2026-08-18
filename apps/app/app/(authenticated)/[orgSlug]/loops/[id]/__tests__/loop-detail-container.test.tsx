/**
 * Tests the loop-detail breadcrumb (FEA-3979): it names the loop by its
 * command + artifact identity rather than the generic "Loop Detail", holds a
 * short-id placeholder while the loop (and its artifact title) load, and still
 * names the terminal error / not-found shells by short id.
 */

import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseLoop = vi.fn();
const mockUseDocument = vi.fn();

// The loaded container mounts sub-components (UserLink) that read the org slug
// from the route param via the navigation adapter, so drive `useParams`.
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  usePathname: vi.fn(() => "/test-org/loops/loop_abcdef123456"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Header renders each breadcrumb entry as a `breadcrumb-entry` testid so the
// test can assert the leaf reads the loop identity; stubbed to avoid the real
// SidebarTrigger, which needs a SidebarProvider.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({
    breadcrumbs,
    children,
  }: {
    breadcrumbs: { label: string; href?: string }[];
    children?: ReactNode;
  }) => (
    <nav aria-label="Breadcrumb">
      {breadcrumbs.map((entry) => (
        <span
          data-href={entry.href ?? ""}
          data-testid="breadcrumb-entry"
          key={entry.label}
        >
          {entry.label}
        </span>
      ))}
      {children}
    </nav>
  ),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "test-org",
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoop: (id: string) => mockUseLoop(id),
  useLoopEventsPaginated: vi.fn(() => ({ data: undefined })),
  useResumeLoop: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocument: (id: string | null) => mockUseDocument(id),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useCancelLoop: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: vi.fn(() => ({ navigate: vi.fn() })),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: vi.fn(() => ({ enabled: false })),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(() => false),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Heavy leaf panels are irrelevant to the breadcrumb — stub them out.
vi.mock("@repo/app/loops/components/loop-progress-panel", () => ({
  LoopProgressPanel: () => <div data-testid="loop-progress-panel" />,
}));

vi.mock("@repo/app/loops/components/loop-audit-log", () => ({
  LoopAuditLog: () => <div data-testid="loop-audit-log" />,
}));

// Import after mocks.
import { createMockLoopWithUser } from "@repo/app/shared/test-fixtures/loops";
import { LoopDetailContainer } from "../loop-detail-container";

const LOOP_ID = "loop_abcdef123456";
const SHORT_ID = "loop_abc";

function loadedLoop(overrides = {}) {
  return createMockLoopWithUser({
    id: LOOP_ID,
    status: LoopStatus.Completed,
    command: LoopCommand.Execute,
    documentId: "doc_1",
    ...overrides,
  });
}

/** A settled `useDocument` result carrying the given artifact title. */
function settledDocument(title: string | undefined) {
  return { data: title ? { title } : undefined, isFetched: true };
}

/**
 * A settled `useDocument` result for a *routable* PRD (title + type + slug), so
 * `getDocumentRoute` resolves a real parent-crumb route. ISS-4477: the loop's
 * producing document is the loop-detail breadcrumb's parent now that the Loops
 * list crumb is gone.
 */
function settledRoutableDocument(title: string, slug: string) {
  return {
    data: { title, type: DocumentType.Prd, slug },
    isFetched: true,
  };
}

function breadcrumbLabels(): string[] {
  return screen
    .getAllByTestId("breadcrumb-entry")
    .map((node) => node.textContent ?? "");
}

describe("LoopDetailContainer breadcrumb (FEA-3979)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no artifact fetch in flight (document-less loops).
    mockUseDocument.mockReturnValue({ data: undefined, isFetched: true });
  });

  it("names the loop by command noun plus artifact title when both are loaded", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop(),
      isLoading: false,
      error: null,
    });
    mockUseDocument.mockReturnValue(
      settledDocument("FEA-3979: Fix breadcrumb")
    );

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain("Code: FEA-3979: Fix breadcrumb");
    expect(labels).not.toContain("Loop Detail");
  });

  // ISS-4477: the Loops list crumb is gone; the loop's producing document is now
  // the parent crumb (the back path) with the loop label as the leaf.
  it("crumbs the producing document as the parent, linking to its route", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop(),
      isLoading: false,
      error: null,
    });
    mockUseDocument.mockReturnValue(
      settledRoutableDocument("PRD: Retire Loops", "prd-retire-loops")
    );

    render(<LoopDetailContainer id={LOOP_ID} />);

    const entries = screen.getAllByTestId("breadcrumb-entry");
    // Parent crumb first (the document), loop label as the leaf.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("PRD: Retire Loops");
    expect(entries[0]).toHaveAttribute(
      "data-href",
      "/test-org/prds/prd-retire-loops"
    );
    expect(entries[1]).toHaveTextContent("Code: PRD: Retire Loops");
    // Never a "Loops" list crumb (the retired list page).
    expect(breadcrumbLabels()).not.toContain("Loops");
  });

  it("renders a single leaf crumb for a document-less loop (no dead parent)", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop({ documentId: null }),
      isLoading: false,
      error: null,
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    expect(screen.getAllByTestId("breadcrumb-entry")).toHaveLength(1);
  });

  it("appends a short id for a document-less loop so the bare noun is unique", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop({ documentId: null }),
      isLoading: false,
      error: null,
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Code ${SHORT_ID}`);
    expect(labels).not.toContain("Loop Detail");
  });

  it("names a manual (document-less) loop with the Manual noun, not raw MANUAL", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop({ command: LoopCommand.Manual, documentId: null }),
      isLoading: false,
      error: null,
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Manual ${SHORT_ID}`);
    expect(labels).not.toContain(`MANUAL ${SHORT_ID}`);
  });

  it("holds the short-id placeholder while the artifact title is still loading", () => {
    mockUseLoop.mockReturnValue({
      data: loadedLoop(),
      isLoading: false,
      error: null,
    });
    // documentId is set but the title query has not settled — do not flash the
    // bare noun before the titled label.
    mockUseDocument.mockReturnValue({ data: undefined, isFetched: false });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Loop ${SHORT_ID}`);
    expect(labels).not.toContain("Code");
    expect(labels).not.toContain("Loop Detail");
  });

  it("shows a short-id placeholder while the loop record loads — not the generic label", () => {
    mockUseLoop.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Loop ${SHORT_ID}`);
    expect(labels).not.toContain("Loop Detail");
    expect(labels).not.toContain("undefined");
  });

  it("names the terminal error shell by short id", () => {
    mockUseLoop.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "boom" },
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Loop ${SHORT_ID}`);
    expect(labels).not.toContain("Loop Detail");
  });

  it("names the not-found shell by short id", () => {
    mockUseLoop.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).toContain(`Loop ${SHORT_ID}`);
    expect(labels).not.toContain("Loop Detail");
  });

  it("drops the retired Loops list crumb (ISS-4477)", () => {
    // The "Loops" list surface is removed from nav & UI, so the detail
    // breadcrumb no longer carries a "Loops" crumb linking back to it.
    mockUseLoop.mockReturnValue({
      data: loadedLoop(),
      isLoading: false,
      error: null,
    });
    mockUseDocument.mockReturnValue(
      settledDocument("FEA-3979: Fix breadcrumb")
    );

    render(<LoopDetailContainer id={LOOP_ID} />);

    const labels = breadcrumbLabels();
    expect(labels).not.toContain("Loops");
  });
});
