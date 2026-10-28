import {
  type CreateDocumentInput,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
} from "@repo/app/shared/api/api-timeout";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-8938 (PRD-695 §3): the flag-ON arm of the one-field create flow. What it
// CREATES is its sibling's contract, asserted here too because both arms owe it;
// what is new is the rejection — said once, in the dialog, over a preserved
// title, with a retry that does not need the title typed again.

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
  isPending: false,
  createDocumentOptions: vi.fn(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: mocks.navigate,
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (orgRelativePath: string) => `/acme${orgRelativePath}`,
}));

vi.mock("../../hooks/use-documents", async () => {
  const actual = await vi.importActual("../../hooks/use-documents");
  return {
    ...actual,
    // Records the options this arm asks the shared mutation for — the seam the
    // shared QueryClient reads `suppressDefaultErrorToast` from.
    useCreateDocument: (options?: unknown) => {
      mocks.createDocumentOptions(options);
      return { mutate: mocks.mutate, isPending: mocks.isPending };
    },
  };
});

import { NewDocumentModalRecoverable } from "../new-document-modal-recoverable";

const TITLE_REGEX = /title/i;
const TYPE_REGEX = /type/i;
const CREATE_REGEX = /create document/i;
const RETRY_REGEX = /try again/i;
const CANCEL_REGEX = /cancel/i;
const FAILURE_TITLE = "Couldn't create this document";
const SERVER_MESSAGE = "Only admins can create documents here";
/** The canonical ISS-5013 timeout copy, not a string this suite invents. */
const TIMEOUT_TITLE = "We stopped waiting";
const TIMEOUT_REMEDIATION_REGEX = /refresh to see whether it completed/i;

function lastCreateInput(): CreateDocumentInput {
  return mocks.mutate.mock.calls.at(-1)?.[0] as CreateDocumentInput;
}

/** Reject the next create with `error`. */
function rejectCreateWithError(error: Error): void {
  mocks.mutate.mockImplementation(
    (_input: CreateDocumentInput, opts?: { onError?: (e: Error) => void }) => {
      opts?.onError?.(error);
    }
  );
}

/** Reject the next create with `message`. */
function rejectCreateWith(message: string): void {
  rejectCreateWithError(new Error(message));
}

/** Reject the next create the way a client deadline actually arrives. */
function rejectCreateWithTimeout(): void {
  rejectCreateWithError(
    new ApiError(
      "The request timed out",
      API_NO_RESPONSE_STATUS,
      API_TIMEOUT_ERROR_CODE
    )
  );
}

function typeTitle(value: string): void {
  fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
    target: { value },
  });
}

describe("NewDocumentModalRecoverable", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isPending = false;
    cleanup();
  });

  it("creates a project-less org-level Document (no projectId, no type selector)", () => {
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    expect(screen.queryByLabelText(TYPE_REGEX)).toBeNull();
    typeTitle("Team Handbook");
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    const input = lastCreateInput();
    expect(input.title).toBe("Team Handbook");
    expect(input.type).toBe(DocumentType.Doc);
    // The whole product thesis: a Document needs no project.
    expect(input.projectId).toBeUndefined();
  });

  it("asks the create mutation to suppress the shared toast, so one rejection is said once", () => {
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    // The production seam: `useCreateDocument` turns this into the mutation
    // `meta` the shared QueryClient reads before it toasts. Its sibling arm
    // passes nothing here, which is what keeps the closed gate's duplicate
    // report intact.
    expect(mocks.createDocumentOptions).toHaveBeenCalledWith({
      suppressDefaultErrorToast: true,
    });
  });

  it("keeps the dialog open with the title intact and names the failure", async () => {
    rejectCreateWith(SERVER_MESSAGE);
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    typeTitle("A doc");
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    expect(await screen.findByText(FAILURE_TITLE)).toBeTruthy();
    // The server's own sentence survives — the dialog adds a heading, it does
    // not replace what the server said with a generic line.
    expect(screen.getByText(SERVER_MESSAGE)).toBeTruthy();
    expect(screen.getByLabelText(TITLE_REGEX)).toHaveValue("A doc");
  });

  it("points the title field at the failure without calling the title invalid", async () => {
    rejectCreateWith(SERVER_MESSAGE);
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    const field = screen.getByLabelText(TITLE_REGEX);
    // Clean state first, so the assertion below is a CHANGE rather than a
    // property the field always had.
    expect(field).not.toHaveAttribute("aria-describedby");

    typeTitle("A doc");
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));
    expect(await screen.findByText(FAILURE_TITLE)).toBeTruthy();

    // A reader who cannot see the red box still reaches what went wrong...
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      SERVER_MESSAGE
    );
    // ...but is NOT sent to fix a field that is not the problem. This rejection
    // is about who may create a document, not about the title, and every other
    // reachable failure here (5xx, a client deadline) is the same. The positive
    // assertion above is this one's control: the failure state was genuinely
    // reached, so the absence below is a decision rather than a selector that
    // never resolved.
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("says a client deadline is a deadline, not a refusal, and says what to do about it", async () => {
    // ISS-5013's canonical timeout copy, reached through the real
    // `useNewDocumentCreate`: `POST /documents` has no idempotency key, so a
    // create that timed out may well have committed. A heading claiming it
    // failed, over a bare retry, invites a duplicate document.
    rejectCreateWithTimeout();
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    typeTitle("A doc");
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    expect(await screen.findByText(TIMEOUT_TITLE)).toBeTruthy();
    // The refusal heading must NOT be what a timeout gets. Its sibling case
    // above is this one's control: the same selector does resolve when a
    // refusal is what happened.
    expect(screen.queryByText(FAILURE_TITLE)).toBeNull();
    expect(screen.getByText(TIMEOUT_REMEDIATION_REGEX)).toBeTruthy();
    expect(screen.getByLabelText(TITLE_REGEX)).toHaveValue("A doc");
  });

  it("disables Cancel while a create is in flight, so a late success cannot land on a cancelled dialog", () => {
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);
    // Positive control on the same control: Cancel is normally available, so
    // the disabled assertion below is `isPending` doing it and not a selector
    // matching a button that was always dead.
    expect(
      screen.getByRole("button", { name: CANCEL_REGEX })
    ).not.toBeDisabled();
    cleanup();

    mocks.isPending = true;
    const onOpenChange = vi.fn();
    render(<NewDocumentModalRecoverable onOpenChange={onOpenChange} open />);

    const cancel = screen.getByRole("button", { name: CANCEL_REGEX });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("retries the preserved title without it being typed again, and clears the stale failure", async () => {
    rejectCreateWith(SERVER_MESSAGE);
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    typeTitle("A doc");
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));
    expect(await screen.findByText(FAILURE_TITLE)).toBeTruthy();

    // The submit control now says what it does. Nothing is re-typed between
    // here and the retry: the click below is the entire recovery.
    const retry = screen.getByRole("button", { name: RETRY_REGEX });
    mocks.mutate.mockImplementation(
      (
        _input: CreateDocumentInput,
        opts?: { onSuccess?: (d: unknown) => void }
      ) => {
        opts?.onSuccess?.(
          createMockDocument({
            id: "doc-1",
            type: DocumentType.Doc,
            slug: "my-doc",
          })
        );
      }
    );
    fireEvent.click(retry);

    // The second attempt carried the title the user never re-entered...
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(lastCreateInput().title).toBe("A doc");
    // ...and the previous rejection is gone rather than left standing over a
    // successful create.
    await waitFor(() => {
      expect(screen.queryByText(FAILURE_TITLE)).toBeNull();
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/acme/documents/my-doc");
  });

  it("does not submit without a title (title is the only requirement — never a project)", () => {
    render(<NewDocumentModalRecoverable onOpenChange={vi.fn()} open />);

    const createButton = screen.getByRole("button", { name: CREATE_REGEX });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(mocks.mutate).not.toHaveBeenCalled();

    typeTitle("Runbook");
    expect(createButton).not.toBeDisabled();
  });

  it("does not dismiss on Escape while a create is in flight (isPending)", () => {
    mocks.isPending = true;
    const onOpenChange = vi.fn();
    render(<NewDocumentModalRecoverable onOpenChange={onOpenChange} open />);

    fireEvent.keyDown(screen.getByLabelText(TITLE_REGEX), {
      key: "Escape",
      code: "Escape",
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

it("creates in the board lane's requested status", () => {
  render(
    <NewDocumentModalRecoverable
      initialStatus={DocumentStatus.InReview}
      onOpenChange={vi.fn()}
      open
    />
  );
  fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
    target: { value: "Review draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));
  expect(mocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ status: DocumentStatus.InReview }),
    expect.anything()
  );
});
