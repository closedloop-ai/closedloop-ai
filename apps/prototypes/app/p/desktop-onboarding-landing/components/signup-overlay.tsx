"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type SignUpContext, signUpCopy } from "../app-mock";

/**
 * The Sign-Up prompt shown at every gated moment: tour finale, the header Sign
 * Up button, selecting Organization scope, and Invite your team. Signing up
 * simulates the system-browser OAuth round trip inline and resumes the intent
 * that prompted it (org scope, invite). The "Sign in" path routes returning
 * users into the shared BrowserSignIn surface (the same place the landing
 * hero's "Sign in" goes) so the same two words never land in two places.
 */
export const SignUpOverlay = ({
  context,
  onClose,
  onComplete,
  onSignIn,
}: {
  context: SignUpContext | null;
  onClose: () => void;
  onComplete: () => void;
  onSignIn: () => void;
}) => {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!(context && pending)) {
      return;
    }
    const timer = window.setTimeout(onComplete, 1200);
    return () => window.clearTimeout(timer);
  }, [context, pending, onComplete]);

  useEffect(() => {
    if (!context) {
      setPending(false);
    }
  }, [context]);

  const copy = context ? signUpCopy[context] : null;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={context !== null}
    >
      <DialogContent className="sm:max-w-md">
        {copy ? (
          <>
            <DialogHeader>
              {copy.eyebrow ? (
                <span className="font-semibold text-primary text-xs uppercase tracking-wide">
                  {copy.eyebrow}
                </span>
              ) : null}
              <DialogTitle className="text-xl tracking-tight">
                {copy.title}
              </DialogTitle>
              <DialogDescription className="text-pretty leading-relaxed">
                {copy.body}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2 flex flex-col gap-3">
              <Button
                disabled={pending}
                onClick={() => setPending(true)}
                size="lg"
              >
                {pending ? (
                  <>
                    <Loader2Icon className="animate-spin" />
                    Opening your browser...
                  </>
                ) : (
                  "Sign Up"
                )}
              </Button>
              <Button onClick={onClose} size="lg" variant="ghost">
                Not now
              </Button>
            </div>
            <p className="text-center text-muted-foreground text-sm">
              Already have an account?{" "}
              <Button
                className="h-auto p-0 align-baseline font-medium text-foreground"
                disabled={pending}
                onClick={onSignIn}
                variant="link"
              >
                Sign in
              </Button>
            </p>
            <p className="flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
              <ShieldCheckIcon className="size-3.5" />
              Your sessions stay on this Mac. Nothing uploads without
              permission.
            </p>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
