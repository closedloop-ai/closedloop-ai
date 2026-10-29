import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableInlineCreateRow } from "../components/ui/table-inline-create-row";

describe("TableInlineCreateRow async writes", () => {
  it("retains the draft after a failed save and permits retry", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValueOnce(undefined);
    render(
      <TableInlineCreateRow
        active
        gridTemplateColumns="1fr 1fr"
        label="Add issue"
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onCommit={onCommit}
      />
    );
    const input = screen.getByRole("textbox", { name: "Add issue name" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveAttribute("aria-busy", "false"));
    expect(input).toHaveValue("Keep this draft");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(onCommit).toHaveBeenNthCalledWith(2, "Keep this draft");
  });
  it("does not submit twice while a write is pending", async () => {
    let settle: () => void = () => undefined;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    render(
      <TableInlineCreateRow
        active
        gridTemplateColumns="1fr 1fr"
        label="Add issue"
        onActivate={vi.fn()}
        onCancel={vi.fn()}
        onCommit={onCommit}
      />
    );
    const input = screen.getByRole("textbox", { name: "Add issue name" });
    fireEvent.change(input, { target: { value: "Once" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input).toHaveAttribute("readonly");
    settle();
    await waitFor(() => expect(input).toHaveValue(""));
  });
});
