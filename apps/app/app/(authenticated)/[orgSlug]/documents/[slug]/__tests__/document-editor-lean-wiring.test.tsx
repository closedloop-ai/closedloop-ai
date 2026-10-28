/**
 * ISS-8939 AC2: the generic-Document editor is a CONFIGURATION of the one
 * shared scaffold, not a second editor.
 *
 * `packages/app/.../document-editor-lean-doc-configuration.test.tsx` proves the
 * scaffold HONORS the lean settings. This suite proves the production DOC
 * surface actually SELECTS them — without it, `DocumentEditor` could stop
 * passing any of the literals below and that suite would stay green, because it
 * mirrors them in a harness of its own rather than reading them from here.
 */

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type {
  DocumentEditorScaffoldProps,
  ScaffoldSlotContext,
} from "@repo/app/documents/components/document-editor-scaffold";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
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
// provider tree, unrelated to which header the slot returns.
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

vi.mock("@repo/app/documents/components/use-comment-permalink-builder", () => ({
  useCommentPermalinkBuilder: () => vi.fn(),
}));

const scaffoldProbe = vi.hoisted(() => ({
  props: undefined as DocumentEditorScaffoldProps | undefined,
}));
vi.mock("@repo/app/documents/components/document-editor-scaffold", () => ({
  DocumentEditorScaffold: (props: DocumentEditorScaffoldProps) => {
    scaffoldProbe.props = props;
    return null;
  },
}));

import { DocumentEditor } from "@repo/app/documents/editors/documents/detail/document-editor";

const DOC: DocumentDetail = {
  id: "doc-1",
  title: "Onboarding",
  slug: "onboarding",
  type: DocumentType.Doc,
  status: DocumentStatus.Draft,
  projectId: null,
  latestVersion: 1,
} as unknown as DocumentDetail;

function renderEditor(): DocumentEditorScaffoldProps {
  render(
    <DocumentEditor
      currentVersion={1}
      document={DOC}
      onVersionChange={vi.fn()}
    />
  );
  const props = scaffoldProbe.props;
  if (!props) {
    throw new Error("DocumentEditor did not mount the shared scaffold");
  }
  return props;
}

describe("DocumentEditor lean configuration wiring (ISS-8939)", () => {
  test("mounts the shared scaffold rather than a Document-only editor", () => {
    expect(renderEditor()).toBeDefined();
  });

  test("suppresses the repositories placeholder in the metadata bar", () => {
    expect(renderEditor().hideRepositoriesInMetadataBar).toBe(true);
  });

  test("suppresses Move to Project", () => {
    expect(renderEditor().hideMoveAction).toBe(true);
  });

  test("contributes no PRD/Plan detail sections", () => {
    const props = renderEditor();
    // Called, not merely present: a slot that returns something would put PRD
    // workflow chrome back on the page.
    expect(
      props.detailsSections({} as Parameters<typeof props.detailsSections>[0])
    ).toBeNull();
  });

  test("opens a blank latest version ready to type", () => {
    expect(renderEditor().startInEditModeWhenEmpty).toBe(true);
  });

  test("breadcrumbs back to the Documents index on delete", () => {
    expect(renderEditor().redirectPath).toBe("/acme/documents");
  });

  // The remaining literals `DocumentEditor` hardcodes. The sibling scaffold
  // suite mirrors these values in its own harness, so without an assertion here
  // the surface could pass a PRD's identity — its feed scope, its delete copy,
  // its persisted panel layout — and both suites would stay green.
  test("names the artifact as a Document in its own delete copy and feed scope", () => {
    const props = renderEditor();

    expect(props.deleteDialogTitle).toBe("Document");
    expect(props.feedArtifactType).toBe(FeedArtifactType.Doc);
  });

  // The blank page this surface opens into is the one place the placeholder is
  // read, so falling back to the scaffold default would greet a new Document
  // with the PRD/Plan wording ("Add description...").
  test("prompts a blank Document to be written, not described", () => {
    expect(renderEditor().emptyContentPlaceholder).toBe("Start writing...");
  });
});

const FLAGS_OFF = {
  useFeatureFlagEnabled: () => false,
};

/**
 * The slot context the scaffold hands `renderHeader`, reduced to the members
 * this surface's slot actually reads. The header's own panel toggle is a
 * locator only the lean header owns, and it serves as a positive control beside
 * the absence assertions.
 */
function headerSlotContext(isViewingHistorical: boolean): ScaffoldSlotContext {
  return {
    actions: { handleCopy: vi.fn(), handleDownload: vi.fn() },
    chrome: {
      openDeleteDialog: vi.fn(),
      showMetadataPanel: false,
      toggleMetadataPanel: vi.fn(),
    },
    contentController: { restoreVersion: vi.fn() },
    session: { isViewingHistorical },
  } as unknown as ScaffoldSlotContext;
}

function renderHeaderSlot({ isViewingHistorical = false } = {}) {
  const { renderHeader } = renderEditor();

  render(
    <FeatureFlagAdapterProvider adapter={FLAGS_OFF}>
      <SidebarProvider>
        {renderHeader(headerSlotContext(isViewingHistorical))}
      </SidebarProvider>
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The assertions above read the scaffold's props without ever INVOKING the
 * header slot, so swapping the production slot to a PRD/Plan workflow header
 * would leave every one of them green (PR #6603 review, whitlockk). These run it.
 */
describe("DocumentEditor header slot (ISS-8939)", () => {
  test("mounts the lean Document header, not a PRD/Plan workflow header", () => {
    renderHeaderSlot();

    // Locators only this header renders: the slot produced a real, mounted
    // header.
    expect(
      screen.getByRole("button", { name: "More options" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle side panel" })
    ).toBeInTheDocument();
  });

  test("passes the historical-version flag through, so Restore Version is offered", async () => {
    const user = userEvent.setup();
    renderHeaderSlot({ isViewingHistorical: true });

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.getByRole("menuitem", { name: "Restore Version" })
    ).toBeInTheDocument();
  });

  test("offers no Restore Version while the latest version is open", async () => {
    const user = userEvent.setup();
    renderHeaderSlot({ isViewingHistorical: false });

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.queryByRole("menuitem", { name: "Restore Version" })
    ).not.toBeInTheDocument();
    // Same menu, opposite state: it did open, so the absence is real.
    expect(
      screen.getByRole("menuitem", { name: "Delete Document" })
    ).toBeInTheDocument();
  });
});
