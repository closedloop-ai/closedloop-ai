/** Retired workflow names must not appear in the generic Document overflow. */

import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
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
  usePathname: () => "/acme/documents/onboarding",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "onboarding" }),
}));

// The shared Header mounts a MobileSearchOverlay that pulls in the auth/API
// provider tree, unrelated to the action structure under test.
vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock(
  "@repo/app/documents/components/document-host-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/document-host-context")
    >()),
    useOrgSlug: () => "acme",
  })
);

vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));

import { DocumentEditorHeader } from "@repo/app/documents/editors/documents/detail/components/document-editor-header";

const ACTIONS_MENU_NAME = "Actions";

const DOC: DocumentWithProject = {
  id: "doc-1",
  title: "Onboarding",
  slug: "onboarding",
  type: DocumentType.Doc,
  status: DocumentStatus.Draft,
  projectId: null,
  project: null,
} as unknown as DocumentWithProject;

/**
 * Every PRD/Plan execution control ISS-8939 removes for generic Documents, each
 * named by the accessible name it actually renders under, and by which menu
 * opens it. Written as one table so the absence and presence cases are driven
 * by the SAME list and cannot fall out of step.
 *
 * This must enumerate the WHOLE `Actions` menu of `PlanEditorHeader`, not the
 * subset the ticket's prose happens to name: an item omitted here can leak into
 * the Document header with the whole suite still green (PR #6603 review, whitlockk
 * and tamsinb). That includes items the Plan header renders CONDITIONALLY —
 * `Evaluate PR` appears only when `onEvaluateCode` is passed, so
 * `renderPlanHeader` passes it; a table whose presence half is satisfied by the
 * Plan header not rendering the item either is the same false green.
 *
 * The Plan overflow's other conditional block is its `pullRequests` link list,
 * which is data-named (`<repo> PR #<n>`) rather than a fixed control, so it has
 * no stable locator to pin here.
 */
const WORKFLOW_CONTROLS = [
  { name: "Approve" },
  { name: "Execute" },
  { name: "Request Changes" },
  { name: "Regenerate Plan" },
  { name: "Evaluate Plan" },
  { name: "Evaluate PR" },
  { name: "Move..." },
] as const;

const FLAGS_OFF = {
  useFeatureFlagEnabled: () => false,
};

function renderDocHeader() {
  render(
    <FeatureFlagAdapterProvider adapter={FLAGS_OFF}>
      <SidebarProvider>
        <DocumentEditorHeader
          document={DOC}
          onCopyMarkdown={vi.fn()}
          onDelete={vi.fn()}
          onExportMarkdown={vi.fn()}
          onRestoreVersion={vi.fn()}
          onToggleMetadataPanel={vi.fn()}
        />
      </SidebarProvider>
    </FeatureFlagAdapterProvider>
  );
}

describe("generic Document editor header (ISS-8939)", () => {
  test("offers no PRD/Plan Actions menu at all", () => {
    renderDocHeader();

    expect(
      screen.queryByRole("button", { name: ACTIONS_MENU_NAME })
    ).not.toBeInTheDocument();
    // Proves the header rendered: its own overflow trigger is present, so the
    // absence above is a real omission and not an unmounted subtree.
    expect(
      screen.getByRole("button", { name: "More options" })
    ).toBeInTheDocument();
  });

  test.each(WORKFLOW_CONTROLS)(
    "$name is absent from the generic Document header",
    async ({ name }) => {
      const user = userEvent.setup();
      renderDocHeader();

      // Role-agnostic and taken BEFORE any menu opens, because the header's
      // `children` slot is where `PlanEditorHeader` mounts its own workflow menu.
      // A control leaked there is a plain button under no trigger named
      // "Actions", which a menuitem-only check inside the overflow would miss.
      expect(screen.queryByText(name)).not.toBeInTheDocument();

      // Then the overflow, the only menu this header has: a closed menu renders
      // no items either way, so it has to be opened to mean anything.
      await user.click(screen.getByRole("button", { name: "More options" }));

      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
  );

  test("keeps the lean content actions a generic Document does own", async () => {
    const user = userEvent.setup();
    renderDocHeader();

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.getByRole("menuitem", { name: "Export Markdown" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Copy Markdown" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete Document" })
    ).toBeInTheDocument();
  });
});
