// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactKind, ArtifactStatus, genericArtifacts } from "../../fixtures";
import { GenericArtifactListShell } from "../artifact-shells";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: toastSuccess,
  },
}));

describe("artifact list group-drop receipts", () => {
  it("uses the status receipt and restores the row through Undo", async () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;
    const onArtifactsChange = vi.fn();
    const { container } = render(
      <GenericArtifactListShell
        artifacts={[issue]}
        defaultGroupBy="status"
        onArtifactsChange={onArtifactsChange}
        onOpenArtifact={vi.fn()}
        showSummaryCards={false}
        variant="embedded"
      />
    );
    const row = screen
      .getByText(issue.title)
      .closest<HTMLElement>('[draggable="true"]');
    const doneBand = [
      ...container.querySelectorAll<HTMLElement>('[role="rowgroup"]'),
    ].find((band) => band.textContent?.includes("Done"));
    const dataTransfer = createDataTransfer();
    if (!(row && doneBand)) {
      throw new Error("expected a draggable issue row and Done group band");
    }

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(doneBand, { dataTransfer });
    fireEvent.drop(doneBand, { dataTransfer });

    await waitFor(() =>
      expect(onArtifactsChange).toHaveBeenCalledWith([
        expect.objectContaining({
          id: issue.id,
          status: ArtifactStatus.Done,
          statusRaw: undefined,
        }),
      ])
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      `${issue.slug} moved to Done`,
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );

    const receiptOptions = toastSuccess.mock.calls.at(-1)?.[1];
    await act(async () => receiptOptions?.action?.onClick?.());

    await waitFor(() =>
      expect(onArtifactsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: issue.id,
          status: issue.status,
          statusRaw: issue.statusRaw,
        }),
      ])
    );
  });
});

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData(type: string) {
      return store.get(type) ?? "";
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    types: [] as string[],
  };
}
