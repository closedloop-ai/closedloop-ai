import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("DialogContent size", () => {
  it("keeps the default dialog width contract", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Dialog size" });

    expect(dialog).toHaveClass("w-full");
    expect(dialog).toHaveClass("max-w-[calc(100%-2rem)]");
    expect(dialog).toHaveClass("sm:max-w-lg");
    expect(dialog).not.toHaveClass("h-[min(680px,calc(100dvh-2rem))]");
  });

  it("renders the large geometry with compact viewport insets", () => {
    renderDialog("large");

    const dialog = screen.getByRole("dialog", { name: "Dialog size" });

    expect(dialog).toHaveClass("h-[min(680px,calc(100dvh-2rem))]");
    expect(dialog).toHaveClass("w-[min(900px,calc(100vw-2rem))]");
    expect(dialog).toHaveClass("max-w-[900px]");
    expect(dialog).toHaveClass("sm:max-w-[900px]");
    expect(dialog).not.toHaveClass("sm:max-w-lg");
  });

  it("renders the xlarge geometry, radius included", () => {
    renderDialog("xlarge");

    const dialog = screen.getByRole("dialog", { name: "Dialog size" });

    expect(dialog).toHaveClass("h-[min(880px,calc(100dvh-2rem))]");
    expect(dialog).toHaveClass("w-[min(1180px,calc(100vw-2rem))]");
    expect(dialog).toHaveClass("max-w-[1180px]");
    expect(dialog).toHaveClass("sm:max-w-[1180px]");
    // The radius rides the size rather than arriving as a caller's override,
    // so it cannot drift from the dimensions it was chosen for.
    expect(dialog).toHaveClass("rounded-2xl");
    expect(dialog).not.toHaveClass("sm:max-w-[900px]");
  });
});

type DialogSize = React.ComponentProps<typeof DialogContent>["size"];

function renderDialog(size?: DialogSize) {
  render(
    <Dialog defaultOpen>
      <DialogContent size={size}>
        <DialogTitle>Dialog size</DialogTitle>
        <DialogDescription>Dialog size contract.</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
