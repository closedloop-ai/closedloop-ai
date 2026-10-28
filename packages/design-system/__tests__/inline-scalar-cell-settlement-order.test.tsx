import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const SAVE_ERROR_MESSAGE = "Save failed";

describe("PRD-722 DT-035 InlineScalarCell settlement ownership", () => {
  it("keeps a newer text rejection visible after an older acceptance", async () => {
    const settlers = settlementControls();
    const onCommit = vi.fn(settlers.commit);
    render(
      <InlineScalarCell
        label="Estimate"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage={SAVE_ERROR_MESSAGE}
        value="7"
      />
    );

    const input = screen.getByRole("textbox", { name: "Estimate" });
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.blur(input);

    await settleNewerFailureThenOlderSuccess(settlers.controls, onCommit);

    expect(input).toHaveValue("11");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_MESSAGE);
  });

  it("keeps a newer date rejection visible after an older acceptance", async () => {
    const settlers = settlementControls();
    const onCommit = vi.fn(settlers.commit);
    render(
      <InlineScalarCell
        label="Due date"
        onCommit={onCommit}
        retainRejectedDraft
        saveErrorMessage={SAVE_ERROR_MESSAGE}
        type="date"
        value="2026-08-17"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Due date: Aug 17, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "20"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Due date: Aug 20, 2026" })
    );
    fireEvent.click(dayCell(await screen.findByRole("dialog"), "21"));

    await settleNewerFailureThenOlderSuccess(settlers.controls, onCommit);

    expect(
      screen.getByRole("button", { name: "Due date: Aug 21, 2026" })
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_ERROR_MESSAGE);
  });
});

function settlementControls(): {
  commit: () => Promise<void>;
  controls: Array<{
    reject: (reason: unknown) => void;
    resolve: () => void;
  }>;
} {
  const controls: Array<{
    reject: (reason: unknown) => void;
    resolve: () => void;
  }> = [];
  return {
    commit: () =>
      new Promise<void>((resolve, reject) => {
        controls.push({ reject, resolve });
      }),
    controls,
  };
}

async function settleNewerFailureThenOlderSuccess(
  controls: Array<{
    reject: (reason: unknown) => void;
    resolve: () => void;
  }>,
  onCommit: ReturnType<typeof vi.fn<() => Promise<void>>>
): Promise<void> {
  const [older, newer] = onCommit.mock.results.map((entry) => entry.value);
  controls[1]?.reject(new Error("newer refused"));
  await act(async () => newer?.catch(() => undefined));
  controls[0]?.resolve();
  await act(async () => older);
}

function dayCell(dialog: HTMLElement, dayOfMonth: string): HTMLElement {
  return within(dialog).getByText(dayOfMonth);
}
