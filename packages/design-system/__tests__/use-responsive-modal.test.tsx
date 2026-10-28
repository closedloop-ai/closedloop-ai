import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@closedloop-ai/design-system/components/ui/sheet";
import { useResponsiveModal } from "@closedloop-ai/design-system/hooks/use-responsive-modal";
import { render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function stubMatches(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches,
      removeEventListener: vi.fn(),
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResponsiveModal", () => {
  it("selects the Dialog family on desktop", () => {
    stubMatches(false);

    const { result } = renderHook(() => useResponsiveModal());

    expect(result.current.isMobile).toBe(false);
    expect(result.current.Root).toBe(Dialog);
    expect(result.current.Content).toBe(DialogContent);
    expect(result.current.Header).toBe(DialogHeader);
    expect(result.current.Footer).toBe(DialogFooter);
    expect(result.current.Title).toBe(DialogTitle);
    expect(result.current.Description).toBe(DialogDescription);
  });

  it("selects the Sheet family below the sm breakpoint", () => {
    stubMatches(true);

    const { result } = renderHook(() => useResponsiveModal());

    expect(result.current.isMobile).toBe(true);
    expect(result.current.Root).toBe(Sheet);
    expect(result.current.Content).not.toBe(DialogContent);
    expect(result.current.Header).toBe(SheetHeader);
    expect(result.current.Footer).toBe(SheetFooter);
    expect(result.current.Title).toBe(SheetTitle);
    expect(result.current.Description).toBe(SheetDescription);
  });

  it("queries the sm breakpoint", () => {
    const matchMedia = vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    renderHook(() => useResponsiveModal());

    expect(matchMedia).toHaveBeenCalledWith("(max-width: 639px)");
  });

  it("renders the desktop Content as a centered dialog", () => {
    stubMatches(false);
    const { result } = renderHook(() => useResponsiveModal());
    const { Root, Content, Title, Description } = result.current;

    render(
      <Root defaultOpen>
        <Content>
          <Title>Modal title</Title>
          <Description>Modal description</Description>
        </Content>
      </Root>
    );

    const dialog = screen.getByRole("dialog", { name: "Modal title" });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(dialog).toHaveClass("sm:max-w-lg");
  });

  it("renders the mobile Content as a bottom sheet with merged classes", () => {
    stubMatches(true);
    const { result } = renderHook(() => useResponsiveModal());
    const { Root, Content, Title, Description } = result.current;

    render(
      <Root defaultOpen>
        <Content className="custom-class">
          <Title>Modal title</Title>
          <Description>Modal description</Description>
        </Content>
      </Root>
    );

    const dialog = screen.getByRole("dialog", { name: "Modal title" });
    expect(dialog).toHaveAttribute("data-slot", "sheet-content");
    expect(dialog).toHaveClass("max-h-[90vh]");
    expect(dialog).toHaveClass("rounded-t-lg");
    expect(dialog).toHaveClass("custom-class");
    // Pinned to the bottom, not the sheet default (`right`).
    expect(dialog).toHaveClass("inset-x-0");
    expect(dialog).toHaveClass("bottom-0");
  });
});
