import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleField } from "./use-inline-edit.test-support";

/**
 * ISS-9589. A title handed down while the user is typing — another user's
 * rename, a refetch on focus or reconnect, the echo of an earlier save — used
 * to replace what they were typing. Each case lands that value BETWEEN the
 * typing and the save or cancel, and renders two fields so a rule that holds
 * every field, or none, cannot pass for one that holds only the dirty one.
 */

afterEach(cleanup);

describe("PRD-722 AC-5 DT-032 useInlineEdit under a live update", () => {
  it("keeps the typing in the dirty field and applies the update to the clean one", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TwoFields onSave={onSave} summary="Scope" title="Plan" />
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan v2" } });

    rerender(<TwoFields onSave={onSave} summary="Scope v2" title="Roadmap" />);

    expect(title).toHaveValue("Plan v2");
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "Scope v2"
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the held update after Escape, not the title the edit began from", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TwoFields onSave={onSave} summary="Scope" title="Plan" />
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan v2" } });
    rerender(<TwoFields onSave={onSave} summary="Scope" title="Roadmap" />);
    fireEvent.keyDown(title, { key: "Escape" });

    expect(title).toHaveValue("Roadmap");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the typing over a held update", () => {
    // Never settles: what is pinned is the write the blur sends, not its echo.
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(
      <TwoFields onSave={onSave} summary="Scope" title="Plan" />
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan v2" } });
    rerender(<TwoFields onSave={onSave} summary="Scope" title="Roadmap" />);
    fireEvent.blur(title);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Title", "Plan v2");
  });

  it("keeps a save the user made before the update's effects flushed", () => {
    // whitlockk review, PR #7836: React commits the new title, then the next Enter
    // lands before the field's effects run. The save never settles, so only the
    // field's own decision can keep the typing on screen.
    const onSave = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(
      <>
        <PressEnter press={false} />
        <TwoFields onSave={onSave} summary="Scope" title="Plan" />
      </>
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan v2" } });
    rerender(
      <>
        <PressEnter press />
        <TwoFields onSave={onSave} summary="Scope" title="Roadmap" />
      </>
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Title", "Plan v2");
    expect(title).toHaveValue("Plan v2");
  });

  it("does not hold a draft that differs only by whitespace a save would trim", () => {
    const onSave = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <TwoFields onSave={onSave} summary="Scope" title="Plan" />
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan " } });
    rerender(<TwoFields onSave={onSave} summary="Scope" title="Roadmap" />);

    expect(title).toHaveValue("Roadmap");
    // Held, the blur would trim "Plan " and write it back over "Roadmap".
    fireEvent.blur(title);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("PRD-722 DT-034 keeps the refused draft active over a later confirmed title", async () => {
    const refused = Promise.reject(new Error("the server refused it"));
    refused.catch(() => undefined);
    const onSave = vi.fn(() => refused);
    const { rerender } = render(
      <TwoFields onSave={onSave} summary="Scope" title="Plan" />
    );

    const title = screen.getByRole("textbox", { name: "Title" });
    title.focus();
    fireEvent.change(title, { target: { value: "Plan v2" } });
    act(() => title.blur());
    await act(async () => {
      await refused.catch(() => undefined);
    });
    expect(onSave).toHaveBeenCalledWith("Title", "Plan v2");
    expect(title).toHaveValue("Plan v2");
    expect(title).toHaveFocus();

    rerender(<TwoFields onSave={onSave} summary="Scope" title="Roadmap" />);

    expect(title).toHaveValue("Plan v2");
    fireEvent.keyDown(title, { key: "Escape" });
    expect(title).toHaveValue("Roadmap");
  });
});

/** Two always-mounted fields on one page, as the project header renders them. */
function TwoFields({
  onSave,
  summary,
  title,
}: Readonly<{
  onSave: (label: string, trimmedValue: string) => Promise<unknown>;
  summary: string;
  title: string;
}>) {
  return (
    <>
      <TitleField
        initialTitle={title}
        label="Title"
        onSave={(next) => onSave("Title", next)}
      />
      <TitleField
        initialTitle={summary}
        label="Summary"
        onSave={(next) => onSave("Summary", next)}
      />
    </>
  );
}

/**
 * Presses Enter in the Title field from a passive effect that runs BEFORE the
 * fields' own, because it is an earlier sibling: the window in which a real
 * keystroke can land between React committing a value and flushing effects.
 */
function PressEnter({ press }: Readonly<{ press: boolean }>) {
  useEffect(() => {
    if (press) {
      screen
        .getByRole("textbox", { name: "Title" })
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
        );
    }
  }, [press]);
  return null;
}
