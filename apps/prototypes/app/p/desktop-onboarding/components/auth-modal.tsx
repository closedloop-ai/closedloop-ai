"use client";

import { GoogleGlyph } from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import {
  GithubIcon,
  Loader2Icon,
  MailIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthTrigger, authCopy } from "../mock";

type PendingMethod = "github" | "google" | "email" | null;

type AuthModalProps = {
  open: boolean;
  trigger: AuthTrigger;
  mode: "create" | "signin";
  onClose: () => void;
  // The chosen method matters downstream: a GitHub sign-up is one-shot (identity
  // + scoped token), while Google / email mint identity only and still require a
  // GitHub connection before syncing.
  onSuccess: (method: "github" | "google" | "email") => void;
};

// Deferred account modal. The account is never on the critical path — this only
// appears when the user reaches for something that needs identity. GitHub is the
// prioritized primary method: it mints the Clerk account AND grants a scoped
// GitHub API token, so PR/repo backfill runs through the API rather than the
// user's local gh/git binaries.
export const AuthModal = ({
  open,
  trigger,
  mode,
  onClose,
  onSuccess,
}: AuthModalProps) => {
  const [pending, setPending] = useState<PendingMethod>(null);
  const [email, setEmail] = useState("");
  // Holds the simulated OAuth resolve so a mid-flight close/unmount can cancel
  // it — otherwise onSuccess would fire after the user backed out.
  const successTimer = useRef<number | null>(null);

  // Stable identity so the effects below can list it as a dependency without
  // re-running every render (matches the timer-cleanup pattern in the workspace).
  const clearSuccessTimer = useCallback(() => {
    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setPending(null);
      setEmail("");
      clearSuccessTimer();
    }
  }, [open, clearSuccessTimer]);

  // Cancel any pending resolve if the modal unmounts mid-flight.
  useEffect(() => clearSuccessTimer, [clearSuccessTimer]);

  const copy = authCopy[trigger];
  const isSignin = mode === "signin";
  const emailIdleLabel = isSignin
    ? "Email me a link"
    : "Create account with email";
  const emailButtonLabel =
    pending === "email" ? "Sending magic link…" : emailIdleLabel;

  const go = (method: NonNullable<PendingMethod>) => {
    setPending(method);
    // Prototype: simulate the OAuth round-trip, then resolve.
    clearSuccessTimer();
    successTimer.current = window.setTimeout(() => onSuccess(method), 1100);
  };

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent className="max-w-[400px] gap-0">
        <DialogHeader className="items-center text-center">
          <p className="font-semibold text-[11px] text-primary uppercase tracking-[0.08em]">
            {copy.eyebrow}
          </p>
          <DialogTitle className="text-xl tracking-tight">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="text-pretty text-sm">
            {copy.body}
          </DialogDescription>
        </DialogHeader>

        {isSignin ? null : (
          <div className="mt-4 flex items-start gap-2 text-muted-foreground">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
            <p className="text-pretty text-xs leading-relaxed">
              Your sessions stay on this Mac. Nothing uploads automatically
              without your permission, and GitHub sign-in only reads the scopes
              you approve.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2.5">
          {/* GitHub is deliberately first + emphasized as the primary path. */}
          <Button
            className="w-full"
            disabled={pending !== null}
            onClick={() => go("github")}
            size="lg"
          >
            {pending === "github" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <GithubIcon />
            )}
            {pending === "github"
              ? "Opening your browser…"
              : "Continue with GitHub"}
          </Button>
          <Button
            className="w-full"
            disabled={pending !== null}
            onClick={() => go("google")}
            size="lg"
            variant="outline"
          >
            {pending === "google" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <GoogleGlyph />
            )}
            {pending === "google"
              ? "Opening your browser…"
              : "Continue with Google"}
          </Button>

          <div className="my-1 flex items-center gap-3 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>

          <Input
            aria-label="Email address"
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && email) {
                go("email");
              }
            }}
            placeholder="you@company.com"
            type="email"
            value={email}
          />
          <Button
            className="w-full"
            disabled={pending !== null || email.length === 0}
            onClick={() => email && go("email")}
            size="lg"
            variant="outline"
          >
            {pending === "email" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <MailIcon />
            )}
            {emailButtonLabel}
          </Button>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground leading-relaxed">
          {isSignin
            ? "New here? Just close this and try it first, no account needed."
            : "Free to start. By continuing you agree to the Terms and Privacy Policy."}
        </p>
      </DialogContent>
    </Dialog>
  );
};
