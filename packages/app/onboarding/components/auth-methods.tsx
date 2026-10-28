"use client";

import { GoogleGlyph } from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Loader2, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { GitHubLogo } from "../../shared/feature-flags/github-logo";

export type AuthMethod = "github" | "google" | "email";

type AuthMethodsProps = {
  /**
   * Fired when the user picks a method. The host runs the real Clerk / loopback
   * OAuth flow and reflects progress via `pendingMethod` — this component never
   * simulates the round-trip.
   */
  onSelect: (method: AuthMethod, email?: string) => void;
  /**
   * Controlled in-flight method (host-owned): drives the spinner and disables
   * the actions while the real flow runs.
   */
  pendingMethod?: AuthMethod | null;
  /** Email submit label, e.g. "Create account with email" vs "Continue with email". */
  emailCtaLabel?: string;
};

/**
 * Canonical GitHub-first sign-in hierarchy (PRD-532 §5.2; matches the
 * `desktop-onboarding` and `sign-in` prototypes): GitHub is the single filled
 * primary above the divider, Google is de-emphasized to outline, and email is a
 * secondary Continue — so no two actions compete as primary. Surface-agnostic:
 * the host wires `onSelect` to the real auth flow and owns the in-flight state
 * via `pendingMethod`.
 *
 * ISS-5954: the method set is fixed — GitHub, Google, AND email, always. The
 * retired per-host `showEmail` opt-out is how the desktop surfaces drifted into
 * offering different products; a capability prop that does not exist cannot be
 * forgotten. Desktop reaches this through the shared guided-onboarding account
 * step, the same mount web uses — ISS-10246 deleted the `DesktopAuthMethods`
 * wrapper with the legacy Settings → Account tab that was its last consumer.
 */
export function AuthMethods({
  onSelect,
  pendingMethod = null,
  emailCtaLabel = "Continue with email",
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
          <GitHubLogo />
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

      <form className="flex flex-col gap-3" onSubmit={submitEmail}>
        <Input
          aria-label="Email address"
          autoComplete="email"
          disabled={busy}
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
    </div>
  );
}
