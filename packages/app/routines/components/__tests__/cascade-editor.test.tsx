import type { CascadeStep } from "@repo/crewd/model";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CascadeEditor } from "../cascade-editor";

const ADD_STEP = /add step/i;
const MOVE_1_DOWN = /move step 1 down/i;
const MOVE_2_UP = /move step 2 up/i;
const MOVE_1_UP = /move step 1 up/i;
const MOVE_2_DOWN = /move step 2 down/i;
const REMOVE_1 = /remove step 1/i;

const TWO_STEPS: CascadeStep[] = [
  { harness: "codex", model: "gpt-5-codex" },
  { harness: "claude" },
];

describe("CascadeEditor", () => {
  it("adds a step with the default harness", () => {
    const onChange = vi.fn();
    render(<CascadeEditor onChange={onChange} steps={[]} />);

    fireEvent.click(screen.getByRole("button", { name: ADD_STEP }));

    expect(onChange).toHaveBeenCalledWith([{ harness: "codex" }]);
  });

  it("moves a step down, reordering the cascade", () => {
    const onChange = vi.fn();
    render(<CascadeEditor onChange={onChange} steps={TWO_STEPS} />);

    fireEvent.click(screen.getByRole("button", { name: MOVE_1_DOWN }));

    expect(onChange).toHaveBeenCalledWith([
      { harness: "claude" },
      { harness: "codex", model: "gpt-5-codex" },
    ]);
  });

  it("moves a step up, reordering the cascade", () => {
    const onChange = vi.fn();
    render(<CascadeEditor onChange={onChange} steps={TWO_STEPS} />);

    fireEvent.click(screen.getByRole("button", { name: MOVE_2_UP }));

    expect(onChange).toHaveBeenCalledWith([
      { harness: "claude" },
      { harness: "codex", model: "gpt-5-codex" },
    ]);
  });

  it("removes a step", () => {
    const onChange = vi.fn();
    render(<CascadeEditor onChange={onChange} steps={TWO_STEPS} />);

    fireEvent.click(screen.getByRole("button", { name: REMOVE_1 }));

    expect(onChange).toHaveBeenCalledWith([{ harness: "claude" }]);
  });

  it("disables move-up on the first step and move-down on the last", () => {
    render(<CascadeEditor onChange={vi.fn()} steps={TWO_STEPS} />);

    expect(screen.getByRole("button", { name: MOVE_1_UP })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByRole("button", { name: MOVE_2_DOWN })).toHaveProperty(
      "disabled",
      true
    );
  });
});
