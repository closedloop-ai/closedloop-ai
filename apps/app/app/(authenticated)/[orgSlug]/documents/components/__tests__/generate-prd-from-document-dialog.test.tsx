import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useProjects: vi.fn(),
  useGeneratePrdFromDocument: vi.fn(),
  mutate: vi.fn(),
  selectTarget: vi.fn(),
  clearTargetSelection: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: mocks.useProjects,
}));

vi.mock("@/hooks/queries/use-document-generation", () => ({
  useGeneratePrdFromDocument: mocks.useGeneratePrdFromDocument,
}));

// No pre-loop provider is mounted in these tests, so the optional gate resolves
// to null and generation runs directly (execute({})).
vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  useOptionalPreLoopSystemCheckGate: () => null,
}));

vi.mock("@/components/engineer/LoopDispatchTargetSelector", () => ({
  LoopDispatchTargetSelector: ({
    onSelect,
  }: {
    onSelect: (id: string) => void;
  }) => (
    <button onClick={() => onSelect("target-1")} type="button">
      pick-target
    </button>
  ),
}));

import { GeneratePrdFromDocumentDialog } from "../generate-prd-from-document-dialog";

const SOURCE_DOC = { id: "doc-1", title: "Strategy Doc" };
const GENERATE_PRD_BUTTON = /generate prd/i;
const PICK_TARGET_BUTTON = /pick-target/i;

function mockHook(
  overrides: Partial<{
    isPending: boolean;
    multiTargetState: unknown;
  }> = {}
) {
  mocks.useGeneratePrdFromDocument.mockReturnValue({
    mutate: mocks.mutate,
    isPending: overrides.isPending ?? false,
    multiTargetState: overrides.multiTargetState ?? null,
    selectTarget: mocks.selectTarget,
    clearTargetSelection: mocks.clearTargetSelection,
  });
}

describe("GeneratePrdFromDocumentDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjects.mockReturnValue({
      data: [
        { id: "project-a", name: "Project A" },
        { id: "project-b", name: "Project B" },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    mockHook();
  });

  it("generates a PRD for the picked project, carrying the source Document id and a derived title", () => {
    render(
      <GeneratePrdFromDocumentDialog
        document={SOURCE_DOC}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    // Open the project select and choose Project B.
    fireEvent.click(screen.getByLabelText("Select target project"));
    fireEvent.click(screen.getByText("Project B"));

    fireEvent.click(screen.getByRole("button", { name: GENERATE_PRD_BUTTON }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [args] = mocks.mutate.mock.calls[0];
    expect(args).toMatchObject({
      documentId: "doc-1",
      projectId: "project-b",
      // Title is seeded as "PRD: <source title>" so the derived artifact reads
      // as derived rather than colliding verbatim with the source Document.
      title: "PRD: Strategy Doc",
    });
  });

  it("pre-selects the project when opened from a project-scoped surface", () => {
    render(
      <GeneratePrdFromDocumentDialog
        defaultProjectId="project-a"
        document={SOURCE_DOC}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    // Primary button is enabled immediately since the project is pre-filled.
    fireEvent.click(screen.getByRole("button", { name: GENERATE_PRD_BUTTON }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({
      projectId: "project-a",
    });
  });

  it("does not generate until a target project is chosen", () => {
    render(
      <GeneratePrdFromDocumentDialog
        document={SOURCE_DOC}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    const generateButton = screen.getByRole("button", {
      name: GENERATE_PRD_BUTTON,
    });
    expect(generateButton).toBeDisabled();

    fireEvent.click(generateButton);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("surfaces a projects load error instead of an empty-organization lie", () => {
    mocks.useProjects.mockReturnValue({
      data: [],
      isLoading: false,
      isError: true,
      error: new Error("Failed to load projects"),
    });

    render(
      <GeneratePrdFromDocumentDialog
        document={SOURCE_DOC}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByText("Failed to load projects")).toBeInTheDocument();
  });

  it("locks the project and title fields and replays only the launch once a draft PRD is pending target selection", () => {
    mockHook({
      multiTargetState: {
        availableTargets: [
          { id: "target-1", machineName: "m1", status: "online" },
        ],
        pendingArtifact: { id: "prd-seeded" },
      },
    });

    render(
      <GeneratePrdFromDocumentDialog
        document={SOURCE_DOC}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    // Fields are locked because the seed PRD already committed.
    expect(screen.getByLabelText("Select target project")).toBeDisabled();
    expect(screen.getByLabelText("PRD title")).toBeDisabled();

    // Picking a target replays only the launch — never a second seed mutation.
    fireEvent.click(screen.getByRole("button", { name: PICK_TARGET_BUTTON }));
    expect(mocks.selectTarget).toHaveBeenCalledWith("target-1");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
