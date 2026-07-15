import { HarnessType } from "@repo/api/src/types/compute-target";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  // Radix UI Select requires pointer-capture APIs not implemented in jsdom.
  if (typeof Element !== "undefined") {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  }
});

// Import after any setup
import { HarnessSelector } from "../harness-selector";

describe("HarnessSelector — neither available", () => {
  it("renders an error Alert with 'No AI harness available'", () => {
    render(
      <HarnessSelector
        availableHarnesses={[]}
        disabled={false}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(screen.getByText("No AI harness available")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not render a Select dropdown", () => {
    render(
      <HarnessSelector
        availableHarnesses={[]}
        disabled={false}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not render a Badge", () => {
    const { container } = render(
      <HarnessSelector
        availableHarnesses={[]}
        disabled={false}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    // Badge renders an element; in the neither-available case only the Alert is rendered
    expect(container.querySelector('[data-slot="alert"]')).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

const singleHarnessCases: Array<{
  harness: HarnessType;
  expectedLabel: string;
}> = [
  { harness: HarnessType.Claude, expectedLabel: "Claude" },
  { harness: HarnessType.Codex, expectedLabel: "Codex" },
];

describe("HarnessSelector — one harness available", () => {
  it.each(
    singleHarnessCases
  )("renders a static Badge with label '$expectedLabel' when only $harness is available", ({
    harness,
    expectedLabel,
  }) => {
    render(
      <HarnessSelector
        availableHarnesses={[harness]}
        disabled={false}
        onHarnessChange={vi.fn()}
        selectedHarness={harness}
      />
    );

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.queryByText("No AI harness available")
    ).not.toBeInTheDocument();
  });
});

describe("HarnessSelector — both harnesses available", () => {
  it("renders a Select dropdown (combobox role)", () => {
    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("does not render the warning alert", () => {
    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(
      screen.queryByText("No AI harness available")
    ).not.toBeInTheDocument();
  });

  it("calls onHarnessChange with HarnessType.Codex when Codex option is selected", async () => {
    const onHarnessChange = vi.fn();
    const user = userEvent.setup();

    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        onHarnessChange={onHarnessChange}
        selectedHarness={HarnessType.Claude}
      />
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("Codex"));

    expect(onHarnessChange).toHaveBeenCalledWith(HarnessType.Codex);
  });

  it("calls onHarnessChange with HarnessType.Claude when Claude option is selected", async () => {
    const onHarnessChange = vi.fn();
    const user = userEvent.setup();

    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        onHarnessChange={onHarnessChange}
        selectedHarness={HarnessType.Codex}
      />
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("Claude"));

    expect(onHarnessChange).toHaveBeenCalledWith(HarnessType.Claude);
  });
});

describe("HarnessSelector — disabled prop", () => {
  it("disables the Select trigger when disabled=true and both harnesses are available", () => {
    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        disabled={true}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("does not disable the Select trigger when disabled=false", () => {
    render(
      <HarnessSelector
        availableHarnesses={[HarnessType.Claude, HarnessType.Codex]}
        disabled={false}
        onHarnessChange={vi.fn()}
        selectedHarness={HarnessType.Claude}
      />
    );

    expect(screen.getByRole("combobox")).not.toBeDisabled();
  });
});
