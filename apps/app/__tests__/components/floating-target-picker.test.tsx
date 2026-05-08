import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FloatingTargetPicker,
  type FloatingTargetPickerSource,
  resolveFloatingTargetPickerSource,
} from "@/components/engineer/floating-target-picker";

vi.mock("@/components/engineer/LoopDispatchTargetSelector", () => ({
  LoopDispatchTargetSelector: ({
    availableTargets,
    onSelect,
  }: {
    availableTargets: { id: string; machineName: string; status: string }[];
    onSelect: (targetId: string) => void;
  }) => (
    <button
      onClick={() => onSelect(availableTargets[0]?.id ?? "")}
      type="button"
    >
      {availableTargets[0]?.machineName ?? "No targets"}
    </button>
  ),
}));

const makeSource = (
  id: string,
  onSelect = vi.fn()
): FloatingTargetPickerSource => ({
  multiTargetState: {
    availableTargets: [{ id, machineName: `${id}-machine`, status: "online" }],
  },
  onSelect,
});

describe("FloatingTargetPicker", () => {
  it("does not render without a multi-target conflict", () => {
    const { container } = render(
      <FloatingTargetPicker multiTargetState={null} onSelect={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the active conflict and forwards target selection", () => {
    const onSelect = vi.fn();
    render(
      <FloatingTargetPicker
        multiTargetState={makeSource("target-1").multiTargetState}
        onSelect={onSelect}
      />
    );

    expect(
      screen.getByText("Multiple compute targets are online. Select one:")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "target-1-machine" }));

    expect(onSelect).toHaveBeenCalledWith("target-1");
  });

  it("keeps a single active source when primary and fallback conflicts exist", () => {
    const primary = makeSource("feature-target");
    const fallback = makeSource("plan-target");

    expect(resolveFloatingTargetPickerSource(primary, fallback)).toBe(primary);
  });

  it("falls back when the primary conflict is absent", () => {
    const primary = { multiTargetState: null, onSelect: vi.fn() };
    const fallback = makeSource("plan-target");

    expect(resolveFloatingTargetPickerSource(primary, fallback)).toBe(fallback);
  });
});
