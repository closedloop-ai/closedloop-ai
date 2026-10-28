/**
 * Supplementary GoogleImportModal coverage. google-import-modal.test.tsx
 * already covers the post-import result panel (success, all-failed,
 * genuinely-empty cases) and the reset-on-close effect. This file covers the
 * branches that one does not exercise:
 *  - inline folder-id format validation
 *  - the combined folder-id + project disabled gate on Import
 *  - the projects-loading and no-projects-found states
 *  - the in-flight "Importing..." pending state
 *  - the mutation-rejects catch branch (its toast is the mutation's
 *    hook-level `onError`, pinned in google-import-modal-failure-toast.test.tsx)
 *  - the genuinely-empty-folder case rendering a Done footer with no panel
 */

import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { render, screen, waitFor } from "@testing-library/react";
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

const { mockImportMutation, mockToast, mockUseProjects } = vi.hoisted(() => ({
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
  mockUseProjects: vi.fn(),
}));

vi.mock("../../hooks/use-google-integration", () => ({
  useImportGoogleDocs: () => mockImportMutation,
}));

vi.mock("../../../projects/hooks/use-projects", () => ({
  useProjects: () => mockUseProjects(),
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
const CANCEL_BUTTON_NAME = /^cancel$/i;
const DONE_BUTTON_NAME = /^done$/i;
const INVALID_FOLDER_ID_ERROR = /invalid folder id format/i;
const RE_LOADING_PROJECTS = /loading projects/i;
const RE_NO_PROJECTS_FOUND = /no projects found/i;
const RE_IMPORTING = /importing/i;
const RE_IMPORTED_0_DOCS = /imported 0 documents/i;

function primeSuccess(data: ImportGoogleDocsResponse) {
  mockImportMutation.mutateAsync.mockImplementation(() => {
    mockImportMutation.isSuccess = true;
    mockImportMutation.data = data;
    return Promise.resolve(data);
  });
}

describe("GoogleImportModal — validation and loading states", () => {
  beforeEach(() => {
    mockImportMutation.mutateAsync.mockReset();
    mockImportMutation.reset.mockReset();
    mockImportMutation.isPending = false;
    mockImportMutation.isSuccess = false;
    mockImportMutation.data = undefined;
    mockToast.success.mockReset();
    mockToast.warning.mockReset();
    mockToast.error.mockReset();
    mockUseProjects.mockReset();
    mockUseProjects.mockReturnValue({
      data: [{ id: "proj-1", name: "Project One" }],
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an inline format error for an invalid folder id, and clears it once the id becomes valid", async () => {
    const user = userEvent.setup();
    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), "too-short");
    expect(screen.getByText(INVALID_FOLDER_ID_ERROR)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(FOLDER_ID_LABEL));
    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);

    expect(screen.queryByText(INVALID_FOLDER_ID_ERROR)).not.toBeInTheDocument();
  });

  it("keeps Import disabled until both a valid folder id and a project are set", async () => {
    const user = userEvent.setup();
    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    const importButton = screen.getByRole("button", {
      name: IMPORT_BUTTON_NAME,
    });
    expect(importButton).toBeDisabled();

    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
    expect(importButton).toBeDisabled();

    await user.selectOptions(
      screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
      "proj-1"
    );
    expect(importButton).toBeEnabled();
  });

  it("shows a loading indicator while projects are loading, and no project selector", () => {
    mockUseProjects.mockReturnValue({ data: undefined, isLoading: true });
    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByText(RE_LOADING_PROJECTS)).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: TARGET_PROJECT_NAME })
    ).not.toBeInTheDocument();
  });

  it("shows a no-projects-found alert when the org has no projects", () => {
    mockUseProjects.mockReturnValue({ data: [], isLoading: false });
    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByText(RE_NO_PROJECTS_FOUND)).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: TARGET_PROJECT_NAME })
    ).not.toBeInTheDocument();
  });

  it("disables Cancel and Import and shows an importing indicator while the mutation is in flight", async () => {
    let resolveImport: (value: ImportGoogleDocsResponse) => void = () =>
      undefined;
    mockImportMutation.mutateAsync.mockImplementation(
      () =>
        new Promise<ImportGoogleDocsResponse>((resolve) => {
          resolveImport = resolve;
        })
    );

    const user = userEvent.setup();
    const { rerender } = render(
      <GoogleImportModal onOpenChange={vi.fn()} open={true} />
    );

    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
    await user.selectOptions(
      screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
      "proj-1"
    );
    await user.click(screen.getByRole("button", { name: IMPORT_BUTTON_NAME }));

    // The mutation hasn't resolved yet — mimic react-query flipping isPending.
    mockImportMutation.isPending = true;
    rerender(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByText(RE_IMPORTING)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_NAME })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: IMPORT_BUTTON_NAME })
    ).not.toBeInTheDocument();

    resolveImport({
      importedCount: 1,
      totalDocsInFolder: 1,
      artifacts: [{ id: "a1", slug: "PRD-1", title: "Doc" }],
      failures: [],
    });

    // Settle the handler's awaited mutateAsync INSIDE the test rather than
    // leaving it suspended into the next one. Nothing downstream of that await
    // sets state — `reportImportOutcome` only calls `toast` — so this needs no
    // `act` wrapper, and awaiting the toast also pins the singular wording.
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith(
        "Successfully imported 1 document"
      )
    );
  });

  it("keeps the Cancel/Import footer, with no toast from its own catch, when the import rejects", async () => {
    mockImportMutation.mutateAsync.mockRejectedValueOnce(
      new Error("Google API unavailable")
    );

    const user = userEvent.setup();
    render(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
    await user.selectOptions(
      screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
      "proj-1"
    );
    await user.click(screen.getByRole("button", { name: IMPORT_BUTTON_NAME }));

    await vi.waitFor(() => {
      expect(mockImportMutation.mutateAsync).toHaveBeenCalledTimes(1);
    });
    // The modal attached its handler to this promise first, so its catch has
    // run by the time this await resumes.
    await mockImportMutation.mutateAsync.mock.results[0]?.value.catch(
      () => undefined
    );
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: IMPORT_BUTTON_NAME })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: DONE_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("switches the footer to Done, with no result panel, for a genuinely empty folder", async () => {
    primeSuccess({
      importedCount: 0,
      totalDocsInFolder: 0,
      artifacts: [],
      failures: [],
    });

    const user = userEvent.setup();
    const { rerender } = render(
      <GoogleImportModal onOpenChange={vi.fn()} open={true} />
    );

    await user.type(screen.getByLabelText(FOLDER_ID_LABEL), VALID_FOLDER_ID);
    await user.selectOptions(
      screen.getByRole("combobox", { name: TARGET_PROJECT_NAME }),
      "proj-1"
    );
    await user.click(screen.getByRole("button", { name: IMPORT_BUTTON_NAME }));
    rerender(<GoogleImportModal onOpenChange={vi.fn()} open={true} />);

    // The footer already switched to Done (isSuccess alone drives it)...
    expect(
      await screen.findByRole("button", { name: DONE_BUTTON_NAME })
    ).toBeInTheDocument();
    // ...but the result panel itself stays hidden: nothing to show.
    expect(screen.queryByText(RE_IMPORTED_0_DOCS)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: IMPORT_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });
});
