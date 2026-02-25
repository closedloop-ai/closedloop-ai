import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { MergeArtifactsDialog } from "../merge-artifacts-dialog";

const CANCEL_REGEX = /cancel/i;
const MERGING_REGEX = /merging/i;
const SWAP_REGEX = /swap/i;

// Mock date-utils so relative time is predictable
vi.mock("@/lib/date-utils", () => ({
  formatRelativeTime: () => "2 days ago",
}));

// Mock ArtifactTypeBadge to simplify rendering
vi.mock("../artifact-type-badge", () => ({
  ArtifactTypeBadge: ({ type }: { type: string }) => (
    <span data-testid="artifact-type-badge">{type}</span>
  ),
}));

function createDialogArtifact(
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream {
  return createMockArtifact({
    updatedAt: new Date("2024-01-16T10:00:00Z"),
    ...overrides,
  }) as ArtifactWithWorkstream;
}

function renderDialog(props: {
  artifacts?: [ArtifactWithWorkstream, ArtifactWithWorkstream];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm?: (primaryId: string, secondaryId: string) => Promise<void>;
  isPending?: boolean;
  error?: string | null;
}) {
  const artifact1 =
    props.artifacts?.[0] ??
    createDialogArtifact({
      id: "artifact-1",
      title: "Primary Artifact",
      type: "PRD",
    });
  const artifact2 =
    props.artifacts?.[1] ??
    createDialogArtifact({
      id: "artifact-2",
      title: "Secondary Artifact",
      type: "PRD",
    });

  const defaultProps = {
    artifacts: [artifact1, artifact2] as [
      ArtifactWithWorkstream,
      ArtifactWithWorkstream,
    ],
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
    ...props,
  };

  return render(<MergeArtifactsDialog {...defaultProps} />);
}

describe("MergeArtifactsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders primary and secondary artifact titles", () => {
    renderDialog({});

    expect(screen.getByText("Primary Artifact")).toBeInTheDocument();
    expect(screen.getByText("Secondary Artifact")).toBeInTheDocument();
  });

  test("renders Primary (survives) and Secondary (will be deleted) labels", () => {
    renderDialog({});

    expect(screen.getByText("Primary (survives)")).toBeInTheDocument();
    expect(screen.getByText("Secondary (will be deleted)")).toBeInTheDocument();
  });

  test("Swap button swaps primary/secondary card labels", () => {
    renderDialog({});

    // Initially artifact-1 is primary
    const primarySection = screen
      .getByText("Primary (survives)")
      .closest("div");
    expect(primarySection).toHaveTextContent("Primary Artifact");

    const secondarySection = screen
      .getByText("Secondary (will be deleted)")
      .closest("div");
    expect(secondarySection).toHaveTextContent("Secondary Artifact");

    // Click Swap
    const swapButton = screen.getByRole("button", { name: SWAP_REGEX });
    fireEvent.click(swapButton);

    // After swap, artifact-2 should be primary
    const newPrimarySection = screen
      .getByText("Primary (survives)")
      .closest("div");
    expect(newPrimarySection).toHaveTextContent("Secondary Artifact");

    const newSecondarySection = screen
      .getByText("Secondary (will be deleted)")
      .closest("div");
    expect(newSecondarySection).toHaveTextContent("Primary Artifact");
  });

  test("Swap button reverses onConfirm argument order", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const artifact1 = createDialogArtifact({
      id: "artifact-1",
      title: "Primary Artifact",
    });
    const artifact2 = createDialogArtifact({
      id: "artifact-2",
      title: "Secondary Artifact",
    });

    renderDialog({
      artifacts: [artifact1, artifact2],
      onConfirm,
    });

    // Swap so artifact-2 becomes primary
    const swapButton = screen.getByRole("button", { name: SWAP_REGEX });
    fireEvent.click(swapButton);

    // Click Merge
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    fireEvent.click(mergeButton);

    // After swap, artifact-2 is primary, artifact-1 is secondary
    expect(onConfirm).toHaveBeenCalledWith("artifact-2", "artifact-1");
  });

  test("isPending=true shows Merging... and disables buttons", () => {
    renderDialog({ isPending: true });

    expect(screen.getByText("Merging...")).toBeInTheDocument();

    // Both Cancel and Merge/Merging buttons should be disabled
    const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
    expect(cancelButton).toBeDisabled();

    const mergeButton = screen.getByRole("button", { name: MERGING_REGEX });
    expect(mergeButton).toBeDisabled();

    // Swap button should also be disabled
    const swapButton = screen.getByRole("button", { name: SWAP_REGEX });
    expect(swapButton).toBeDisabled();
  });

  test("isPending=true prevents onOpenChange from being called on dialog close", () => {
    const onOpenChange = vi.fn();
    renderDialog({ isPending: true, onOpenChange });

    // The Dialog's onOpenChange is guarded by isPending — simulate what happens
    // when the dialog would normally close via Cancel button click
    // The Cancel button calls onOpenChange(false) directly, but we test
    // the Dialog wrapper's guard (the Dialog onOpenChange prop)
    // We verify: Cancel button is disabled when isPending=true
    const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
    expect(cancelButton).toBeDisabled();

    // Clicking a disabled button should NOT call onOpenChange
    fireEvent.click(cancelButton);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("isPending=true prevents close on Escape key", () => {
    const onOpenChange = vi.fn();
    renderDialog({ isPending: true, onOpenChange });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("error prop shows error message in dialog", () => {
    renderDialog({ error: "Failed to merge artifacts" });

    expect(screen.getByText("Failed to merge artifacts")).toBeInTheDocument();
  });

  test("no error message rendered when error is null", () => {
    renderDialog({ error: null });

    expect(screen.queryByText("Failed to merge")).not.toBeInTheDocument();
  });

  test("clicking Merge button calls onConfirm with correct artifact IDs", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const artifact1 = createDialogArtifact({
      id: "primary-id",
      title: "Primary Artifact",
    });
    const artifact2 = createDialogArtifact({
      id: "secondary-id",
      title: "Secondary Artifact",
    });

    renderDialog({
      artifacts: [artifact1, artifact2],
      onConfirm,
    });

    const mergeButton = screen.getByRole("button", { name: "Merge" });
    fireEvent.click(mergeButton);

    expect(onConfirm).toHaveBeenCalledWith("primary-id", "secondary-id");
  });

  test("clicking Cancel calls onOpenChange with false", () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
    fireEvent.click(cancelButton);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
