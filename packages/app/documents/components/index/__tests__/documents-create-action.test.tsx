import {
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { GenericArtifactStatus } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// FEA-4345: DocumentsCreateAction is the org-level Documents page's first-class
// "New Document" entry point. A Document is a type-agnostic, org-level artifact
// that does NOT require a project, so the action always renders (no project
// gate) and opens the type-agnostic NewDocumentModal (mocked here to a marker
// that surfaces its props and can drive onSuccess).

const mocks = vi.hoisted(() => ({
  newDocumentModalProps: vi.fn(),
  recoverableModalProps: vi.fn(),
  featureFlagEnabled: vi.fn((_key: string) => false),
}));

// ISS-8938: the action is the ONE place the create flow reads
// `documents-create-failure-recovery`, and the read picks between two whole
// dialogs. Closed by default here, matching what a real user sees.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mocks.featureFlagEnabled(key),
}));

vi.mock(
  "@repo/app/documents/components/new-document-modal-recoverable",
  () => ({
    NewDocumentModalRecoverable: (props: { open: boolean }) => {
      mocks.recoverableModalProps(props);
      return <div data-testid="recoverable-modal" />;
    },
  })
);

// The modal is the canonical create flow; here it is a marker that records its
// props (so the test asserts the wiring) and exposes a button to drive its
// onSuccess callback, without a query/DB/provider tree.
vi.mock("@repo/app/documents/components/new-document-modal", () => ({
  NewDocumentModal: (props: {
    open: boolean;
    onSuccess?: (artifact: Document) => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    mocks.newDocumentModalProps(props);
    return (
      <div data-testid="new-document-modal">
        <span data-testid="modal-open">{String(props.open)}</span>
        <button
          data-testid="fire-success"
          onClick={() =>
            props.onSuccess?.(
              createMockDocument({
                id: "doc-1",
                type: DocumentType.Doc,
                slug: "my-doc",
              })
            )
          }
          type="button"
        >
          success
        </button>
      </div>
    );
  },
}));

import {
  DocumentsCreateAction,
  DocumentsCreateProvider,
  useDocumentsCreateAction,
} from "@repo/app/documents/components/index/documents-create-action";
import { DOCUMENTS_CREATE_FAILURE_RECOVERY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

const NEW_DOCUMENT_REGEX = /new document/i;
const NEW_PRD_REGEX = /new prd/i;

describe("DocumentsCreateAction", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.featureFlagEnabled.mockReturnValue(false);
    cleanup();
  });

  it("opens the shipped dialog while the failure-recovery gate is closed", () => {
    render(<DocumentsCreateAction />);

    expect(mocks.featureFlagEnabled).toHaveBeenCalledWith(
      DOCUMENTS_CREATE_FAILURE_RECOVERY_FEATURE_FLAG_KEY
    );
    expect(screen.getByTestId("new-document-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("recoverable-modal")).toBeNull();
  });

  it("opens the recoverable dialog when the gate is open, and keeps the button either way", () => {
    mocks.featureFlagEnabled.mockReturnValue(true);
    render(<DocumentsCreateAction />);

    expect(screen.getByTestId("recoverable-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("new-document-modal")).toBeNull();
    // The create entry point itself is OUTSIDE the gate: it is shipped
    // behavior, and a closed-by-default gate over it would withdraw a live
    // capability rather than roll a new one out.
    expect(
      screen.getByRole("button", { name: NEW_DOCUMENT_REGEX })
    ).toBeInTheDocument();
  });

  it("keeps the arm it opened with when the flag resolves mid-dialog", () => {
    // PostHog answers false until it resolves. Without a latch this rerender
    // unmounts one modal and mounts the other, taking the typed title, the
    // rendered rejection, and the in-flight guard with it — a user who had just
    // been refused would lose the title they were about to retry.
    const { rerender } = render(<DocumentsCreateAction />);
    fireEvent.click(screen.getByRole("button", { name: NEW_DOCUMENT_REGEX }));
    expect(screen.getByTestId("modal-open")).toHaveTextContent("true");

    mocks.featureFlagEnabled.mockReturnValue(true);
    rerender(<DocumentsCreateAction />);

    // Still the arm the dialog opened with, still open.
    expect(screen.getByTestId("new-document-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("recoverable-modal")).toBeNull();
    expect(screen.getByTestId("modal-open")).toHaveTextContent("true");
  });

  it("follows the resolved flag again once the dialog has closed", () => {
    // The falsifier for the latch above: it holds for the life of an OPEN
    // dialog, it does not pin the arm for the life of the page.
    const { rerender } = render(<DocumentsCreateAction />);
    fireEvent.click(screen.getByRole("button", { name: NEW_DOCUMENT_REGEX }));

    mocks.featureFlagEnabled.mockReturnValue(true);
    rerender(<DocumentsCreateAction />);
    const lastProps = mocks.newDocumentModalProps.mock.calls.at(-1)?.[0];
    act(() => {
      lastProps.onOpenChange(false);
    });

    expect(screen.getByTestId("recoverable-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("new-document-modal")).toBeNull();
  });

  it("names the action 'New Document' (type-agnostic, not 'New PRD')", () => {
    render(<DocumentsCreateAction />);
    expect(
      screen.getByRole("button", { name: NEW_DOCUMENT_REGEX })
    ).toBeInTheDocument();
    // The old PRD-specific label must be gone.
    expect(screen.queryByRole("button", { name: NEW_PRD_REGEX })).toBeNull();
  });

  it("always renders the create action — no project gate — since org documents need no project", () => {
    // No useProjects mock, no project data: the action still renders. A missing
    // project must not suppress creation the way the old PRD gate did.
    render(<DocumentsCreateAction />);
    expect(
      screen.getByRole("button", { name: NEW_DOCUMENT_REGEX })
    ).toBeInTheDocument();
  });

  it("opens the type-agnostic New Document modal when invoked", () => {
    render(<DocumentsCreateAction />);

    // Closed until invoked.
    expect(screen.getByTestId("modal-open")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: NEW_DOCUMENT_REGEX }));

    expect(screen.getByTestId("modal-open")).toHaveTextContent("true");
    const lastProps = mocks.newDocumentModalProps.mock.calls.at(-1)?.[0];
    // No project/team is passed: this is an org-level create with no project
    // context, so the modal is not scoped to a project or team.
    expect(lastProps).not.toHaveProperty("projectId");
    expect(lastProps).not.toHaveProperty("teamId");
  });

  it("closes the modal when the modal reports onOpenChange(false)", () => {
    render(<DocumentsCreateAction />);
    fireEvent.click(screen.getByRole("button", { name: NEW_DOCUMENT_REGEX }));
    expect(screen.getByTestId("modal-open")).toHaveTextContent("true");

    const lastProps = mocks.newDocumentModalProps.mock.calls.at(-1)?.[0];
    act(() => {
      lastProps.onOpenChange(false);
    });

    expect(screen.getByTestId("modal-open")).toHaveTextContent("false");
  });

  it("does not wire an onSuccess into the modal — the modal owns routing, the action does not", async () => {
    render(<DocumentsCreateAction />);
    fireEvent.click(screen.getByRole("button", { name: NEW_DOCUMENT_REGEX }));

    // The action must NOT pass an onSuccess handler: routing to the created
    // document's detail page is the modal's responsibility, not this action's.
    // (An earlier version of this test asserted a spy that was never wired in —
    // a tautology; this asserts the actual prop contract instead.)
    const lastProps = mocks.newDocumentModalProps.mock.calls.at(-1)?.[0];
    expect(lastProps.onSuccess).toBeUndefined();

    // Driving the modal's own success path must not crash or unmount the action.
    fireEvent.click(screen.getByTestId("fire-success"));
    await waitFor(() => {
      expect(screen.getByTestId("new-document-modal")).toBeInTheDocument();
    });
  });
});

function BoardCreateAction() {
  const onRequestCreate = useDocumentsCreateAction();
  return (
    <button
      onClick={() => onRequestCreate?.(GenericArtifactStatus.InReview)}
      type="button"
    >
      Board create
    </button>
  );
}

describe("DocumentsCreateProvider", () => {
  it("shares one recoverable dialog between the header and board entry points", () => {
    mocks.featureFlagEnabled.mockReturnValue(true);
    render(
      <DocumentsCreateProvider>
        <DocumentsCreateAction label="Add document" />
        <BoardCreateAction />
      </DocumentsCreateProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Board create" }));
    expect(screen.getAllByTestId("recoverable-modal")).toHaveLength(1);
    expect(mocks.recoverableModalProps.mock.calls.at(-1)?.[0]).toMatchObject({
      open: true,
      initialStatus: DocumentStatus.InReview,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add document" }));
    expect(screen.getAllByTestId("recoverable-modal")).toHaveLength(1);
    expect(
      mocks.recoverableModalProps.mock.calls.at(-1)?.[0].initialStatus
    ).toBe(DocumentStatus.Draft);
  });
});
