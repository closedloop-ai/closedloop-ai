import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleImportModal } from "../google-import-modal";

type MockMutation = {
  mutateAsync: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isSuccess: boolean;
  data: ImportGoogleDocsResponse | undefined;
};

const { mockImportMutation, mockToast } = vi.hoisted(() => ({
  mockImportMutation: {
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
  } as MockMutation,
  mockToast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/app/google/hooks/use-google-integration", () => ({
  useImportGoogleDocs: () => mockImportMutation,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({
    data: [{ id: "proj-1", name: "Project One" }],
    isLoading: false,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: mockToast,
}));

// Radix Select does not open its portal-rendered options under jsdom, so mock
// it as a native <select> that still drives onValueChange.
vi.mock("@repo/design-system/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (v: string) => void;
    value?: string;
  }) => (
    <select
      aria-label="Target Project"
      onChange={(e) => onValueChange(e.target.value)}
      value={value ?? ""}
    >
      <option value="">Select a project</option>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const VALID_FOLDER_ID = "1A2B3C4D5E6F7G8H9I0J1K2L3M4N";
const FOLDER_ID_LABEL = /google drive folder id/i;
const TARGET_PROJECT_NAME = /target project/i;
const IMPORT_BUTTON_NAME = /^import$/i;
const DONE_BUTTON_NAME = /^done$/i;
const FAILURE_ROW = /Gamma Doc: boom/;
const IMPORTED_TWO_LINE = "Imported 2 documents";
const IMPORTED_ZERO_LINE = "Imported 0 documents";

function primeSuccess(data: ImportGoogleDocsResponse) {
  mockImportMutation.mutateAsync.mockImplementation(() => {
    // Simulate react-query flipping state after a resolved mutation.
    mockImportMutation.isSuccess = true;
    mockImportMutation.data = data;
    return Promise.resolve(data);
  });
}

describe("GoogleImportModal", () => {
  beforeEach(() => {
    mockImportMutation.mutateAsync.mockReset();
    mockImportMutation.reset.mockReset();
    mockImportMutation.isPending = false;
    mockImportMutation.isSuccess = false;
    mockImportMutation.data = undefined;
    mockToast.success.mockReset();
    mockToast.warning.mockReset();
    mockToast.error.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function fillAndImport() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
    await user.selectOptions(
      screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
      "proj-1"
    );
    await user.click(screen.getByRole("button", { name: IMPORT_BUTTON_NAME }));
    return user;
  }

  it("keeps the modal open and shows the result panel after a successful import", async () => {
    const onOpenChange = vi.fn();
    primeSuccess({
      importedCount: 2,
      totalDocsInFolder: 3,
      artifacts: [
        { id: "a1", slug: "PRD-1", title: "Alpha Doc" },
        { id: "a2", slug: "PRD-2", title: "Beta Doc" },
      ],
      failures: [{ docId: "d3", docTitle: "Gamma Doc", error: "boom" }],
    });

    const { rerender } = render(
      <GoogleImportModal onOpenChange={onOpenChange} open={true} />
    );

    await fillAndImport();

    // Bug regression: modal must NOT auto-close on a successful import.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Re-render to reflect the mutation's success state.
    rerender(<GoogleImportModal onOpenChange={onOpenChange} open={true} />);

    // The result panel — unreachable before the fix — is now visible.
    expect(await screen.findByText(IMPORTED_TWO_LINE)).toBeInTheDocument();
    expect(screen.getByText("Alpha Doc")).toBeInTheDocument();
    expect(screen.getByText("Beta Doc")).toBeInTheDocument();
    expect(screen.getByText(FAILURE_ROW)).toBeInTheDocument();

    // A Done button replaces Cancel/Import so the user can dismiss.
    const doneButton = screen.getByRole("button", { name: DONE_BUTTON_NAME });
    expect(doneButton).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: IMPORT_BUTTON_NAME })
    ).not.toBeInTheDocument();

    await userEvent.setup().click(doneButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not claim the folder was empty when every document failed", async () => {
    // The service reports this exact contract for a nonempty folder whose
    // documents all failed: importedCount 0, totalDocsInFolder 2, two failures.
    // Reading importedCount alone reads that as "empty" and contradicts the
    // failure toast fired immediately after it.
    primeSuccess({
      importedCount: 0,
      totalDocsInFolder: 2,
      artifacts: [],
      failures: [
        { docId: "d1", docTitle: "Alpha Doc", error: "boom" },
        { docId: "d2", docTitle: "Gamma Doc", error: "boom" },
      ],
    });

    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    await fillAndImport();

    expect(mockToast.warning).not.toHaveBeenCalled();
    // Not an absence-only assertion: the failure toast must still fire, so the
    // user is told what happened rather than told nothing at all.
    expect(mockToast.error).toHaveBeenCalledWith(
      "Failed to import 2 documents"
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("shows no success affordance in the panel when every document failed", async () => {
    // The panel half of the same lie the toast half fixes: a check mark and
    // "Imported 0 documents" rendered directly above the red failure list.
    primeSuccess({
      importedCount: 0,
      totalDocsInFolder: 2,
      artifacts: [],
      failures: [
        { docId: "d1", docTitle: "Alpha Doc", error: "boom" },
        { docId: "d3", docTitle: "Gamma Doc", error: "boom" },
      ],
    });

    const { rerender } = render(
      <GoogleImportModal onOpenChange={vi.fn()} open={true} />
    );

    await fillAndImport();
    rerender(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    // Not an absence-only assertion: the panel still renders, and still tells
    // the user exactly which documents failed.
    expect(await screen.findByText(FAILURE_ROW)).toBeInTheDocument();
    expect(screen.queryByText(IMPORTED_ZERO_LINE)).not.toBeInTheDocument();
  });

  it("still reports a genuinely empty folder as empty", async () => {
    // The other side of the same branch: with no failures, zero really does
    // mean the folder held nothing, and that message must survive.
    primeSuccess({
      importedCount: 0,
      totalDocsInFolder: 0,
      artifacts: [],
      failures: [],
    });

    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    await fillAndImport();

    expect(mockToast.warning).toHaveBeenCalledWith(
      "No Google Docs found in this folder"
    );
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("clears the prior import result when the modal is closed", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <GoogleImportModal onOpenChange={onOpenChange} open={true} />
    );

    // Closing the modal must reset the mutation so a stale result panel does
    // not reappear on the next open.
    rerender(<GoogleImportModal onOpenChange={onOpenChange} open={false} />);

    expect(mockImportMutation.reset).toHaveBeenCalled();
  });
});
