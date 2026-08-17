import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ISS-4382: the DOC editor header is intentionally lean — no PRD/Plan "Actions"
// workflow menu, no Move (a DOC is org-level and cannot live in a project), and
// no standalone Rename dialog (the inline EditableDocumentTitle owns renaming).
// These tests render the real header and assert that observable structure plus
// its action callbacks, so a regression that re-adds Move/Rename or re-disables
// the panel toggle on save fails here.

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

// The shared Header renders a MobileSearchOverlay that pulls in the auth/API
// provider tree, unrelated to the action-menu structure under test.
vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// FavoriteButton wraps favorites hooks that reach the API client; stub it so the
// test stays focused on the header's action-menu structure.
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: ({ artifactId }: { artifactId: string }) => (
    <button
      aria-label="Add to favorites"
      data-testid="favorite-button"
      type="button"
    >
      {artifactId}
    </button>
  ),
}));

import { DocumentEditorHeader } from "../document-editor-header";

const RE_RENAME = /rename/i;
const RE_MOVE = /move/i;

const DOCUMENT: DocumentWithProject = {
  id: "doc-1",
  title: "Onboarding",
  slug: "onboarding",
  type: DocumentType.Doc,
  status: DocumentStatus.Draft,
  projectId: null,
  project: null,
} as unknown as DocumentWithProject;

type HeaderOverrides = {
  showRestore?: boolean;
  canShowPanel?: boolean;
  isMetadataPanelOpen?: boolean;
  onCopyMarkdown?: () => void;
  onExportMarkdown?: () => void;
  onRestoreVersion?: () => void;
  onDelete?: () => void;
  onToggleMetadataPanel?: () => void;
};

function renderHeader(overrides: HeaderOverrides = {}) {
  const props = {
    onCopyMarkdown: vi.fn(),
    onExportMarkdown: vi.fn(),
    onRestoreVersion: vi.fn(),
    onDelete: vi.fn(),
    onToggleMetadataPanel: vi.fn(),
    ...overrides,
  };
  render(
    <SidebarProvider>
      <DocumentEditorHeader
        canShowPanel={overrides.canShowPanel ?? true}
        document={DOCUMENT}
        isMetadataPanelOpen={overrides.isMetadataPanelOpen ?? false}
        onCopyMarkdown={props.onCopyMarkdown}
        onDelete={props.onDelete}
        onExportMarkdown={props.onExportMarkdown}
        onRestoreVersion={props.onRestoreVersion}
        onToggleMetadataPanel={props.onToggleMetadataPanel}
        showRestore={overrides.showRestore ?? false}
      />
    </SidebarProvider>
  );
  return props;
}

describe("DocumentEditorHeader (ISS-4382)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders the overflow menu and favorite star, with no PRD/Plan Actions menu", () => {
    renderHeader();

    expect(
      screen.getAllByRole("button", { name: "More options" })
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Add to favorites" })
    ).toBeInTheDocument();
    // A generic document has no generation pipeline, so no "Actions" menu.
    expect(
      screen.queryByRole("button", { name: "Actions" })
    ).not.toBeInTheDocument();
  });

  test("overflow menu keeps content actions but omits Move and Rename", async () => {
    const user = userEvent.setup();
    renderHeader();

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
    // Move is forbidden for an org-level DOC; Rename is owned by the inline
    // title. Neither is offered here.
    expect(
      screen.queryByRole("menuitem", { name: RE_MOVE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: RE_RENAME })
    ).not.toBeInTheDocument();
  });

  test("omits the Restore Version item when viewing the latest version", async () => {
    const user = userEvent.setup();

    renderHeader({ showRestore: false });
    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.queryByRole("menuitem", { name: "Restore Version" })
    ).not.toBeInTheDocument();
  });

  test("shows Restore Version and fires its callback when viewing a historical version", async () => {
    const user = userEvent.setup();
    const restore = vi.fn();

    renderHeader({ showRestore: true, onRestoreVersion: restore });
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Restore Version" }));

    expect(restore).toHaveBeenCalledTimes(1);
  });

  test("Export, Copy, and Delete invoke their callbacks", async () => {
    const user = userEvent.setup();
    const props = renderHeader();

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Export Markdown" }));
    expect(props.onExportMarkdown).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    expect(props.onCopyMarkdown).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete Document" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  test("the side-panel toggle stays enabled and fires its callback", async () => {
    const user = userEvent.setup();
    const props = renderHeader();

    const toggle = screen.getByRole("button", { name: "Toggle side panel" });
    // Saving content must not grey out the rail toggle (it carries no disabled
    // state), so it is always clickable.
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    expect(props.onToggleMetadataPanel).toHaveBeenCalledTimes(1);
  });

  test("the side-panel toggle reflects the panel's open state via aria-expanded", () => {
    renderHeader({ isMetadataPanelOpen: false });
    expect(
      screen.getByRole("button", { name: "Toggle side panel" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  test("aria-expanded is true when the metadata panel is open", () => {
    renderHeader({ isMetadataPanelOpen: true });
    expect(
      screen.getByRole("button", { name: "Toggle side panel" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("hides the panel toggle when neither chat nor feed is available", () => {
    renderHeader({ canShowPanel: false });

    expect(
      screen.queryByRole("button", { name: "Toggle side panel" })
    ).not.toBeInTheDocument();
  });
});
