import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// Guards the additive `hideClose` prop on the design-system SheetContent: the
// built-in top-right close-X renders by default (every existing consumer is
// unchanged), and opting into `hideClose` suppresses it so a sheet with its own
// dismiss affordance doesn't stack two X's (mobile search, FEA-3930 finding #1).
describe("SheetContent hideClose", () => {
  afterEach(cleanup);

  it("renders the built-in close button by default", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle className="sr-only">Panel</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("omits the built-in close button when hideClose is set", () => {
    render(
      <Sheet open>
        <SheetContent hideClose>
          <SheetTitle className="sr-only">Panel</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    // The sheet itself still mounts and keeps its accessible name.
    expect(screen.getByRole("dialog", { name: "Panel" })).toBeInTheDocument();
  });
});
