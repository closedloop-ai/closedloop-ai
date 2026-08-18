"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useResponsiveModal } from "@repo/design-system/hooks/use-responsive-modal";
import { Loader2Icon } from "lucide-react";

type ConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => Promise<void> | void;
  isPending?: boolean;
  variant?: "default" | "destructive";
};

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  isPending = false,
  variant = "default",
}: Readonly<ConfirmationDialogProps>) {
  // Dialog on desktop, bottom Sheet below `sm` — one markup tree, the hook
  // swaps the catalog primitive family and keeps focus trap / Escape / a11y.
  const { Root, Content, Header, Footer, Title, Description } =
    useResponsiveModal();

  const handleConfirm = async () => {
    try {
      await onConfirm();
      // Only close on success: keep onOpenChange inside the try so a rejected
      // onConfirm leaves the dialog open for retry.
      onOpenChange(false);
    } catch {
      // The failure is already surfaced by the global mutation onError handler;
      // swallow it here so the unawaited onClick promise never rejects.
    }
  };

  return (
    <Root onOpenChange={onOpenChange} open={open}>
      <Content>
        <Header>
          <Title>{title}</Title>
          <Description>{description}</Description>
        </Header>
        <Footer>
          <Button
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {cancelLabel}
          </Button>
          <Button
            disabled={isPending}
            onClick={handleConfirm}
            variant={variant}
          >
            {isPending ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                {confirmLabel}...
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </Footer>
      </Content>
    </Root>
  );
}
