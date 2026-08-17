import {
  type CreateDocumentInput,
  DocumentType,
} from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// FEA-4345: NewDocumentModal is the type-agnostic, org-level Document create
// flow. It must NOT require or force a project, and on success it routes into
// the created document's detail page. These tests drive the real component and
// assert the mutation payload + navigation. It lives in @repo/app, so it
// navigates through the injected @repo/navigation ports, which are mocked here.

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
  isPending: false,
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
    useCreateDocument: () => ({
      mutate: mocks.mutate,
      isPending: mocks.isPending,
    }),
  };
});

import { NewDocumentModal } from "../new-document-modal";

const TITLE_REGEX = /title/i;
const CREATE_REGEX = /create document/i;
const TYPE_REGEX = /type/i;

function lastCreateInput(): CreateDocumentInput {
  return mocks.mutate.mock.calls.at(-1)?.[0] as CreateDocumentInput;
}

describe("NewDocumentModal", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isPending = false;
    cleanup();
  });

  it("creates a project-less org-level Document (no projectId, no type selector)", () => {
    render(<NewDocumentModal onOpenChange={vi.fn()} open />);

    // The dialog is a single field: there is no type selector to disambiguate,
    // it always creates a generic Document.
    expect(screen.queryByLabelText(TYPE_REGEX)).toBeNull();

    fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
      target: { value: "Team Handbook" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const input = lastCreateInput();
    expect(input.title).toBe("Team Handbook");
    expect(input.type).toBe(DocumentType.Doc);
    // The load-bearing assertion: no project is required or forced.
    expect(input.projectId).toBeUndefined();
  });

  it("does not submit without a title (title is the only requirement — never a project)", () => {
    render(<NewDocumentModal onOpenChange={vi.fn()} open />);

    // The create button is disabled until a title is entered; a missing
    // project never blocks (there is no project field at all).
    const createButton = screen.getByRole("button", { name: CREATE_REGEX });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(mocks.mutate).not.toHaveBeenCalled();

    // Once a title is present the button enables and submits — proving a
    // project is genuinely not required.
    fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
      target: { value: "Runbook" },
    });
    expect(createButton).not.toBeDisabled();
  });

  it("submits on Enter from the title field (single-field dialog form submit)", () => {
    render(<NewDocumentModal onOpenChange={vi.fn()} open />);

    const titleInput = screen.getByLabelText(TITLE_REGEX);
    fireEvent.change(titleInput, { target: { value: "Runbook" } });
    // The fields are wrapped in a <form> with a submit button, so a title-field
    // form submission (Enter) creates the document without clicking.
    fireEvent.submit(titleInput.closest("form") as HTMLFormElement);

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(lastCreateInput().title).toBe("Runbook");
  });

  it("routes into the created document's detail page on success when the type has a route", async () => {
    // Drive the mutation's onSuccess with a navigable artifact (PRD has a
    // detail route) to prove the modal routes to detail on create.
    mocks.mutate.mockImplementation(
      (
        _input: CreateDocumentInput,
        opts?: { onSuccess?: (d: unknown) => void }
      ) => {
        opts?.onSuccess?.(
          createMockDocument({
            id: "prd-1",
            type: DocumentType.Prd,
            slug: "my-prd",
          })
        );
      }
    );

    render(<NewDocumentModal onOpenChange={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
      target: { value: "A doc" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/acme/prds/my-prd");
    });
  });

  it("routes into the created Document's editor on success (ISS-4382)", async () => {
    // ISS-4382: DOC now has a real editor at /documents/[slug], so creating one
    // navigates straight into it — proving the create → editor flow the ticket
    // asks for, alongside the onSuccess callback still firing.
    const onSuccess = vi.fn();
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

    render(
      <NewDocumentModal onOpenChange={vi.fn()} onSuccess={onSuccess} open />
    );
    fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
      target: { value: "A doc" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/acme/documents/my-doc");
  });

  it("does not dismiss on Escape while a create is in flight (isPending)", () => {
    // A create request is in flight: an Escape keypress must be swallowed so a
    // late success can't close a reopened dialog or navigate after the user
    // thought they'd dismissed. onOpenChange(false) must not fire.
    mocks.isPending = true;
    const onOpenChange = vi.fn();
    render(<NewDocumentModal onOpenChange={onOpenChange} open />);

    fireEvent.keyDown(screen.getByLabelText(TITLE_REGEX), {
      key: "Escape",
      code: "Escape",
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("dismisses on Escape when idle (not saving)", () => {
    // Control: with no request in flight, Escape closes normally.
    const onOpenChange = vi.fn();
    render(<NewDocumentModal onOpenChange={onOpenChange} open />);

    fireEvent.keyDown(screen.getByLabelText(TITLE_REGEX), {
      key: "Escape",
      code: "Escape",
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a create failure inside the dialog instead of only toasting", async () => {
    mocks.mutate.mockImplementation(
      (
        _input: CreateDocumentInput,
        opts?: { onError?: (e: Error) => void }
      ) => {
        opts?.onError?.(new Error("Server exploded"));
      }
    );

    render(<NewDocumentModal onOpenChange={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
      target: { value: "A doc" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_REGEX }));

    // The failure message renders in the dialog (where the user is looking),
    // and the dialog stays open with the title retained.
    expect(await screen.findByText("Server exploded")).toBeTruthy();
    expect(screen.getByLabelText(TITLE_REGEX)).toHaveValue("A doc");
  });
});
