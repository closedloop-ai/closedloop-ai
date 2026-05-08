/**
 * Unit tests for LoopDispatchTargetSelector component.
 * Verifies target list rendering, online/offline indicators, and selection callback.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Render Popover content inline so jsdom can query it without portal simulation.
vi.mock("@repo/design-system/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

// Render Command primitives inline so item text and empty state are always visible.
vi.mock("@repo/design-system/components/ui/command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode;
    heading?: string;
  }) => (
    <div>
      {heading && <span>{heading}</span>}
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => (
    <button data-value={value} onClick={onSelect} role="option" type="button">
      {children}
    </button>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@repo/design-system/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: React.ReactNode;
  }) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => <svg data-testid="chevron-icon" />,
}));

// Import after mocks
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";

const MIKES_MACBOOK_NAME = /Mikes-MacBook/i;

const makeTargets = () => [
  { id: "ct-1", machineName: "Mikes-MacBook", status: "online" },
  { id: "ct-2", machineName: "Office-Desktop", status: "offline" },
];

describe("LoopDispatchTargetSelector", () => {
  it("renders the trigger button with placeholder text", () => {
    render(
      <LoopDispatchTargetSelector
        availableTargets={makeTargets()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText("Select compute target")).toBeInTheDocument();
  });

  it("renders each available target's machine name", () => {
    render(
      <LoopDispatchTargetSelector
        availableTargets={makeTargets()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText("Mikes-MacBook")).toBeInTheDocument();
    expect(screen.getByText("Office-Desktop")).toBeInTheDocument();
  });

  it("renders the empty state message when availableTargets is empty", () => {
    render(
      <LoopDispatchTargetSelector availableTargets={[]} onSelect={vi.fn()} />
    );

    expect(
      screen.getByText("No compute targets available.")
    ).toBeInTheDocument();
  });

  it("calls onSelect with the target id when a target is clicked", () => {
    const onSelect = vi.fn();
    render(
      <LoopDispatchTargetSelector
        availableTargets={makeTargets()}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByRole("option", { name: MIKES_MACBOOK_NAME }));

    expect(onSelect).toHaveBeenCalledWith("ct-1");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("applies emerald indicator class for an online target", () => {
    const { container } = render(
      <LoopDispatchTargetSelector
        availableTargets={[
          { id: "ct-1", machineName: "Mikes-MacBook", status: "online" },
        ]}
        onSelect={vi.fn()}
      />
    );

    const indicator = container.querySelector(".bg-emerald-500");

    expect(indicator).toBeInTheDocument();
  });

  it("applies red indicator class for an offline target", () => {
    const { container } = render(
      <LoopDispatchTargetSelector
        availableTargets={[
          { id: "ct-2", machineName: "Office-Desktop", status: "offline" },
        ]}
        onSelect={vi.fn()}
      />
    );

    const indicator = container.querySelector(".bg-red-500");

    expect(indicator).toBeInTheDocument();
  });
});
