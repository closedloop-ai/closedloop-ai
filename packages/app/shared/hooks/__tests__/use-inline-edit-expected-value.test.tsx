import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleField } from "./use-inline-edit.test-support";

/**
 * ISS-11198. A save carries the value the server last confirmed, which the
 * server refuses the write against if another writer moved it. That value is
 * the ledger's, not the prop the field was first handed, and a save made while
 * another is in flight carries none: the ledger's value is optimistic then.
 */

afterEach(cleanup);

describe("PRD-722 AC-5 DT-032 useInlineEdit expected value", () => {
  it("expects the held update, not the title the edit began from", () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(
      <TitleField initialTitle="Plan" onSave={onSave} />
    );

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    rerender(<TitleField initialTitle="Roadmap" onSave={onSave} />);
    fireEvent.blur(input);

    // ISS-9589 sends the typing over the held value; the guard says so.
    expect(onSave).toHaveBeenCalledWith(
      "Plan v2",
      "Roadmap",
      expect.any(Function)
    );
  });

  // marisolashgrove review, PR #7924: guarding on the first save's optimistic
  // value refused the second whenever the first failed or landed after it.
  it("sends no expected value while an earlier save is in flight", () => {
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    render(<TitleField initialTitle="Plan" onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Plan v3" } });
    fireEvent.blur(input);

    // The third argument is the attempt's feedback-owner probe (PRD-722).
    expect(onSave.mock.calls).toEqual([
      ["Plan v2", "Plan", expect.any(Function)],
      ["Plan v3", undefined, expect.any(Function)],
    ]);
  });

  it("expects the confirmed value once the earlier save has settled", async () => {
    // The first save settles; the second stays in flight.
    const onSave = vi
      .fn<(value: string, expected: string | undefined) => Promise<unknown>>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValue(new Promise(() => undefined));
    render(<TitleField initialTitle="Plan" onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan v2" } });
    // Enter saves without blurring; the act flushes that save's settle.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    fireEvent.change(input, { target: { value: "Plan v3" } });
    fireEvent.blur(input);

    expect(onSave.mock.calls).toEqual([
      ["Plan v2", "Plan", expect.any(Function)],
      ["Plan v3", "Plan v2", expect.any(Function)],
    ]);
  });

  it("PRD-722 DT-075 keeps accepted B confirmed when delayed accepted A settles later", async () => {
    const settlers: { resolve: () => void }[] = [];
    const onSave = vi.fn<
      (value: string, expected: string | undefined) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          settlers.push({ resolve });
        })
    );
    const onChange = vi.fn<(next: string) => void>();
    render(<TitleField onChange={onChange} onSave={onSave} />);

    const input = screen.getByRole("textbox", { name: "Title" });
    input.focus();
    fireEvent.change(input, { target: { value: "Plan A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Plan B" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(2);
    const [acceptedA, acceptedB] = onSave.mock.results.map(
      (entry) => entry.value
    );

    settlers[1].resolve();
    await act(async () => acceptedB);
    expect(input).toHaveAttribute("data-confirmed-value", "Plan B");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Plan B");

    settlers[0].resolve();
    await act(async () => acceptedA);
    expect(input).toHaveAttribute("data-confirmed-value", "Plan B");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Plan B");
  });
});
