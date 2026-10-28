"use client";

/**
 * @file ISS-12364: "notify me when Desktop is available for my platform", the
 * email capture a reader gets on the download step when the platform they are
 * on has no published installer (today: Windows, PRD-685).
 *
 * DESIGN-ONLY. No waitlist or notification endpoint exists yet, so this module
 * stores nothing and sends nothing: the host owns the request through
 * {@link DesktopAvailabilityNotifyFormProps.onSubmit}, a promise this form
 * awaits. Resolving it is the success state; rejecting it is the error state,
 * with the address kept and the same button offered again as the retry.
 * Implementing email storage and the notification itself is separate work, as
 * the ticket says.
 *
 * WHERE IT RENDERS. In the installer-gap arm of `DesktopDownloadAction`, between
 * the existing "Not available for <platform> yet" alert and the step's
 * `Continue without installing`. The alert already explains current platform
 * availability in approved words, so this form adds only what submitting does;
 * and because the forward control stays below it in every state, submitting is
 * never a step the reader has to take, and a failed request is never a dead end.
 *
 * EVERY WORD IS A PROP. None of this copy has a product ruling yet, so the
 * shared package carries no wording of its own (root AGENTS.md Human
 * Provenance); hosts and story fixtures supply {@link DesktopAvailabilityNotifyCopy}.
 */

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { isValidEmailAddress } from "../../shared/lib/email-address";

/** The words the form needs. No approved source supplies any of them yet. */
export type DesktopAvailabilityNotifyCopy = {
  /** What submitting does. Must not promise a release date. */
  explanation: string;
  /** The email field's visible label. */
  emailLabel: string;
  /** Shown under the field when the address cannot be an email. */
  invalidEmail: string;
  /** The call to action. */
  submitLabel: string;
  /** The same button while the host's request is in flight. */
  submittingLabel: string;
  /** Says the request did not go through and that the reader can try again. */
  failure: string;
  /** The button's label after a failure: the retry path. */
  retryLabel: string;
  /** Confirms the request was received. */
  successTitle: string;
  /** What happens next, after a received request. */
  successDetail: string;
};

/** Where the form is. Exported for tests and stories, not for hosts. */
export const DesktopAvailabilityNotifyStatus = {
  Editing: "editing",
  Invalid: "invalid",
  Submitting: "submitting",
  Failed: "failed",
  Succeeded: "succeeded",
} as const;

export type DesktopAvailabilityNotifyStatus =
  (typeof DesktopAvailabilityNotifyStatus)[keyof typeof DesktopAvailabilityNotifyStatus];

export type DesktopAvailabilityNotifyFormProps = {
  readonly copy: DesktopAvailabilityNotifyCopy;
  /**
   * The signed-in reader's address, offered pre-filled and still editable. A
   * Web reader reaches the download step after the account step, so the host
   * normally knows it; omitted, the field starts empty.
   */
  readonly defaultEmail?: string;
  /**
   * The host's request. Called with a trimmed, valid address only; resolve for
   * the success state, reject for the error state.
   */
  readonly onSubmit: (email: string) => Promise<void>;
  /**
   * The address the host has ALREADY recorded for this reader, when it has
   * one. Set, the form opens on its confirmation instead of an empty field, so
   * a reader who signed up, went Back and returned to the step is not offered
   * the sign-up again (marisolashgrove, review of #8983). The host learns it when
   * its {@link onSubmit} resolves, and keeps it for as long as it should hold:
   * the form's own success state lives only as long as it stays mounted.
   */
  readonly submittedEmail?: string;
};

export function DesktopAvailabilityNotifyForm({
  copy,
  defaultEmail = "",
  onSubmit,
  submittedEmail,
}: DesktopAvailabilityNotifyFormProps) {
  const fieldId = useId();
  const explanationId = `${fieldId}-explanation`;
  const messageId = `${fieldId}-message`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [status, setStatus] = useState<DesktopAvailabilityNotifyStatus>(
    DesktopAvailabilityNotifyStatus.Editing
  );

  if (
    status === DesktopAvailabilityNotifyStatus.Succeeded ||
    submittedEmail !== undefined
  ) {
    // The catalog `Alert`, like the installer-gap alert above it, but as a
    // polite status: a confirmation the reader asked for is not an interruption.
    return (
      <Alert
        className="mb-3 text-left"
        data-slot="desktop-availability-notify"
        data-status={DesktopAvailabilityNotifyStatus.Succeeded}
        role="status"
        variant="success"
      >
        <CheckIcon aria-hidden="true" />
        <AlertTitle>{copy.successTitle}</AlertTitle>
        <AlertDescription>{copy.successDetail}</AlertDescription>
      </Alert>
    );
  }

  const submitting = status === DesktopAvailabilityNotifyStatus.Submitting;
  const invalid = status === DesktopAvailabilityNotifyStatus.Invalid;
  const failed = status === DesktopAvailabilityNotifyStatus.Failed;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const candidate = email.trim();
    if (!isValidEmailAddress(candidate.toLowerCase())) {
      setStatus(DesktopAvailabilityNotifyStatus.Invalid);
      inputRef.current?.focus();
      return;
    }
    setStatus(DesktopAvailabilityNotifyStatus.Submitting);
    try {
      await onSubmit(candidate);
      setStatus(DesktopAvailabilityNotifyStatus.Succeeded);
    } catch {
      setStatus(DesktopAvailabilityNotifyStatus.Failed);
    }
  }

  return (
    <form
      aria-busy={submitting || undefined}
      className="mb-3 flex flex-col gap-2 text-left"
      data-slot="desktop-availability-notify"
      data-status={status}
      noValidate
      onSubmit={handleSubmit}
    >
      <p className="text-muted-foreground text-xs" id={explanationId}>
        {copy.explanation}
      </p>
      <Label htmlFor={fieldId}>{copy.emailLabel}</Label>
      <Input
        aria-describedby={`${explanationId} ${messageId}`}
        aria-invalid={invalid || undefined}
        autoComplete="email"
        id={fieldId}
        inputMode="email"
        name="email"
        onChange={(event) => {
          setEmail(event.target.value);
          // The message describes the address that was submitted; once it is
          // edited the message no longer describes what is in the field.
          if (invalid) {
            setStatus(DesktopAvailabilityNotifyStatus.Editing);
          }
        }}
        readOnly={submitting}
        ref={inputRef}
        type="email"
        value={email}
      />
      {/* One live region for both messages, present before either appears, so
          assistive technology announces the change rather than missing a region
          that was inserted with its text already in it. */}
      <p
        aria-live="polite"
        className="min-h-4 text-destructive text-xs"
        id={messageId}
      >
        {invalid ? copy.invalidEmail : null}
        {failed ? copy.failure : null}
      </p>
      {/* The primary control on a screen that offers no installer; the step's
          outline `Continue without installing` stays below it as the way on. */}
      <Button className="w-full" disabled={submitting} size="lg" type="submit">
        {submitting ? (
          <Loader2Icon aria-hidden="true" className="animate-spin" />
        ) : null}
        {submitButtonLabel(copy, status)}
      </Button>
    </form>
  );
}

function submitButtonLabel(
  copy: DesktopAvailabilityNotifyCopy,
  status: DesktopAvailabilityNotifyStatus
): string {
  if (status === DesktopAvailabilityNotifyStatus.Submitting) {
    return copy.submittingLabel;
  }
  if (status === DesktopAvailabilityNotifyStatus.Failed) {
    return copy.retryLabel;
  }
  return copy.submitLabel;
}
