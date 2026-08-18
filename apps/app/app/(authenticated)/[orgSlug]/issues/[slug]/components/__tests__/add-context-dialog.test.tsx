/**
 * FEA-3951: the Context "Link Existing" tab can reference an evergreen Document
 * (DocumentType.Doc) as long-term context for a FEAT/PRD, alongside the
 * existing PRD link. Selecting a Document must create a `LinkType.RelatesTo`
 * artifact link from the Document (source) to the feature (target).
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLinkMutate: vi.fn(),
  useDocuments: vi.fn(),
  useFeatureFlag: vi.fn(),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: mocks.useFeatureFlag,
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useCreateArtifactLink: () => ({
    mutate: mocks.createLinkMutate,
    isPending: false,
  }),
}));

vi.mock("@repo/app/documents/hooks/use-attachments", () => ({
  attachmentKeys: { list: (id: string) => ["attachments", id] },
}));

vi.mock("@repo/app/documents/hooks/use-context-attachments", () => ({
  useCreateContextAttachment: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useImportGDriveContext: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: mocks.useDocuments,
}));

vi.mock("@repo/app/google/hooks/use-google-integration", () => ({
  // The Google Docs tab is disabled in these tests (feature flag off), so this
  // exported regex is never matched against — it only needs to be a valid
  // RegExp so the module contract holds. Defined inline here because a
  // top-level literal cannot be referenced from this hoisted factory (TDZ).
  // biome-ignore lint/performance/useTopLevelRegex: hoisted mock factory; value never executed
  GDRIVE_FOLDER_ID_REGEX: /^[a-zA-Z0-9_-]{28,40}$/,
  useGDriveFolderFiles: () => ({ data: [], isLoading: false, isError: false }),
  useGoogleIntegrationStatus: () => ({ data: { connected: false } }),
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

// cmdk (the Command list in SelectDocumentDialog) needs ResizeObserver, which
// jsdom does not implement.
class MockResizeObserver {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

import { AddContextDialog } from "../add-context-dialog";

const FEATURE_ID = "feat-1";
const PROJECT_ID = "proj-1";
const RE_BROWSE_DOCUMENTS = /Browse Documents/i;
const RE_BROWSE_PRDS = /Browse PRDs/i;
const EVERGREEN_DOC = {
  id: "doc-1",
  title: "Company Brand Guide",
  slug: "DOC-1",
  type: DocumentType.Doc,
};

function renderDialog(projectId: string | undefined) {
  return render(
    <AddContextDialog
      excludeArtifactIds={new Set()}
      featureId={FEATURE_ID}
      onOpenChange={vi.fn()}
      open={true}
      projectId={projectId}
    />
  );
}

describe("AddContextDialog — link evergreen Document as context (FEA-3951)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // gdrive tab hidden by default.
    mocks.useFeatureFlag.mockReturnValue({ enabled: false });
    // The evergreen-doc picker lists DocumentType.Doc org-wide.
    mocks.useDocuments.mockImplementation(
      (params: { type: string; projectId?: string }) =>
        params.type === DocumentType.Doc
          ? { data: [EVERGREEN_DOC], isLoading: false }
          : { data: [], isLoading: false }
    );
  });

  test("selecting a Document creates a RelatesTo link to the feature", async () => {
    const user = userEvent.setup();
    renderDialog(PROJECT_ID);

    await user.click(screen.getByRole("button", { name: RE_BROWSE_DOCUMENTS }));

    // The evergreen-doc picker opens and lists the org-wide Document.
    const option = await screen.findByText("Company Brand Guide");
    await user.click(option);

    await waitFor(() => {
      expect(mocks.createLinkMutate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createLinkMutate).toHaveBeenCalledWith(
      {
        sourceId: EVERGREEN_DOC.id,
        targetId: FEATURE_ID,
        linkType: LinkType.RelatesTo,
      },
      expect.any(Object)
    );
  });

  test("lists Documents org-wide (not scoped to the feature's project)", async () => {
    const user = userEvent.setup();
    renderDialog(PROJECT_ID);

    await user.click(screen.getByRole("button", { name: RE_BROWSE_DOCUMENTS }));
    await screen.findByText("Company Brand Guide");

    // orgWide → the Doc query must omit projectId so org-level docs surface.
    const docCall = mocks.useDocuments.mock.calls.find(
      ([params]) => params.type === DocumentType.Doc
    );
    expect(docCall?.[0].projectId).toBeUndefined();
  });

  test("offers the Document link even when the feature has no project", () => {
    renderDialog(undefined);

    // PRD link is project-gated (warning shown); the Document link is not.
    expect(
      screen.getByRole("button", { name: RE_BROWSE_DOCUMENTS })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_BROWSE_PRDS })
    ).not.toBeInTheDocument();
  });
});
