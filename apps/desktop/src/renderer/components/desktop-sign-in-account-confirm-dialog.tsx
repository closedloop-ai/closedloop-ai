import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@closedloop-ai/design-system/components/ui/alert-dialog";
import { useState } from "react";
import { DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY } from "../shared-agent-sessions/desktop-sign-in-copy";
import type { DesktopIdentity } from "../types/desktop-api";
import { IdentityDetails } from "./settings/desktop-account-identity-details";

/**
 * ISS-11345: asks the user to confirm the account a sign-in brought back from
 * the browser before Desktop adopts it. Every way out other than the confirm
 * button — Cancel, Escape — cancels, so dismissing it can never sign anyone in.
 */
export function DesktopSignInAccountConfirmDialog({
  account,
  onConfirm,
  onCancel,
}: {
  account: DesktopIdentity;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Once confirmed, the dialog stays until main pushes the adopted state; a
  // late Escape in that window must not cancel what was just confirmed.
  const [confirmed, setConfirmed] = useState(false);
  // No trigger opened this dialog, so Radix has nowhere to return focus on
  // close; hand it back to whatever held it when the dialog appeared.
  const [returnFocus] = useState(() => document.activeElement);
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!(open || confirmed)) {
          onCancel();
        }
      }}
      open
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
            event.preventDefault();
            returnFocus.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <IdentityDetails
                identity={account}
                organizationId={account.organizationId}
                userId={account.userId}
              />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirmed}>
            {DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmed}
            onClick={(event) => {
              event.preventDefault();
              setConfirmed(true);
              onConfirm();
            }}
          >
            {DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
