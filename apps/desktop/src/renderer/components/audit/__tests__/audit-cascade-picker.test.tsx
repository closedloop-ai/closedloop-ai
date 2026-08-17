import {
  AVAILABLE_MODELS,
  type CascadeStep,
  DEFAULT_MODEL,
  HarnessName,
} from "@repo/crewd/model";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditCascadePicker } from "../audit-cascade-picker";

// Radix Select relies on a few DOM APIs jsdom does not implement. Polyfill them
// so the model popover opens and options are clickable in the test environment.
const POLYFILLED_ELEMENT_METHODS = [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const;

const originalElementMethods = new Map<
  string,
  PropertyDescriptor | undefined
>();

beforeAll(() => {
  for (const method of POLYFILLED_ELEMENT_METHODS) {
    originalElementMethods.set(
      method,
      Object.getOwnPropertyDescriptor(Element.prototype, method)
    );
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {
    // no-op in jsdom
  };
  Element.prototype.releasePointerCapture = () => {
    // no-op in jsdom
  };
  Element.prototype.scrollIntoView = () => {
    // no-op in jsdom
  };
});

afterAll(() => {
  for (const method of POLYFILLED_ELEMENT_METHODS) {
    const original = originalElementMethods.get(method);
    if (original) {
      Object.defineProperty(Element.prototype, method, original);
    } else {
      Reflect.deleteProperty(Element.prototype, method);
    }
  }
});

const DEFAULT_CASCADE: CascadeStep[] = [
  { harness: HarnessName.Codex },
  { harness: HarnessName.Opencode },
  { harness: HarnessName.Claude },
];

// Accessible-name matchers, hoisted to satisfy Ultracite's useTopLevelRegex.
const CODEX_NAME = /Codex/;
const CLAUDE_NAME = /Claude/;
const CLAUDE_MODEL_NAME = /Claude model/;
const MOVE_OPENCODE_EARLIER_NAME = /Move OpenCode earlier/;

function renderPicker(
  overrides: Partial<Parameters<typeof AuditCascadePicker>[0]> = {}
) {
  const onCascadeChange = vi.fn<(cascade: CascadeStep[]) => void>();
  render(
    <AuditCascadePicker
      cascade={DEFAULT_CASCADE}
      onCascadeChange={onCascadeChange}
      {...overrides}
    />
  );
  return { onCascadeChange };
}

describe("AuditCascadePicker", () => {
  it("offers every canonical harness sourced from the crewd registry", () => {
    renderPicker();
    // One checkbox per canonical harness — the count is driven by the model
    // SSOT (Object.keys(HarnessName)), not a hardcoded list in the picker.
    expect(screen.getAllByRole("checkbox")).toHaveLength(
      Object.keys(HarnessName).length
    );
    expect(screen.getByRole("checkbox", { name: CODEX_NAME })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: CLAUDE_NAME })).toBeDefined();
  });

  it("shows the model options from the canonical AVAILABLE_MODELS for a harness", () => {
    renderPicker();
    // Claude's model picker offers exactly claude's registry models.
    fireEvent.click(screen.getByRole("combobox", { name: CLAUDE_MODEL_NAME }));
    const listbox = screen.getByRole("listbox");
    for (const model of AVAILABLE_MODELS[HarnessName.Claude]) {
      expect(within(listbox).getByText(model)).toBeDefined();
    }
  });

  it("removes a harness from the cascade when its checkbox is unchecked", () => {
    const { onCascadeChange } = renderPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: CODEX_NAME }));
    expect(onCascadeChange).toHaveBeenCalledWith([
      { harness: HarnessName.Opencode },
      { harness: HarnessName.Claude },
    ]);
  });

  it("adds an off harness back to the END of the cascade when checked", () => {
    // Start with only codex; opencode/claude are off and re-addable.
    const { onCascadeChange } = renderPicker({
      cascade: [{ harness: HarnessName.Codex }],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: CLAUDE_NAME }));
    expect(onCascadeChange).toHaveBeenCalledWith([
      { harness: HarnessName.Codex },
      { harness: HarnessName.Claude },
    ]);
  });

  it("reorders a step earlier via the move-up control", () => {
    const { onCascadeChange } = renderPicker();
    fireEvent.click(
      screen.getByRole("button", { name: MOVE_OPENCODE_EARLIER_NAME })
    );
    expect(onCascadeChange).toHaveBeenCalledWith([
      { harness: HarnessName.Opencode },
      { harness: HarnessName.Codex },
      { harness: HarnessName.Claude },
    ]);
  });

  it("picks a non-default model as an explicit step model", () => {
    const { onCascadeChange } = renderPicker();
    fireEvent.click(screen.getByRole("combobox", { name: CLAUDE_MODEL_NAME }));
    const listbox = screen.getByRole("listbox");
    // "opus" is not claude's default ("sonnet"), so it is stored explicitly.
    fireEvent.click(within(listbox).getByText("opus"));
    expect(onCascadeChange).toHaveBeenCalledWith([
      { harness: HarnessName.Codex },
      { harness: HarnessName.Opencode },
      { harness: HarnessName.Claude, model: "opus" },
    ]);
  });

  it("stores a picked DEFAULT model as an omitted model (bare-harness semantics)", () => {
    // Seed claude with a non-default model so re-picking the default is a change.
    const { onCascadeChange } = renderPicker({
      cascade: [{ harness: HarnessName.Claude, model: "opus" }],
    });
    fireEvent.click(screen.getByRole("combobox", { name: CLAUDE_MODEL_NAME }));
    const listbox = screen.getByRole("listbox");
    fireEvent.click(
      within(listbox).getByText(DEFAULT_MODEL[HarnessName.Claude])
    );
    expect(onCascadeChange).toHaveBeenCalledWith([
      { harness: HarnessName.Claude },
    ]);
  });

  it("disables every control while a run is in flight", () => {
    renderPicker({ disabled: true });
    expect(
      (screen.getByRole("checkbox", { name: CODEX_NAME }) as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: MOVE_OPENCODE_EARLIER_NAME })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});
