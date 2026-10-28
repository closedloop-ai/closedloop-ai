import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import {
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useResolvedArtifactLinks: vi.fn(),
  useDeleteArtifactLink: vi.fn(),
  useDocumentAttachments: vi.fn(),
  useDeleteAttachment: vi.fn(),
  useDownloadAttachment: vi.fn(),
  downloadAttachmentMutate: vi.fn(),
  useDocumentsByProject: vi.fn(),
  useDocument: vi.fn(),
  deleteLinkMutate: vi.fn(),
  deleteAttachmentMutate: vi.fn(),
  AddContextDialog: vi.fn(
    (_props: {
      featureId: string;
      projectId: string | undefined;
      excludeArtifactIds: Set<string>;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => null
  ),
}));

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

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: mocks.useResolvedArtifactLinks,
  useDeleteArtifactLink: mocks.useDeleteArtifactLink,
}));

vi.mock("@repo/app/documents/hooks/use-attachments", () => ({
  useDeleteAttachment: mocks.useDeleteAttachment,
  useDocumentAttachments: mocks.useDocumentAttachments,
  useDownloadAttachment: mocks.useDownloadAttachment,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsByProject: mocks.useDocumentsByProject,
  useDocument: mocks.useDocument,
}));

vi.mock(
  "@repo/app/documents/editors/issues/detail/components/add-context-dialog",
  () => ({
    AddContextDialog: mocks.AddContextDialog,
  })
);

import { ContextSection } from "@repo/app/documents/editors/issues/detail/components/context-section";

const FEATURE_ID = "feature-1";
const PROJECT_ID = "project-1";
const RE_NO_CONTEXT_DOCUMENTS = /No context documents/i;
const RE_DELETE_REFERENCED_ATTACHMENT = /Delete referenced attachment/i;

function makeLinkedDoc(
  overrides: Partial<DocumentWithProject> = {}
): DocumentWithProject {
  return makeArtifact({
    id: "doc-1",
    projectId: PROJECT_ID,
    title: "Design Doc",
    slug: "PRD-1",
    type: DocumentType.Prd,
    status: DocumentStatus.Draft,
    ...overrides,
  });
}

function makeEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkEndpoint {
  return {
    id: "doc-1",
    organizationId: "org-1",
    projectId: PROJECT_ID,
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Design Doc",
    slug: "PRD-1",
    status: DocumentStatus.Draft,
    priority: null,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLink(
  sourceOverrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkWithEndpoints {
  const source = makeEndpoint(sourceOverrides);
  return {
    id: `link-${source.id}`,
    organizationId: "org-1",
    sourceId: source.id,
    targetId: FEATURE_ID,
    linkType: LinkType.RelatesTo,
    metadata: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    source,
    target: makeEndpoint({
      id: FEATURE_ID,
      subtype: ArtifactSubtype.Feature,
      name: "Ship the thing",
      slug: "FEA-1",
    }),
  };
}

function makeAttachment(
  overrides: Partial<FileAttachment> = {}
): FileAttachment {
  return {
    id: "att-1",
    artifactId: FEATURE_ID,
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2024-01-01T00:00:00.000Z",
    createdById: "user-1",
    ...overrides,
  };
}

function renderContextSection(
  projectId: string | undefined = PROJECT_ID,
  latestContent?: string
) {
  return render(
    <ContextSection
      featureId={FEATURE_ID}
      latestContent={latestContent}
      projectId={projectId}
    />
  );
}

describe("ContextSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useResolvedArtifactLinks.mockReturnValue({ data: [] });
    mocks.useDocumentAttachments.mockReturnValue({ data: [] });
    mocks.useDocumentsByProject.mockReturnValue({ data: [] });
    mocks.useDocument.mockReturnValue({ data: undefined });
    mocks.useDeleteArtifactLink.mockReturnValue({
      mutate: mocks.deleteLinkMutate,
    });
    mocks.useDeleteAttachment.mockReturnValue({
      mutate: mocks.deleteAttachmentMutate,
    });
    mocks.useDownloadAttachment.mockReturnValue({
      mutate: mocks.downloadAttachmentMutate,
    });
  });

  test("shows the empty state with an Add Documents action when there are no links or attachments", () => {
    renderContextSection();

    expect(screen.getByText(RE_NO_CONTEXT_DOCUMENTS)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add Documents" })
    ).toBeInTheDocument();
  });

  test("renders an ArtifactRow for each linked context document", () => {
    const docA = makeLinkedDoc({ id: "doc-a", title: "Design Doc" });
    const docB = makeLinkedDoc({ id: "doc-b", title: "Research Notes" });
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [makeLink({ id: "doc-a" }), makeLink({ id: "doc-b" })],
    });
    mocks.useDocumentsByProject.mockReturnValue({ data: [docA, docB] });

    renderContextSection();

    expect(screen.getByText("Design Doc")).toBeInTheDocument();
    expect(screen.getByText("Research Notes")).toBeInTheDocument();
  });

  test("renders an image thumbnail for an attachment with a previewUrl", () => {
    const attachment = makeAttachment({
      previewUrl: "https://cdn.example.com/preview.png",
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection();

    const image = screen.getByRole("img", { name: attachment.filename });
    expect(image).toHaveAttribute("src", attachment.previewUrl);
  });

  test("renders a file icon instead of a thumbnail for an attachment without a previewUrl", () => {
    const attachment = makeAttachment({
      filename: "notes.txt",
      previewUrl: undefined,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    const { container } = renderContextSection();

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".lucide-file")).toBeInTheDocument();
  });

  test("collapses the section body when the header is toggled", async () => {
    const user = userEvent.setup();
    renderContextSection();

    expect(
      screen.getByRole("button", { name: "Add Documents" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Context" }));

    expect(
      screen.queryByRole("button", { name: "Add Documents" })
    ).not.toBeInTheDocument();
  });

  test("clicking Add context opens AddContextDialog with open=true", async () => {
    const user = userEvent.setup();
    renderContextSection();

    await user.click(screen.getByRole("button", { name: "Add context" }));

    await waitFor(() => {
      const lastCall = mocks.AddContextDialog.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({
        open: true,
        featureId: FEATURE_ID,
      });
    });
  });

  test("renders a fallback row with slug and name for a linked document outside the feature's project", () => {
    const otherProjectDoc = makeLinkedDoc({
      id: "doc-other-project",
      title: "Other Project Doc",
    });
    // documentsById is built from useDocumentsByProject for the feature's own
    // project, so a doc belonging to a different project never appears in it —
    // the row must fall back to the resolved link's endpoint fields.
    mocks.useDocumentsByProject.mockReturnValue({ data: [otherProjectDoc] });
    mocks.useResolvedArtifactLinks.mockReturnValue({
      data: [
        makeLink({
          id: "doc-cross",
          slug: "PRD-99",
          name: "External Brand Guide",
        }),
      ],
    });
    mocks.useDocument.mockReturnValue({ data: undefined });

    renderContextSection();

    expect(screen.getByText("External Brand Guide")).toBeInTheDocument();
    expect(screen.getByText("PRD-99")).toBeInTheDocument();
  });

  // ISS-8036 acceptance 1: a context image could be seen but never saved — its
  // thumbnail opened a view URL and there was no download affordance at all.
  test("gives a context image attachment a working download control", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({
      previewUrl: "https://cdn.example.com/preview.png",
      purpose: AttachmentPurpose.Context,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection();

    await user.click(
      screen.getByRole("button", { name: `Download ${attachment.filename}` })
    );

    expect(mocks.downloadAttachmentMutate).toHaveBeenCalledWith({
      attachmentId: attachment.id,
      documentId: FEATURE_ID,
    });
  });

  // ISS-8036 acceptance 2, first half: an inline upload nothing references was
  // listed nowhere, so the owner had no cue the file existed.
  test("lists an unreferenced inline image, marked, with a download control", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({
      id: "00000000-0000-4000-8000-000000000009",
      filename: "pasted-screenshot.png",
      previewUrl: "https://cdn.example.com/pasted.png",
      purpose: AttachmentPurpose.Inline,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection(PROJECT_ID, "A body that references no images.");

    expect(screen.getByText("pasted-screenshot.png")).toBeInTheDocument();
    expect(screen.getByText("Inline")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: `Download ${attachment.filename}` })
    );

    expect(mocks.downloadAttachmentMutate).toHaveBeenCalledWith({
      attachmentId: attachment.id,
      documentId: FEATURE_ID,
    });
  });

  // ISS-8036 acceptance 2, second half: one the body DOES render must stay out
  // of the list, or every embedded image would be duplicated into the rail.
  test("omits an inline image the latest content already renders", () => {
    const attachment = makeAttachment({
      id: "00000000-0000-4000-8000-000000000009",
      filename: "pasted-screenshot.png",
      purpose: AttachmentPurpose.Inline,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection(
      PROJECT_ID,
      `![shot](${buildInlineAttachmentRef("00000000-0000-4000-8000-000000000009")})`
    );

    expect(screen.queryByText("pasted-screenshot.png")).not.toBeInTheDocument();
  });

  test("falls back to the empty state when filtering removes every attachment", () => {
    // The filter runs in ContextSection, above the empty-state gate — if it ran
    // inside ContextBody the section would render populated with zero rows.
    mocks.useDocumentAttachments.mockReturnValue({
      data: [
        makeAttachment({
          id: "00000000-0000-4000-8000-000000000009",
          purpose: AttachmentPurpose.Inline,
        }),
      ],
    });

    renderContextSection(
      PROJECT_ID,
      `![shot](${buildInlineAttachmentRef("00000000-0000-4000-8000-000000000009")})`
    );

    expect(screen.getByText(RE_NO_CONTEXT_DOCUMENTS)).toBeInTheDocument();
  });

  // Listing inline rows made this reachable for the first time: before ISS-8036
  // the rail showed `context` rows only, so it could never delete an image the
  // body renders. A bare prose ref counts — that is what the loose predicate is
  // for — so this row is listed AND referenced at the same time.
  test("confirms before deleting an attachment the latest content references", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({
      id: "00000000-0000-4000-8000-00000000000a",
      filename: "pasted-screenshot.png",
      purpose: AttachmentPurpose.Inline,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection(
      PROJECT_ID,
      `See ${buildInlineAttachmentRef("00000000-0000-4000-8000-00000000000a")} for the layout.`
    );

    await user.click(screen.getByRole("button", { name: "Remove attachment" }));

    expect(mocks.deleteAttachmentMutate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: RE_DELETE_REFERENCED_ATTACHMENT })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete attachment" }));

    expect(mocks.deleteAttachmentMutate).toHaveBeenCalledWith(attachment.id);
  });

  test("deletes an unreferenced attachment without a confirm step", async () => {
    const user = userEvent.setup();
    const attachment = makeAttachment({
      purpose: AttachmentPurpose.Context,
    });
    mocks.useDocumentAttachments.mockReturnValue({ data: [attachment] });

    renderContextSection(PROJECT_ID, "A body that references no attachments.");

    await user.click(screen.getByRole("button", { name: "Remove attachment" }));

    expect(mocks.deleteAttachmentMutate).toHaveBeenCalledWith(attachment.id);
    expect(
      screen.queryByRole("heading", { name: RE_DELETE_REFERENCED_ATTACHMENT })
    ).not.toBeInTheDocument();
  });
});
