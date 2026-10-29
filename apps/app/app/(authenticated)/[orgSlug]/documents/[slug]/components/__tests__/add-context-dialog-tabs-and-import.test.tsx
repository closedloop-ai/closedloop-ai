/**
 * ISS-9714 — coverage for the Upload File tab, the tab-reset-on-close effect,
 * and the Link Existing tab's project-gating + dialog-close paths in
 * AddContextDialog. The sibling
 * `add-context-dialog.test.tsx` only exercises the default Link Existing tab
 * (evergreen-Document linking); this file drives the rest of the component.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { RenderOptions } from "@testing-library/react";
import { render as renderDOM, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@repo/navigation/use-org-path", async (importOriginal) =>
  importOriginal()
);

const mocks = vi.hoisted(() => ({
  useFeatureFlag: vi.fn(),
  useDocuments: vi.fn(),
  createLinkMutate: vi.fn(),
  useCreateContextAttachment: vi.fn(),
  uploadToS3: vi.fn(),
  toastSuccess: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: mocks.useFeatureFlag,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: mocks.useDocuments,
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
  useCreateContextAttachment: mocks.useCreateContextAttachment,
}));

vi.mock("@repo/app/shared/lib/s3-upload", () => ({
  uploadToS3: mocks.uploadToS3,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
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

// cmdk (the Command list in SelectDocumentDialog) needs ResizeObserver, which
// jsdom does not implement. Stubbed per-test and unstubbed in afterEach so this
// suite does not change the environment for unrelated tests in the same worker.
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

import { AddContextDialog } from "@repo/app/documents/editors/issues/detail/components/add-context-dialog";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";

const FEATURE_ID = "feat-1";
const PROJECT_ID = "proj-1";

const RE_NOT_ASSOCIATED_WITH_PROJECT = /not associated with a project/i;
const RE_BROWSE_PRDS = /Browse PRDs/i;
const RE_BROWSE_DOCUMENTS = /Browse Documents/i;
const RE_UPLOADING = /Uploading/i;

const PRD_FIXTURE = {
  id: "prd-1",
  title: "PRD One",
  slug: "PRD-1",
  type: DocumentType.Prd,
};
const EVERGREEN_DOC = {
  id: "doc-1",
  title: "Company Brand Guide",
  slug: "DOC-1",
  type: DocumentType.Doc,
};

function renderDialog(
  overrides: Partial<ComponentProps<typeof AddContextDialog>> = {}
) {
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const utils = render(
    <AddContextDialog
      excludeArtifactIds={new Set()}
      featureId={FEATURE_ID}
      onOpenChange={onOpenChange}
      open={true}
      projectId={PROJECT_ID}
      {...overrides}
    />,
    { wrapper: WebFeatureFlagProvider }
  );
  return { onOpenChange, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  mocks.useFeatureFlag.mockReturnValue({ enabled: false });
  mocks.useDocuments.mockReturnValue({ data: [], isLoading: false });
  mocks.useCreateContextAttachment.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddContextDialog — tabs and tab reset", () => {
  test("offers only Link Existing and Upload File even with the google-drive flag on", () => {
    mocks.useFeatureFlag.mockReturnValue({ enabled: true });
    renderDialog();

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.getByRole("tab", { name: "Link Existing" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Upload File" })
    ).toBeInTheDocument();
  });

  test("resets to the Link Existing tab once the dialog closes and reopens", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender, onOpenChange } = renderDialog({ open: true });

    await user.click(screen.getByRole("tab", { name: "Upload File" }));
    expect(await screen.findByLabelText("File")).toBeInTheDocument();

    rerender(
      <AddContextDialog
        excludeArtifactIds={new Set()}
        featureId={FEATURE_ID}
        onOpenChange={onOpenChange}
        open={false}
        projectId={PROJECT_ID}
      />
    );
    rerender(
      <AddContextDialog
        excludeArtifactIds={new Set()}
        featureId={FEATURE_ID}
        onOpenChange={onOpenChange}
        open={true}
        projectId={PROJECT_ID}
      />
    );

    expect(
      await screen.findByRole("button", { name: RE_BROWSE_PRDS })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("File")).not.toBeInTheDocument();
  });
});

describe("LinkExistingTab — PRD link availability", () => {
  test("shows the Browse PRDs button and no warning when the feature has a project", () => {
    renderDialog({ projectId: PROJECT_ID });

    expect(
      screen.getByRole("button", { name: RE_BROWSE_PRDS })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(RE_NOT_ASSOCIATED_WITH_PROJECT)
    ).not.toBeInTheDocument();
  });

  test("shows a warning instead of Browse PRDs when the feature has no project", () => {
    renderDialog({ projectId: undefined });

    expect(
      screen.queryByRole("button", { name: RE_BROWSE_PRDS })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(RE_NOT_ASSOCIATED_WITH_PROJECT)
    ).toBeInTheDocument();
  });
});

describe("LinkExistingTab — creating links and dialog close behavior", () => {
  beforeEach(() => {
    mocks.createLinkMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });
  });

  test("selecting a PRD creates a Produces link and closes the dialog on success", async () => {
    mocks.useDocuments.mockImplementation(
      (params: { type: string; projectId?: string }) =>
        params.type === DocumentType.Prd
          ? { data: [PRD_FIXTURE], isLoading: false }
          : { data: [], isLoading: false }
    );
    const user = userEvent.setup({ delay: null });
    const { onOpenChange } = renderDialog({ projectId: PROJECT_ID });

    await user.click(screen.getByRole("button", { name: RE_BROWSE_PRDS }));
    const option = await screen.findByText("PRD One");
    await user.click(option);

    expect(mocks.createLinkMutate).toHaveBeenCalledWith(
      {
        sourceId: PRD_FIXTURE.id,
        targetId: FEATURE_ID,
        linkType: LinkType.Produces,
      },
      expect.any(Object)
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("selecting a Document creates a RelatesTo link and closes the dialog on success", async () => {
    mocks.useDocuments.mockImplementation(
      (params: { type: string; projectId?: string }) =>
        params.type === DocumentType.Doc
          ? { data: [EVERGREEN_DOC], isLoading: false }
          : { data: [], isLoading: false }
    );
    const user = userEvent.setup({ delay: null });
    const { onOpenChange } = renderDialog({ projectId: PROJECT_ID });

    await user.click(screen.getByRole("button", { name: RE_BROWSE_DOCUMENTS }));
    const option = await screen.findByText("Company Brand Guide");
    await user.click(option);

    expect(mocks.createLinkMutate).toHaveBeenCalledWith(
      {
        sourceId: EVERGREEN_DOC.id,
        targetId: FEATURE_ID,
        linkType: LinkType.RelatesTo,
      },
      expect.any(Object)
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("closing the PRD picker without selecting notifies onOpenChange and creates no link", async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpenChange } = renderDialog({
      projectId: PROJECT_ID,
      open: true,
    });

    await user.click(screen.getByRole("button", { name: RE_BROWSE_PRDS }));
    const dialog = await screen.findByRole("dialog", { name: "Select PRD" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(
      await screen.findByRole("button", { name: RE_BROWSE_PRDS })
    ).toBeInTheDocument();
    // `open` here is LinkExistingTab's own `open` prop (dialog open && tab
    // active), which is `true` for this render.
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(mocks.createLinkMutate).not.toHaveBeenCalled();
  });

  test("closing the Document picker without selecting notifies onOpenChange and creates no link", async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpenChange } = renderDialog({
      projectId: PROJECT_ID,
      open: true,
    });

    await user.click(screen.getByRole("button", { name: RE_BROWSE_DOCUMENTS }));
    const dialog = await screen.findByRole("dialog", {
      name: "Select Document",
    });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(
      await screen.findByRole("button", { name: RE_BROWSE_DOCUMENTS })
    ).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(mocks.createLinkMutate).not.toHaveBeenCalled();
  });
});

describe("UploadFileTab", () => {
  async function openUploadTab(
    overrides: Partial<ComponentProps<typeof AddContextDialog>> = {}
  ) {
    const user = userEvent.setup({ delay: null });
    const result = renderDialog(overrides);
    await user.click(screen.getByRole("tab", { name: "Upload File" }));
    await screen.findByLabelText("File");
    return { user, ...result };
  }

  test("disables Upload until a file is chosen", async () => {
    await openUploadTab();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  test("disables Upload and shows the spinner label while the mutation is pending", async () => {
    mocks.useCreateContextAttachment.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: true,
    });
    const { user } = await openUploadTab();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File"), file);

    expect(screen.getByRole("button", { name: RE_UPLOADING })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Upload" })
    ).not.toBeInTheDocument();
  });

  test("clears the selected file, and re-disables Upload, when the file input selection is emptied", async () => {
    const { user } = await openUploadTab();
    const input = screen.getByLabelText("File") as HTMLInputElement;
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await user.upload(input, file);
    expect(screen.getByRole("button", { name: "Upload" })).not.toBeDisabled();

    await user.upload(input, [] as unknown as File[]);
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  test("uploads the file, invalidates the attachments query, toasts, and closes the dialog", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      uploadUrl: "https://s3.example.com/put",
      artifactId: "artifact-1",
      attachmentId: "attachment-1",
    });
    mocks.useCreateContextAttachment.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    mocks.uploadToS3.mockResolvedValue(undefined);
    const { user, onOpenChange } = await openUploadTab({
      projectId: PROJECT_ID,
    });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File"), file);

    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: file.size,
      projectId: PROJECT_ID,
    });
    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      "https://s3.example.com/put",
      file,
      "text/plain"
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["attachments", FEATURE_ID],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("File uploaded as context");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("shows the S3 error message and does not toast or close when the S3 PUT rejects with an Error", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      uploadUrl: "https://s3.example.com/put",
      artifactId: "artifact-1",
      attachmentId: "attachment-1",
    });
    mocks.useCreateContextAttachment.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    mocks.uploadToS3.mockRejectedValue(new Error("S3 exploded"));
    const { user, onOpenChange } = await openUploadTab();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("S3 exploded");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("falls back to a generic message when the S3 PUT rejects with a non-Error value", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      uploadUrl: "https://s3.example.com/put",
      artifactId: "artifact-1",
      attachmentId: "attachment-1",
    });
    mocks.useCreateContextAttachment.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    mocks.uploadToS3.mockRejectedValue("network gone");
    const { user } = await openUploadTab();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to upload file"
    );
  });

  test("silently swallows a createAttachment rejection without toasting, erroring, or closing", async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error("db down"));
    mocks.useCreateContextAttachment.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    const { user, onOpenChange } = await openUploadTab();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("File"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(mutateAsync).toHaveBeenCalled();
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

function render(ui: ReactNode, options?: RenderOptions) {
  const OriginalWrapper = options?.wrapper;
  const navigation = createMemoryNavigation({ orgSlug: "acme" });
  return renderDOM(ui, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={navigation.adapter}>
        {OriginalWrapper ? (
          <OriginalWrapper>{children}</OriginalWrapper>
        ) : (
          children
        )}
      </NavigationProvider>
    ),
  });
}
