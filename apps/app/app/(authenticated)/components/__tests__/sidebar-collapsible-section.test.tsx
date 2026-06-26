import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

// Exercises the shared design-system section (previously the app-local
// CollapsibleNavSection) through the real Radix Collapsible so the test
// covers the actual aria-expanded wiring and content mount/unmount behavior.

function getToggle(name = "Artifacts") {
  return screen.getByRole("button", { name });
}

describe("SidebarCollapsibleSection", () => {
  afterEach(() => {
    cleanup();
    globalThis.localStorage.clear();
  });

  test("renders children expanded by default with aria-expanded true", () => {
    render(
      <SidebarCollapsibleSection title="Artifacts">
        <span>Documents</span>
      </SidebarCollapsibleSection>
    );

    expect(getToggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Documents")).toBeInTheDocument();
  });

  test("collapses and re-expands children when the header toggle is clicked", () => {
    render(
      <SidebarCollapsibleSection title="Artifacts">
        <span>Documents</span>
      </SidebarCollapsibleSection>
    );

    fireEvent.click(getToggle());
    expect(getToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();

    fireEvent.click(getToggle());
    expect(getToggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Documents")).toBeInTheDocument();
  });

  test("respects defaultOpen=false by rendering collapsed", () => {
    render(
      <SidebarCollapsibleSection defaultOpen={false} title="Artifacts">
        <span>Documents</span>
      </SidebarCollapsibleSection>
    );

    expect(getToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
  });

  test("restores persisted expanded state on mount", () => {
    globalThis.localStorage.setItem("test-sidebar-labs-open", "true");

    render(
      <SidebarCollapsibleSection
        defaultOpen={false}
        persistenceKey="test-sidebar-labs-open"
        title="Labs"
      >
        <span>Loops</span>
      </SidebarCollapsibleSection>
    );

    expect(getToggle("Labs")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Loops")).toBeInTheDocument();
  });

  test("persists toggle state across remounts", () => {
    const { unmount } = render(
      <SidebarCollapsibleSection
        persistenceKey="test-sidebar-labs-open"
        title="Labs"
      >
        <span>Loops</span>
      </SidebarCollapsibleSection>
    );

    fireEvent.click(getToggle("Labs"));
    expect(globalThis.localStorage.getItem("test-sidebar-labs-open")).toBe(
      "false"
    );

    unmount();
    render(
      <SidebarCollapsibleSection
        persistenceKey="test-sidebar-labs-open"
        title="Labs"
      >
        <span>Loops</span>
      </SidebarCollapsibleSection>
    );

    expect(getToggle("Labs")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Loops")).not.toBeInTheDocument();

    fireEvent.click(getToggle("Labs"));
    expect(globalThis.localStorage.getItem("test-sidebar-labs-open")).toBe(
      "true"
    );
  });
});
