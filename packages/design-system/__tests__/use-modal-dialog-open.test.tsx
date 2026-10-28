import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@closedloop-ai/design-system/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@closedloop-ai/design-system/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@closedloop-ai/design-system/components/ui/sheet";
import { useModalDialogOpen } from "@closedloop-ai/design-system/hooks/use-modal-dialog-open";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

const OPEN_PROBE = "modal-open-probe";

describe("useModalDialogOpen", () => {
  it("is true while a dialog is open and false once it closes", () => {
    const { rerender } = render(<DialogFixture open />);

    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("true");

    rerender(<DialogFixture open={false} />);

    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("false");
  });

  it("does not count a dialog whose content is rendered but closed", () => {
    render(<DialogFixture open={false} />);

    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("false");
  });

  it("stays true until the last of two open dialogs closes", () => {
    const { rerender } = render(<TwoDialogs first second />);

    rerender(<TwoDialogs first={false} second />);
    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("true");

    rerender(<TwoDialogs first={false} second={false} />);
    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("false");
  });

  it.each([
    [
      "an alert dialog",
      <AlertDialog key="alert" open>
        <AlertDialogContent>
          <AlertDialogTitle>Alert</AlertDialogTitle>
          <AlertDialogDescription>Alert body.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    ],
    [
      "a sheet",
      <Sheet key="sheet" open>
        <SheetContent>
          <SheetTitle>Sheet</SheetTitle>
          <SheetDescription>Sheet body.</SheetDescription>
        </SheetContent>
      </Sheet>,
    ],
    [
      "a drawer",
      <Drawer key="drawer" open>
        <DrawerContent>
          <DrawerTitle>Drawer</DrawerTitle>
          <DrawerDescription>Drawer body.</DrawerDescription>
        </DrawerContent>
      </Drawer>,
    ],
  ])("counts %s, and stops counting it once it unmounts", (_family, dialog) => {
    render(<OpenProbe />);
    const { unmount } = render(dialog);

    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("true");

    unmount();

    expect(screen.getByTestId(OPEN_PROBE)).toHaveTextContent("false");
  });
});

function OpenProbe() {
  return (
    <output data-testid={OPEN_PROBE}>{String(useModalDialogOpen())}</output>
  );
}

function WithProbe({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <OpenProbe />
    </>
  );
}

function DialogFixture({ open }: { open: boolean }) {
  return (
    <WithProbe>
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Dialog</DialogTitle>
          <DialogDescription>Dialog body.</DialogDescription>
        </DialogContent>
      </Dialog>
    </WithProbe>
  );
}

function TwoDialogs({ first, second }: { first: boolean; second: boolean }) {
  return (
    <WithProbe>
      <Dialog open={first}>
        <DialogContent>
          <DialogTitle>First</DialogTitle>
          <DialogDescription>First body.</DialogDescription>
        </DialogContent>
      </Dialog>
      <Dialog open={second}>
        <DialogContent>
          <DialogTitle>Second</DialogTitle>
          <DialogDescription>Second body.</DialogDescription>
        </DialogContent>
      </Dialog>
    </WithProbe>
  );
}
