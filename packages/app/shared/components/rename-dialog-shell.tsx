"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useResponsiveModal } from "@repo/design-system/hooks/use-responsive-modal";
import type { FormEvent, ReactNode } from "react";

type RenameDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  onSubmit: () => Promise<void> | void;
  isPending?: boolean;
  canSave?: boolean;
};

export function RenameDialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  isPending = false,
  canSave = true,
}: Readonly<RenameDialogShellProps>) {
  // Dialog on desktop, bottom Sheet below `sm` — one markup tree, the hook
  // swaps the catalog primitive family and keeps focus trap / Escape / a11y.
  const { Root, Content, Header, Footer, Title, Description } =
    useResponsiveModal();

  const submitDisabled = isPending || !canSave;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) {
      return;
    }

    try {
      await onSubmit();
    } catch {
      // Failure surfaced by the mutation's onError handler; swallow here to
      // prevent an unhandled rejection from a future consumer.
    }
  };

  return (
    <Root onOpenChange={onOpenChange} open={open}>
      <Content>
        <Header>
          <Title>{title}</Title>
          <Description>{description}</Description>
        </Header>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">{children}</div>
          <Footer>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={submitDisabled} type="submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </Footer>
        </form>
      </Content>
    </Root>
  );
}
