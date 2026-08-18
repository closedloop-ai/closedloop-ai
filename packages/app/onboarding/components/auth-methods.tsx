"use client";

import { GoogleGlyph } from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Github, Loader2, Mail } from "lucide-react";
import { type ComponentPropsWithoutRef, type FormEvent, useState } from "react";

export type AuthMethod = "github" | "google" | "email";

type AuthMethodsProps = {
  /**
   * Fired when the user picks a method. The host runs the real Clerk / loopback
   * OAuth (or magic-link) flow and reflects progress via `pendingMethod` — this
   * component never simulates the round-trip.
   */
  onSelect: (method: AuthMethod, email?: string) => void;
  /**
   * Controlled in-flight method (host-owned): drives the spinner and disables
   * the actions while the real flow runs.
   */
  pendingMethod?: AuthMethod | null;
  /** Email submit label, e.g. "Create account with email" vs "Email me a link". */
  emailCtaLabel?: string;
  /**
   * Adapter-owned native form target for the email form, so a pre-hydration or
   * no-JS submit on the web sign-in surface still posts the address to a real
   * endpoint (per `packages/app/AGENTS.md`). Desktop passes nothing.
   */
  nativeAction?: string;
  /** Adapter-owned native form method for pre-hydration or no-JS email submits. */
  nativeMethod?: ComponentPropsWithoutRef<"form">["method"];
  /**
   * Whether the email magic-link form is offered below the two social methods.
   * Defaults to `true`, so every existing host keeps the full set.
   *
   * ISS-5112: the desktop landing's sign-in step passes `false` to match the
   * `pre-auth-desktop-onboarding` prototype, which offers GitHub and Google only.
   * Hiding it removes a real capability from that one screen, so this is a host
   * decision rather than a default — do not flip the default to trim the panel.
   */
  showEmail?: boolean;
  /**
   * Adapter-owned native field name for the email input, so a pre-hydration or
   * no-JS submit actually carries the address. Desktop passes nothing.
   */
  nativeEmailInputName?: string;
};

/**
 * Canonical GitHub-first sign-in hierarchy (PRD-532 §5.2; matches the
 * `desktop-onboarding` and `sign-in` prototypes): GitHub is the single filled
 * primary above the divider, Google is de-emphasized to outline, and email is a
 * secondary Continue — so no two actions compete as primary. Surface-agnostic:
 * the host wires `onSelect` to the real auth flow and owns the in-flight state
 * via `pendingMethod`. Shared by desktop onboarding, web sign-in, and
 * Settings→Account so the entry point is identical across surfaces.
 */
export function AuthMethods({
  onSelect,
  pendingMethod = null,
  emailCtaLabel = "Continue with email",
  nativeAction,
  nativeMethod,
  nativeEmailInputName,
  showEmail = true,
}: AuthMethodsProps) {
  const [email, setEmail] = useState("");
  const busy = pendingMethod !== null;
  const canSubmitEmail = email.trim().length > 0;

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmitEmail) {
      onSelect("email", email.trim());
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        aria-busy={pendingMethod === "github"}
        className="w-full"
        disabled={busy}
        onClick={() => onSelect("github")}
        size="lg"
        type="button"
      >
        {pendingMethod === "github" ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Github />
        )}
        Continue with GitHub
      </Button>

      <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        aria-busy={pendingMethod === "google"}
        className="w-full"
        disabled={busy}
        onClick={() => onSelect("google")}
        size="lg"
        type="button"
        variant="outline"
      >
        {pendingMethod === "google" ? (
          <Loader2 className="animate-spin" />
        ) : (
          <GoogleGlyph />
        )}
        Continue with Google
      </Button>

      {showEmail ? (
        <form
          action={nativeAction}
          className="flex flex-col gap-3"
          method={nativeMethod}
          onSubmit={submitEmail}
        >
          <Input
            aria-label="Email address"
            autoComplete="email"
            disabled={busy}
            name={nativeEmailInputName}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            type="email"
            value={email}
          />
          <Button
            aria-busy={pendingMethod === "email"}
            className="w-full"
            disabled={busy || !canSubmitEmail}
            size="lg"
            type="submit"
            variant="secondary"
          >
            {pendingMethod === "email" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Mail />
            )}
            {emailCtaLabel}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
